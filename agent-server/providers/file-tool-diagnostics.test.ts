import { describe, it, expect } from 'vitest';
import { summarizeAcpFileTool, summarizeFileToolData } from './file-tool-diagnostics';

describe('file tool diagnostic evidence', () => {
  it('retains Write classification and result shape without logging content or extra fields', () => {
    const summary = summarizeFileToolData({ type: 'create', filePath: '/repo/file', content: 'private',
      originalFile: null, structuredPatch: [{ lines: ['private'] }], token: 'private' });
    expect(summary).toMatchObject({ operation: 'create', paths: { filePath: '/repo/file' },
      contentLength: 7, originalFileShape: 'null', patchCount: 1 });
    expect(JSON.stringify(summary)).not.toContain('private');
    expect(summarizeFileToolData('private')).toMatchObject({ shape: 'string' });
  });
  it('distinguishes missing, null and empty original text and retains all diff counts', () => {
    const summary = summarizeAcpFileTool({ sessionUpdate: 'tool_call_update', toolCallId: 'call', kind: 'edit',
      title: 'private', rawInput: { command: 'private', path: '/repo/file' }, rawOutput: 'private',
      locations: [{ path: '/repo/file', secret: 'private' }],
      content: [undefined, null, ''].map(oldText => ({ type: 'diff', path: '/repo/file', oldText, newText: 'private' })),
    });
    expect(summary.diffs.map(diff => diff.oldTextShape)).toEqual(['undefined', 'null', 'string']);
    expect(summary).toMatchObject({ toolCallId: 'call', diffCount: 3, locationCount: 1 });
    expect(JSON.stringify(summary)).not.toContain('private');
  });
});
