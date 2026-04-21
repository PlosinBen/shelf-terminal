import path from 'path';
import fs from 'fs/promises';
import os from 'os';

/**
 * Per-provider static-credential store. Writes to `~/.config/shelf/{id}.json`
 * with mode 0600 (owner-read only — matches aws cli / gh / npm conventions).
 *
 * Read order: env var first (runtime override), then file. Write is to file
 * only — we never mutate the process environment.
 */
export interface StaticCredentialStore {
  get(): Promise<string | null>;
  set(apiKey: string): Promise<void>;
  clear(): Promise<void>;
  filePath(): string;
}

export function createStaticCredentialStore(providerId: string, envVar: string): StaticCredentialStore {
  const filePath = path.join(os.homedir(), '.config', 'shelf', `${providerId}.json`);

  return {
    filePath() {
      return filePath;
    },

    async get(): Promise<string | null> {
      const fromEnv = process.env[envVar];
      if (fromEnv && fromEnv.length > 0) return fromEnv;
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw) as { apiKey?: string };
        return typeof parsed.apiKey === 'string' && parsed.apiKey.length > 0 ? parsed.apiKey : null;
      } catch {
        return null;
      }
    },

    async set(apiKey: string): Promise<void> {
      if (!apiKey || typeof apiKey !== 'string') {
        throw new Error('API key must be a non-empty string');
      }
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify({ apiKey }), { mode: 0o600 });
    },

    async clear(): Promise<void> {
      try {
        await fs.unlink(filePath);
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err;
      }
    },
  };
}
