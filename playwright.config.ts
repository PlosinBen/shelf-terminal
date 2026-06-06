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
    {
      name: 'agent-deploy',
      testDir: './e2e/connector',
      testMatch: 'agent-deploy*.spec.ts',
      // WSL has its own project (Windows-host-only); keep it out of the
      // docker-backed agent-deploy run so non-Windows CI stays green.
      testIgnore: 'agent-deploy-wsl.spec.ts',
    },
    {
      // Windows-host-only: targets a pre-installed WSL distro via wsl.exe (no
      // container to start). Run standalone: npm run test:agent-deploy-wsl
      name: 'agent-deploy-wsl',
      testDir: './e2e/connector',
      testMatch: 'agent-deploy-wsl.spec.ts',
    },
  ],
});
