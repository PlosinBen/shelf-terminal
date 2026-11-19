import { expect, it } from 'vitest';
import { summarizeCompletionIdentity } from './completion-diagnostics';

it.each(['task_complete', 'Task complete', 'Task completion'])('records completion identity %s without payload values', title => {
  const result = summarizeCompletionIdentity({ title, toolCallId: 'id', status: 'completed', toolName: 'task_complete',
    _meta: { tool_name: 'task_complete', secret: 'private-token' }, rawInput: { summary: 'private-summary' },
    rawOutput: { content: 'private-result' }, content: [{ text: 'private-body' }],
  });
  expect(result).toMatchObject({ title, toolCallId: 'id', status: 'completed', identifiers: { toolName: 'task_complete' },
    metaIdentifiers: { tool_name: 'task_complete' }, rawInputFields: ['summary'], rawOutputFields: ['content'] });
  expect(JSON.stringify(result)).not.toContain('private-');
});

it('omits arbitrary titles and malformed identifier values while preserving field names', () => {
  const result = summarizeCompletionIdentity({ title: 'cat private-file', name: 'private command text', _meta: null });
  expect(result).toMatchObject({ title: undefined, titleLength: 16, identifiers: {}, fields: ['title', 'name', '_meta'] });
  expect(JSON.stringify(result)).not.toContain('private');
  expect(summarizeCompletionIdentity(null)).toMatchObject({ fields: [], identifiers: {} });
});
