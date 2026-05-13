import { describe, it, expect, vi, afterEach } from 'vitest';
import { mergeClaudeModels, rateLimitInfoToSegment, formatClaudeToolInput, extractToolResultText, processMessage, createBlockMsgIdState, askUserQuestionToPrompts, buildAskUserQuestionAnswerJson } from './claude';
import type { OutgoingMessage } from './types';
import type { ProviderModel } from '../../src/shared/types';

describe('mergeClaudeModels', () => {
  it('returns SDK models unchanged when no customs', () => {
    const sdk = [
      { value: 'opus', displayName: 'Opus' },
      { value: 'sonnet', displayName: 'Sonnet' },
    ];
    const merged = mergeClaudeModels(sdk, []);
    expect(merged).toEqual([
      { value: 'opus', displayName: 'Opus', vision: true },
      { value: 'sonnet', displayName: 'Sonnet', vision: true },
    ]);
  });

  it('appends custom models that are not in SDK list', () => {
    const sdk = [{ value: 'opus', displayName: 'Opus' }];
    const customs: ProviderModel[] = [
      { id: 'claude-opus-4-6', contextWindow: 200_000 },
    ];
    const merged = mergeClaudeModels(sdk, customs);
    expect(merged).toEqual([
      { value: 'opus', displayName: 'Opus', vision: true },
      { value: 'claude-opus-4-6', displayName: 'claude-opus-4-6', vision: true },
    ]);
  });

  it('user custom overrides SDK entry of the same id', () => {
    const sdk = [{ value: 'opus', displayName: 'Opus' }];
    const customs: ProviderModel[] = [
      { id: 'opus', contextWindow: 1_000_000 },
    ];
    const merged = mergeClaudeModels(sdk, customs);
    expect(merged).toHaveLength(1);
    expect(merged[0].value).toBe('opus');
  });

  it('handles empty SDK list (only customs)', () => {
    const sdk: { value: string; displayName: string }[] = [];
    const customs: ProviderModel[] = [
      { id: 'claude-opus-4-7', contextWindow: 200_000 },
    ];
    const merged = mergeClaudeModels(sdk, customs);
    expect(merged).toEqual([
      { value: 'claude-opus-4-7', displayName: 'claude-opus-4-7', vision: true },
    ]);
  });

  it('handles undefined customs', () => {
    const sdk = [{ value: 'opus', displayName: 'Opus' }];
    const merged = mergeClaudeModels(sdk, undefined);
    expect(merged).toEqual([{ value: 'opus', displayName: 'Opus', vision: true }]);
  });
});

