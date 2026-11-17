import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { isSkillCommandControlPath } from './skill-commands';

/** Correctness digest of one skill's consumption files; errors/symlinks are fatal. */
export function skillPayloadDigest(directory: string): string {
  const root = fs.lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Skill payload must be a regular directory');
  const hash = createHash('sha256');
  let hasInstructions = false;
  const walk = (dir: string, prefix: string) => {
    const names = fs.readdirSync(dir).sort();
    for (const name of names) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (!prefix && (name === '.locked' || name === '.disabled' || isSkillCommandControlPath(name))) continue;
      const file = path.join(dir, name);
      const before = fs.lstatSync(file);
      if (before.isSymbolicLink()) throw new Error(`Skill payload contains symlink: ${relative}`);
      if (before.isDirectory()) { walk(file, relative); continue; }
      if (!before.isFile()) throw new Error(`Skill payload contains special file: ${relative}`);
      const bytes = fs.readFileSync(file);
      const after = fs.lstatSync(file);
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || !after.isFile()) throw new Error(`Skill payload changed while reading: ${relative}`);
      if (relative === 'SKILL.md') hasInstructions = true;
      hash.update(`${Buffer.byteLength(relative)}:`).update(relative).update(`:${bytes.length}:`).update(bytes);
    }
    if (JSON.stringify(fs.readdirSync(dir).sort()) !== JSON.stringify(names)) throw new Error(`Skill payload directory changed while reading: ${prefix}`);
  };
  walk(directory, '');
  if (!hasInstructions) throw new Error('Skill payload has no SKILL.md');
  return hash.digest('hex');
}
