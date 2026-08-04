import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { openAgentTab } from '../helpers';
import { makeShelfAppFixture, expect } from './agent-deploy-helpers';

const CONTAINER = 'shelf-agent-test';
const test = makeShelfAppFixture(CONTAINER);
test.setTimeout(180_000);

function memoryRecords(userDataDir: string): any[] {
  const dir = path.join(userDataDir, 'logs', 'mem');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => /^\d{8}\.log$/.test(name))
    .flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').split('\n'))
    .filter(Boolean)
    .flatMap((line) => {
      const start = line.indexOf('{');
      if (start < 0) return [];
      try { return [JSON.parse(line.slice(start))]; } catch { return []; }
    });
}

test('docker: deployed dispatcher and exec independently report Linux memory', async ({
  shelfApp: { page, userDataDir },
}) => {
  // The deploy sentinel is persistent across runs; force this spec to exercise the
  // bundle built by the current checkout instead of a prior container artifact.
  execSync(`docker exec ${CONTAINER} rm -rf /root/.shelf`, { stdio: 'pipe' });

  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 5_000 }).catch(() => false)) await prompt.click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 10_000 });
  await openAgentTab(page);

  await expect.poll(() => {
    const records = memoryRecords(userDataDir).filter((record) => record.accepted === true);
    return {
      dispatcher: records.some((record) =>
        record.source?.kind === 'dispatcher'
        && record.report?.status === 'ok'
        && record.report.rows?.length === 1
        && record.report.rows[0]?.role === 'dispatcher'),
      exec: records.some((record) =>
        record.source?.kind === 'exec'
        && record.report?.status === 'ok'
        && record.report.rows?.some((row: any) => row.role === 'exec')),
    };
  }, { timeout: 150_000 }).toEqual({ dispatcher: true, exec: true });
});
