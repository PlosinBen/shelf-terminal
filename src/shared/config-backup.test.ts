import { describe, it, expect } from 'vitest';
import { sanitizeMachineLabel, backupItemId } from './config-backup';

describe('sanitizeMachineLabel', () => {
  it('keeps letters, digits, dot, underscore, hyphen', () => {
    expect(sanitizeMachineLabel('work-mac_2.local')).toBe('work-mac_2.local');
  });

  it('replaces every other character with a hyphen (does NOT strip the domain)', () => {
    expect(sanitizeMachineLabel("Ben's MBP.local")).toBe('Ben-s-MBP.local');
  });

  it('turns spaces and slashes into hyphens', () => {
    expect(sanitizeMachineLabel('a b/c:d')).toBe('a-b-c-d');
  });
});

describe('backupItemId', () => {
  it('joins kind and name with a colon', () => {
    expect(backupItemId('skill', 'demo')).toBe('skill:demo');
    expect(backupItemId('mcp', 'fs')).toBe('mcp:fs');
  });
});
