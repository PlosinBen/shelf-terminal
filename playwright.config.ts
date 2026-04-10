import { defineConfig } from '@playwright/test';

export default defineConfig({
  timeout: 30_000,
  retries: 0,
  workers: 1,
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'e2e',
      testDir: './e2e',
    },
    {
      name: 'docker',
      testDir: './connector',
      testMatch: 'docker.spec.ts',
    },
    {
      name: 'ssh',
      testDir: './connector',
      testMatch: 'ssh.spec.ts',
    },
  ],
});