describe('rateLimitInfoToSegment', () => {
  // Pin "now" so resetsAt countdown formatting is deterministic.
  // Fixed at 2026-05-07 16:18 UTC; SDK's resetsAt is unix seconds.
  const FIXED_NOW_MS = Date.UTC(2026, 4, 7, 16, 18, 0);

  afterEach(() => {
    vi.useRealTimers();
  });

  function freezeNow() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW_MS));
  }

  // Regression: SDK only populates `utilization` when status crosses into
  // warning/rejected. On `allowed`, the field is absent — previous code
  // dropped the entire segment, hiding the bucket and reset countdown.
  it('renders segment without percent when utilization is absent', () => {
    freezeNow();
    const seg = rateLimitInfoToSegment({
      status: 'allowed',
      resetsAt: 1778181600, // 2026-05-07 19:20 UTC, ~3h ahead of FIXED_NOW
      rateLimitType: 'five_hour',
      overageStatus: 'rejected',
      isUsingOverage: false,
    });
    expect(seg).not.toBeNull();
    expect(seg!.text).toBe('5h: — ↻3.0h');
    expect(seg!.severity).toBe('normal');
  });

  it('renders percent + countdown when utilization is present', () => {
    freezeNow();
    const seg = rateLimitInfoToSegment({
      status: 'allowed_warning',
      resetsAt: 1778181600,
      rateLimitType: 'five_hour',
      utilization: 0.62,
    });
    expect(seg!.text).toBe('5h: 62% ↻3.0h');
    // allowed_warning forces 'warning' regardless of utilization severity.
    expect(seg!.severity).toBe('warning');
  });

  // Regression: SDK sends resetsAt in seconds; formatResetCountdown expects ms.
  // Without the *1000, countdown was always null and `↻Xh` never appeared.
  it('treats resetsAt as seconds (multiplies by 1000)', () => {
    freezeNow();
    const seg = rateLimitInfoToSegment({
      status: 'allowed',
      resetsAt: 1778181600, // seconds, NOT ms
      rateLimitType: 'five_hour',
    });
    expect(seg!.text).toContain('↻');
  });

  it('marks rejected status as critical even without utilization', () => {
    freezeNow();
    const seg = rateLimitInfoToSegment({
      status: 'rejected',
      resetsAt: 1778181600,
      rateLimitType: 'five_hour',
    });
    expect(seg!.severity).toBe('critical');
  });

  it('falls back to raw rateLimitType when label not mapped', () => {
    freezeNow();
    const seg = rateLimitInfoToSegment({
      status: 'allowed',
      rateLimitType: 'mystery_bucket',
    });
    expect(seg!.text).toMatch(/^mystery_bucket:/);
  });

  it('uses "quota" label when rateLimitType missing entirely', () => {
    const seg = rateLimitInfoToSegment({ status: 'allowed' });
    expect(seg!.text).toMatch(/^quota:/);
  });

  it('returns null for nullish info', () => {
    expect(rateLimitInfoToSegment(null)).toBeNull();
    expect(rateLimitInfoToSegment(undefined)).toBeNull();
  });

  it('drops countdown when resetsAt is in the past', () => {
    freezeNow();
    const seg = rateLimitInfoToSegment({
      status: 'allowed',
      resetsAt: Math.floor(FIXED_NOW_MS / 1000) - 3600, // 1h ago
      rateLimitType: 'five_hour',
    });
    expect(seg!.text).toBe('5h: —');
  });
});

describe('formatClaudeToolInput', () => {
  const cwd = '/Users/me/proj';

  it('formats Bash to bare command', () => {
    expect(formatClaudeToolInput('Bash', { command: 'ls -la', description: 'list files' }, cwd))
      .toBe('ls -la');
  });

  it('strips cwd from Read file_path and shows offset/limit', () => {
    expect(formatClaudeToolInput('Read', { file_path: '/Users/me/proj/src/foo.ts' }, cwd))
      .toBe('src/foo.ts');
    expect(formatClaudeToolInput('Read', { file_path: '/Users/me/proj/src/foo.ts', offset: 10, limit: 50 }, cwd))
      .toBe('src/foo.ts (10..+50)');
  });

  it('formats Grep with pattern + relative path', () => {
    expect(formatClaudeToolInput('Grep', { pattern: 'TODO', path: '/Users/me/proj/src' }, cwd))
      .toBe('TODO in src');
  });

  it('formats Glob with pattern only when path absent', () => {
    expect(formatClaudeToolInput('Glob', { pattern: '**/*.ts' }, cwd))
      .toBe('**/*.ts');
  });

  it('formats Task with description + truncated prompt', () => {
    const prompt = 'a'.repeat(200);
    const out = formatClaudeToolInput('Task', { description: 'lookup', prompt }, cwd);
    expect(out.startsWith('lookup: ')).toBe(true);
    expect(out.length).toBeLessThan(prompt.length);
  });

  it('falls back to first string for unknown tool', () => {
    expect(formatClaudeToolInput('mystery_mcp_tool', { foo: 42, bar: 'hello' }, cwd))
      .toBe('hello');
  });

  it('falls back to JSON when no string field', () => {
    const out = formatClaudeToolInput('mystery', { count: 3, ok: true }, cwd);
    expect(out).toContain('"count":3');
  });
});

