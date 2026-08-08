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

export * from './store-projects';
export * from './store-ui';

type StoreSnapshot = ProjectSliceSnapshot & UiSliceSnapshot;

let snapshotVersion = -1;
let snapshotRef: StoreSnapshot;

function getSnapshot(): StoreSnapshot {
  const version = getStoreVersion();
  if (snapshotVersion !== version) {
    snapshotVersion = version;
    snapshotRef = {
      ...getProjectSliceSnapshot(),
      ...getUiSliceSnapshot(),
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
}

export function __getSnapshotForTests() {
  return getSnapshot();
}
