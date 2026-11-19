import { it, expect } from 'vitest';
import { displayFilePath } from './display-path';

it.each([
  ['/repo/app/a', '/repo/app/', 'a'], ['/repo/app-other/a', '/repo/app', '/repo/app-other/a'],
  ['/repo/app/../other/a', '/repo/app', '/repo/app/../other/a'], ['a', '/repo/app', 'a'],
  ['/repo/app', '/repo/app', '.'], ['/a', '/', 'a'],
  ['C:\\repo\\app\\a', 'C:\\repo\\app\\', 'a'],
  ['D:\\other\\a', 'C:\\repo\\app', 'D:\\other\\a'],
  ['\\\\host\\share\\app\\a', '\\\\host\\share\\app', 'a'],
])('formats path %s against %s', (value, cwd, expected) => {
  expect(displayFilePath(value, cwd)).toBe(expected);
});