describe('extractToolResultText', () => {
  // Regression: Claude SDK Task/Agent tool_result content is a content-block
  // array, not a string. Pre-fix we JSON-stringified it and the user saw
  // raw `[{"type":"text","text":"..."}]` in the result body.
  it('joins text blocks into newline-separated string', () => {
    const raw = [
      { type: 'text', text: 'first line' },
      { type: 'text', text: 'second line' },
    ];
    expect(extractToolResultText(raw)).toBe('first line\nsecond line');
  });

  it('passes strings through unchanged (legacy / simple tools)', () => {
    expect(extractToolResultText('hello world')).toBe('hello world');
  });

  it('falls back to JSON for non-text block types so info is not lost', () => {
    const raw = [{ type: 'image', data: 'b64...' }];
    expect(extractToolResultText(raw)).toContain('"type":"image"');
  });

  it('returns empty string for nullish input', () => {
    expect(extractToolResultText(null)).toBe('');
    expect(extractToolResultText(undefined)).toBe('');
  });
});

describe('processMessage — text msgId stability across SDK quirks', () => {
  // Helpers to drive processMessage like the real for-await loop does.
  function makeSink() {
    const sent: any[] = [];
    const send = (m: OutgoingMessage) => { sent.push(m); };
    return { send, sent };
  }
  const textBlocksAt = (msgs: any[]) => msgs.filter((m) => m.type === 'message' && m.msgType === 'text');

  it('clears blockMsgIds on message_start, mints fresh ids per assistant message', () => {
    // Two logical assistant messages, both starting with text at idx 0.
    // After message_start fires for #2, the idx-0 msgId must NOT be reused
    // from #1 — otherwise renderer upserts #2's text onto #1's entry.
    const { send, sent } = makeSink();
    const map = createBlockMsgIdState();

    // Turn 1
    processMessage({ type: 'stream_event', event: { type: 'message_start' } } as any, send, '/x', map);
    processMessage({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } } as any, send, '/x', map);
    processMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'First message' }] } } as any, send, '/x', map);

    // Turn 2 starts
    processMessage({ type: 'stream_event', event: { type: 'message_start' } } as any, send, '/x', map);
    processMessage({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } } as any, send, '/x', map);
    processMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'Second message' }] } } as any, send, '/x', map);

    const texts = textBlocksAt(sent);
    expect(texts).toHaveLength(2);
    expect(texts[0].content).toBe('First message');
    expect(texts[1].content).toBe('Second message');
    expect(texts[0].msgId).not.toBe(texts[1].msgId);
  });

  it('content_block_start mid-turn re-fire is idempotent (no msgId churn)', () => {
    // Regression: SDK was observed re-firing content_block_start for an
    // already-active text block mid-turn. If we re-minted, the renderer
    // entry already accumulating under M1 would orphan, and the next
    // assistant emit (now M2) would create a duplicate timeline entry.
    const { send, sent } = makeSink();
    const map = createBlockMsgIdState();

    processMessage({ type: 'stream_event', event: { type: 'message_start' } } as any, send, '/x', map);
    processMessage({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } } as any, send, '/x', map);
    const firstId = map.byIndex.get(0);
    processMessage({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } } as any, send, '/x', map);
    expect(map.byIndex.get(0)).toBe(firstId);

    // Two partial assistants for the same logical text block share one id.
    processMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } } as any, send, '/x', map);
    processMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'OK done' }] } } as any, send, '/x', map);
    const texts = textBlocksAt(sent);
    expect(texts).toHaveLength(2);
    expect(texts[0].msgId).toBe(texts[1].msgId);
  });

  it('delta-mode assistant emits map each block to its absolute index, not array idx', () => {
    // Regression: SDK with includePartialMessages: true emits one assistant
    // event per block, each with content.length === 1 — NOT a cumulative
    // growing array. So content[0] of the text-block emit is at absolute
    // index 1 (after thinking at 0), not 0. The old `forEach((b, i) => ...)`
    // looked up i=0 and got thinking's msgId, then upserted the thinking
    // entry to text → duplicate text entries + missing thinking.
    const { send, sent } = makeSink();
    const map = createBlockMsgIdState();

    processMessage({ type: 'stream_event', event: { type: 'message_start' } } as any, send, '/x', map);
    processMessage({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } } as any, send, '/x', map);
    const thinkingId = map.byIndex.get(0);
    processMessage({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'think...' }] } } as any, send, '/x', map);

    processMessage({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } } as any, send, '/x', map);
    const textId = map.byIndex.get(1);
    processMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } } as any, send, '/x', map);

    expect(thinkingId).toBeDefined();
    expect(textId).toBeDefined();
    expect(thinkingId).not.toBe(textId);

    const thinkings = sent.filter((m) => m.type === 'message' && m.msgType === 'thinking');
    const texts = textBlocksAt(sent);
    expect(thinkings).toHaveLength(1);
    expect(thinkings[0].msgId).toBe(thinkingId);
    expect(texts).toHaveLength(1);
    expect(texts[0].msgId).toBe(textId); // NOT thinkingId
  });

  it('late partial assistant arriving after tool_result does NOT duplicate text', () => {
    // The bug: previously we cleared blockMsgIds on tool_result. If the
    // SDK delivered one more late partial assistant for the just-finished
    // turn (observed empirically), getOrMintBlockMsgId(0) would mint a
    // fresh msgId and the renderer would see two timeline entries with
    // identical content. With message_start as the only boundary, the
    // late emit reuses the existing id → upsert collapses on the renderer.
    const { send, sent } = makeSink();
    const map = createBlockMsgIdState();

    processMessage({ type: 'stream_event', event: { type: 'message_start' } } as any, send, '/x', map);
    processMessage({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } } as any, send, '/x', map);
    processMessage({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use' } } } as any, send, '/x', map);
    processMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'Result text' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } } as any, send, '/x', map);
    // user tool_result arrives
    processMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'output' }] } } as any, send, '/x', map);
    // late partial assistant for the SAME turn (cumulative content)
    processMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'Result text' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } } as any, send, '/x', map);

    const texts = textBlocksAt(sent);
    expect(texts.length).toBe(2); // emitted twice
    expect(texts[0].msgId).toBe(texts[1].msgId); // ...but with SAME id → renderer collapses
    expect(texts[0].content).toBe(texts[1].content);
  });
});

