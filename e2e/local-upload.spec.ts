import { test, expect } from './helpers';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Local connector upload E2E (runs everywhere — no container/host needed).
 * Regression for the Phase 2 refactor that collapsed `uploadFile` onto the
 * single `putFile` byte primitive + a separate non-clobber `.tmp/.gitignore`
 * guard. Asserts the file lands at `<cwd>/.tmp/shelf/<prefix>-<name>` and the
 * gitignore guard is created. Driven through the real IPC bridge
 * (window.shelfApi.connector.uploadFile), so it exercises the whole path.
 */

test('local: uploadFile lands the file under .tmp/shelf and writes a non-clobber .gitignore', async ({ shelfApp: { page } }) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-local-upload-'));
  try {
    const result = await page.evaluate(
      async (dir) => window.shelfApi.connector.uploadFile(
        { type: 'local' },
        dir,
        'paste.txt',
        new TextEncoder().encode('hello-local').buffer,
      ),
      cwd,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Path comes from the single-sourced .tmp/shelf placement.
    expect(result.remotePath).toMatch(new RegExp(`^${cwd}/\\.tmp/shelf/[a-z0-9]+-paste\\.txt$`));
    // Bytes landed through putFile.
    expect(fs.readFileSync(result.remotePath, 'utf8')).toBe('hello-local');
    // The gitignore guard created the hide-everything marker.
    const gitignore = path.join(cwd, '.tmp', '.gitignore');
    expect(fs.existsSync(gitignore)).toBe(true);
    expect(fs.readFileSync(gitignore, 'utf8')).toBe('*\n');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('local: a pre-existing .tmp/.gitignore is NOT clobbered', async ({ shelfApp: { page } }) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-local-upload-'));
  try {
    // Seed a customised gitignore the upload must preserve (non-clobber guard).
    fs.mkdirSync(path.join(cwd, '.tmp'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.tmp', '.gitignore'), 'custom\n');

    const result = await page.evaluate(
      async (dir) => window.shelfApi.connector.uploadFile(
        { type: 'local' },
        dir,
        'note.txt',
        new TextEncoder().encode('x').buffer,
      ),
      cwd,
    );
    expect(result.ok).toBe(true);
    // Guard only writes when absent — the user's content survives.
    expect(fs.readFileSync(path.join(cwd, '.tmp', '.gitignore'), 'utf8')).toBe('custom\n');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
