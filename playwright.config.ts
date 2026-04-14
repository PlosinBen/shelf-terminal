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
      testIgnore: '**/connector/**',
    },
    {
      name: 'docker',
      testDir: './e2e/connector',
      testMatch: 'docker.spec.ts',
    },
    {
      name: 'ssh',
      testDir: './e2e/connector',
      testMatch: 'ssh.spec.ts',
    },
  ],
});
