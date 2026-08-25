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

export * from './store-projects';
export * from './store-ui';
export * from './store-external-url-intent';

type StoreSnapshot = ProjectSliceSnapshot & UiSliceSnapshot & ExternalUrlIntentSliceSnapshot;

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
}

export function __getSnapshotForTests() {
  return getSnapshot();
}
