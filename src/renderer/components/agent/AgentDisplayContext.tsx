import { createContext } from 'react';
import type { AgentDisplayKey, AgentDisplayMode } from '@shared/types';

export type AgentDisplay = Partial<Record<AgentDisplayKey, AgentDisplayMode>>;

/**
 * Per-fold-type display prefs (collapsed/expanded), provided by the message
 * list to its `AgentMessage` children. Decouples `AgentMessage` from the global
 * store: the list owns the display config and passes it down, rather than every
 * message reaching into `useStore`. Default `{}` falls back to
 * `DEFAULT_AGENT_DISPLAY` per key inside `AgentMessage`.
 */
export const AgentDisplayContext = createContext<AgentDisplay>({});
