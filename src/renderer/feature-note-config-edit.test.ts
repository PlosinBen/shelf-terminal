import { describe, expect, it } from 'vitest';
import { featureNoteDirForProjectSave } from './feature-note-config-edit';

const main = { parentProjectId: null, featureNoteDir: null };

describe('featureNoteDirForProjectSave', () => {
  it('normalizes a main project edit', () => {
    expect(featureNoteDirForProjectSave(main, ' .agent/features/// ')).toBe('.agent/features');
  });

  it('clears a main project binding when the input is blank', () => {
    expect(featureNoteDirForProjectSave({ ...main, featureNoteDir: '.agent/features' }, '  ')).toBeNull();
  });

  it('keeps a child snapshot regardless of submitted input', () => {
    const child = {
      ...main,
      parentProjectId: 'main',
      featureNoteDir: '.agent/features',
    };
    expect(featureNoteDirForProjectSave(child, 'notes/other')).toBe('.agent/features');
  });
});
