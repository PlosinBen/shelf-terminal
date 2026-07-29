import { describe, expect, it } from 'vitest';
import pkg from '../package.json';

describe('test:e2e script environment isolation', () => {
  it('unsets ELECTRON_RUN_AS_NODE for both build and Playwright', () => {
    const script = pkg.scripts['test:e2e'];
    const unsetPrefix = 'env -u ELECTRON_RUN_AS_NODE NODE_ENV=test';

    expect(script).toBe(
      `${unsetPrefix} npm run build && ${unsetPrefix} npx playwright test --project=e2e`,
    );
  });
});

describe('test:agent-deploy script', () => {
  it('passes spec args through to Playwright and preserves its exit code after cleanup', () => {
    const script = pkg.scripts['test:agent-deploy'];
    expect(script).toContain('npx playwright test --project=agent-deploy "$@"');
    expect(script).toContain('status=$?; docker rm -f shelf-agent-test shelf-agent-test-musl shelf-agent-test-copilot; exit $status');
  });
});

describe('packaged Codex runtime inventory', () => {
  it('ships the Codex CLI/native tree but not a duplicate app-server JS tree', () => {
    const build = pkg.build;
    expect(build.files).toContain('!node_modules/@openai/codex/**/*');
    expect(build.files).toContain('!node_modules/@openai/codex-*/**/*');

    const openaiResource = build.extraResources.find((r: any) => r.to === 'codex-cli/node_modules/@openai');
    expect(openaiResource).toBeTruthy();
    if (!openaiResource?.filter) throw new Error('missing @openai codex extraResource filter');
    expect(openaiResource.filter).toEqual([
      'codex/bin/**/*',
      'codex/package.json',
      'codex/LICENSE',
      'codex-*-*/vendor/**/*',
      'codex-*-*/package.json',
    ]);
    expect(openaiResource.filter.some((entry: string) => entry.includes('codex-sdk'))).toBe(false);
  });
});
