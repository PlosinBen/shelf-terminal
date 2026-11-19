export const FAKE_TEST_ENV = {
  COPILOT_USAGE: 'SHELF_TEST_COPILOT_USAGE',
  NATIVE_APPROVAL: 'SHELF_TEST_NATIVE_APPROVAL',
  CAPS_FAIL: 'SHELF_TEST_CAPS_FAIL',
  CAPS_DELAY: 'SHELF_TEST_CAPS_DELAY',
  LOGIN_SUCCESS: 'SHELF_TEST_LOGIN_SUCCESS',
  POST_LOGIN_CAPS_FAIL: 'SHELF_TEST_POST_LOGIN_CAPS_FAIL',
  NATIVE_PERMISSIONS: 'SHELF_TEST_NATIVE_PERMISSIONS',
} as const;

export const FAKE_RETIRED_MODEL = 'fake-retired-model';

export const FAKE_FILE_CHANGES = {
  COPILOT: 'file_changes:copilot',
  CLAUDE: 'file_changes:claude',
  SUCCESS: 'file_changes:success',
  MIXED: 'file_changes:mixed',
  FAILED: 'file_changes:failed',
  DECLINED: 'file_changes:declined',
  LEGACY: 'file_changes:legacy',
} as const;
