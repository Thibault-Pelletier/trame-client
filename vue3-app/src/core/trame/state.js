import { decorate, registerDecorator } from "./decorators";

// ----------------------------------------------------------------------------
// State helper
// ----------------------------------------------------------------------------
export class WatcherManager {
  constructor() {
    this.nextId = 1;
    this.listeners = {};
  }

  watch(dependencies, callback) {
    const key = `${this.nextId++}`;
    this.listeners[key] = {
      key,
      dependencies,
      callback,
    };
    const unsubscribe = () => delete this.listeners[key];
    return unsubscribe;
  }

  notifyWatchers(changedKeys, fullState) {
    const watchers = Object.values(this.listeners);
    const keys = new Set(changedKeys);

    for (let i = 0; i < watchers.length; i++) {
      const { dependencies, callback } = watchers[i];
      if (keys.intersection(new Set(dependencies)).size) {
        const args = dependencies.map((v) => fullState[v]);
        try {
          callback(...args);
        } catch (e) {
          console.error(`Watcher error with dependencies: ${dependencies}`, e);
        }
      }
    }
  }

  getWatchers() {
    return Object.values(this.listeners);
  }
}

export class SharedState {
  constructor(client) {
    this.name = "Default trame application";
    this.client = client;
    this.subscriptions = [];
    this.dirtyKeys = new Set();
    this.state = {};
    this.keyTS = {};
    this.mtime = 0;
    this.listeners = [];
    this.ready = false;
    this._watchers = new WatcherManager();

    // bind decorator helper
    this.registerDecorator = registerDecorator;

    const updateFromServer = async (serverState) => {
      const updatedKeys = [];
      const allKeys = Object.keys(serverState);
      for (let i = 0; i < allKeys.length; i++) {
        let modified = true;
        const key = allKeys[i];
        const value = serverState[key];

        // Handle _filter field
        if (value?._filter?.length) {
          modified = false;
          const prevValue = this.state[key];
          const objKeys = Object.keys(value);
          for (let j = 0; !modified && j < objKeys.length; j++) {
            const subKey = objKeys[j];
            if (subKey[0] === "_") {
              continue;
            }
            if (
              prevValue === undefined ||
              prevValue[subKey] !== value[subKey]
            ) {
              modified = true;
            }
          }
        }

        if (modified) {
          updatedKeys.push(key);
          this.state[key] = value;
        }
      }

      this.mtime += 1;
      const newKeys = [];
      for (let i = 0; i < updatedKeys.length; i++) {
        const key = updatedKeys[i];
        if (this.keyTS[key] === undefined) {
          newKeys.push(key);
        }
        this.keyTS[key] = this.mtime;
      }

      if (newKeys.length > 0) {
        this.notifyListeners({ type: "new-keys", keys: newKeys });
      }

      this.notifyListeners({ type: "dirty-state", keys: updatedKeys });
    };

    this.subscriptions.push(
      this.client
        .getRemote()
        .Trame.subscribeToStateUpdate(([serverState]) =>
          updateFromServer(serverState)
        )
    );

    this.subscriptions.push(
      this.addListener(({ type, keys }) => {
        if (type === "dirty-state") {
          this._watchers.notifyWatchers(keys, this.state);
        }
      })
    );

    // Keep it so we can call it on disconnect
    this._updateFromServer = updateFromServer;
  }

  async loadState() {
    const { state, name } = await this.client.getRemote().Trame.getState();
    this.name = name;
    this._updateFromServer(state);
    this.notifyListeners({ type: "ready" });
    this.ready = true;
  }

  notifyListeners(even) {
    for (let i = 0; i < this.listeners.length; i++) {
      this.listeners[i](even);
    }
  }

  addListener(listener) {
    this.listeners.push(listener);
  }

  removeListener(listener) {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  getAllKeys() {
    return Object.keys(this.state);
  }

  getMutableStateKeys() {
    const keysToRemove = new Set(this.state.trame__disable_mutation || []);
    return this.getAllKeys().filter((v) => !keysToRemove.has(v));
  }

  delete() {
    while (this.subscriptions.length) {
      this.client.getRemote().Trame.unsubscribe(this.subscriptions.pop());
    }
  }

  get(key) {
    if (key === undefined) {
      return this.state;
    }
    return this.state[key];
  }

  watch(keys, fn) {
    const unsubscribe = this._watchers.watch(keys, fn);

    // Call it right away with available values
    fn(...keys.map((v) => this.state[v]));

    return unsubscribe;
  }

  async set(key, value) {
    // Prevent triggering change when same value is set
    if (this.state[key] === value) {
      return;
    }

    this.ts += 1;
    this.state[key] = value;
    this.keyTS[key] = this.ts;
    this.dirty(key);
    await this.flush();
  }

  async update(obj) {
    this.ts += 1;
    for (const [key, value] of Object.entries(obj)) {
      if (this.state[key] !== value) {
        this.state[key] = value;
        this.keyTS[key] = this.ts;
        this.dirty(key);
      }
    }
    await this.flush();
  }

  canDirty(name) {
    return !this.state.trame__client_only.includes(name);
  }

  dirty(...keys) {
    keys.forEach((key) => {
      if (this.canDirty(key)) {
        this.dirtyKeys.add(key);
      }
    });
    // Make sure client side is aware of that change...
    this.notifyListeners({
      type: "dirty-state",
      keys,
    });
  }

  async flush(...keys) {
    if (keys.length) {
      keys.forEach((key) => {
        if (Array.isArray(key)) {
          this.dirty(...key);
        } else {
          this.dirty(key);
        }
      });
    }

    if (this.dirtyKeys.size && !this.client.isBusy()) {
      const waitOn = [];
      const keys = [];
      this.dirtyKeys.forEach((key) => {
        waitOn.push(decorate(this.state[key]));
        keys.push(key);
      });
      this.dirtyKeys.clear();
      const values = await Promise.all(waitOn);
      const deltaState = keys.map((key, i) => ({ key, value: values[i] }));
      if (this.client.isConnected()) {
        await this.client.getRemote().Trame.updateState(deltaState);
      }

      // Make sure we don't leave any pending update...
      if (this.dirtyKeys.size) {
        this.flush();
      }
    }

    // when connection died, the client is busy...
    if (!this.client.isConnected()) {
      // Handle dynamic update once disconnected
      this._updateFromServer(this.state);
    }
  }
}
