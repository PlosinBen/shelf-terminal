/**
 * Provider-agnostic handler + copy for the in-process bridge tools that expose
 * client-owned resources (app-level skills) to the model. Each provider
 * registers these via its own SDK API (claude `tool()` / copilot `defineTool`),
 * but the handler body — call main, format the result — is shared here. Step 3
 * ships the safe READ tools (list/get); writes land later.
 * See .agent/features/app-level-capabilities.md.
 */
import { callMain } from './app-tool-client';

export const APP_SKILL_LIST_DESC =
  'List the app-level Agent Skills available in this app (each skill\'s name and description). '
  + 'Use this before creating a skill to avoid duplicate names, or to find one to read/update.';

export const APP_SKILL_GET_DESC =
  'Read the full SKILL.md content of one app-level skill, by its folder name (as returned by list_app_skills).';

export interface BridgeToolText {
  text: string;
  isError: boolean;
}

/** Run a bridge op via main and format its result as the text a tool returns. */
export async function runBridgeTool(op: string, args: Record<string, unknown>): Promise<BridgeToolText> {
  const r = await callMain(op, args);
  if (r.ok) {
    return { text: typeof r.data === 'string' ? r.data : JSON.stringify(r.data ?? null), isError: false };
  }
  return { text: `Error: ${r.error ?? 'app tool failed'}`, isError: true };
}
