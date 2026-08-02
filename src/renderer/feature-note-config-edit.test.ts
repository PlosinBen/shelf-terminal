import { describe, expect, it } from 'vitest';
import { featureNoteDirForProjectSave } from './feature-note-config-edit';
import type { ProjectConfig } from '@shared/types';

const main: ProjectConfig = {
  id: 'main',
  name: 'Main',
  cwd: '/repo',
  connection: { type: 'local' },
  maxTabs: 4,
};

describe('featureNoteDirForProjectSave', () => {
  it('normalizes a main project edit', () => {
    expect(featureNoteDirForProjectSave(main, ' .agent/features/// ')).toBe('.agent/features');
  });

  it('clears a main project binding when the input is blank', () => {
    expect(featureNoteDirForProjectSave({ ...main, featureNoteDir: '.agent/features' }, '  ')).toBeUndefined();
  });

  it('keeps a child snapshot regardless of submitted input', () => {
    const child = {
      ...main,
      id: 'child',
      parentProjectId: 'main',
      featureNoteDir: '.agent/features',
    };
    expect(featureNoteDirForProjectSave(child, 'notes/other')).toBe('.agent/features');
  });
});
