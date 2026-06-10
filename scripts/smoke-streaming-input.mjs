/**
 * End-to-end smoke for the Architecture B claude provider, driving the BUNDLED
 * agent-server exactly as the main process does (stdin/stdout JSON-lines) against
 * real claude. Validates the rewrite beyond the mocked unit tests: persistent
 * session across turns, FIFO turn attribution, and a backgrounded task not
 * swallowing a follow-up turn.
 *
 * Run (after `node agent-server/build.mjs`):  node scripts/smoke-streaming-input.mjs
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const bundle = process.env.SMOKE_BUNDLE || join(root, 'dist', 'agent-server', `${version}`, 'index.mjs');
const cwd = root;

const proc = spawn('node', [bundle], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = createInterface({ input: proc.stdout });

const lines = [];
const waiters = [];
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  lines.push(m);
  const tid = m.turnId ?? '·';
  const extra = m.type === 'message' ? `${m.msgType}:${(m.content ?? '').slice(0, 50)}`
    : m.type === 'status' ? m.state
    : m.type === 'task_event' ? `${m.kind}` : '';
  console.log(`  ← ${m.type}[${tid}] ${extra}`);
  for (const w of waiters) w(m);
});

const send = (o) => proc.stdin.write(JSON.stringify(o) + '\n');
const waitFor = (pred, ms = 120000) => new Promise((res, rej) => {
  const found = lines.find(pred);
  if (found) return res(found);
  const t = setTimeout(() => rej(new Error('timeout waiting for ' + pred)), ms);
  waiters.push((m) => { if (pred(m)) { clearTimeout(t); res(m); } });
});
const idle = (tid) => (m) => m.type === 'status' && m.state === 'idle' && m.turnId === tid;
const replyText = (tid) => lines.filter((m) => m.type === 'message' && m.msgType === 'reply' && m.turnId === tid).map((m) => m.content).join(' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok) => { console.log(`${ok ? '✅' : '❌'} ${name}`); if (!ok) failures++; };

async function main() {
  await waitFor((m) => m.type === 'ready', 30000);
  console.log('agent-server ready\n');
  const base = { provider: 'claude', cwd, sessionId: 'smoke1' };

  // Turn 1
  console.log('— turn A: remember 42');
  send({ type: 'send', turnId: 't-A', prompt: 'Remember the number 42. Reply with just "ok".', ...base });
  await waitFor(idle('t-A'));

  // Turn 2 (same session → context retained)
  console.log('— turn B: recall');
  send({ type: 'send', turnId: 't-B', prompt: 'What number did I ask you to remember? Reply with just the number.', ...base });
  await waitFor(idle('t-B'));
  check('A and B both got foreground idle', true);
  check('session persisted (B recalls 42)', /42/.test(replyText('t-B')));

  // Turn C: background task, then push D before it settles.
  console.log('— turn C: start background sleep');
  send({ type: 'send', turnId: 't-C', prompt: 'Run this shell command IN THE BACKGROUND (run_in_background): `sleep 15 && echo BG_DONE`. Immediately reply "started".', permissionMode: 'bypassPermissions', ...base });
  await waitFor(idle('t-C'));
  console.log('— turn D: pushed while C task still running');
  send({ type: 'send', turnId: 't-D', prompt: 'What is 2+2? Reply with just the number.', permissionMode: 'bypassPermissions', ...base });
  await waitFor(idle('t-D'));
  check('D not swallowed by C background task (answers 4)', /4/.test(replyText('t-D')));

  console.log('— waiting for background settle + auto-resume (server turn)…');
  const ts = await waitFor((m) => m.type === 'turn_started', 30000).catch(() => null);
  check('auto-resume opened a server turn (turn_started)', !!ts);
  if (ts) {
    await waitFor(idle(ts.turnId), 20000).catch(() => null);
    check('server turn produced a reply', replyText(ts.turnId).length > 0);
  }

  console.log(`\n${failures === 0 ? '🎉 ALL PASS' : `💥 ${failures} FAILED`}`);
  proc.kill();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('smoke error:', e); proc.kill(); process.exit(1); });
