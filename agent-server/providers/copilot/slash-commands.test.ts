import { describe, it, expect } from 'vitest';
import { createCopilotBackend } from './index';
import type { OutgoingMessage, SendFn, QueryInput } from '../types';

/**
 * Test helper — captures all messages emitted by the provider via the wire
 * send fn. Slash commands flow through `query()`: provider parses the prefix
 * internally and dispatches via dispatchSlash. Output is emitted as
 * fold_markdown wire messages (pending → success/error upsert by msgId).
 */
function makeSendCapture(): { send: SendFn; emitted: OutgoingMessage[] } {
  const emitted: OutgoingMessage[] = [];
  const send: SendFn = (msg) => { emitted.push(msg); };
  return { send, emitted };
}

type FoldMarkdownMsg = Extract<OutgoingMessage, { type: 'message'; msgType: 'fold_markdown' }>;

function pickFoldMarkdown(emitted: OutgoingMessage[]): FoldMarkdownMsg[] {
  return emitted.filter(
    (m): m is FoldMarkdownMsg =>
      m.type === 'message' && (m as any).msgType === 'fold_markdown',
  );
}

function makeQueryInput(prompt: string): QueryInput {
  return { prompt, cwd: '/tmp' };
}

describe('Copilot slash dispatch via query()', () => {
  it('/clear without prior session emits pending → success fold_markdown', async () => {
    const backend = createCopilotBackend();
    const { send, emitted } = makeSendCapture();
    await backend.query(makeQueryInput('/clear'), send);
    const responses = pickFoldMarkdown(emitted);
    expect(responses.length).toBe(2);
    // Pending: no body, no errorMessage.
    expect(responses[0].label).toBe('/clear');
    expect(responses[0].body).toBeUndefined();
    expect(responses[0].errorMessage).toBeUndefined();
    // Success: body present, no errorMessage.
    expect(responses[1].body?.content).toMatch(/cleared/i);
    expect(responses[1].errorMessage).toBeUndefined();
    expect(responses[0].msgId).toBe(responses[1].msgId);
    backend.dispose();
  });

  it('/help emits one success fold_markdown listing commands', async () => {
    const backend = createCopilotBackend();
    const { send, emitted } = makeSendCapture();
    await backend.query(makeQueryInput('/help'), send);
    const responses = pickFoldMarkdown(emitted);
    expect(responses.length).toBe(1);
    expect(responses[0].label).toBe('/help');
    expect(responses[0].errorMessage).toBeUndefined();
    expect(responses[0].body?.content).toContain('/clear');
    expect(responses[0].body?.content).toContain('/compact');
    expect(responses[0].body?.content).toContain('/context');
    expect(responses[0].body?.content).toContain('/help');
    backend.dispose();
  });

  it('/context emits error fold_markdown when no usage tracked yet', async () => {
    const backend = createCopilotBackend();
    const { send, emitted } = makeSendCapture();
    await backend.query(makeQueryInput('/context'), send);
    const responses = pickFoldMarkdown(emitted);
    expect(responses.length).toBe(2);
    expect(responses[0].body).toBeUndefined();
    expect(responses[1].errorMessage).toMatch(/no context info/i);
    backend.dispose();
  });

  it('/compact before any session emits error fold_markdown', async () => {
    const backend = createCopilotBackend();
    const { send, emitted } = makeSendCapture();
    await backend.query(makeQueryInput('/compact'), send);
    const responses = pickFoldMarkdown(emitted);
    expect(responses.length).toBe(2);
    expect(responses[0].body).toBeUndefined();
    expect(responses[1].errorMessage).toMatch(/no active session/i);
    backend.dispose();
  });

  it('unknown command emits error fold_markdown', async () => {
    const backend = createCopilotBackend();
    const { send, emitted } = makeSendCapture();
    await backend.query(makeQueryInput('/foobar'), send);
    const responses = pickFoldMarkdown(emitted);
    expect(responses.length).toBe(1);
    expect(responses[0].errorMessage).toContain('foobar');
    backend.dispose();
  });

  // Config-edit turns (picker / status-bar) arrive as { configEdit, prompt: '' }.
  // Regression: Copilot's query() used to ignore input.configEdit and only parse
  // the (empty) prompt, so the turn fell through to a normal SDK send — no card,
  // and the model never switched (it continued the conversation instead).
  // Config edits render as a `system` divider (like Claude), NOT a fold_markdown
  // card.
  const pickSystem = (emitted: OutgoingMessage[]) =>
    emitted.filter((m): m is Extract<OutgoingMessage, { type: 'message' }> =>
      m.type === 'message' && (m as any).msgType === 'system');

  it('config-edit model turn applies the change and emits a system divider, no SDK send', async () => {
    const backend = createCopilotBackend();
    const { send, emitted } = makeSendCapture();
    // Use a value != DEFAULT_MODEL so it's a real change (re-picking the default
    // is a no-op — covered separately below).
    await backend.query({ prompt: '', cwd: '/tmp', configEdit: { key: 'model', value: 'claude-sonnet-4.5' } }, send);

    expect(pickFoldMarkdown(emitted).length).toBe(0); // not a slash-style card
    expect((pickSystem(emitted).at(-1) as any)?.content).toMatch(/claude-sonnet-4\.5/);

    const caps = emitted.find((m) => m.type === 'capabilities') as any;
    expect(caps?.currentModel).toBe('claude-sonnet-4.5');
    // No SDK round-trip: a normal send would surface auth/error from ensureSession.
    expect(emitted.some((m) => m.type === 'auth_required')).toBe(false);
    backend.dispose();
  });

  it('config-edit permissionMode turn maps to /permission and emits a system divider', async () => {
    const backend = createCopilotBackend();
    const { send, emitted } = makeSendCapture();
    await backend.query({ prompt: '', cwd: '/tmp', configEdit: { key: 'permissionMode', value: 'bypassPermissions' } }, send);

    expect(pickFoldMarkdown(emitted).length).toBe(0);
    expect((pickSystem(emitted).at(-1) as any)?.content).toMatch(/bypassPermissions/);
    backend.dispose();
  });

  // Re-submitting the value that's already live (re-picking the selected option,
  // or `/model <current>`) is a no-op: no divider, no status flicker.
  it('config-edit with the current value emits nothing (no divider, no status cycle)', async () => {
    const backend = createCopilotBackend();
    const { send, emitted } = makeSendCapture();
    // First edit to a non-default value takes effect (divider + status cycle).
    await backend.query({ prompt: '', cwd: '/tmp', configEdit: { key: 'model', value: 'claude-sonnet-4.5' } }, send);
    expect(pickSystem(emitted).length).toBe(1);

    // Second edit to the SAME value is a no-op.
    emitted.length = 0;
    await backend.query({ prompt: '', cwd: '/tmp', configEdit: { key: 'model', value: 'claude-sonnet-4.5' } }, send);
    expect(pickSystem(emitted).length).toBe(0);
    expect(emitted.filter((m) => m.type === 'status').length).toBe(0);
    expect(emitted.some((m) => m.type === 'capabilities')).toBe(false);
    backend.dispose();
  });

  // An app permission mode Copilot can't translate (invalid, or unsupported
  // like acceptEdits) has no SDK action — report error, do not claim success.
  it('rejects an untranslatable permission mode instead of silently accepting it', async () => {
    const backend = createCopilotBackend();
    const { send, emitted } = makeSendCapture();
    await backend.query({ prompt: '/permission acceptEdits', cwd: '/tmp' }, send);

    expect(pickSystem(emitted).length).toBe(0); // no "success" divider
    const err = emitted.find((m) => m.type === 'message' && (m as any).msgType === 'error') as any;
    expect(err?.content).toMatch(/acceptEdits/);
    backend.dispose();
  });

  it('emits streaming → idle status pair around slash dispatch (no cost/tokens on slash idle)', async () => {
    const backend = createCopilotBackend();
    const { send, emitted } = makeSendCapture();
    await backend.query(makeQueryInput('/help'), send);
    const statusEvents = emitted.filter((m) => m.type === 'status') as Extract<OutgoingMessage, { type: 'status' }>[];
    expect(statusEvents.length).toBe(2);
    expect(statusEvents[0].state).toBe('streaming');
    expect(statusEvents[1].state).toBe('idle');
    expect(statusEvents[1].costUsd).toBeUndefined();
    expect(statusEvents[1].inputTokens).toBeUndefined();
    expect(statusEvents[1].numTurns).toBeUndefined();
    expect(statusEvents[1].contextUsage).toBeUndefined();
    backend.dispose();
  });
});

describe('Copilot reloadSkills (live skill hot-reload)', () => {
  it('exposes reloadSkills (provider supports hot-reload)', () => {
    const backend = createCopilotBackend();
    expect(typeof backend.reloadSkills).toBe('function');
    backend.dispose();
  });

  it('reports reloaded:false (no live session) without touching the SDK or throwing', async () => {
    const backend = createCopilotBackend();
    // No query() has run → state.session is null. reloadSkills must short-circuit
    // without touching the SDK and without throwing into the dispatch loop,
    // returning a no-op outcome so the agent-server emits no `skills_reloaded` line.
    await expect(backend.reloadSkills!()).resolves.toEqual({ reloaded: false, ok: true });
    backend.dispose();
  });
});
