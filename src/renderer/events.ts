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
  CLOSE_TAB: 'close-tab',           // (projectIndex, tabIndex)
  REMOVE_PROJECT: 'remove-project',  // (projectIndex)
  NEW_TAB: 'new-tab',               // (projectIndex)
  CONNECT_PROJECT: 'connect-project',       // (projectIndex)
  DISCONNECT_PROJECT: 'disconnect-project', // (projectIndex)
  OPEN_FOLDER_PICKER: 'open-folder-picker',
  ADD_PROJECT: 'add-project',       // (ProjectConfig)
  TOGGLE_SPLIT: 'toggle-split',     // (projectIndex)
  CREATE_WORKTREE: 'create-worktree', // (projectIndex)
  NEW_AGENT_TAB: 'new-agent-tab',    // (projectIndex, provider)
} as const;
