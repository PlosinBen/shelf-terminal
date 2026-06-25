/**
 * Repro for "Copilot 長任務(大範圍 grep)卡住、bash 沒回應、沒錯誤訊息".
 * Drives the REAL built bundle (copilot provider, bypassPermissions) and forces
 * ONE long-running, high-output bash grep over node_modules. Every `[copilot]
 * DIAG ...` stderr line + every wire message/error/status/task_event is printed
 * with a +Ns timestamp so we can see EXACTLY which tool-lifecycle events arrive
 * (and which never do) for a tool that takes a long time.
 *
 *   Key questions:
 *     - does tool.execution_complete EVER fire, or does the card hang until the
 *       30-min turn timeout?
 *     - do partial_result / progress stream during the run (feedback we drop)?
 *     - does the CLI detach the shell (system.notification shell_detached_*)?
 *
 * Run (after `node agent-server/build.mjs`): node scripts/spike-copilot-biggrep.mjs
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const bundle = join(root, 'dist', 'agent-server', `${version}`, 'index.mjs');

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const proc = spawn('node', [bundle], { stdio: ['pipe', 'pipe', 'pipe'] });
const out = createInterface({ input: proc.stdout });
const err = createInterface({ input: proc.stderr });
const lines = [];
const waiters = [];
let sawComplete = false;

out.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  lines.push(m);
  if (m.type === 'message') console.log(`  ${ts()} ▸ message ${m.msgType} label=${JSON.stringify(m.label ?? '')} ${m.errorMessage ? 'ERR=' + JSON.stringify(m.errorMessage) : (m.body ? 'body=' + JSON.stringify(String(m.body.content ?? '').slice(0, 60)) : '(pending/no-body)')}`);
  else if (m.type === 'error') console.log(`  ${ts()} ▸ ERROR ${JSON.stringify(m.error)}`);
  else if (m.type === 'status') console.log(`  ${ts()} ▸ status ${m.state}`);
  else if (m.type === 'task_event') console.log(`  ${ts()} ▸ task_event kind=${m.kind} tasks=${JSON.stringify(m.tasks ?? m.task)}`);
  else if (m.type === 'permission_request') { console.log(`  ${ts()} ▸ permission_request ${m.toolName}`); send({ type: 'resolve_permission', toolUseId: m.toolUseId, allow: true }); }
  for (const w of waiters) w(m);
});
err.on('line', (line) => {
  if (/\[copilot\] DIAG/.test(line)) {
    if (/tool\.complete/.test(line)) sawComplete = true;
    console.log(`  ${ts()} 🪵 ${line}`);
  } else if (/\[copilot\]/.test(line)) {
    console.log(`  ${ts()} 🪵 ${line}`);
  }
});

const send = (o) => proc.stdin.write(JSON.stringify(o) + '\n');
const waitFor = (pred, ms) => new Promise((res) => {
  const hit = lines.find(pred); if (hit) return res(hit);
  const t = setTimeout(() => res(null), ms);
  waiters.push((m) => { if (pred(m)) { clearTimeout(t); res(m); } });
});

async function main() {
  await waitFor((m) => m.type === 'ready', 30000);
  const base = { provider: 'copilot', cwd: root, sessionId: 'biggrep1', permissionMode: 'bypassPermissions' };

  console.log(`\n${ts()} === Turn: force ONE long, high-output bash grep over node_modules ===`);
  send({ type: 'send', turnId: 't-grep', ...base,
    prompt: 'Run EXACTLY ONE shell command (run_in_background=false) and nothing else, then report the line count. '
      + 'Command: `grep -rn "function" node_modules | wc -l`. Do not use any other tool.' });

  // Wait up to 5 min for idle, narrating arrivals as they come.
  const idle = await waitFor((m) => m.type === 'status' && m.state === 'idle', 5 * 60 * 1000);

  console.log(`\n${ts()} === VERDICT ===`);
  console.log(`  reached idle: ${idle ? 'YES' : 'NO (5-min spike cap hit)'}`);
  console.log(`  saw tool.execution_complete: ${sawComplete ? 'YES' : 'NO — tool never completed (hang reproduced)'}`);
  proc.kill();
  process.exit(0);
}
main().catch((e) => { console.error('spike error:', e); proc.kill(); process.exit(1); });
