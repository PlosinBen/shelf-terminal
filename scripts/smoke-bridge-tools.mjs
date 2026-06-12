/**
 * Runtime construction smoke for the app-level bridge tools. Typecheck proves
 * the shapes; this proves the SDK functions + zod actually run (the real risk
 * was zod-version compat with claude's tool()/createSdkMcpServer). Does NOT
 * exercise a live model calling the tool — that needs the app + real auth.
 *
 * Run: node scripts/smoke-bridge-tools.mjs
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

let fail = 0;
const ok = (n, cond) => { console.log(`${cond ? '✅' : '💥'} ${n}`); if (!cond) fail++; };

// claude: createSdkMcpServer + tool() with a zod-shape arg.
const server = createSdkMcpServer({
  name: 'shelf',
  version: '1.0.0',
  tools: [
    tool('list_app_skills', 'list', {}, async () => ({ content: [{ type: 'text', text: '[]' }] })),
    tool('get_app_skill', 'get', { name: z.string() }, async ({ name }) => ({ content: [{ type: 'text', text: String(name) }] })),
  ],
});
ok('claude createSdkMcpServer built', server && server.type === 'sdk' && !!server.instance);

// copilot: defineTool with a JSON-schema parameters block (no zod needed).
let copilotOk = false;
try {
  const { defineTool } = await import('@github/copilot-sdk');
  const t = defineTool('list_app_skills', {
    description: 'list',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => '[]',
    skipPermission: true,
  });
  copilotOk = t && t.name === 'list_app_skills' && typeof t.handler === 'function';
} catch (e) {
  console.error('copilot defineTool error:', e?.message ?? e);
}
ok('copilot defineTool built', copilotOk);

console.log(`\n${fail === 0 ? '🎉 ALL PASS' : `💥 ${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
