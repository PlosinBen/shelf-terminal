import type { AgentProvider, Connection } from '@shared/types';
import type { AgentMsg } from './components/AgentMessage';
import type { PersistedAgentMessage } from './agent-history';

/**
 * Single source of truth for "user submits a message to an agent tab".
 *
 * The trigger can be either a direct Enter press in AgentView, or the App-level
 * queue flush when the previous turn finishes while user-typed messages were
 * waiting. Both paths must do the same three things:
 *
 *   1. add to the in-memory AgentTabState.messages (so the UI renders it)
 *   2. persist to IndexedDB history (so reload restores it)
 *   3. hand off to the backend over IPC (so the agent actually sees it)
 *
 * Before this helper existed, the queue flush path only did step 3, which
 * meant queued messages silently disappeared from the transcript — see
 * GOTCHAS #33.
 */
export interface SubmitAgentMessagePayload {
  tabId: string;
  projectId: string;
  provider: AgentProvider;
  cwd: string;
  connection: Connection;
  initScript?: string;
  text: string;
  files?: Array<{ path: string; displayPath: string }>;
  images?: string[];
}

export interface SubmitAgentMessageDeps {
  addAgentMessage: (tabId: string, msg: AgentMsg) => void;
  saveMessage: (msg: Omit<PersistedAgentMessage, 'id'>) => Promise<void> | void;
  send: (
    tabId: string,
    text: string,
    cwd: string,
    provider: AgentProvider,
    connection: Connection,
    initScript: string | undefined,
    attachments: { files?: string[]; images?: string[] },
  ) => Promise<void> | void;
  now?: () => number;
}

export function submitAgentMessage(
  payload: SubmitAgentMessagePayload,
  deps: SubmitAgentMessageDeps,
): void {
  const ts = (deps.now ?? Date.now)();
  const hasFiles = payload.files && payload.files.length > 0;
  const hasImages = payload.images && payload.images.length > 0;
  const attachments = (hasFiles || hasImages)
    ? {
        ...(hasFiles ? { files: payload.files } : {}),
        ...(hasImages ? { images: payload.images } : {}),
      }
    : undefined;

  deps.addAgentMessage(payload.tabId, {
    id: `msg-${ts}`,
    role: 'user',
    type: 'text',
    content: payload.text,
    ...(attachments ? { attachments } : {}),
  });

  void deps.saveMessage({
    projectId: payload.projectId,
    timestamp: ts,
    role: 'user',
    type: 'text',
    content: payload.text,
    provider: payload.provider,
    ...(attachments ? { attachments } : {}),
  });

  void deps.send(
    payload.tabId,
    payload.text,
    payload.cwd,
    payload.provider,
    payload.connection,
    payload.initScript,
    {
      files: hasFiles ? payload.files!.map((f) => f.path) : undefined,
      images: hasImages ? payload.images : undefined,
    },
  );
}
