/**
 * Pure tests for telegram-mode helpers — alias derivation and fallback.
 * resolveAlias / buildUseCommands / formatProjectsList are exercised by the
 * Telegram bridge manual test plan (see features/telegram-agent-bridge.md
 * Task 6) since they pull from live agent/tools state.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock module deps so we can import telegram-mode without dragging electron in.
vi.mock('../agent', () => ({
  isAgentTab: () => false,
  getAgentProvider: () => null,
}));
vi.mock('./tools', () => ({
  getSyncedProjects: () => [],
}));

import { deriveAlias, aliasOrFallback } from './telegram-mode';

describe('deriveAlias', () => {
  it('drops whitespace and lowercases', () => {
    expect(deriveAlias('Shelf Terminal')).toBe('shelfterminal');
  });

  it('drops dash / underscore / dot / slash', () => {
    expect(deriveAlias('shelf-terminal')).toBe('shelfterminal');
    expect(deriveAlias('shelf_terminal')).toBe('shelfterminal');
    expect(deriveAlias('shelf.terminal')).toBe('shelfterminal');
    expect(deriveAlias('shelf/terminal')).toBe('shelfterminal');
  });

  it('preserves digits', () => {
    expect(deriveAlias('Project A2')).toBe('projecta2');
    expect(deriveAlias('v2024.web')).toBe('v2024web');
  });

  it('returns empty string for pure non-ASCII (CJK, emoji)', () => {
    expect(deriveAlias('我的專案')).toBe('');
    expect(deriveAlias('🚀 rocket')).toBe('rocket'); // emoji stripped, ASCII kept
    expect(deriveAlias('🚀')).toBe('');
  });

  it('truncates to 28 chars (room for use_ prefix → 32 total)', () => {
    const long = 'a'.repeat(50);
    expect(deriveAlias(long)).toBe('a'.repeat(28));
    expect(deriveAlias(long).length).toBe(28);
  });

  it('handles all-symbol names as empty', () => {
    expect(deriveAlias('---')).toBe('');
    expect(deriveAlias('???')).toBe('');
    expect(deriveAlias('  ')).toBe('');
  });
});

describe('aliasOrFallback', () => {
  it('uses derived alias when non-empty', () => {
    expect(aliasOrFallback('My Project', 'abc12345-de67')).toBe('myproject');
  });

  it('falls back to id-prefix when derivation is empty', () => {
    // pure CJK → use first 6 alphanumeric chars of id
    expect(aliasOrFallback('我的專案', 'abc12345-de67-89ab')).toBe('abc123');
  });

  it('id fallback strips dashes', () => {
    expect(aliasOrFallback('', 'aa-bb-cc-dd-ee')).toBe('aabbcc');
  });

  it('id fallback lowercases', () => {
    expect(aliasOrFallback('', 'ABC-DEF-123')).toBe('abcdef');
  });
});
