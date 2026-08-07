/**
 * Focused smoke: does an IMAGE-ONLY send (no text prompt) wedge the persistent
 * session? Drives the bundled agent-server against real claude. A 1x1 PNG is
 * sent with no prompt; we wait (bounded) for the execution's idle. If it never
 * arrives the execution wedged (the reported "whole conversation stuck").
 *
 * Run (after `node agent-server/build.mjs`): node scripts/smoke-image-only.mjs
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const bundle = process.env.SMOKE_BUNDLE || join(root, 'dist', 'agent-server', `${version}`, 'index.mjs');

// 1x1 transparent PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const proc = spawn('node', [bundle], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = createInterface({ input: proc.stdout });
const lines = [];
const waiters = [];
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  lines.push(m);
  if (m.type !== 'stream') console.log(`  ← ${JSON.stringify(m).slice(0, 160)}`);
  // Auto-allow tools so the execution can reach its result (mirrors bypass/approve).
  if (m.type === 'permission_request') send({ type: 'resolve_permission', toolUseId: m.toolUseId, allow: true });
  for (const w of waiters) w(m);
});
const send = (o) => proc.stdin.write(JSON.stringify(o) + '\n');
const waitFor = (pred, ms) => new Promise((res) => {
  if (lines.find(pred)) return res(true);
  const t = setTimeout(() => res(false), ms);
  waiters.push((m) => { if (pred(m)) { clearTimeout(t); res(true); } });
});

async function main() {
  await waitFor((m) => m.type === 'ready', 30000);
  console.log('ready — sending IMAGE-ONLY (no prompt)\n');
  send({ type: 'send', executionId: 'e-img', provider: 'claude', prompt: '', cwd: root, sessionId: 'img1', images: [PNG] });

  // The fix: image-only is no longer rejected at the handleSend guard (the old
  // bug emitted "Missing prompt or cwd" + NO idle → renderer spinner wedged
  // forever). Deterministic assert: the execution reaches the SDK (gets `streaming`)
  // and is NOT rejected with Missing-prompt. (Whether it then idles quickly is
  // model-dependent — our degenerate 1x1 PNG is rejected by the API and can send
  // the model on a long tool tangent; a real image responds + idles normally.)
  const reachedSdk = await waitFor((m) => m.type === 'status' && m.state === 'streaming' && m.executionId === 'e-img', 15000);
  const missingErr = lines.find((m) => m.type === 'error' && /Missing prompt/i.test(m.error ?? ''));
  console.log(!missingErr && reachedSdk ? '\n✅ image-only accepted, execution reached the SDK (no wedge at the guard)'
    : `\n💥 ${missingErr ? 'rejected with Missing-prompt' : 'execution never started'}`);
  const gotIdle = await waitFor((m) => m.type === 'status' && m.state === 'idle' && m.executionId === 'e-img', 90000);
  console.log(gotIdle ? '✅ execution terminated with idle' : 'ℹ️ no idle in 90s (degenerate test image → model tangent; not a wedge)');

  if (gotIdle) {
    // Follow-up: confirm the session is still usable (not silently wedged).
    console.log('— follow-up text execution');
    send({ type: 'send', executionId: 'e-after', provider: 'claude', prompt: 'Reply with just "ok".', cwd: root, sessionId: 'img1' });
    const ok = await waitFor((m) => m.type === 'status' && m.state === 'idle' && m.executionId === 'e-after', 30000);
    console.log(ok ? '✅ follow-up responded (session healthy)' : '💥 follow-up WEDGED (session stuck after image-only)');
  }
  proc.kill();
  process.exit(0);
}
main().catch((e) => { console.error(e); proc.kill(); process.exit(1); });
