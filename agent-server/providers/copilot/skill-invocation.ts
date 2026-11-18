import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SKILL_PLUGIN } from '@shared/skill-commands';
import { SKILL_COMMAND_ERROR as E, SkillCommandFailure, type SkillInvocation } from '@shared/skill-invocation';
import { skillPayloadDigest } from '@shared/skill-payload';
import type { QueryInput } from '../types';
import { inputPromptForDispatch } from '../../input-prompt';
import { resolveInvocationSkillPath } from '../skill-invocation';
import { copilotEnv, resolveCopilotCommand } from './helpers';

export interface CopilotNativeSkill { name: string; path: string; enabled: boolean; source?: string }
interface SkillSource { name: string; file: string; enabled: boolean; payloadDigest?: string }
export type CopilotSkillSnapshot = SkillSource[];
const run = promisify(execFile);

export function assertCopilotSkillInput(input: QueryInput, nativeCommands: readonly { name: string }[] = []): void {
  const name = inputPromptForDispatch(input).trim().match(/^\/([^\s]+)(?:[ \t]|$)/)?.[1];
  const isCommand = input.invocation || nativeCommands.some(command => command.name === name);
  if (isCommand && (input.images?.length || input.attachments?.length || input.inputMessage?.attachments.length)) {
    throw new SkillCommandFailure(E.ATTACHMENTS, 'Copilot slash commands do not support attachments. Send this command without attachments; ordinary messages can still include them.');
  }
}

/** Native discovery owns source precedence. No credential/config parsing here. */
export async function readCopilotSkillCatalog(cwd: string, appId?: string): Promise<CopilotNativeSkill[]> {
  const { command } = resolveCopilotCommand();
  const { stdout } = await run(command, ['--no-auto-update', '--disable-client-telemetry', 'skill', 'list', '--json'], {
    cwd, env: copilotEnv(appId), timeout: 10000, maxBuffer: 8 * 1024 * 1024,
  });
  const value: unknown = JSON.parse(stdout);
  if (!Array.isArray(value) || value.some(row => !row || typeof row.name !== 'string' || !row.name || typeof row.path !== 'string' || !path.isAbsolute(row.path) || typeof row.enabled !== 'boolean')) {
    throw new SkillCommandFailure(E.SOURCE, 'Native skill catalog has an invalid shape');
  }
  return value;
}

export function snapshotCopilotSkills(catalog: CopilotNativeSkill[], pluginRoot: string): CopilotSkillSnapshot {
  const parent = fs.realpathSync(path.join(pluginRoot, 'skills'));
  return catalog.map(skill => {
    const file = fs.realpathSync(fs.statSync(skill.path).isDirectory() ? path.join(skill.path, 'SKILL.md') : skill.path);
    const directory = path.dirname(file);
    const isAppSkill = path.dirname(directory) === parent && path.basename(file) === 'SKILL.md';
    return { name: skill.name, file, enabled: skill.enabled, ...(isAppSkill ? { payloadDigest: skillPayloadDigest(directory) } : {}) };
  });
}

/** Retain only app skills unchanged across the native session creation boundary. */
export function loadedCopilotSkills(before: CopilotSkillSnapshot, after: CopilotSkillSnapshot): CopilotSkillSnapshot {
  return after.filter(skill => skill.payloadDigest && before.some(old => JSON.stringify(old) === JSON.stringify(skill)));
}

export function resolveCopilotSkillCommand(invocation: SkillInvocation, root: string | null, loaded: CopilotSkillSnapshot | null, current: CopilotSkillSnapshot): string {
  const expected = resolveInvocationSkillPath(invocation, root);
  if (!loaded) throw new SkillCommandFailure(E.UNAVAILABLE, 'This conversation has no verified skill snapshot. Open a new conversation to use this command.');
  const names = new Set([invocation.skillName, `${SKILL_PLUGIN.NAME}:${invocation.skillName}`]);
  const candidates = current.filter(skill => names.has(skill.name));
  const matches = candidates.filter(skill => skill.file === expected);
  if (matches.length !== 1) throw new SkillCommandFailure(candidates.length ? E.CONFLICT : E.SOURCE, 'Native skill resolution does not select the registered app skill');
  const selected = matches[0];
  if (!selected.enabled) throw new SkillCommandFailure(E.DISABLED, 'The native skill is disabled');
  if (!loaded.some(skill => skill.name === selected.name && skill.file === expected && skill.enabled && skill.payloadDigest === invocation.payloadDigest)) {
    throw new SkillCommandFailure(E.CHANGED, 'The app skill changed after this conversation loaded. Open a new conversation to load the current skill.');
  }
  return `/${selected.name}${invocation.args ? ` ${invocation.args}` : ''}`;
}
