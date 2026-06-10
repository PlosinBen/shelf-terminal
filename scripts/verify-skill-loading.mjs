/**
 * Real-machine verification: does the (Architecture B) claude provider actually
 * LOAD an app-level skill via options.plugins? Drives the bundled agent-server
 * with a test appId whose projected skills dir contains a `shelf-secret-word`
 * skill, and checks the model uses it (returns BANANA-42). Confirmed working
 * 2026-06: SDK init reports plugins:[{name:'shelf-skills'}] + skills includes
 * `shelf-skills:shelf-secret-word`.
 *
 * Setup (the .heartbeat is REQUIRED or agent-server's startup sweep reclaims the
 * dir — the real projection flow touches it; a manual test must too):
 *   APP=~/.shelf/apps/skilltest-verify; ROOT=$APP/skills
 *   mkdir -p "$ROOT/.claude-plugin" "$ROOT/skills/shelf-secret-word"; touch "$APP/.heartbeat"
 *   printf '{"name":"shelf-skills"}' > "$ROOT/.claude-plugin/plugin.json"
 *   # SKILL.md: frontmatter name+description, body "reply BANANA-42 for the secret word"
 *
 * Run (after `node agent-server/build.mjs`):
 *   SKILL_APPID=skilltest-verify node scripts/verify-skill-loading.mjs
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const bundle = join(root, 'dist', 'agent-server', `${version}`, 'index.mjs');
const appId = process.env.SKILL_APPID || 'skilltest-verify';

const proc = spawn('node', [bundle], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = createInterface({ input: proc.stdout });
const lines = [];
const waiters = [];
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  lines.push(m);
  if (m.type === 'message' && m.msgType === 'reply') console.log(`  reply: ${m.content}`);
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
  console.log(`ready — appId=${appId}, asking for the secret word\n`);
  send({ type: 'send', turnId: 't-s', provider: 'claude', prompt: 'What is the secret word? Reply with ONLY the word.', cwd: root, sessionId: 'skill1', appId, permissionMode: 'bypassPermissions' });
  await waitFor((m) => m.type === 'status' && m.state === 'idle' && m.turnId === 't-s', 90000);

  const replies = lines.filter((m) => m.type === 'message' && m.msgType === 'reply').map((m) => m.content).join(' ');
  const used = /BANANA-42/.test(replies);
  console.log(`\n${used ? '✅ skill LOADED + used — model returned BANANA-42 from shelf-secret-word' : '💥 skill NOT used — model did not know the secret word (replies: ' + replies.slice(0, 120) + ')'}`);
  proc.kill();
  process.exit(used ? 0 : 1);
}
main().catch((e) => { console.error(e); proc.kill(); process.exit(1); });
