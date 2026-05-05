import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CONTEXT_DIR = path.join(os.homedir(), '.shelf', 'agent-context');

export interface PersistedContext {
  sessionId: string;
  provider: string;
  modelMessages: unknown[];
  totalInputTokens: number;
  totalOutputTokens: number;
  model: string;
  updatedAt: number;
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
