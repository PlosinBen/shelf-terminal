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

export const APP_SKILL_CREATE_DESC =
  'Create a new app-level Agent Skill. `content` is the full SKILL.md, including YAML frontmatter with `name` '
  + '(lowercase kebab-case — this is the skill\'s identity) and `description`, followed by the markdown body. '
  + 'Fails if a skill with that name already exists (read list_app_skills first, or use update_app_skill). '
  + 'Takes effect for the agent on the next session.';

export const APP_SKILL_UPDATE_DESC =
  'Overwrite an existing app-level skill. `name` is its current folder name; `content` is the full new SKILL.md '
  + '(its frontmatter `name` may rename the skill). Fails if the skill is locked (the user has reserved it — '
  + 'do not retry; list_app_skills reports `locked`). Takes effect on the next session.';

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
