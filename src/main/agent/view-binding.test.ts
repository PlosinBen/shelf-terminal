import { expect, it } from 'vitest';
import { validateViewBinding } from './view-binding';
import type { Project } from '@shared/projects';

const project = { id: 'p', agentViews: { a: { provider: 'claude', prefs: { model: 'a' } }, b: { provider: 'claude', prefs: {} } } } as unknown as Project;
it('allows distinct same-provider Views and rejects mismatched ownership and duplicate mounts', () => {
  const live = [{ tabId: 't-a', projectId: 'p', provider: 'claude', sessionId: 'a' }];
  expect(validateViewBinding(project, 'b', 'claude', 't-b', live).prefs).toEqual({});
  expect(validateViewBinding(project, 'a', 'claude', 't-a', live).prefs).toEqual({ model: 'a' });
  expect(() => validateViewBinding(project, 'a', 'claude', 't-b', live)).toThrow('already mounted');
  expect(() => validateViewBinding(project, 'b', 'claude', 't-a', live)).toThrow('binding changed');
  expect(() => validateViewBinding(project, 'a', 'codex', 't-b', [])).toThrow('mismatch');
  expect(() => validateViewBinding(project, 'missing', 'claude', 't-b', [])).toThrow('Unknown');
  expect(() => validateViewBinding(null, 'a', 'claude', 't-b', [])).toThrow('Unknown');
});
