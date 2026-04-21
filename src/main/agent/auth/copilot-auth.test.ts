import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

function hasCopilotAuth(): boolean {
  try {
    return fs.existsSync(path.join(os.homedir(), '.config', 'github-copilot', 'apps.json'))
      || fs.existsSync(path.join(os.homedir(), '.config', 'github-copilot', 'hosts.json'));
  } catch {
    return false;
  }
}

// Integration-only: exchange GitHub token for a Copilot session token. Skipped
// on machines without local Copilot credentials (CI, fresh checkouts).
describe.skipIf(!hasCopilotAuth())('copilot-auth (integration)', () => {
  it('isAuthenticated is true when credentials are present', async () => {
    const { isAuthenticated } = await import('./copilot-auth');
    expect(await isAuthenticated()).toBe(true);
  }, 10_000);

  it('getCopilotSessionToken returns a live session shape', async () => {
    const { getCopilotSessionToken } = await import('./copilot-auth');
    const session = await getCopilotSessionToken();
    expect(session.token.length).toBeGreaterThan(0);
    expect(typeof session.expiresAt).toBe('number');
    expect(session.expiresAt * 1000).toBeGreaterThan(Date.now());
    expect(session.apiEndpoint).toMatch(/^https:\/\//);
  }, 10_000);
});
