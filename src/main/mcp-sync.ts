/**
 * Sibling of skills-sync.ts for app-level MCP config — its OWN post-mutation
 * pipeline, NOT a call into onSkillsChanged(). MCP and skills are different
 * content domains: folding MCP into the skills pipeline would re-project the skill
 * tree, fire skill hot-reload, and spew a "Skills reloaded" line into unrelated
 * agent tabs on an MCP-only edit (skills#2 Decision C / skills#9). See
 * features/app-level-mcps.
 *
 * Reactions after any MCP config write:
 *   1. Re-project onto THIS machine — a local agent picks it up next session.
 *   2. Run subscribers — the remote re-mirror (registered by agent/index.ts via
 *      `subscribeMcpChanged`, same import-cycle avoidance as skills). NOTE v1 has
 *      NO hot-reload: MCP can't be live-set uniformly, so instead of a reload the
 *      subscriber emits a "reconnect to apply" notice (see T2.3). Until that's
 *      wired, there are simply no subscribers and v1 is local-projection-only.
 *   3. Notify the renderer — the open MCP settings view refetches its list.
 *
 * Best-effort throughout: a reaction that throws must not fail the mutation.
 */
import { projectMcpLocal } from './mcp-projection';
import { getAppInstanceId } from './app-instance-id';
import { getMainWindow } from './app-state';
import { IPC } from '@shared/ipc-channels';
import { log } from '@shared/logger';

type McpChangedSubscriber = () => void;
const subscribers = new Set<McpChangedSubscriber>();

/** Register a reaction to MCP config mutations (e.g. the remote re-mirror, wired
 *  by agent/index.ts). Inverts the dependency so mcp-sync never imports back into
 *  the agent/remote layer. */
export function subscribeMcpChanged(fn: McpChangedSubscriber): void {
  subscribers.add(fn);
}

/** Tell the renderer the MCP config changed so the open settings view refetches. */
export function notifyRendererMcpChanged(): void {
  try {
    getMainWindow()?.webContents.send(IPC.MCP_CHANGED);
  } catch {
    /* renderer may be gone — nothing to refresh */
  }
}

export function onMcpChanged(): void {
  try {
    projectMcpLocal(getAppInstanceId());
  } catch {
    /* best-effort — projection failure must not fail the mutation */
  }

  for (const fn of subscribers) {
    try {
      fn();
    } catch (err: any) {
      log.error('mcp', `mcp-changed subscriber failed: ${err?.message ?? err}`);
    }
  }

  notifyRendererMcpChanged();
}
