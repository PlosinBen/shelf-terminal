import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CONTEXT_DIR = path.join(os.homedir(), '.shelf', 'agent-context');

export interface PersistedContext {
  sessionId: string;
  provider: string;
  updatedAt: number;
  /** Chat Completions history (stateless mode). Only set for stateless OpenAI-compatible providers. */
  modelMessages?: unknown[];
  totalInputTokens?: number;
  totalOutputTokens?: number;
  model?: string;
  /** OpenAI Responses API stateful chain handle. Set when using a stateful model. */
  lastResponseId?: string;
  /**
   * Provider SDK's session ID from the last completed turn. Used to resume
   * conversation state across process restarts:
   * - `claude`: feeds `options.resume` so the SDK reloads its jsonl
   * - `copilot`: feeds `client.resumeSession()` so the Copilot CLI reloads
   *   its on-disk session state by id
   * Written via `context_patch` outgoing messages from providers; orchestrator
   * (`agent-server/index.ts`) is the single writer to disk.
   *
   * `null` is the explicit "clear this field" sentinel used by `/clear` flow:
   * provider emits `context_patch: { lastSdkSessionId: null }` to overwrite
   * a stored id so the next process doesn't resurrect a cleared session.
   * `undefined` (field omitted) on the wire would no-op via spread-merge.
   */
  lastSdkSessionId?: string | null;
}

function contextPath(sessionId: string): string {
  return path.join(CONTEXT_DIR, `${sessionId}.json`);
}

export function loadContext(sessionId: string): PersistedContext | null {
  try {
    const raw = fs.readFileSync(contextPath(sessionId), 'utf-8');
    return JSON.parse(raw);
  } catch (err: any) {
    // ENOENT is the dominant case (fresh session, never persisted yet).
    // Anything else (permission denied, JSON corruption) is worth flagging
    // because it silently loses user history.
    if (err?.code !== 'ENOENT') {
      console.error('[context-store] loadContext failed', { sessionId, code: err?.code, message: err?.message ?? err });
    }
    return null;
  }
}

export function saveContext(data: PersistedContext): void {
  fs.mkdirSync(CONTEXT_DIR, { recursive: true });
  const tmp = contextPath(data.sessionId) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
  fs.renameSync(tmp, contextPath(data.sessionId));
}

export function deleteContext(sessionId: string): void {
  try {
    fs.unlinkSync(contextPath(sessionId));
  } catch (err: any) {
    // ENOENT = already deleted, no-op. Anything else (permission denied)
    // is a real problem — context lingers beyond /clear, may resurrect.
    if (err?.code !== 'ENOENT') {
      console.error('[context-store] deleteContext failed', { sessionId, code: err?.code, message: err?.message ?? err });
    }
  }
}

export function cleanupOldContexts(maxAgeDays = 30): void {
  try {
    if (!fs.existsSync(CONTEXT_DIR)) return;
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    for (const file of fs.readdirSync(CONTEXT_DIR)) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(CONTEXT_DIR, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw) as { updatedAt?: number };
        if (data.updatedAt && data.updatedAt < cutoff) {
          fs.unlinkSync(filePath);
        }
      } catch (err: any) {
        // Corrupt file — remove it. The parse/read failure itself is worth
        // logging so we know context files are getting corrupted.
        console.error('[context-store] corrupt context file removed', { file, code: err?.code, message: err?.message ?? err });
        try {
          fs.unlinkSync(filePath);
        } catch (unlinkErr: any) {
          console.error('[context-store] failed to remove corrupt context file', { file, code: unlinkErr?.code, message: unlinkErr?.message ?? unlinkErr });
        }
      }
    }
  } catch (err: any) {
    console.error('[context-store] cleanupOldContexts dir scan failed', err?.message ?? err);
  }
}
