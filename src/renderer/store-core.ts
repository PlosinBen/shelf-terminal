type Listener = () => void;

const listeners = new Set<Listener>();
let version = 0;

export function subscribeStore(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitStoreChange() {
  version++;
  for (const listener of listeners) listener();
}

export function getStoreVersion() {
  return version;
}
