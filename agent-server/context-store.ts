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
   * Claude SDK session_id from the last completed turn. Used to set
   * `options.resume` so the SDK reloads the conversation jsonl on next process
   * start. Only set for `provider === 'claude'`.
   */
  lastSdkSessionId?: string;
}

function contextPath(sessionId: string): string {
  return path.join(CONTEXT_DIR, `${sessionId}.json`);
}

export function loadContext(sessionId: string): PersistedContext | null {
  try {
    const raw = fs.readFileSync(contextPath(sessionId), 'utf-8');
    return JSON.parse(raw);
  } catch {
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
  try { fs.unlinkSync(contextPath(sessionId)); } catch {}
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
      } catch {
        // Corrupt file — remove it
        try { fs.unlinkSync(filePath); } catch {}
      }
    }
  } catch {}
}
