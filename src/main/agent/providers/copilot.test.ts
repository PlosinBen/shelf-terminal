import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { filterChatModels, type CopilotModelRaw } from './copilot';

describe('filterChatModels', () => {
  it('keeps type:chat and drops other capability types', () => {
    const raw: CopilotModelRaw[] = [
      { id: 'gpt-4o', capabilities: { type: 'chat' } },
      { id: 'text-embedding-3', capabilities: { type: 'embeddings' } },
      { id: 'gpt-5.3-codex', capabilities: { type: 'completion' } },
      { id: 'no-type', capabilities: {} },
      { id: 'no-capabilities' },
    ];
    expect(filterChatModels(raw).map((m) => m.id)).toEqual(['gpt-4o']);
  });

  it('drops models with model_picker_enabled=false even if type:chat', () => {
    const raw: CopilotModelRaw[] = [
      { id: 'experimental', capabilities: { type: 'chat' }, model_picker_enabled: false },
      { id: 'stable', capabilities: { type: 'chat' } },
      { id: 'explicit-true', capabilities: { type: 'chat' }, model_picker_enabled: true },
    ];
    expect(filterChatModels(raw).map((m) => m.id)).toEqual(['stable', 'explicit-true']);
  });

  it('drops models whose supported_endpoints omit /chat/completions (e.g. gpt-5.x-codex)', () => {
    const raw: CopilotModelRaw[] = [
      { id: 'gpt-5.3-codex', capabilities: { type: 'chat' }, supported_endpoints: ['/responses', 'ws:/responses'] },
      { id: 'gpt-5.4', capabilities: { type: 'chat' }, supported_endpoints: ['/responses', '/chat/completions'] },
      { id: 'gpt-4o', capabilities: { type: 'chat' } }, // legacy: no supported_endpoints field
    ];
    expect(filterChatModels(raw).map((m) => m.id)).toEqual(['gpt-5.4', 'gpt-4o']);
  });
});

// ── Integration: only runs when Copilot auth is present on this machine ──

function hasCopilotAuth(): boolean {
  try {
    return fs.existsSync(path.join(os.homedir(), '.config', 'github-copilot', 'apps.json'))
      || fs.existsSync(path.join(os.homedir(), '.config', 'github-copilot', 'hosts.json'));
  } catch {
    return false;
  }
}

describe.skipIf(!hasCopilotAuth())('copilot backend getModels (integration)', () => {
  it('returns a non-empty chat-only list from the live /models endpoint', async () => {
    const { createCopilotBackend } = await import('./copilot');
    const backend = createCopilotBackend({ type: 'local' } as any);
    const models = await backend.getModels!();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      // Regression guards for the known bad capability types that used to leak
      // through the filter; see commit 73448e9.
      expect(m.id).not.toMatch(/codex/i);
      expect(m.id).not.toMatch(/embed/i);
    }
  }, 15_000);
});
