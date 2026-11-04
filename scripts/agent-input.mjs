// Manual bundle drivers use the production factory without adding a TS runtime
// or importing the Electron/provider process. esbuild is already a build dependency.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const result = await build({
  entryPoints: [fileURLToPath(new URL('../src/shared/agent-input.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm',
});
const { createAgentInputMessage, AGENT_INPUT_SOURCE } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);

/** Adapt a manual driver's send at its Caller boundary; control frames stay opaque. */
export function canonicalSmokeFrame(frame) {
  if (frame.type !== 'send') return frame;
  const { prompt, attachments, images, ...envelope } = frame;
  if (images?.length) throw new Error('Smoke images must be staged as uploaded attachments');
  const built = createAgentInputMessage({
    source: { kind: AGENT_INPUT_SOURCE.AGENT_VIEW }, content: prompt, attachments,
  });
  if (!built.ok) throw new Error(`Invalid smoke input: ${built.error}`);
  return { ...envelope, inputMessage: built.message };
}
