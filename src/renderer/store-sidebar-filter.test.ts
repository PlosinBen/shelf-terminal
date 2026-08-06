import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectConfig } from '@shared/types';
import {
  __getSnapshotForTests,
  __resetStoreForTests,
  getActiveProjectId,
  setProjects,
  toggleHideDisconnected,
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

describe('sidebar connected filter state', () => {
  beforeEach(() => {
    __resetStoreForTests();
    setProjects([config('A'), config('B')]);
  });

  it('defaults off and toggles through the named store action', () => {
    expect(__getSnapshotForTests().hideDisconnected).toBe(false);

    toggleHideDisconnected();
    expect(__getSnapshotForTests().hideDisconnected).toBe(true);

    toggleHideDisconnected();
    expect(__getSnapshotForTests().hideDisconnected).toBe(false);
  });

  it('does not change the active project when toggled', () => {
    const activeProjectId = getActiveProjectId();
    toggleHideDisconnected();
    expect(getActiveProjectId()).toBe(activeProjectId);
  });

  it('resets the transient state for isolated tests', () => {
    toggleHideDisconnected();
    __resetStoreForTests();
    expect(__getSnapshotForTests().hideDisconnected).toBe(false);
  });
});