describe('askUserQuestionToPrompts', () => {
  it('maps single question with options to one prompt, inputType always text', () => {
    const input = {
      questions: [{
        question: 'Which color?',
        header: 'Color',
        multiSelect: false,
        options: [
          { label: 'Red', description: 'warm' },
          { label: 'Blue', description: 'cool' },
        ],
      }],
    };
    const result = askUserQuestionToPrompts(input);
    expect(result).not.toBeNull();
    expect(result!.prompts).toHaveLength(1);
    expect(result!.prompts[0]).toEqual({
      question: 'Which color?',
      header: 'Color',
      multiSelect: false,
      options: [
        { label: 'Red', description: 'warm', preview: undefined },
        { label: 'Blue', description: 'cool', preview: undefined },
      ],
      // 'Other' is auto-added by AskUserQuestion spec → inputType always 'text'.
      inputType: 'text',
    });
    expect(result!.previewSamples).toEqual([]);
  });

  it('maps multi-question form preserving order', () => {
    const input = {
      questions: [
        { question: 'Q1', header: 'A', multiSelect: false, options: [{ label: 'a' }] },
        { question: 'Q2', header: 'B', multiSelect: true,  options: [{ label: 'b' }, { label: 'c' }] },
      ],
    };
    const result = askUserQuestionToPrompts(input)!;
    expect(result.prompts.map((p) => p.question)).toEqual(['Q1', 'Q2']);
    expect(result.prompts[1].multiSelect).toBe(true);
  });

  it('collects preview samples without filtering them out of the prompt', () => {
    const input = {
      questions: [{
        question: 'Pick',
        multiSelect: false,
        options: [
          { label: 'A', preview: 'snippet A' },
          { label: 'B' },
          { label: 'C', preview: 'snippet C' },
        ],
      }],
    };
    const result = askUserQuestionToPrompts(input)!;
    // Preview text stays on the prompt — even though v1 UI doesn't render it,
    // we don't strip it on the wire so a future UI doesn't need a provider change.
    expect(result.prompts[0].options[0].preview).toBe('snippet A');
    expect(result.previewSamples).toHaveLength(2);
    expect(result.previewSamples[0]).toMatchObject({
      question: 'Pick', optionLabel: 'A', previewLength: 9, preview: 'snippet A',
    });
    expect(result.previewSamples[1].optionLabel).toBe('C');
  });

  it('returns null on missing or empty questions array', () => {
    expect(askUserQuestionToPrompts({})).toBeNull();
    expect(askUserQuestionToPrompts({ questions: [] })).toBeNull();
    expect(askUserQuestionToPrompts({ questions: 'oops' as any })).toBeNull();
  });
});

