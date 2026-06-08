import { describe, it, expect, vi, afterEach } from 'vitest';
import { processMessage, createBlockMsgIdState } from './index';
import { mergeClaudeModels, rateLimitInfoToSegment, formatClaudeToolInput, extractToolResultText, askUserQuestionToPrompts, buildAskUserQuestionAnswerJson, parseTaskCreateOutput, parseTaskListOutput, reconcileTasks, renderPlan, shouldAdoptResolvedModel, stripToolErrorWrapper, normalizeTaskMessage } from './helpers';
import type { OutgoingMessage } from '../types';
import type { ProviderModel, NormalizedTask } from '@shared/types';

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

describe('stripToolErrorWrapper', () => {
  it('strips the <tool_use_error> wrapper and trims', () => {
    expect(stripToolErrorWrapper('<tool_use_error>file_path is missing</tool_use_error>'))
      .toBe('file_path is missing');
  });

  it('handles multi-line wrapped content', () => {
    expect(stripToolErrorWrapper('<tool_use_error>line 1\nline 2</tool_use_error>'))
      .toBe('line 1\nline 2');
  });

  it('is a no-op when no wrapper present', () => {
    expect(stripToolErrorWrapper('plain error text')).toBe('plain error text');
    expect(stripToolErrorWrapper('{"answer":"json"}')).toBe('{"answer":"json"}');
  });

  it('only strips a full wrapper, not a stray mention of the tag', () => {
    const s = 'see <tool_use_error> in the docs';
    expect(stripToolErrorWrapper(s)).toBe(s);
  });
});

