import fs from 'fs';
import path from 'path';
import { log } from '@shared/logger';
import { SKILL_EDITOR_MAIN_FILE, type SkillEditorSaveRequest, type SkillEditorSaveResult, type SkillEditorState } from '@shared/skill-editor';
import { validateSkillCommandDraft, validateSkillCommandCatalog, type SkillCommandResult, type SkillCommandDraft } from '@shared/skill-commands';
import { createSkillCommandStore, readSkillCommandFile, readSkillCommandCatalog } from './skill-commands';
import { withSkillsMutation } from './skills-mutation';
import { skillsCollectionDir, skillDirPath, isValidSkillName, resolveAuxPath, parseSkillMeta, validateFrontmatterYaml, skillEditorMutations } from './skills-store';

function sameCommand(a: SkillCommandDraft | null, b: SkillCommandDraft | null): boolean {
  return a === null || b === null ? a === b : a.alias === b.alias && a.description === b.description;
}
function assertDirectory(name: string): string {
  if (typeof name !== 'string' || !isValidSkillName(name)) throw new Error('Invalid skill name');
  const directory = skillDirPath(name);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Skill must be a regular directory');
  const source = fs.lstatSync(path.join(directory, SKILL_EDITOR_MAIN_FILE));
  if (!source.isFile() || source.isSymbolicLink()) throw new Error('Skill needs a regular SKILL.md');
  return directory;
}
function present(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function regularText(file: string): string {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Editor file must be a regular file');
  return fs.readFileSync(file, 'utf8');
}
function activePath(name: string, activeFile: string): string {
  const file = activeFile === SKILL_EDITOR_MAIN_FILE ? path.join(skillDirPath(name), activeFile) : resolveAuxPath(name, activeFile);
  if (!file) throw new Error('Invalid or reserved editor file');
  // Reject symlink ancestors as well as the leaf before reading/writing.
  let current = path.dirname(file);
  const directory = skillDirPath(name);
  while (current !== directory) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Editor file parent must be a regular directory');
    current = path.dirname(current);
  }
  return file;
}

/** User-only coordinated Save; partial persistence contract: skills#13. */
export function createSkillEditorService(reservedAliases: ReadonlySet<string>) {
  const commands = createSkillCommandStore({ collectionDirectory: skillsCollectionDir, reservedAliases });
  return {
    read(name: string): Promise<SkillCommandResult<SkillEditorState>> {
      return withSkillsMutation(() => {
        try {
          const directory = assertDirectory(name);
          const command = readSkillCommandFile(directory);
          if (!command.ok) log.error('skills', `editor command read failed skill=${name}: ${command.error}`);
          return { ok: true, value: { content: regularText(path.join(directory, SKILL_EDITOR_MAIN_FILE)), command } };
        } catch (error) {
          log.error('skills', `editor read failed skill=${name}: ${(error as Error).message}`);
          return { ok: false, error: (error as Error).message };
        }
      });
    },
    save(request: SkillEditorSaveRequest): Promise<SkillEditorSaveResult> {
      return withSkillsMutation(async () => {
        const result: SkillEditorSaveResult = { ok: false, name: typeof request?.name === 'string' ? request.name : '', saved: { content: false, command: false }, contentChanged: false, commandChanged: false };
        try {
          if (!request || typeof request.name !== 'string' || typeof request.activeFile !== 'string' || typeof request.content !== 'string'
            || Object.keys(request).some(key => !['name', 'activeFile', 'content', 'commandDraft'].includes(key))) throw new Error('Invalid editor save request');
          const directory = assertDirectory(request.name);
          const file = activePath(request.name, request.activeFile);
          const previousContent = regularText(file);
          let nextName = request.name;
          if (request.activeFile === SKILL_EDITOR_MAIN_FILE) {
            const yamlError = validateFrontmatterYaml(request.content);
            if (yamlError) throw new Error(yamlError);
            nextName = parseSkillMeta(request.content).name?.trim() ?? '';
            if (!isValidSkillName(nextName)) throw new Error('SKILL.md needs a valid name in its frontmatter');
            if (nextName !== request.name) {
              try { fs.lstatSync(skillDirPath(nextName)); throw new Error(`A skill named "${nextName}" already exists`); }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            }
          }
          let draft = request.commandDraft;
          const previous = readSkillCommandFile(directory);
          if (draft !== null) {
            const checked = validateSkillCommandDraft(draft);
            if (!checked.ok) throw new Error(checked.error);
            draft = checked.value;
            if (reservedAliases.has(draft.alias)) throw new Error(`Command alias ${draft.alias} is reserved`);
            if (!previous.ok) throw new Error(previous.error);
            const catalog = readSkillCommandCatalog(skillsCollectionDir());
            if (!catalog.ok) throw new Error(catalog.error);
            // The prospective ID is only for validation, never persisted.
            const other = catalog.value.filter(entry => entry.skillName !== request.name);
            if (other.some(entry => entry.command.alias === draft!.alias)) throw new Error(`Command alias "${draft.alias}" conflicts with another skill`);
            const error = validateSkillCommandCatalog(other);
            if (error) throw new Error(error);
          }
          const contentDirty = previousContent !== request.content;
          const commandDirty = !previous.ok || !sameCommand(previous.value, draft);
          if (contentDirty) {
            // A rename may succeed before the content write fails. Reconcile its actual location.
            result.contentChanged = true; // Conservatively refresh consumers if readback becomes uncertain.
            let contentError: string | undefined;
            try {
              const saved = request.activeFile === SKILL_EDITOR_MAIN_FILE
                ? await skillEditorMutations.update(request.name, request.content)
                : await skillEditorMutations.writeFile(request.name, request.activeFile, request.content);
              if (!saved.ok) contentError = saved.error ?? 'Content save failed';
            } catch (error) { contentError = (error as Error).message; }
            if (nextName !== request.name) {
              try {
                const oldExists = present(directory);
                const newExists = present(skillDirPath(nextName));
                if (!oldExists && newExists) result.name = nextName;
                else if (!oldExists || newExists) throw new Error('Cannot establish skill location after rename');
              } catch (error) { result.uncertain = true; throw error; }
            }
            let actual: string;
            try { actual = regularText(activePath(result.name, request.activeFile)); }
            catch (error) { result.uncertain = true; throw error; }
            result.contentChanged = actual !== previousContent || result.name !== request.name;
            result.saved.content = actual === request.content;
            if (contentError || !result.saved.content) throw new Error(contentError ?? 'Content readback did not match');
          } else result.saved.content = true;
          if (commandDirty) {
            result.commandChanged = true;
            const saved = commands.saveWithinMutation(result.name, draft);
            const actual = readSkillCommandFile(skillDirPath(result.name));
            if (!actual.ok) { result.uncertain = true; throw new Error(actual.error); }
            result.commandChanged = !previous.ok || !sameCommand(previous.value, actual.value);
            result.saved.command = sameCommand(actual.value, draft);
            if (!saved.ok || !result.saved.command) throw new Error(!saved.ok ? saved.error : 'Command readback did not match');
          } else result.saved.command = true;
          result.ok = true;
        } catch (error) {
          result.error = (error as Error).message;
          log.error('skills', `editor save failed skill=${request?.name} actual=${result.name} uncertain=${!!result.uncertain}: ${result.error}`);
        }
        return result;
      });
    },
  };
}