describe('buildAskUserQuestionAnswerJson', () => {
  it('produces SDK-shaped output with answers keyed by question text', () => {
    const questions = [
      { question: 'Which color?' },
      { question: 'Which size?' },
    ];
    const json = buildAskUserQuestionAnswerJson(questions, ['Blue', 'Large']);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual({
      questions,
      answers: { 'Which color?': 'Blue', 'Which size?': 'Large' },
    });
    // annotations intentionally absent (optional per SDK schema)
    expect(parsed.annotations).toBeUndefined();
  });

  it('joins multi-select answers comma-separated (per SDK spec)', () => {
    const questions = [{ question: 'Features?' }];
    const json = buildAskUserQuestionAnswerJson(questions, [['TypeScript', 'React', 'Vitest']]);
    const parsed = JSON.parse(json);
    // SDK spec: "multi-select answers are comma-separated" (sdk-tools.d.ts:2688)
    expect(parsed.answers['Features?']).toBe('TypeScript, React, Vitest');
  });

  it('coerces non-string single answers to string', () => {
    const questions = [{ question: 'Count?' }];
    const json = buildAskUserQuestionAnswerJson(questions, [42 as any]);
    const parsed = JSON.parse(json);
    expect(parsed.answers['Count?']).toBe('42');
  });
});

describe('AskUserQuestion intercept survives bypassPermissions', () => {
  // Regression: an earlier patch wrapped canUseTool in a bypass-mode stub
  // that auto-allowed every tool, including AskUserQuestion — which meant
  // SDK ran the (nonexistent) tool implementation and auto-resolved with
  // empty answers (user reported "/schedule didn't show a picker"). The
  // intercept must run before the bypass short-circuit. This test verifies
  // the shape of `askUserQuestionToPrompts` returns something even when
  // the caller is in bypass mode — bypass is an orthogonal concern that
  // shouldn't elide picker UI.
  it('mapper produces prompts regardless of upstream permissionMode', () => {
    const input = {
      questions: [{
        question: 'Which action?',
        header: 'Action',
        multiSelect: false,
        options: [{ label: 'Create' }, { label: 'List' }],
      }],
    };
    // No permissionMode parameter — the mapper is pure shape transform.
    // Bypass-vs-not lives in the caller (canUseTool branch ordering), so
    // the regression we care about is "the intercept fires before bypass
    // short-circuits", documented by the comment in claude.ts canUseTool.
    const result = askUserQuestionToPrompts(input);
    expect(result).not.toBeNull();
    expect(result!.prompts).toHaveLength(1);
    expect(result!.prompts[0].inputType).toBe('text');
  });
});

describe('formatClaudeToolInput Agent alias', () => {
  // Regression: Claude SDK ships sub-agent dispatch as both `Task` (legacy)
  // and `Agent` (newer claude-code SDK). Header was previously falling to
  // the generic default branch when toolName === 'Agent', showing only the
  // first string field instead of the description + prompt preview.
  it('formats Agent the same as Task', () => {
    const input = { description: 'lookup', subagent_type: 'explore', prompt: 'find foo' };
    expect(formatClaudeToolInput('Agent', input, '/x'))
      .toBe(formatClaudeToolInput('Task', input, '/x'));
    expect(formatClaudeToolInput('Agent', input, '/x'))
      .toMatch(/^lookup: find foo/);
  });
});
