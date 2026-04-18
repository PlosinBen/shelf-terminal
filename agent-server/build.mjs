import { build } from 'esbuild';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['agent-server/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: `dist/agent-server/${pkg.version}/index.js`,
  external: [],
  banner: { js: `// shelf-terminal agent-server v${pkg.version}\n` },
  minify: true,
});

console.log(`Built agent-server v${pkg.version} → dist/agent-server/${pkg.version}/index.js`);
