// ACP session drive — the runtime half of the shared acp/ toolkit.
//
// Semantics-free helpers that start a session and pump a prompt turn's
// session/update stream through the pure `translate` layer onto Shelf's wire
// `send`. No codex specifics; reused by every ACP-backed provider.

import type { ActiveSession, ClientContext, StopReason } from '@agentclientprotocol/sdk';
import type { OutgoingMessage } from '../types';
import { translateSessionUpdate } from './translate';

export interface StartSessionOptions {
  cwd: string;
  /** Extra workspace roots (e.g. the projected skills root → codex extraRoots). */
  additionalDirectories?: string[];
}

/**
 * Start a NEW ACP session. (Resume is a separate concern — see T2.3.) Returns
 * the `ActiveSession`, which routes this session's `session/update` stream into
 * a queue read by {@link drivePromptTurn}.
 */
export async function startSession(agent: ClientContext, opts: StartSessionOptions): Promise<ActiveSession> {
  let builder = agent.buildSession(opts.cwd);
  if (opts.additionalDirectories?.length) {
    builder = builder.withAdditionalDirectories(opts.additionalDirectories);
  }
  return builder.start();
}

/**
 * Drive one prompt turn to completion: send `prompt`, translate each
 * `session/update` to wire primitives via `send`, accumulate streamed assistant
 * text, and on turn end emit a finalize `reply` message per streamed message id.
 * Returns the ACP stop reason. Caller emits the terminal `status: idle`.
 */
export async function drivePromptTurn(
  session: ActiveSession,
  prompt: string,
  send: (msg: OutgoingMessage) => void,
): Promise<StopReason> {
  // Kick the turn; its completion is also surfaced as a `stop` message below.
  const promptDone = session.prompt(prompt);
  // Accumulate streamed assistant text per message id so we can emit a finalize
  // `reply` that the renderer upserts over the streamed placeholder.
  const textByMsg = new Map<string, string>();

  for (;;) {
    const m = await session.nextUpdate();
    if (m.kind === 'stop') {
      for (const [msgId, content] of textByMsg) {
        send({ type: 'message', msgId, msgType: 'reply', content });
      }
      // Surface any prompt-level rejection loudly rather than swallowing it.
      await promptDone.catch((err) => {
        send({ type: 'error', error: `ACP prompt failed: ${(err as Error)?.message ?? String(err)}` });
      });
      return m.stopReason;
    }
    for (const wire of translateSessionUpdate(m.update)) {
      if (wire.type === 'stream' && wire.streamType === 'text') {
        textByMsg.set(wire.msgId, (textByMsg.get(wire.msgId) ?? '') + wire.content);
      }
      send(wire);
    }
  }
}
