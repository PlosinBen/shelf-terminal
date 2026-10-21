import { describe, expect, it } from 'vitest';
import { CLAUDE_PROVIDER } from '@shared/agent-providers';
import type { Tab } from './store-projects';
import { runtimeTabToTemplate } from './tab-default-template';

function tab(overrides: Partial<Tab>): Tab {
  return {
    id: 'tab-1',
    label: 'Saved tab',
    color: '#89b4fa',
    hasUnread: false,
    muted: false,
    type: 'terminal',
    ...overrides,
  };
}

describe('runtimeTabToTemplate', () => {
  it('preserves Terminal command, label, and color', () => {
    expect(runtimeTabToTemplate(tab({ cmd: 'npm test' }))).toEqual({
      name: 'Saved tab',
      color: '#89b4fa',
      cmd: 'npm test',
    });
  });

  it('preserves Web URL, label, and color', () => {
    expect(runtimeTabToTemplate(tab({ type: 'web', url: 'https://example.com' }))).toEqual({
      name: 'Saved tab',
      color: '#89b4fa',
      kind: 'web',
      url: 'https://example.com',
    });
  });

  it('preserves Agent provider, label, and color', () => {
    expect(runtimeTabToTemplate(tab({ type: 'agent', provider: CLAUDE_PROVIDER }))).toEqual({
      name: 'Saved tab',
      color: '#89b4fa',
      kind: 'agent',
      provider: CLAUDE_PROVIDER,
    });
  });

  it('refuses a malformed Agent tab without a provider', () => {
    expect(runtimeTabToTemplate(tab({ type: 'agent', provider: undefined }))).toBeNull();
  });
});
