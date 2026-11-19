import { describe, it, expect, vi } from 'vitest';
import { readClaudeFileResult } from './file-result';
import { processMessage, createBlockMsgIdState } from './index';
import type { OutgoingMessage } from '../types';
import * as logger from '../../server-logger';

const path = '/repo/a.txt';
const patch = [{ oldStart: 4, oldLines: 1, newStart: 4, newLines: 1, lines: ['-old', '+actual'] }];
const output = { type: 'update', filePath: path, content: 'actual', structuredPatch: patch, originalFile: 'old' };

describe('Claude structured file results', () => {
  it('uses explicit create/update and actual output, including empty files and large overwrites', () => {
    expect(readClaudeFileResult({ ...output, type: 'create', content: '', structuredPatch: [], originalFile: null }, path, true))
      .toEqual({ label: 'Create file', content: '' });
    expect(readClaudeFileResult({ ...output, structuredPatch: [], originalFile: null }, path, true))
      .toEqual({ label: 'Edit file', content: 'actual' });
    expect(readClaudeFileResult(output, path, true)).toEqual({ label: 'Edit file', diff: { hunks: [
      { oldStart: 4, newStart: 4, oldLines: ['old'], newLines: ['actual'] },
    ] } });
  });
  it('preserves actual text when a patch is invalid and rejects mismatched paths/discriminators', () => {
    expect(readClaudeFileResult({ ...output, structuredPatch: [{ ...patch[0], oldLines: 9 }] }, path, true))
      .toMatchObject({ content: 'actual', anomaly: 'patch-count-mismatch' });
    expect(readClaudeFileResult(output, '/elsewhere', true)).toMatchObject({ anomaly: 'path-mismatch' });
    expect(readClaudeFileResult({ ...output, type: 'delete' }, path, true)).toMatchObject({ anomaly: 'invalid-write' });
    expect(readClaudeFileResult(undefined, path, true)).toBeUndefined();
  });
  it('uses Edit result strings rather than proposed input when the user modified the edit', () => {
    expect(readClaudeFileResult({ filePath: path, oldString: 'old', newString: 'actual', userModified: true, structuredPatch: [] }, path, false))
      .toEqual({ label: 'Edit file', diff: { oldString: 'old', newString: 'actual' } });
  });
  it.each(['success', 'error', 'missing', 'ambiguous', 'mismatch'])('handles %s result envelopes without misattribution', mode => {
    const log = vi.spyOn(logger, 'serverLog').mockImplementation(() => {});
    try {
      const out: OutgoingMessage[] = [];
      const send = (m: OutgoingMessage) => out.push(m);
      const state = createBlockMsgIdState();
      const id = `file-result-${mode}`;
      const calls = [{ type: 'tool_use', id, name: 'Write', input: { file_path: path, content: 'proposed' } }];
      if (mode === 'ambiguous') calls.push({ ...calls[0], id: `${id}-2` });
      processMessage({ type: 'assistant', parent_tool_use_id: 'parent', message: { content: calls } } as any, send, '/repo/', state);
      expect(out[0]).toMatchObject({ label: 'Write', subtitle: 'a.txt', parentToolUseId: 'parent' });
      processMessage({ type: 'user', tool_use_result: mode === 'missing' ? undefined : { ...output, filePath: mode === 'mismatch' ? '/other' : path },
        message: { content: calls.map(call => ({ type: 'tool_result', tool_use_id: call.id, content: 'result text', is_error: mode === 'error' })) },
      } as any, send, '/repo/', state);
      expect(out.at(-1)).toMatchObject({ msgId: mode === 'ambiguous' ? `${id}-2` : id, parentToolUseId: 'parent', subtitle: 'a.txt',
        label: mode === 'success' ? 'Edit file' : 'Write' });
      if (mode === 'success') expect(out.at(-1)).toMatchObject({ msgType: 'fold_diff', body: { diff: { hunks: expect.any(Array) } } });
      else expect(out.at(-1)).toMatchObject({ body: { content: 'proposed' } });
      if (mode === 'error') expect(out.at(-1)).toMatchObject({ errorMessage: 'result text' });
      if (mode === 'ambiguous' || mode === 'mismatch') expect(log).toHaveBeenCalledWith('warn', expect.any(String), expect.any(String), expect.any(Object));
    } finally { log.mockRestore(); }
  });
  it('retains Read ranges, outside paths, command text and output content', () => {
    const out: OutgoingMessage[] = [];
    const state = createBlockMsgIdState();
    const send = (m: OutgoingMessage) => out.push(m);
    processMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read-result', name: 'Read', input: { file_path: '/other/a.txt', offset: 2, limit: 3 } }] } } as any, send, '/repo', state);
    processMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-result', content: '/repo/content stays' }] } } as any, send, '/repo', state);
    expect(out.at(-1)).toMatchObject({ label: 'Read file', subtitle: '/other/a.txt (2..+3)', body: { content: '/repo/content stays' } });
  });
});
