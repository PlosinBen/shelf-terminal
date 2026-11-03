import { describe, expect, it } from 'vitest';
import { projectFieldEdits, sameProjectValue, type ProjectEditValues } from './project-mutations';

const original: ProjectEditValues = {
  name: 'Project', initScript: null, defaultTabs: [{ name: 'Terminal' }],
  quickCommands: [], envPlain: { A: 'a', B: 'b' }, featureNoteDir: null,
};

describe('project editor changed fields', () => {
  it('ignores record ordering and absent optional properties', () => {
    expect(projectFieldEdits(original, {
      ...original, envPlain: { B: 'b', A: 'a' }, defaultTabs: [{ name: 'Terminal', cmd: undefined }],
    })).toEqual([]);
  });
  it('submits only the modified fields with their original values', () => {
    expect(projectFieldEdits(original, { ...original, name: 'Draft' })).toEqual([
      { field: 'name', before: 'Project', value: 'Draft' },
    ]);
  });
  it('compares nested values and ordered arrays without conflating null and absent', () => {
    expect(sameProjectValue([{ name: 'A' }, { name: 'B' }], [{ name: 'B' }, { name: 'A' }])).toBe(false);
    expect(sameProjectValue({ value: null }, {})).toBe(false);
    expect(sameProjectValue([undefined], [])).toBe(false);
    expect(sameProjectValue({ A: 'a' }, { A: 'other' })).toBe(false);
  });
});
