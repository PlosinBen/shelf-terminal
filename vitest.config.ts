import { defineConfig } from 'vitest/config';
import { alias } from './aliases';

// Minimal vitest config — does not extend vite.config.ts because that one
// loads vite-plugin-electron which would try to spawn Electron during tests.
// Unit tests here cover pure TypeScript modules only.
export default defineConfig({
  resolve: { alias },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
