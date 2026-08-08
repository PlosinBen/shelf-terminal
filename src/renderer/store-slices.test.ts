import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectConfig } from '@shared/types';
import {
  __getSnapshotForTests,
  __resetStoreForTests,
  setProjects,
  toggleRightSidebar,
} from './store';

function config(id: string): ProjectConfig {
  return {
    id,
    name: id,
    cwd: `/repo/${id}`,
    connection: { type: 'local' },
    maxTabs: 5,
  };
}

describe('store facade slice behavior', () => {
  beforeEach(() => {
    __resetStoreForTests();
    setProjects([config('A')]);
  });

  it('publishes a new facade snapshot without rebuilding projects for UI-only changes', () => {
    const before = __getSnapshotForTests();

    toggleRightSidebar('pm');

    const after = __getSnapshotForTests();
    expect(after).not.toBe(before);
    expect(after.projects).toBe(before.projects);
    expect(after.pmVisible).toBe(true);
  });

  it('keeps right-sidebar features independent', () => {
    toggleRightSidebar('pm');
    toggleRightSidebar('notes');

    expect(__getSnapshotForTests()).toMatchObject({
      pmVisible: true,
      notesVisible: true,
      skillsVisible: false,
      mcpVisible: false,
      backupVisible: false,
      devToolsVisible: false,
    });

    toggleRightSidebar('pm');

    expect(__getSnapshotForTests()).toMatchObject({
      pmVisible: false,
      notesVisible: true,
    });
  });
});
