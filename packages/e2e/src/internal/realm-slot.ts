/**
 * Typed accessor for a `Symbol.for` slot on a host object. Test modules load
 * in isolated module realms (tsx), so runner-owned instances are shared
 * through registry symbols instead of module state. All unsafe reads live
 * here; call sites stay fully typed.
 */
export interface RealmSlot<T> {
  set(host: object, value: T): void;
  get(host: unknown): T | undefined;
  delete(host: object): void;
}

export function realmSlot<T>(key: string | symbol): RealmSlot<T> {
  const symbol = typeof key === 'symbol' ? key : Symbol.for(key);
  return {
    set(host, value) {
      Object.defineProperty(host, symbol, {
        value,
        enumerable: false,
        configurable: true,
        writable: false,
      });
    },
    get(host) {
      if ((typeof host !== 'object' || host === null) && typeof host !== 'function') {
        return undefined;
      }
      return (host as Record<PropertyKey, unknown>)[symbol] as T | undefined;
    },
    delete(host) {
      delete (host as Record<PropertyKey, unknown>)[symbol];
    },
  };
}
