import { afterAll, expect, it, vi } from 'vitest';

const isolated = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  return { home: fs.mkdtempSync(`${os.tmpdir()}/shelf-context-retention-`) };
});
vi.mock('os', async () => ({ ...await vi.importActual<object>('os'), homedir: () => isolated.home }));
import { rmSync } from 'node:fs';
import { cleanupOldContexts, loadContext, saveContext } from './context-store';

afterAll(() => rmSync(isolated.home, { recursive: true, force: true }));

it('does not expire resume pointers or other owners solely because they are old', () => {
  for (const sessionId of ['saved-view', 'other-project-view']) {
    saveContext({ sessionId, provider: 'claude', updatedAt: 1, lastSdkSessionId: `native-${sessionId}` });
  }
  cleanupOldContexts();
  for (const sessionId of ['saved-view', 'other-project-view']) {
    expect(loadContext(sessionId)?.lastSdkSessionId).toBe(`native-${sessionId}`);
  }
});
