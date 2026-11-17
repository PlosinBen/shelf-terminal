import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { AgentInputMessage } from '@shared/agent-input';
import { SKILL_COMMAND_RESOLUTION as R, resolveSkillCommand, parseShelfCommandPrefix, type SkillCommandEntry } from '@shared/skill-commands';
import { SKILL_INVOCATION as I, SKILL_COMMAND_ERROR as E, SkillCommandFailure, validSkillInvocation, validSkillCommandSelection, type SkillInvocation, type SkillCommandSelection, type SkillValidationRequest, type SkillValidationResult } from '@shared/skill-invocation';
import { skillPayloadDigest } from '@shared/skill-payload';
import { readSkillCommandCatalog, readSkillCommandFile } from '../skill-commands';
import { withSkillsMutation, skillInvocationRevision } from '../skills-mutation';

export function skillCommandCatalogRevision(entries: readonly SkillCommandEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

/** Main-owned bindings: no renderer-supplied target/path and no durable queue promise. */
export function createSkillInvocationRegistry<Owner extends object>(collectionDirectory: () => string) {
  interface Receipt { owner: Owner; msgId: string; invocation: SkillInvocation; revision: number; directoryIdentity: string; executionId?: string }
  const bindings = new Map<string, Receipt>();
  const identity = (directory: string) => { const stat = fs.lstatSync(directory); return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`; };
  return {
    prepare(owner: Owner, message: AgentInputMessage, nativeNames: ReadonlySet<string>, selection?: SkillCommandSelection): Promise<SkillInvocation | undefined> {
      return withSkillsMutation(() => {
        if (selection !== undefined && !validSkillCommandSelection(selection)) throw new SkillCommandFailure(E.STALE, 'Invalid command selection');
        const parsed = parseShelfCommandPrefix(message.content);
        if (!parsed) {
          if (selection) throw new SkillCommandFailure(E.STALE, 'Selected command no longer matches the message');
          return undefined;
        }
        if (nativeNames.has(parsed.alias)) {
          if (selection) throw new SkillCommandFailure(E.CONFLICT, 'Native command now owns this alias');
          return undefined;
        }
        const catalog = readSkillCommandCatalog(collectionDirectory());
        if (!catalog.ok) throw new SkillCommandFailure(E.INVALID, catalog.error);
        const resolved = resolveSkillCommand(message.content, catalog.value, nativeNames);
        if (selection && (selection.catalogRevision !== skillCommandCatalogRevision(catalog.value)
          || resolved.kind !== R.MATCH || resolved.registrationId !== selection.registrationId)) throw new SkillCommandFailure(E.STALE, 'Command selection changed; select it again');
        if (resolved.kind !== R.MATCH) {
          if (resolved.kind === R.ERROR) throw new SkillCommandFailure(E.INVALID, resolved.error);
          return undefined;
        }
        const directory = path.join(collectionDirectory(), resolved.skillName);
        const invocation: SkillInvocation = { kind: I.KIND, bindingId: randomUUID(), skillName: resolved.skillName, registrationId: resolved.registrationId, alias: resolved.alias, args: resolved.args, payloadDigest: skillPayloadDigest(directory) };
        bindings.set(invocation.bindingId, { owner, msgId: message.msgId, invocation: { ...invocation }, revision: skillInvocationRevision(invocation.skillName), directoryIdentity: identity(directory) });
        return invocation;
      });
    },
    attach(owner: Owner, invocation: SkillInvocation, msgId: string, executionId: string): void {
      const receipt = bindings.get(invocation.bindingId);
      if (!receipt || receipt.owner !== owner || receipt.msgId !== msgId || receipt.executionId) throw new SkillCommandFailure(E.CHANGED, 'Invocation binding is missing or already dispatched');
      receipt.executionId = executionId;
    },
    validate(owner: Owner, request: SkillValidationRequest): Promise<SkillValidationResult> {
      return withSkillsMutation(() => {
        try {
          if (!validSkillInvocation(request.invocation)) throw new SkillCommandFailure(E.INVALID, 'Malformed invocation');
          const receipt = bindings.get(request.invocation.bindingId);
          if (!receipt || receipt.owner !== owner || receipt.msgId !== request.msgId || receipt.executionId !== request.executionId
            || Object.keys(receipt.invocation).some(key => receipt.invocation[key as keyof SkillInvocation] !== request.invocation[key as keyof SkillInvocation])) throw new SkillCommandFailure(E.CHANGED, 'Invocation ownership or payload does not match');
          const directory = path.join(collectionDirectory(), receipt.invocation.skillName);
          const registration = readSkillCommandFile(directory);
          if (!registration.ok || registration.value?.registrationId !== receipt.invocation.registrationId) throw new SkillCommandFailure(E.CHANGED, 'Skill registration was removed or replaced');
          try { fs.lstatSync(path.join(directory, '.disabled')); throw new SkillCommandFailure(E.DISABLED, 'Skill is disabled'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (receipt.revision !== skillInvocationRevision(receipt.invocation.skillName) || receipt.directoryIdentity !== identity(directory)
            || skillPayloadDigest(directory) !== receipt.invocation.payloadDigest) throw new SkillCommandFailure(E.CHANGED, 'Skill content or identity changed while queued');
          return { ok: true };
        } catch (error) {
          return { ok: false, code: error instanceof SkillCommandFailure ? error.code : E.CHANGED, error: (error as Error).message };
        }
      });
    },
    release(bindingId: string) { bindings.delete(bindingId); },
    close(owner: Owner) { for (const [id, receipt] of bindings) if (receipt.owner === owner) bindings.delete(id); },
    size: () => bindings.size,
  };
}
