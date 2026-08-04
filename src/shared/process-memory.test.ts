import { describe, expect, it } from 'vitest';
import {
  MEM_RENDERER_PUBLISH_INTERVAL_MS,
  MEM_SAMPLE_INTERVAL_MS,
  MEM_SOURCE_STALE_AFTER_MS,
  MEMORY_PROCESS_ROLE,
  MEMORY_REPORT_STATUS,
  MEMORY_WIRE_TYPE,
  connectionScopeKey,
} from './process-memory';

describe('process memory contracts', () => {
  it('uses named wire values and a derived stale interval', () => {
    expect(MEMORY_WIRE_TYPE).toEqual({
      GET_USAGE: 'get_memory_usage',
      USAGE: 'memory_usage',
    });
    expect(MEMORY_REPORT_STATUS).toEqual({ OK: 'ok', ERROR: 'error' });
    expect(new Set(Object.values(MEMORY_PROCESS_ROLE)).size).toBe(
      Object.keys(MEMORY_PROCESS_ROLE).length,
    );
    expect(MEM_SOURCE_STALE_AFTER_MS).toBe(
      2 * MEM_SAMPLE_INTERVAL_MS + MEM_RENDERER_PUBLISH_INTERVAL_MS,
    );
  });

  it('derives the same non-secret scope used for one dispatcher host', () => {
    expect(connectionScopeKey({ type: 'local' })).toBe('local');
    expect(connectionScopeKey({
      type: 'ssh',
      host: 'example.test',
      port: 2222,
      user: 'shelf',
      password: 'do-not-include',
      idleShutdownMinutes: 12,
    })).toBe('ssh:example.test:2222:shelf');
    expect(connectionScopeKey({ type: 'docker', container: 'agent-dev' })).toBe(
      'docker:agent-dev',
    );
    expect(connectionScopeKey({ type: 'wsl', distro: 'Ubuntu-24.04' })).toBe(
      'wsl:Ubuntu-24.04',
    );
  });
});