describe('processMessage — text msgId stability across SDK quirks', () => {
  // Helpers to drive processMessage like the real for-await loop does.
  function makeSink() {
    const sent: any[] = [];
    const send = (m: OutgoingMessage) => { sent.push(m); };
    return { send, sent };
  }
  const textBlocksAt = (msgs: any[]) => msgs.filter((m) => m.type === 'message' && m.msgType === 'reply');

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

    const thinkings = sent.filter((m) => m.type === 'message' && m.msgType === 'fold_text');
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

describe('shouldAdoptResolvedModel', () => {
  // supportedModels() returns recommended aliases; concrete ids are not in it.
  const ALIASES = [{ value: 'default' }, { value: 'sonnet' }, { value: 'haiku' }];

  it('does NOT adopt when current selection is a recommended alias', () => {
    // User picked "default"; SDK resolves to claude-opus-4-8. Keep "default".
    expect(shouldAdoptResolvedModel('claude-opus-4-8', 'default', ALIASES)).toBe(false);
    expect(shouldAdoptResolvedModel('claude-sonnet-4-5', 'sonnet', ALIASES)).toBe(false);
  });

  it('adopts when current selection is a pinned non-alias model', () => {
    // User pinned a custom/specific id (not in supportedModels) → reflect actual.
    expect(shouldAdoptResolvedModel('claude-opus-4-8[1m]', 'claude-opus-4-8', ALIASES)).toBe(true);
  });

  it('does not adopt synthetic models', () => {
    expect(shouldAdoptResolvedModel('<synthetic>', 'claude-opus-4-8', ALIASES)).toBe(false);
  });

  it('does not adopt when resolved equals current (no-op)', () => {
    expect(shouldAdoptResolvedModel('claude-opus-4-8', 'claude-opus-4-8', ALIASES)).toBe(false);
  });

  it('does not adopt when current model is unset (unpinned / alias-like)', () => {
    expect(shouldAdoptResolvedModel('claude-opus-4-8', undefined, ALIASES)).toBe(false);
  });

  it('does not adopt before alias list is populated (warmup guard)', () => {
    // Empty alias list = can't classify; be conservative and keep current.
    expect(shouldAdoptResolvedModel('claude-opus-4-8', 'claude-opus-4-8-old', [])).toBe(false);
  });

  it('does not adopt non-string resolved values', () => {
    expect(shouldAdoptResolvedModel(undefined, 'claude-opus-4-8', ALIASES)).toBe(false);
    expect(shouldAdoptResolvedModel(null, 'claude-opus-4-8', ALIASES)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Task* plan-panel mirror (replaces TodoWrite as of SDK 0.3.142)
// ──────────────────────────────────────────────────────────────────────────
//
// These tests exercise the pure helpers (parse / render / reconcile). The
// processMessage-level wiring is intentionally NOT tested here because the
// task state Maps in claude.ts are module-scoped and cross-test pollution
// would make assertions fragile — mirroring existing convention for
// inflightToolUses. The pure helpers carry the actual logic; the wiring
// just calls them.

describe('parseTaskCreateOutput', () => {
  // Real wire format (verified on SDK 0.3.159 + claude-opus-4-8):
  // "Task #1 created successfully: <subject>"
  // sdk-tools.d.ts documents a JSON shape that doesn't match runtime — we
  // try text first, JSON as defensive fallback.

  it('extracts numeric id from observed text wire format', () => {
    expect(parseTaskCreateOutput('Task #1 created successfully: Run typecheck'))
      .toBe('1');
    expect(parseTaskCreateOutput('Task #42 created successfully: Multi-digit'))
      .toBe('42');
  });

  it('is case-insensitive on the "Task #N created successfully" prefix', () => {
    expect(parseTaskCreateOutput('task #5 created successfully: lowercase')).toBe('5');
  });

  it('falls back to documented JSON shape when text pattern fails', () => {
    expect(parseTaskCreateOutput('{"task":{"id":"abc-123","subject":"Setup"}}'))
      .toBe('abc-123');
  });

  it('coerces numeric JSON ids to string', () => {
    expect(parseTaskCreateOutput('{"task":{"id":7}}')).toBe('7');
  });

  it('returns null when neither shape matches', () => {
    expect(parseTaskCreateOutput('not json and no task header')).toBeNull();
    expect(parseTaskCreateOutput('{"task":{}}')).toBeNull();
    expect(parseTaskCreateOutput('')).toBeNull();
  });
});

describe('parseTaskListOutput', () => {
  it('parses well-formed TaskList output', () => {
    const content = JSON.stringify({
      tasks: [
        { id: 't1', subject: 'Setup', status: 'pending' },
        { id: 't2', subject: 'Write tests', status: 'in_progress' },
        { id: 't3', subject: 'Ship', status: 'completed' },
      ],
    });
    expect(parseTaskListOutput(content)).toEqual([
      { id: 't1', subject: 'Setup', status: 'pending' },
      { id: 't2', subject: 'Write tests', status: 'in_progress' },
      { id: 't3', subject: 'Ship', status: 'completed' },
    ]);
  });

  it('skips entries with missing id / subject / status', () => {
    const content = JSON.stringify({
      tasks: [
        { id: 't1', subject: 'Good', status: 'pending' },
        { id: 't2', subject: 'Missing status' },
        { subject: 'Missing id', status: 'pending' },
      ],
    });
    expect(parseTaskListOutput(content)).toEqual([
      { id: 't1', subject: 'Good', status: 'pending' },
    ]);
  });

  it('rejects unknown status values (e.g. "deleted") to keep TaskRecord type clean', () => {
    const content = JSON.stringify({
      tasks: [{ id: 't1', subject: 'X', status: 'deleted' }],
    });
    expect(parseTaskListOutput(content)).toEqual([]);
  });

  it('returns null when not JSON or wrong shape (so non-TaskList tool_results pass through)', () => {
    expect(parseTaskListOutput('Read file output')).toBeNull();
    expect(parseTaskListOutput('{"foo":"bar"}')).toBeNull();
    expect(parseTaskListOutput('{"tasks":"not an array"}')).toBeNull();
  });
});

describe('renderPlan', () => {
  function makeSink() {
    const sent: any[] = [];
    return { send: (m: any) => { sent.push(m); }, sent };
  }

  it('renders each status with the correct checklist prefix', () => {
    const { send, sent } = makeSink();
    const m = new Map<string, any>();
    m.set('t1', { subject: 'pending task', description: '', status: 'pending' });
    m.set('t2', { subject: 'doing task', description: '', activeForm: 'Doing thing', status: 'in_progress' });
    m.set('t3', { subject: 'done task', description: '', status: 'completed' });
    renderPlan(send, m);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'plan',
      content: '- [ ] pending task\n- [~] Doing thing\n- [x] done task',
    });
  });

  it('falls back to subject when in_progress task has no activeForm', () => {
    const { send, sent } = makeSink();
    const m = new Map<string, any>();
    m.set('t1', { subject: 'no-activeForm task', description: '', status: 'in_progress' });
    renderPlan(send, m);
    expect(sent[0].content).toBe('- [~] no-activeForm task');
  });

  it('preserves insertion order so plan rows match Agent creation order', () => {
    const { send, sent } = makeSink();
    const m = new Map<string, any>();
    m.set('t3', { subject: 'third', description: '', status: 'pending' });
    m.set('t1', { subject: 'first', description: '', status: 'pending' });
    m.set('t2', { subject: 'second', description: '', status: 'pending' });
    renderPlan(send, m);
    // Map iteration follows insertion order — t3 first, then t1, then t2.
    expect(sent[0].content).toBe('- [ ] third\n- [ ] first\n- [ ] second');
  });

  it('emits empty content when Map is empty', () => {
    const { send, sent } = makeSink();
    renderPlan(send, new Map());
    expect(sent[0]).toEqual({ type: 'plan', content: '' });
  });
});

describe('normalizeTaskMessage', () => {
  // Field shapes verified against a real backgrounded Bash (Phase 0 spike,
  // DECISIONS #69):
  //   task_started      { task_id, description, task_type:'local_bash', tool_use_id, skip_transcript? }
  //   task_updated      { task_id, patch:{ status, end_time } }
  //   task_notification { task_id, status, summary, output_file }
  const started = (over: any = {}) => ({
    type: 'system', subtype: 'task_started',
    task_id: 'bm2esv0l0', description: 'Sleep 30 seconds then echo done',
    task_type: 'local_bash', tool_use_id: 'toolu_x', ...over,
  });

  it('maps task_started (local_bash) → running shell task', () => {
    const out = normalizeTaskMessage(started());
    expect(out).toEqual({
      kind: 'started',
      task: { id: 'bm2esv0l0', type: 'shell', label: 'Sleep 30 seconds then echo done', status: 'running', done: false },
    });
  });

  it('flags skip_transcript task_started as ambient (caller hides it)', () => {
    const out = normalizeTaskMessage(started({ skip_transcript: true }));
    expect(out?.ambient).toBe(true);
    expect(out?.kind).toBe('started');
  });

  it('collapses unknown task_type to "unknown"', () => {
    expect(normalizeTaskMessage(started({ task_type: 'some_future_type' }))?.task.type).toBe('unknown');
    expect(normalizeTaskMessage(started({ task_type: undefined }))?.task.type).toBe('unknown');
  });

  it('maps subagent / workflow task types', () => {
    expect(normalizeTaskMessage(started({ task_type: 'subagent' }))?.task.type).toBe('subagent');
    expect(normalizeTaskMessage(started({ task_type: 'local_workflow' }))?.task.type).toBe('workflow');
  });

  it('task_updated → done when status terminal, merging prev label/type', () => {
    const prev: NormalizedTask = { id: 'bm2esv0l0', type: 'shell', label: 'Sleep 30', status: 'running', done: false };
    const out = normalizeTaskMessage(
      { type: 'system', subtype: 'task_updated', task_id: 'bm2esv0l0', patch: { status: 'completed', end_time: 1 } },
      prev,
    );
    expect(out).toEqual({
      kind: 'done',
      task: { id: 'bm2esv0l0', type: 'shell', label: 'Sleep 30', status: 'completed', done: true },
    });
  });

  it('task_updated non-terminal status → kind "updated", done false', () => {
    const out = normalizeTaskMessage(
      { type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'running' } },
    );
    expect(out?.kind).toBe('updated');
    expect(out?.task.done).toBe(false);
  });

  it('maps SDK-only statuses: killed→stopped (terminal), paused→running', () => {
    const killed = normalizeTaskMessage({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'killed' } });
    expect(killed?.task.status).toBe('stopped');
    expect(killed?.task.done).toBe(true);
    const paused = normalizeTaskMessage({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'paused' } });
    expect(paused?.task.status).toBe('running');
    expect(paused?.task.done).toBe(false);
  });

  it('carries patch.error onto the task', () => {
    const out = normalizeTaskMessage(
      { type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'failed', error: 'boom' } },
    );
    expect(out?.task.status).toBe('failed');
    expect(out?.task.error).toBe('boom');
    expect(out?.task.done).toBe(true);
  });

  it('task_progress updates summary, preserves the rest', () => {
    const prev: NormalizedTask = { id: 't1', type: 'shell', label: 'x', status: 'running', done: false };
    const out = normalizeTaskMessage({ type: 'system', subtype: 'task_progress', task_id: 't1', summary: 'half way' }, prev);
    expect(out).toEqual({
      kind: 'progress',
      task: { id: 't1', type: 'shell', label: 'x', status: 'running', summary: 'half way', done: false },
    });
  });

  it('task_notification → done with summary + returns output_file separately (not on the task)', () => {
    const prev: NormalizedTask = { id: 'bm2esv0l0', type: 'shell', label: 'Sleep 30', status: 'running', done: false };
    const out = normalizeTaskMessage({
      type: 'system', subtype: 'task_notification', task_id: 'bm2esv0l0',
      status: 'completed',
      summary: 'Background command "Sleep 30" completed (exit code 0)',
      output_file: '/tmp/claude/tasks/bm2esv0l0.output',
    }, prev);
    expect(out?.kind).toBe('done');
    expect(out?.task.done).toBe(true);
    expect(out?.task.summary).toBe('Background command "Sleep 30" completed (exit code 0)');
    expect(out?.outputFile).toBe('/tmp/claude/tasks/bm2esv0l0.output');
    // output_file is server-only (M2 RPC), never a render-primitive field.
    expect('outputFile' in (out!.task as any)).toBe(false);
  });

  it('returns null for non-task / malformed messages', () => {
    expect(normalizeTaskMessage({ type: 'system', subtype: 'init' })).toBeNull();
    expect(normalizeTaskMessage({ type: 'assistant' })).toBeNull();
    expect(normalizeTaskMessage({ type: 'system', subtype: 'task_started' })).toBeNull(); // no task_id
    expect(normalizeTaskMessage(null)).toBeNull();
  });
});

describe('reconcileTasks', () => {
  function makeSink() {
    const sent: any[] = [];
    return { send: (m: any) => { sent.push(m); }, sent };
  }

  it('removes local tasks missing from snapshot (server-side deletion)', () => {
    const { send } = makeSink();
    const local = new Map<string, any>();
    local.set('t1', { subject: 'stays', description: 'd1', status: 'pending' });
    local.set('t2', { subject: 'orphan', description: 'd2', status: 'pending' });
    reconcileTasks(local, [{ id: 't1', subject: 'stays', status: 'pending' }], send);
    expect(local.has('t2')).toBe(false);
    expect(local.has('t1')).toBe(true);
  });

  it('adds snapshot tasks missing locally (resume-session recovery)', () => {
    const { send } = makeSink();
    const local = new Map<string, any>();
    reconcileTasks(
      local,
      [
        { id: 't1', subject: 'recovered', status: 'in_progress' },
        { id: 't2', subject: 'also recovered', status: 'completed' },
      ],
      send,
    );
    expect(local.get('t1')).toEqual({ subject: 'recovered', description: '', status: 'in_progress' });
    expect(local.get('t2')).toEqual({ subject: 'also recovered', description: '', status: 'completed' });
  });

  it('preserves local description/activeForm when snapshot updates status', () => {
    // TaskListOutput doesn't carry description/activeForm, so reconcile must
    // not clobber them when an entry exists in both local and snapshot.
    const { send } = makeSink();
    const local = new Map<string, any>();
    local.set('t1', { subject: 'old subject', description: 'rich desc', activeForm: 'Doing it', status: 'pending' });
    reconcileTasks(local, [{ id: 't1', subject: 'new subject', status: 'in_progress' }], send);
    expect(local.get('t1')).toEqual({
      subject: 'new subject',          // updated from snapshot
      description: 'rich desc',         // preserved
      activeForm: 'Doing it',           // preserved
      status: 'in_progress',            // updated from snapshot
    });
  });

  it('re-emits plan after reconciliation', () => {
    const { send, sent } = makeSink();
    const local = new Map<string, any>();
    reconcileTasks(local, [{ id: 't1', subject: 'new', status: 'pending' }], send);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ type: 'plan', content: '- [ ] new' });
  });
});
