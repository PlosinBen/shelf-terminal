import fs from 'fs';
import path from 'path';
import { TextDecoder } from 'util';
import { SKILL_CONTROL_MARKERS } from '@shared/config-backup';
import {
  isValidSkillName,
  parseSkillMeta,
  validateFrontmatterYaml,
} from '../skills-store';

const CONTROL_MARKERS = new Set<string>(SKILL_CONTROL_MARKERS);
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export type SkillPayloadValidation =
  | { valid: true; payloadFiles: string[] }
  | { valid: false; reason: string };

function invalid(reason: string): SkillPayloadValidation {
  return { valid: false, reason };
}

/**
 * Validate one materialized Skill directory for portable Backup/Import use.
 * The returned file list is the exact copy allowlist; local control markers are
 * accepted but omitted. Symlinks are rejected rather than followed so a Skill
 * can never copy bytes from outside its own directory.
 */
export function validateSkillPayload(name: string, directory: string): SkillPayloadValidation {
  if (!isValidSkillName(name)) return invalid(`Invalid Skill name: ${name}`);

  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(directory);
  } catch {
    return invalid('Skill directory is missing');
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return invalid('Skill path must be a regular directory');
  }

  const root = path.resolve(directory);
  const payloadFiles: string[] = [];

  const walk = (current: string, relativeDir: string): string | null => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      return `Cannot read Skill directory: ${error instanceof Error ? error.message : String(error)}`;
    }

    for (const entry of entries) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (!relativeDir && CONTROL_MARKERS.has(entry.name)) continue;

      const absolute = path.resolve(current, entry.name);
      const contained = path.relative(root, absolute);
      if (!contained || contained.startsWith('..') || path.isAbsolute(contained)) {
        return `Path escapes the Skill directory: ${relative}`;
      }

      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(absolute);
      } catch (error) {
        return `Cannot inspect ${relative}: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (stat.isSymbolicLink()) return `Symlinks are not supported: ${relative}`;
      if (stat.isDirectory()) {
        const error = walk(absolute, relative);
        if (error) return error;
      } else if (stat.isFile()) {
        payloadFiles.push(relative);
      } else {
        return `Special files are not supported: ${relative}`;
      }
    }
    return null;
  };

  const walkError = walk(root, '');
  if (walkError) return invalid(walkError);
  if (!payloadFiles.includes('SKILL.md')) return invalid('SKILL.md is required');

  let skillMarkdown: string;
  try {
    skillMarkdown = UTF8_DECODER.decode(fs.readFileSync(path.join(root, 'SKILL.md')));
  } catch (error) {
    return invalid(`SKILL.md must be valid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
  }

  const yamlError = validateFrontmatterYaml(skillMarkdown);
  if (yamlError) return invalid(yamlError);
  const declaredName = parseSkillMeta(skillMarkdown).name?.trim();
  if (!declaredName) return invalid('SKILL.md needs a `name:` in its frontmatter');
  if (!isValidSkillName(declaredName)) {
    return invalid(`Skill name must be lowercase kebab-case (got "${declaredName}")`);
  }
  if (declaredName !== name) {
    return invalid(`SKILL.md name "${declaredName}" does not match folder "${name}"`);
  }

  return { valid: true, payloadFiles: payloadFiles.sort() };
}
