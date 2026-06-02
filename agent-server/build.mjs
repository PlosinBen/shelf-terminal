import { build } from 'esbuild';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

import { builtinModules } from 'module';

// agent-server uses the project-wide `@shared/*` alias (→ src/shared/*), same as
// src/. typecheck (root tsconfig paths) and vitest (vite resolve.alias) already
// know it; esbuild needs to be told here so the bundle resolves it too.
const agentServerDir = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: ['agent-server/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: `dist/agent-server/${pkg.version}/index.mjs`,
  alias: { '@shared': path.resolve(agentServerDir, '../src/shared') },
  external: builtinModules.flatMap((m) => [m, `node:${m}`]),
  banner: { js: `// shelf-terminal agent-server v${pkg.version}\nimport{fileURLToPath as __fu}from"url";import{dirname as __dn}from"path";const __filename=__fu(import.meta.url);const __dirname=__dn(__filename);\nimport{createRequire as __cr}from"module";const require=__cr(import.meta.url);\n` },
  minify: true,
});

console.log(`Built agent-server v${pkg.version} → dist/agent-server/${pkg.version}/index.mjs`);
