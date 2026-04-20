import { build } from 'esbuild';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve } from 'path';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  entryPoints: ['agent-server/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: `dist/agent-server/${pkg.version}/index.js`,
  external: [],
  alias: {
    // Match the @shared alias the renderer / main use so openai-processor's
    // logger import resolves when bundled into the server.
    '@shared': resolve(root, 'src/shared'),
  },
  banner: { js: `// shelf-terminal agent-server v${pkg.version}\n` },
  minify: true,
});

console.log(`Built agent-server v${pkg.version} → dist/agent-server/${pkg.version}/index.js`);
