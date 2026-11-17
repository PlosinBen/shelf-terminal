import fs from 'fs';
import path from 'path';
import { SKILL_COMMAND_ERROR as E, SkillCommandFailure, validSkillInvocation, type SkillInvocation } from '@shared/skill-invocation';
import { skillPayloadDigest } from '@shared/skill-payload';

/** Target-host canonical app projection. Never resolve by skill name alone. */
export function resolveInvocationSkillPath(invocation: SkillInvocation, pluginRoot: string | null): string {
  if (!validSkillInvocation(invocation)) throw new SkillCommandFailure(E.INVALID, 'Malformed skill invocation');
  if (!pluginRoot) throw new SkillCommandFailure(E.PROJECTION, 'App skill projection is unavailable');
  const parent = fs.realpathSync(path.join(pluginRoot, 'skills'));
  const directory = path.join(parent, invocation.skillName);
  if (fs.realpathSync(directory) !== directory) throw new SkillCommandFailure(E.PROJECTION, 'App skill projection contains a redirected target');
  if (skillPayloadDigest(directory) !== invocation.payloadDigest) throw new SkillCommandFailure(E.PROJECTION, 'App skill projection does not match the queued payload');
  return path.join(directory, 'SKILL.md');
}
