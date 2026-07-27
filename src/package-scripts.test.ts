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
