import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { TextDecoder } from 'util';
import { log } from '@shared/logger';
import {
  SKILL_COMMAND_FILE, SKILL_COMMAND_TEMP_PREFIX, SKILL_COMMAND_VERSION,
  validateSkillCommandDraft, validateSkillCommandRegistration, validateSkillCommandCatalog,
  type SkillCommandResult, type SkillCommandRegistration, type SkillCommandEntry,
} from '@shared/skill-commands';
import { isValidSkillName } from './skills-store';
import { withSkillsMutation, invalidateSkillInvocations } from './skills-mutation';

/** Missing metadata is normal; unreadable/invalid metadata is never treated as unregistered. */
export function readSkillCommandFile(directory: string): SkillCommandResult<SkillCommandRegistration | null> {
  const file = path.join(directory, SKILL_COMMAND_FILE);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, value: null };
    return { ok: false, error: `Cannot inspect command settings: ${(error as Error).message}` };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, error: `${SKILL_COMMAND_FILE} must be a regular file` };
  try {
    return validateSkillCommandRegistration(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file))));
  } catch (error) {
    return { ok: false, error: `Cannot read command settings: ${(error as Error).message}` };
  }
}

export interface SkillCommandStoreOptions {
  collectionDirectory: () => string;
  /** The integration supplies its authoritative built-in command names. */
  reservedAliases: ReadonlySet<string>;
}

function pathPresent(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function assertSkillDirectory(directory: string, name: string): void {
  if (!isValidSkillName(name)) throw new Error(`Invalid skill name: ${name}`);
  const dirStat = fs.lstatSync(directory);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error(`Skill ${name} must be a regular directory`);
  const skillStat = fs.lstatSync(path.join(directory, 'SKILL.md'));
  if (!skillStat.isFile() || skillStat.isSymbolicLink()) throw new Error(`Skill ${name} needs a regular SKILL.md`);
}

/** Caller holds the mutation lock. Replacements describe an Import's final whole-item state. */
export function readSkillCommandCatalog(
  collectionDirectory: string,
  replacements: ReadonlyMap<string, string> = new Map(),
): SkillCommandResult<SkillCommandEntry[]> {
  const entries: SkillCommandEntry[] = [];
  try {
    let children: fs.Dirent[];
    try { children = fs.readdirSync(collectionDirectory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      children = [];
    }
    const directories = new Map<string, string>();
    for (const child of children) {
      if (isValidSkillName(child.name) && (child.isDirectory() || child.isSymbolicLink())) {
        directories.set(child.name, path.join(collectionDirectory, child.name));
      }
    }
    for (const [name, directory] of replacements) directories.set(name, directory);
    for (const [name, directory] of [...directories].sort(([a], [b]) => a.localeCompare(b))) {
      if (!pathPresent(path.join(directory, 'SKILL.md')) && !pathPresent(path.join(directory, SKILL_COMMAND_FILE))) continue;
      assertSkillDirectory(directory, name);
      const checked = readSkillCommandFile(directory);
      if (!checked.ok) throw new Error(`skill=${name} path=${directory}: ${checked.error}`);
      if (checked.value) entries.push({ skillName: name, command: checked.value, disabled: pathPresent(path.join(directory, '.disabled')) });
    }
    const error = validateSkillCommandCatalog(entries);
    if (error) throw new Error(error);
    return { ok: true, value: entries };
  } catch (error) {
    log.error('skills', `command catalog failed collection=${collectionDirectory}: ${(error as Error).message}`);
    return { ok: false, error: (error as Error).message };
  }
}

/** Source-only service. No IPC, renderer, projection notifications or provider dispatch. */
export function createSkillCommandStore(options: SkillCommandStoreOptions) {
  function skillDirectory(name: string): string {
    if (!isValidSkillName(name)) throw new Error(`Invalid skill name: ${name}`);
    const directory = path.join(options.collectionDirectory(), name);
    assertSkillDirectory(directory, name);
    return directory;
  }
  const catalog = () => readSkillCommandCatalog(options.collectionDirectory());

  function saveWithinMutation(name: string, draft: unknown): SkillCommandResult<SkillCommandRegistration | null> {
    let temporary: string | undefined;
    try {
      const directory = skillDirectory(name);
      const file = path.join(directory, SKILL_COMMAND_FILE);
      if (draft === null) {
        // Explicit unregister is also the recovery path for invalid metadata.
        invalidateSkillInvocations(name);
        fs.rmSync(file, { force: true });
        return { ok: true, value: null };
      }
      const checked = validateSkillCommandDraft(draft);
      if (!checked.ok) return checked;
      if (options.reservedAliases.has(checked.value.alias)) return { ok: false, error: `Command alias ${checked.value.alias} is reserved` };
      const previous = readSkillCommandFile(directory);
      if (!previous.ok) return previous;
      const all = catalog();
      if (!all.ok) return all;
      const command: SkillCommandRegistration = { version: SKILL_COMMAND_VERSION, registrationId: previous.value?.registrationId ?? randomUUID(), ...checked.value };
      const error = validateSkillCommandCatalog([...all.value.filter(entry => entry.skillName !== name), { skillName: name, command, disabled: false }]);
      if (error) return { ok: false, error };
      temporary = path.join(directory, `${SKILL_COMMAND_TEMP_PREFIX}${randomUUID()}`);
      fs.writeFileSync(temporary, JSON.stringify(command, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
      return { ok: true, value: command };
    } catch (error) {
      log.error('skills', `command save failed skill=${name}: ${(error as Error).message}`);
      return { ok: false, error: (error as Error).message };
    } finally {
      if (temporary) {
        try { fs.rmSync(temporary, { force: true }); }
        catch (error) { log.error('skills', `command temp cleanup failed skill=${name} path=${temporary}: ${(error as Error).message}`); }
      }
    }
  }

  return {
    catalog: () => withSkillsMutation(catalog),
    read(name: string): Promise<SkillCommandResult<SkillCommandRegistration | null>> {
      return withSkillsMutation(() => {
        try {
          const result = readSkillCommandFile(skillDirectory(name));
          if (!result.ok) log.error('skills', `command read failed skill=${name}: ${result.error}`);
          return result;
        } catch (error) {
          log.error('skills', `command read failed skill=${name}: ${(error as Error).message}`);
          return { ok: false, error: (error as Error).message };
        }
      });
    },
    save(name: string, draft: unknown): Promise<SkillCommandResult<SkillCommandRegistration | null>> {
      return withSkillsMutation(() => saveWithinMutation(name, draft));
    },
    /** Coordinator only: caller must already hold withSkillsMutation. */
    saveWithinMutation,
  };
}
