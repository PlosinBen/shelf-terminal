import { useSyncExternalStore } from 'react';
import { getStoreVersion, subscribeStore } from './store-core';
import {
  getProjectSliceSnapshot,
  resetProjectStoreForTests,
  type ProjectSliceSnapshot,
} from './store-projects';
import {
  getUiSliceSnapshot,
  resetUiStoreForTests,
  type UiSliceSnapshot,
} from './store-ui';
import {
  getExternalUrlIntentSliceSnapshot,
  resetExternalUrlIntentStoreForTests,
  type ExternalUrlIntentSliceSnapshot,
} from './store-external-url-intent';
import {
  getTerminalLifecycleSliceSnapshot,
  resetTerminalLifecycleStoreForTests,
  type TerminalLifecycleSliceSnapshot,
} from './store-terminal-lifecycle';

export * from './store-projects';
export * from './store-ui';
export * from './store-external-url-intent';
export * from './store-terminal-lifecycle';

type StoreSnapshot = ProjectSliceSnapshot & UiSliceSnapshot & ExternalUrlIntentSliceSnapshot
  & TerminalLifecycleSliceSnapshot;

let snapshotVersion = -1;
let snapshotRef: StoreSnapshot;

function getSnapshot(): StoreSnapshot {
  const version = getStoreVersion();
  if (snapshotVersion !== version) {
    snapshotVersion = version;
    snapshotRef = {
      ...getProjectSliceSnapshot(),
      ...getUiSliceSnapshot(),
      ...getExternalUrlIntentSliceSnapshot(),
      ...getTerminalLifecycleSliceSnapshot(),
    };
  }
  return snapshotRef;
}

export function useStore() {
  return useSyncExternalStore(subscribeStore, getSnapshot);
}

export function __resetStoreForTests() {
  resetProjectStoreForTests();
  resetUiStoreForTests();
  resetExternalUrlIntentStoreForTests();
  resetTerminalLifecycleStoreForTests();
}

export function __getSnapshotForTests() {
  return getSnapshot();
}
