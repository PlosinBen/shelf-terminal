import { describe, expect, it, vi } from 'vitest';
import { AGENT_INPUT_SOURCE, AGENT_REPLY_REQUIREMENT, createAgentInputMessage, validateAgentInputMessage, validateAgentInputRequest } from './agent-input';

describe('canonical Agent input', () => {
  const source = { kind: AGENT_INPUT_SOURCE.AGENT_VIEW } as const;

  it('creates an ID and defaults without trimming the original text', () => {
    const random = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
    try {
      expect(createAgentInputMessage({ source, content: '  original\n' })).toEqual({ ok: true, message: {
        msgId: '11111111-1111-4111-8111-111111111111', source, content: '  original\n',
        attachments: [], replyRequirement: AGENT_REPLY_REQUIREMENT.NONE,
      } });
    } finally { random.mockRestore(); }
  });

  it('rejects empty input before allocating an ID', () => {
    const random = vi.spyOn(globalThis.crypto, 'randomUUID');
    try {
      expect(createAgentInputMessage({ source, content: ' \n' })).toMatchObject({ ok: false });
      expect(random).not.toHaveBeenCalled();
    } finally { random.mockRestore(); }
  });

  it('accepts attachment-only input and preserves metadata without retaining caller objects', () => {
    const attachment = { kind: 'image' as const, path: '/tmp/a.svg', displayPath: 'a.svg', name: 'a.svg', mimeType: 'image/svg+xml', size: 12 };
    const result = createAgentInputMessage({ source, content: '', attachments: [attachment] });
    expect(result).toMatchObject({ ok: true, message: { attachments: [attachment] } });
    if (!result.ok) throw new Error(result.error);
    attachment.path = '/changed';
    expect(result.message.attachments[0].path).toBe('/tmp/a.svg');
    expect(validateAgentInputMessage(result.message)).toEqual(result);
  });

  it('validates an existing message without allocating or replacing its ID', () => {
    const built = createAgentInputMessage({ source, content: 'hello' });
    if (!built.ok) throw new Error(built.error);
    const random = vi.spyOn(globalThis.crypto, 'randomUUID');
    try {
      expect(validateAgentInputMessage(built.message)).toEqual(built);
      expect(random).not.toHaveBeenCalled();
    } finally { random.mockRestore(); }
  });

  it.each([
    { source: { kind: 'unknown' }, content: 'x' },
    { source: { kind: AGENT_INPUT_SOURCE.AGENT }, content: 'x' },
    { source, content: 'x', replyRequirement: 'arbitrary prompt' },
    { source, content: 'x', attachments: [{ kind: 'file' }] },
  ])('rejects malformed structure: %j', input => {
    expect(createAgentInputMessage(input as never)).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it('keeps Agent identity and name snapshot without requiring provider details', () => {
    const agent = { kind: AGENT_INPUT_SOURCE.AGENT, agentViewId: 'view', displayName: 'Reviewer' } as const;
    expect(createAgentInputMessage({ source: agent, content: 'review' })).toMatchObject({ ok: true, message: { source: agent } });
  });

  it('rejects forged renderer provenance and keeps config edits separate', () => {
    const built = createAgentInputMessage({ source: { kind: AGENT_INPUT_SOURCE.TELEGRAM }, content: 'hello' });
    if (!built.ok) throw new Error(built.error);
    expect(validateAgentInputRequest({ inputMessage: built.message }, AGENT_INPUT_SOURCE.AGENT_VIEW)).toMatchObject({ ok: false });
    expect(validateAgentInputRequest({ configEdit: { key: 'model', value: 'new' } }, AGENT_INPUT_SOURCE.AGENT_VIEW)).toEqual({ ok: true, message: { configEdit: { key: 'model', value: 'new' } } });
    expect(validateAgentInputRequest({ inputMessage: built.message, configEdit: { key: 'model', value: 'new' } })).toMatchObject({ ok: false });
    expect(validateAgentInputRequest({ configEdit: { key: 'unknown', value: 'new' } })).toMatchObject({ ok: false });
  });

  it('does not default invalid explicit fields or accept incomplete wire messages', () => {
    expect(createAgentInputMessage({ source, content: 'x', attachments: null } as never)).toMatchObject({ ok: false });
    expect(createAgentInputMessage({ source, content: 'x', replyRequirement: null } as never)).toMatchObject({ ok: false });
    expect(validateAgentInputMessage({ msgId: 'existing', source, content: 'x' })).toMatchObject({ ok: false });
  });
});


it('rejects renderer-owned invocation fields and keeps selection separate from canonical input', () => {
  const built = createAgentInputMessage({ source: { kind: AGENT_INPUT_SOURCE.AGENT_VIEW }, content: '/dev-flow task' });
  if (!built.ok) throw Error(built.error);
  const commandSelection = { registrationId: 'ad1b0c23-6789-4123-8123-123456789abc', catalogRevision: 'a'.repeat(64) };
  expect(validateAgentInputRequest({ inputMessage: built.message, commandSelection }, AGENT_INPUT_SOURCE.AGENT_VIEW)).toMatchObject({ ok: true, message: { commandSelection } });
  expect(validateAgentInputRequest({ inputMessage: built.message, invocation: { bindingId: 'forged' } }, AGENT_INPUT_SOURCE.AGENT_VIEW)).toMatchObject({ ok: false });
  expect(validateAgentInputRequest({ configEdit: { key: 'model', value: 'x' }, commandSelection })).toMatchObject({ ok: false });
});
