import fs from 'fs/promises';
import path from 'path';
import { app } from 'electron';
import { log } from '@shared/logger';
import type { Message } from './index';

/**
 * On-disk schema for a single engine (Copilot/Gemini) conversation.
 *
 * Kept intentionally simple: one JSON file per sessionId under
 * `<userData>/agent-state/`. The system prompt is NOT saved — it is
 * rebuilt from the current cwd/mode/project instructions on every turn,
 * so persisting it would just mean we hydrate stale text that gets
 * overwritten anyway. Saving only user/assistant/tool messages keeps
 * the file tight and avoids that footgun.
 *
 * Image base64 is stored inline (design option (a) in
 * .agent/features/ENGINE_PERSISTENCE.md). If this becomes a space
 * problem in practice, images can be hoisted into a blobs/ directory
 * later without a schema bump — readers just need to tolerate both
 * forms during the transition.
 */
export interface EngineHistory {
  version: 1;
  sessionId: string;
  providerName: string;
  messages: Message[];
  model?: string;
  createdAt: number;
  updatedAt: number;
}

export interface HistoryStore {
  load(sessionId: string): Promise<EngineHistory | null>;
  save(entry: EngineHistory): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

// Path-traversal guard. sessionIds should be UUIDs (`crypto.randomUUID`),
// but be defensive against anything pathological slipping through opts.resume.
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function createFileHistoryStore(opts?: { dir?: string }): HistoryStore {
  // Lazy-resolve the default dir so tests can instantiate without an
  // Electron `app` handle available.
  const resolveDir = () => opts?.dir ?? path.join(app.getPath('userData'), 'agent-state');

  const pathFor = (sessionId: string) => {
    if (!SAFE_ID.test(sessionId)) {
      throw new Error(`engine-history: unsafe sessionId "${sessionId}"`);
    }
    return path.join(resolveDir(), `${sessionId}.json`);
  };

  return {
    async load(sessionId) {
      let filePath: string;
      try {
        filePath = pathFor(sessionId);
      } catch (err: any) {
        log.info('engine-history', `load skipped: ${err?.message ?? err}`);
        return null;
      }
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        const data = JSON.parse(raw) as EngineHistory;
        if (data.version !== 1) {
          // Forward-compat: if a future version writes the file, do NOT
          // clobber it. Return null so the engine starts with an empty
          // in-memory history; the subsequent save() will overwrite —
          // that's acceptable, better than crashing. If migration matters
          // later, add an explicit upgrade path keyed off version.
          log.info('engine-history', `unknown version=${data.version} id=${sessionId} — ignoring`);
          return null;
        }
        return data;
      } catch (err: any) {
        if (err?.code === 'ENOENT') return null;
        log.info('engine-history', `load failed id=${sessionId}: ${err?.message ?? err}`);
        return null;
      }
    },

    async save(entry) {
      let filePath: string;
      try {
        filePath = pathFor(entry.sessionId);
      } catch (err: any) {
        log.info('engine-history', `save skipped: ${err?.message ?? err}`);
        return;
      }
      const dir = path.dirname(filePath);
      const tmp = `${filePath}.tmp`;
      try {
        await fs.mkdir(dir, { recursive: true });
        // Atomic write: write to tmp then rename. If the process dies
        // mid-write the original file is intact. rename is atomic on
        // the same filesystem (which tmp + target always are here).
        await fs.writeFile(tmp, JSON.stringify(entry), 'utf8');
        await fs.rename(tmp, filePath);
      } catch (err: any) {
        log.info('engine-history', `save failed id=${entry.sessionId}: ${err?.message ?? err}`);
        // Clean up stray tmp file so the next save doesn't trip over it.
        await fs.unlink(tmp).catch(() => {});
      }
    },

    async delete(sessionId) {
      let filePath: string;
      try {
        filePath = pathFor(sessionId);
      } catch {
        return;
      }
      try {
        await fs.unlink(filePath);
      } catch (err: any) {
        if (err?.code !== 'ENOENT') {
          log.info('engine-history', `delete failed id=${sessionId}: ${err?.message ?? err}`);
        }
      }
    },
  };
}
