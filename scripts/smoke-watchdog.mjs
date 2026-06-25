/**
 * Verify the ssh idle-shutdown watchdog (connection-health#2). Spawns the bundled
 * agent-server with `--idle-shutdown-min=0.05` (3s) and checks three cases:
 *   A. no ping        → self-exits within ~3s
 *   B. periodic ping  → stays alive past the window (watchdog reset)
 *   C. no arg         → never self-exits (watchdog disabled)
 *
 * Run (after `node agent-server/build.mjs`): node scripts/smoke-watchdog.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const bundle = join(root, 'dist', 'agent-server', `${version}`, 'index.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (n, ok) => { console.log(`${ok ? '✅' : '💥'} ${n}`); if (!ok) fail++; };

/** Spawn the bundle; returns { proc, exited:()=>bool, ping() }. */
function start(args) {
  const proc = spawn('node', [bundle, ...args], { stdio: ['pipe', 'pipe', 'ignore'] });
  let exited = false;
  proc.on('exit', () => { exited = true; });
  return { proc, isExited: () => exited, ping: () => proc.stdin.write(JSON.stringify({ type: 'ping', seq: 1 }) + '\n') };
}

async function main() {
  // A. no ping → exits within ~3s (+margin)
  const a = start(['--idle-shutdown-min=0.05']);
  await sleep(5000);
  check('A: no-ping → self-exited within 5s', a.isExited());
  if (!a.isExited()) a.proc.kill();

  // B. ping every 1s → still alive at 5s
  const b = start(['--idle-shutdown-min=0.05']);
  const beat = setInterval(() => { try { b.ping(); } catch {} }, 1000);
  await sleep(5000);
  clearInterval(beat);
  check('B: periodic-ping → still alive past the window', !b.isExited());
  b.proc.kill();

  // C. no arg → never exits
  const c = start([]);
  await sleep(5000);
  check('C: no --idle-shutdown-min → watchdog disabled (still alive)', !c.isExited());
  c.proc.kill();

  console.log(`\n${fail === 0 ? '🎉 ALL PASS' : `💥 ${fail} FAILED`}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
