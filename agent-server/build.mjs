import { build } from 'esbuild';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['agent-server/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: `dist/agent-server/${pkg.version}/index.mjs`,
  external: [],
  banner: { js: `// shelf-terminal agent-server v${pkg.version}\nimport{fileURLToPath as __fu}from"url";import{dirname as __dn}from"path";const __filename=__fu(import.meta.url);const __dirname=__dn(__filename);\n` },
  minify: true,
});

console.log(`Built agent-server v${pkg.version} → dist/agent-server/${pkg.version}/index.mjs`);
