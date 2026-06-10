/**
 * Verify /compact and /clear behave under Architecture B (they're now pushed as
 * messages into the persistent streaming session, not a separate query). Drives
 * the bundled agent-server against real claude.
 *
 * Sequence: remember 42 → /compact → recall (should STILL know 42) → /clear →
 * recall (should NOT know 42). Each turn must idle; the session must survive
 * both slashes.
 *
 * Run (after `node agent-server/build.mjs`): node scripts/smoke-slash.mjs
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const bundle = join(root, 'dist', 'agent-server', `${version}`, 'index.mjs');

const proc = spawn('node', [bundle], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = createInterface({ input: proc.stdout });
const lines = [];
const waiters = [];
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  lines.push(m);
  if (m.type === 'message' && (m.msgType === 'reply' || m.msgType === 'fold_markdown'))
    console.log(`  [${m.turnId}] ${m.msgType}${m.label ? '(' + m.label + ')' : ''}: ${m.content ?? JSON.stringify(m.body ?? m.errorMessage ?? '')}`);
  if (m.type === 'permission_request') send({ type: 'resolve_permission', toolUseId: m.toolUseId, allow: true });
  for (const w of waiters) w(m);
});
const send = (o) => proc.stdin.write(JSON.stringify(o) + '\n');
const idle = (tid) => (m) => m.type === 'status' && m.state === 'idle' && m.turnId === tid;
const waitFor = (pred, ms = 90000) => new Promise((res) => {
  if (lines.find(pred)) return res(true);
  const t = setTimeout(() => res(false), ms);
  waiters.push((m) => { if (pred(m)) { clearTimeout(t); res(true); } });
});
const replyOf = (tid) => lines.filter((m) => m.type === 'message' && m.msgType === 'reply' && m.turnId === tid).map((m) => m.content).join(' ');
const base = { provider: 'claude', cwd: root, sessionId: 'slash1', permissionMode: 'bypassPermissions' };
let fail = 0;
const check = (n, ok) => { console.log(`${ok ? '✅' : '💥'} ${n}`); if (!ok) fail++; };

async function turn(tid, prompt) {
  console.log(`\n— ${tid}: ${JSON.stringify(prompt)}`);
  send({ type: 'send', turnId: tid, prompt, ...base });
  return waitFor(idle(tid));
}

async function main() {
  await waitFor((m) => m.type === 'ready', 30000);

  await turn('t-1', 'Remember the number 42. Reply with just "ok".');
  check('t-1 idled', !!lines.find(idle('t-1')));

  const compactIdled = await turn('t-2', '/compact');
  const compactCard = lines.find((m) => m.type === 'message' && m.label === '/compact');
  check('/compact idled + session alive', compactIdled);
  check('/compact emitted its card', !!compactCard); // a real compact fills it with compact_result; a no-op convo just replies "not enough messages"

  await turn('t-3', 'What number did I ask you to remember? Reply with just the number.');
  check('context survives /compact (knows 42)', /42/.test(replyOf('t-3')));

  const clearIdled = await turn('t-4', '/clear');
  check('/clear idled + session alive', clearIdled);

  await turn('t-5', 'What number did I ask you to remember? If you do not know, say "UNKNOWN".');
  const r5 = replyOf('t-5');
  check('context reset by /clear (no longer knows 42)', !/42/.test(r5) || /unknown/i.test(r5));

  console.log(`\n${fail === 0 ? '🎉 ALL PASS' : `💥 ${fail} FAILED`}`);
  proc.kill();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); proc.kill(); process.exit(1); });
