import type { UpdateStatus } from '../shared/types';

/**
 * Pure state machine for the auto-updater. Decoupled from `electron-updater`
 * so it can be unit-tested without the real updater singleton.
 *
 * The wiring layer (`updater.ts`) translates `autoUpdater` events and renderer
 * IPC calls into `UpdaterEvent` values and feeds them through `reduceUpdaterStatus`.
 */
export type UpdaterEvent =
  | { type: 'available'; version: string }
  | { type: 'not-available' }
  | { type: 'download-progress'; percent: number; transferred: number; total: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error' }
  | { type: 'start-download' };

export function reduceUpdaterStatus(state: UpdateStatus, event: UpdaterEvent): UpdateStatus {
  switch (event.type) {
    case 'available':
      return { state: 'available', version: event.version };

    case 'not-available':
      // Don't override mid-flow: if a download is in progress or completed,
      // a stray "not available" event from a re-check should not throw it away.
      if (state.state === 'idle' || state.state === 'available') {
        return { state: 'idle' };
      }
      return state;

    case 'download-progress': {
      // Preserve the version we already know; fall back to 'unknown' only
      // if a progress event somehow arrived before we ever saw `available`.
      const version =
        state.state === 'downloading' || state.state === 'available' || state.state === 'downloaded'
          ? state.version
          : 'unknown';
      return {
        state: 'downloading',
        version,
        percent: event.percent,
        transferred: event.transferred,
        total: event.total,
      };
    }

    case 'downloaded':
      return { state: 'downloaded', version: event.version };

    case 'error':
      // If a download was in progress, revert so the user can retry.
      // Other states are unaffected (the wiring layer logs the error).
      if (state.state === 'downloading') {
        return { state: 'available', version: state.version };
      }
      return state;

    case 'start-download':
      // User-initiated; only valid from `available`.
      if (state.state === 'available') {
        return {
          state: 'downloading',
          version: state.version,
          percent: 0,
          transferred: 0,
          total: 0,
        };
      }
      return state;
  }
}
