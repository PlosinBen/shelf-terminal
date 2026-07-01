// Untyped event bus shared by the renderer. Legacy string-named events
// (CLOSE_TAB / NEW_TAB / etc.) and typed agent events both ride on the
// same Map<string, Set<handler>>. Typed wrappers live in ./types.ts.
//
// Why one bus: typed and untyped are isolated by name prefix
// ('agent:*' for typed). One Map keeps the runtime simple and avoids
// having to thread two bus instances through cleanup paths.

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

// Legacy event-name registry. Kept for the user-action events that
// existed before the typed agent group. New events should go through
// AgentEventMap in ./types.ts and use onAgent/emitAgent helpers.
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
  OPEN_PM: 'open-pm',                 // ()
  NEW_AGENT_TAB: 'new-agent-tab',     // (projectIndex, provider?)
  NEW_WEB_TAB: 'new-web-tab',         // (projectIndex, url?) — url pre-navigates the tab
} as const;

// Test helper — clears every registered handler. Tests run in shared
// module state (Vitest hoists imports), so a failure mid-test can leak
// listeners into the next test's bus. Production code must never call.
export function __resetBusForTests() {
  handlers.clear();
}
