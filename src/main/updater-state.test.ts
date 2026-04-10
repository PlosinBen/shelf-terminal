import { describe, it, expect } from 'vitest';
import { reduceUpdaterStatus, type UpdaterEvent } from './updater-state';
import type { UpdateStatus } from '../shared/types';

const idle: UpdateStatus = { state: 'idle' };
const available = (version = '0.3.0'): UpdateStatus => ({ state: 'available', version });
const downloading = (version = '0.3.0', percent = 42): UpdateStatus => ({
  state: 'downloading',
  version,
  percent,
  transferred: 1000,
  total: 5000,
});
const downloaded = (version = '0.3.0'): UpdateStatus => ({ state: 'downloaded', version });

describe('reduceUpdaterStatus', () => {
  describe('available event', () => {
    it('moves idle → available', () => {
      const next = reduceUpdaterStatus(idle, { type: 'available', version: '0.3.0' });
      expect(next).toEqual({ state: 'available', version: '0.3.0' });
    });

    it('replaces version when a newer one is announced', () => {
      const next = reduceUpdaterStatus(available('0.3.0'), { type: 'available', version: '0.3.1' });
      expect(next).toEqual({ state: 'available', version: '0.3.1' });
    });
  });

  describe('not-available event', () => {
    it('moves available → idle', () => {
      const next = reduceUpdaterStatus(available(), { type: 'not-available' });
      expect(next).toEqual({ state: 'idle' });
    });

    it('keeps idle as idle', () => {
      const next = reduceUpdaterStatus(idle, { type: 'not-available' });
      expect(next).toEqual({ state: 'idle' });
    });

    it('does NOT clobber an in-progress download', () => {
      const state = downloading();
      const next = reduceUpdaterStatus(state, { type: 'not-available' });
      expect(next).toBe(state);
    });

    it('does NOT clobber a completed download', () => {
      const state = downloaded();
      const next = reduceUpdaterStatus(state, { type: 'not-available' });
      expect(next).toBe(state);
    });
  });

  describe('start-download event', () => {
    it('moves available → downloading with zeroed progress', () => {
      const next = reduceUpdaterStatus(available('0.3.0'), { type: 'start-download' });
      expect(next).toEqual({
        state: 'downloading',
        version: '0.3.0',
        percent: 0,
        transferred: 0,
        total: 0,
      });
    });

    it('is a no-op from idle', () => {
      const next = reduceUpdaterStatus(idle, { type: 'start-download' });
      expect(next).toBe(idle);
    });

    it('is a no-op from downloading (does not reset progress)', () => {
      const state = downloading('0.3.0', 42);
      const next = reduceUpdaterStatus(state, { type: 'start-download' });
      expect(next).toBe(state);
    });

    it('is a no-op from downloaded', () => {
      const state = downloaded();
      const next = reduceUpdaterStatus(state, { type: 'start-download' });
      expect(next).toBe(state);
    });
  });

  describe('download-progress event', () => {
    it('moves available → downloading and preserves the version', () => {
      const next = reduceUpdaterStatus(available('0.3.0'), {
        type: 'download-progress',
        percent: 10,
        transferred: 100,
        total: 1000,
      });
      expect(next).toEqual({
        state: 'downloading',
        version: '0.3.0',
        percent: 10,
        transferred: 100,
        total: 1000,
      });
    });

    it('updates progress fields while in downloading', () => {
      const next = reduceUpdaterStatus(downloading('0.3.0', 10), {
        type: 'download-progress',
        percent: 75,
        transferred: 3750,
        total: 5000,
      });
      expect(next).toEqual({
        state: 'downloading',
        version: '0.3.0',
        percent: 75,
        transferred: 3750,
        total: 5000,
      });
    });

    it('falls back to "unknown" version if progress arrives from idle', () => {
      // Should not happen in practice, but the reducer must not crash.
      const next = reduceUpdaterStatus(idle, {
        type: 'download-progress',
        percent: 5,
        transferred: 50,
        total: 1000,
      });
      expect(next).toEqual({
        state: 'downloading',
        version: 'unknown',
        percent: 5,
        transferred: 50,
        total: 1000,
      });
    });
  });

  describe('downloaded event', () => {
    it('moves downloading → downloaded', () => {
      const next = reduceUpdaterStatus(downloading('0.3.0'), {
        type: 'downloaded',
        version: '0.3.0',
      });
      expect(next).toEqual({ state: 'downloaded', version: '0.3.0' });
    });

    it('uses the version carried by the event (in case it changed mid-flow)', () => {
      const next = reduceUpdaterStatus(downloading('0.3.0'), {
        type: 'downloaded',
        version: '0.3.1',
      });
      expect(next).toEqual({ state: 'downloaded', version: '0.3.1' });
    });
  });

  describe('error event', () => {
    it('reverts downloading → available so user can retry', () => {
      const next = reduceUpdaterStatus(downloading('0.3.0', 42), { type: 'error' });
      expect(next).toEqual({ state: 'available', version: '0.3.0' });
    });

    it('does not change idle', () => {
      const next = reduceUpdaterStatus(idle, { type: 'error' });
      expect(next).toBe(idle);
    });

    it('does not change available', () => {
      const state = available();
      const next = reduceUpdaterStatus(state, { type: 'error' });
      expect(next).toBe(state);
    });

    it('does not change downloaded (install-time errors should not lose the binary)', () => {
      const state = downloaded();
      const next = reduceUpdaterStatus(state, { type: 'error' });
      expect(next).toBe(state);
    });
  });

  describe('full happy path', () => {
    it('idle → available → downloading → progress → downloaded', () => {
      const events: UpdaterEvent[] = [
        { type: 'available', version: '0.3.0' },
        { type: 'start-download' },
        { type: 'download-progress', percent: 25, transferred: 1250, total: 5000 },
        { type: 'download-progress', percent: 75, transferred: 3750, total: 5000 },
        { type: 'downloaded', version: '0.3.0' },
      ];
      const final = events.reduce<UpdateStatus>(reduceUpdaterStatus, idle);
      expect(final).toEqual({ state: 'downloaded', version: '0.3.0' });
    });

    it('download fails halfway → user retries → succeeds', () => {
      const events: UpdaterEvent[] = [
        { type: 'available', version: '0.3.0' },
        { type: 'start-download' },
        { type: 'download-progress', percent: 30, transferred: 1500, total: 5000 },
        { type: 'error' }, // network drop
        { type: 'start-download' }, // user retries
        { type: 'download-progress', percent: 50, transferred: 2500, total: 5000 },
        { type: 'downloaded', version: '0.3.0' },
      ];
      const final = events.reduce<UpdateStatus>(reduceUpdaterStatus, idle);
      expect(final).toEqual({ state: 'downloaded', version: '0.3.0' });
    });
  });
});
