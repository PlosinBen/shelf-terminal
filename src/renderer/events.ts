type Handler = (...args: any[]) => void;

const handlers = new Map<string, Set<Handler>>();

export function on(event: string, handler: Handler) {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event)!.add(handler);
  return () => handlers.get(event)?.delete(handler);
}

export function emit(event: string, ...args: any[]) {
  handlers.get(event)?.forEach((h) => h(...args));
}

// Event names
export const Events = {
  CLOSE_TAB: 'close-tab',       // (projectIndex, tabIndex)
  CLOSE_PROJECT: 'close-project', // (projectIndex)
} as const;
