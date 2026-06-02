import { describe, it, expect } from 'vitest';
import { createFakeBackend, parseChain, pickerSinglePrompts, pickerMultiPrompts } from './index';
import type { OutgoingMessage, QueryInput } from '../types';

/**
 * Fake provider unit tests — verify each scenario emits a well-formed
 * OutgoingMessage sequence. The wire shapes are the contract; E2E specs
 * lean on these being stable.
 */

function collect(): { send: (m: OutgoingMessage) => void; msgs: OutgoingMessage[] } {
  const msgs: OutgoingMessage[] = [];
  return { send: (m) => msgs.push(m), msgs };
}

function makeInput(prompt: string): QueryInput {
  return { prompt, cwd: '/tmp', sessionId: 's1' };
}

describe('parseChain', () => {
  it('splits on |, trims, drops empties', () => {
    expect(parseChain('a|b|c')).toEqual(['a', 'b', 'c']);
    expect(parseChain(' text:hi | tool:Read ')).toEqual(['text:hi', 'tool:Read']);
    expect(parseChain('a||b')).toEqual(['a', 'b']);
    expect(parseChain('')).toEqual([]);
  });
});

describe('createFakeBackend — scenarios', () => {
  it('text: emits stream chunks + finalize + idle', async () => {
    const { send, msgs } = collect();
    const b = createFakeBackend();
    await b.query(makeInput('text:hello'), send);
    const types = msgs.map((m) => m.type);
    expect(types[0]).toBe('status');
    expect((msgs[0] as any).state).toBe('streaming');
    expect(types).toContain('stream');
    expect(msgs.filter((m) => m.type === 'stream').length).toBeGreaterThanOrEqual(2);
    const finalize = msgs.find((m) => m.type === 'message') as any;
    expect(finalize.msgType).toBe('reply');
    expect(finalize.content).toBe('hello');
    expect((msgs[msgs.length - 1] as any).state).toBe('idle');
  });

  it('thinking: emits one fold_text message labeled Thinking', async () => {
    const { send, msgs } = collect();
    await createFakeBackend().query(makeInput('thinking:reasoning'), send);
    const m = msgs.find((x) => x.type === 'message') as any;
    expect(m.msgType).toBe('fold_text');
    expect(m.label).toBe('Thinking');
    expect(m.body.content).toBe('reasoning');
    expect(m.body.tone).toBe('muted');
  });

  it('tool: emits fold_code without errorMessage on success', async () => {
    const { send, msgs } = collect();
    await createFakeBackend().query(makeInput('tool:Read'), send);
    const m = msgs.find((x) => x.type === 'message' && (x as any).msgType === 'fold_code') as any;
    expect(m.label).toBe('Read');
    expect(m.errorMessage).toBeUndefined();
  });

  it('tool_err: emits fold_code with errorMessage', async () => {
    const { send, msgs } = collect();
    await createFakeBackend().query(makeInput('tool_err:Bash'), send);
    const m = msgs.find((x) => x.type === 'message' && (x as any).msgType === 'fold_code') as any;
    expect(m.label).toBe('Bash');
    expect(m.errorMessage).toBeDefined();
  });

  it('permission: emits permission_request and waits for resolve', async () => {
    const { send, msgs } = collect();
    const b = createFakeBackend();
    const done = b.query(makeInput('permission:Write'), send);
    // Spin until permission_request appears.
    await new Promise((r) => setTimeout(r, 10));
    const req = msgs.find((m) => m.type === 'permission_request') as any;
    expect(req.toolName).toBe('Write');
    b.resolvePermission!(req.toolUseId, true);
    await done;
    const sys = msgs.find((m) => m.type === 'message' && (m as any).msgType === 'system') as any;
    expect(sys.content).toContain('allowed');
  });

  it('permission: deny includes message', async () => {
    const { send, msgs } = collect();
    const b = createFakeBackend();
    const done = b.query(makeInput('permission:Bash'), send);
    await new Promise((r) => setTimeout(r, 10));
    const req = msgs.find((m) => m.type === 'permission_request') as any;
    b.resolvePermission!(req.toolUseId, false, 'nope');
    await done;
    const sys = msgs.find((m) => m.type === 'message' && (m as any).msgType === 'system') as any;
    expect(sys.content).toContain('denied');
    expect(sys.content).toContain('nope');
  });

  it('picker_single: emits picker_request with one single-select prompt', async () => {
    const { send, msgs } = collect();
    const b = createFakeBackend();
    const done = b.query(makeInput('picker_single'), send);
    await new Promise((r) => setTimeout(r, 10));
    const req = msgs.find((m) => m.type === 'picker_request') as any;
    expect(req.prompts).toHaveLength(1);
    expect(req.prompts[0].multiSelect).toBe(false);
    expect(req.prompts[0].options).toHaveLength(3);
    b.resolvePicker!(req.id, { answers: ['B'] });
    await done;
    const echo = msgs.find((m) => m.type === 'message' && (m as any).content?.startsWith('picker_answers:')) as any;
    expect(echo.content).toBe('picker_answers:["B"]');
  });

  it('picker_multi: 3 prompts with mixed shapes', async () => {
    const { send, msgs } = collect();
    const b = createFakeBackend();
    const done = b.query(makeInput('picker_multi'), send);
    await new Promise((r) => setTimeout(r, 10));
    const req = msgs.find((m) => m.type === 'picker_request') as any;
    expect(req.prompts).toHaveLength(3);
    expect(req.prompts[0].multiSelect).toBe(false);
    expect(req.prompts[1].multiSelect).toBe(true);
    expect(req.prompts[1].options[0].description).toBeDefined();
    expect(req.prompts[2].inputType).toBe('text');
    b.resolvePicker!(req.id, { answers: ['red', ['cheese', 'olives'], 'urgent'] });
    await done;
    const echo = msgs.find((m) => m.type === 'message' && (m as any).content?.startsWith('picker_answers:')) as any;
    expect(echo.content).toBe('picker_answers:["red",["cheese","olives"],"urgent"]');
  });

  it('picker cancel: echoes picker_answers:cancelled', async () => {
    const { send, msgs } = collect();
    const b = createFakeBackend();
    const done = b.query(makeInput('picker_single'), send);
    await new Promise((r) => setTimeout(r, 10));
    const req = msgs.find((m) => m.type === 'picker_request') as any;
    b.resolvePicker!(req.id, { cancelled: true });
    await done;
    const echo = msgs.find((m) => m.type === 'message' && (m as any).content === 'picker_answers:cancelled');
    expect(echo).toBeDefined();
  });

  it('picker_input: options=[] inputType=text', async () => {
    const { send, msgs } = collect();
    const b = createFakeBackend();
    const done = b.query(makeInput('picker_input'), send);
    await new Promise((r) => setTimeout(r, 10));
    const req = msgs.find((m) => m.type === 'picker_request') as any;
    expect(req.prompts[0].options).toHaveLength(0);
    expect(req.prompts[0].inputType).toBe('text');
    b.resolvePicker!(req.id, { answers: ['hello'] });
    await done;
  });

  it('picker_number: inputType=integer', async () => {
    const { send, msgs } = collect();
    const b = createFakeBackend();
    const done = b.query(makeInput('picker_number'), send);
    await new Promise((r) => setTimeout(r, 10));
    const req = msgs.find((m) => m.type === 'picker_request') as any;
    expect(req.prompts[0].inputType).toBe('integer');
    b.resolvePicker!(req.id, { answers: ['42'] });
    await done;
  });

  it('auth_required: emits auth_required event', async () => {
    const { send, msgs } = collect();
    await createFakeBackend().query(makeInput('auth_required'), send);
    const e = msgs.find((m) => m.type === 'auth_required') as any;
    expect(e.provider).toBe('fake');
  });

  it('error: emits error event', async () => {
    const { send, msgs } = collect();
    await createFakeBackend().query(makeInput('error:boom'), send);
    const e = msgs.find((m) => m.type === 'error') as any;
    expect(e.error).toBe('boom');
  });

  it('delay: sleeps between steps', async () => {
    const { send, msgs } = collect();
    const start = Date.now();
    await createFakeBackend().query(makeInput('text:a|delay:60|text:b'), send);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(50);
    const texts = msgs.filter((m) => m.type === 'message' && (m as any).msgType === 'reply');
    expect(texts).toHaveLength(2);
  });

  it('chain: runs steps in order', async () => {
    const { send, msgs } = collect();
    await createFakeBackend().query(makeInput('text:hi|tool:Read|text:bye'), send);
    const ordered = msgs.filter((m) => m.type === 'message') as any[];
    expect(ordered[0].msgType).toBe('reply');
    expect(ordered[0].content).toBe('hi');
    expect(ordered[1].msgType).toBe('fold_code');
    expect(ordered[2].msgType).toBe('reply');
    expect(ordered[2].content).toBe('bye');
  });

  it('unknown prompt falls back to echo reply', async () => {
    const { send, msgs } = collect();
    await createFakeBackend().query(makeInput('not a known scenario'), send);
    const m = msgs.find((x) => x.type === 'message') as any;
    expect(m.msgType).toBe('reply');
    expect(m.content).toContain('fake-echo');
  });

  it('stop() aborts and resolves dangling picker as cancelled', async () => {
    const { send, msgs } = collect();
    const b = createFakeBackend();
    const done = b.query(makeInput('picker_single'), send);
    await new Promise((r) => setTimeout(r, 10));
    await b.stop();
    await done;
    // Final status should still be idle (turn closes cleanly).
    expect((msgs[msgs.length - 1] as any).state).toBe('idle');
  });

  it('gatherCapabilities returns minimal stub', async () => {
    const b = createFakeBackend();
    const caps = await b.gatherCapabilities!('/tmp');
    expect(caps.models[0].value).toBe('fake-model');
    expect(caps.permissionModes[0].value).toBe('default');
  });
});

describe('canned prompt shapes', () => {
  it('pickerSinglePrompts has 3 options, single-select', () => {
    const p = pickerSinglePrompts();
    expect(p[0].multiSelect).toBe(false);
    expect(p[0].options).toHaveLength(3);
  });

  it('pickerMultiPrompts covers single, multi+desc, free-text', () => {
    const p = pickerMultiPrompts();
    expect(p).toHaveLength(3);
    expect(p[0].multiSelect).toBe(false);
    expect(p[1].multiSelect).toBe(true);
    expect(p[1].options.some((o) => o.description)).toBe(true);
    expect(p[2].inputType).toBe('text');
  });
});
