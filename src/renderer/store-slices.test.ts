import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@shared/types';
import {
  __getSnapshotForTests,
  __resetStoreForTests,
  setActiveProjectById,
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

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

  it('syncs PM project state only for project-slice changes', () => {
    vi.useFakeTimers();
    const syncState = vi.fn();
    vi.stubGlobal('window', {
      shelfApi: {
        pm: { syncState },
      },
    });

    setProjects([config('A')]);
    vi.advanceTimersByTime(200);
    syncState.mockClear();

    toggleRightSidebar('pm');
    vi.advanceTimersByTime(200);
    expect(syncState).not.toHaveBeenCalled();

    setActiveProjectById('A');
    vi.advanceTimersByTime(200);
    expect(syncState).toHaveBeenCalledTimes(1);
  });
});
