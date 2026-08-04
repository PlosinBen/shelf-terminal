import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANNEL_LOG } from '@shared/channel-log';
import { channelLog, initializeChannelLog, sanitizeChannel } from './channel-log';

describe('channel-log', () => {
  let root: string;
  let now: Date;

  beforeEach(() => {
    root = join(tmpdir(), `shelf-channel-log-${randomUUID()}`);
    now = new Date(2026, 7, 5, 12, 0, 0);
    fs.mkdirSync(root, { recursive: true });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('sanitizes path traversal and punctuation-only channel names', () => {
    expect(sanitizeChannel('feature-trace')).toBe('feature-trace');
    expect(sanitizeChannel('../etc/passwd')).toBe('___etc_passwd');
    expect(sanitizeChannel('//')).toBe('unnamed');
  });

  it('formats and appends to a YYYYMMDD daily file', () => {
    initializeChannelLog(root, { now: () => now });
    channelLog('feature-trace', 'debug', 'worker', 'phase complete');

    const content = fs.readFileSync(join(root, 'feature-trace', '20260805.log'), 'utf8');
    expect(content).toContain('[DEBUG][worker] phase complete');
    expect(content).toMatch(/^2026-08-05T/);

    now = new Date(2026, 7, 6, 1, 0, 0);
    channelLog('feature-trace', 'info', 'worker', 'next day');
    expect(fs.existsSync(join(root, 'feature-trace', '20260806.log'))).toBe(true);
  });

  it('prunes retained memory channels at initialization but leaves unconfigured channels', () => {
    for (const channel of [CHANNEL_LOG.MEMORY, CHANNEL_LOG.MEMORY_SUMMARY, 'feature-trace']) {
      fs.mkdirSync(join(root, channel), { recursive: true });
      fs.writeFileSync(join(root, channel, '20260705.log'), 'old');
      fs.writeFileSync(join(root, channel, '20260706.log'), 'boundary');
    }

    initializeChannelLog(root, { now: () => now });

    for (const channel of [CHANNEL_LOG.MEMORY, CHANNEL_LOG.MEMORY_SUMMARY]) {
      expect(fs.existsSync(join(root, channel, '20260705.log'))).toBe(false);
      expect(fs.existsSync(join(root, channel, '20260706.log'))).toBe(true);
    }
    expect(fs.existsSync(join(root, 'feature-trace', '20260705.log'))).toBe(true);
  });

  it('runs cleanup only on the first write of a new day', () => {
    initializeChannelLog(root, { now: () => now });
    const memoryDir = join(root, CHANNEL_LOG.MEMORY);
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(join(memoryDir, '20260705.log'), 'created after init');

    channelLog(CHANNEL_LOG.MEMORY, 'info', 'memory', 'same day');
    expect(fs.existsSync(join(memoryDir, '20260705.log'))).toBe(true);

    now = new Date(2026, 7, 6, 0, 1, 0);
    channelLog(CHANNEL_LOG.MEMORY, 'info', 'memory', 'first new-day write');
    expect(fs.existsSync(join(memoryDir, '20260705.log'))).toBe(false);

    fs.writeFileSync(join(memoryDir, '20260705.log'), 'created after daily cleanup');
    channelLog(CHANNEL_LOG.MEMORY, 'info', 'memory', 'second new-day write');
    expect(fs.existsSync(join(memoryDir, '20260705.log'))).toBe(true);
  });
});
