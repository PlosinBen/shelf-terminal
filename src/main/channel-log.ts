import * as fs from 'node:fs';
import { join } from 'node:path';
import { CHANNEL_LOG_POLICY } from '@shared/channel-log';

interface ChannelLogOptions {
  now?: () => Date;
}

let logsBaseDir: string | null = null;
let nowProvider = () => new Date();
let lastCleanupDay: string | null = null;

/** Restrict a channel name to a safe path segment (defends against traversal). */
export function sanitizeChannel(channel: string): string {
  const safe = channel.replace(/[^a-zA-Z0-9_-]/g, '_');
  return /[a-zA-Z0-9]/.test(safe) ? safe : 'unnamed';
}

function localDateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('');
}

function dateKeyOrdinal(dateKey: string): number | null {
  if (!/^\d{8}$/.test(dateKey)) return null;
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(4, 6));
  const day = Number(dateKey.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return Math.floor(date.getTime() / 86_400_000);
}

function cleanupRetainedChannels(todayKey: string): void {
  if (!logsBaseDir) return;
  const todayOrdinal = dateKeyOrdinal(todayKey);
  if (todayOrdinal === null) throw new Error(`invalid channel-log date key: ${todayKey}`);

  for (const [channel, policy] of Object.entries(CHANNEL_LOG_POLICY)) {
    const dir = join(logsBaseDir, sanitizeChannel(channel));
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const name of names) {
      const match = /^(\d{8})\.log$/.exec(name);
      if (!match) continue;
      const ordinal = dateKeyOrdinal(match[1]);
      if (ordinal !== null && todayOrdinal - ordinal > policy.retentionDays) {
        fs.rmSync(join(dir, name));
      }
    }
  }
  lastCleanupDay = todayKey;
}

/** Initialize channel storage and perform the retained-channel cleanup for today. */
export function initializeChannelLog(baseDir: string, options: ChannelLogOptions = {}): void {
  logsBaseDir = baseDir;
  nowProvider = options.now ?? (() => new Date());
  fs.mkdirSync(logsBaseDir, { recursive: true });
  const todayKey = localDateKey(nowProvider());
  lastCleanupDay = null;
  cleanupRetainedChannels(todayKey);
}

/** Format and append one named-channel line. No-op before app bootstrap initializes storage. */
export function channelLog(channel: string, level: string, tag: string, msg: string): void {
  if (!logsBaseDir) return;
  const now = nowProvider();
  const todayKey = localDateKey(now);
  if (lastCleanupDay !== todayKey) cleanupRetainedChannels(todayKey);

  const safeChannel = sanitizeChannel(channel);
  const dir = join(logsBaseDir, safeChannel);
  fs.mkdirSync(dir, { recursive: true });
  const line = `${now.toISOString()} [${level.toUpperCase()}][${tag}] ${msg}`;
  fs.appendFileSync(join(dir, `${todayKey}.log`), `${line}\n`);
}
