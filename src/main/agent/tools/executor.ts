import path from 'path';
import { shellSingleQuote } from '../../connector/file-utils';
import { log } from '@shared/logger';

const MAX_OUTPUT = 100 * 1024; // 100KB — truncate tool output to keep tokens sane

export type ExecFn = (cwd: string, cmd: string) => Promise<{ stdout: string; stderr: string }>;

export interface ToolExecutor {
  execute(name: string, input: Record<string, unknown>, cwd: string): Promise<string>;
  /** Read the project's AGENTS.md (or CLAUDE.md fallback) from the git repo
   * root. Bypasses the tool permission system — instruction files are part of
   * the system prompt, not user-visible tool calls. */
  loadProjectInstructions(cwd: string): Promise<string | null>;
}

export function createToolExecutor(exec: ExecFn): ToolExecutor {
  return {
    async execute(name, input, cwd) {
      switch (name) {
        case 'Read':  return readTool(exec, cwd, input);
        case 'Grep':  return grepTool(exec, cwd, input);
        case 'Glob':  return globTool(exec, cwd, input);
        case 'Ls':    return lsTool(exec, cwd, input);
        case 'Bash':  return bashTool(exec, cwd, input);
        case 'Edit':  return editTool(exec, cwd, input);
        case 'Write': return writeTool(exec, cwd, input);
        default:      throw new Error(`Unknown tool: ${name}`);
      }
    },
    async loadProjectInstructions(cwd) {
      const script = [
        'root=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null || echo "$1")',
        'for f in AGENTS.md CLAUDE.md; do',
        '  if [ -r "$root/$f" ]; then cat "$root/$f"; exit 0; fi',
        'done',
        'exit 0',
      ].join('\n');
      try {
        const { stdout } = await exec(cwd, `sh -c ${q(script)} -- ${q(cwd)}`);
        return stdout.trim().length > 0 ? stdout : null;
      } catch (err: any) {
        log.info('tool-executor', `Failed to load project instructions: ${err?.message}`);
        return null;
      }
    },
  };
}

function resolvePath(cwd: string, p: string): string {
  if (p.startsWith('/') || p.startsWith('~')) return p;
  return path.posix.join(cwd, p);
}

function q(s: string): string {
  return shellSingleQuote(s);
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return s.slice(0, MAX_OUTPUT) + `\n\n[output truncated, ${s.length - MAX_OUTPUT} more bytes]`;
}

async function run(exec: ExecFn, cwd: string, cmd: string): Promise<string> {
  const { stdout, stderr } = await exec(cwd, cmd);
  if (stderr && !stdout) throw new Error(stderr.trim());
  const out = truncate(stderr ? `${stdout}\n[stderr]\n${stderr}` : stdout);
  return out.trim() === '' ? '(no output)' : out;
}

async function readTool(exec: ExecFn, cwd: string, input: Record<string, unknown>): Promise<string> {
  const fp = resolvePath(cwd, String(input.file_path ?? ''));
  const offset = typeof input.offset === 'number' ? Math.max(1, input.offset) : undefined;
  const limit  = typeof input.limit  === 'number' ? Math.max(1, input.limit)  : undefined;

  let cmd: string;
  if (offset != null && limit != null) {
    cmd = `sed -n '${offset},${offset + limit - 1}p' ${q(fp)}`;
  } else if (offset != null) {
    cmd = `tail -n +${offset} ${q(fp)}`;
  } else if (limit != null) {
    cmd = `head -n ${limit} ${q(fp)}`;
  } else {
    cmd = `cat ${q(fp)}`;
  }
  return run(exec, cwd, cmd);
}

async function grepTool(exec: ExecFn, cwd: string, input: Record<string, unknown>): Promise<string> {
  const pattern = String(input.pattern ?? '');
  const where = input.path ? resolvePath(cwd, String(input.path)) : '.';
  const mode = String(input.output_mode ?? 'files_with_matches');
  const glob = input.glob ? String(input.glob) : undefined;
  const ci = input.case_insensitive ? '-i' : '';

  const rgFlags: string[] = [ci];
  if (mode === 'files_with_matches') rgFlags.push('-l');
  else if (mode === 'count') rgFlags.push('-c');
  else rgFlags.push('-n');
  if (glob) rgFlags.push(`--glob ${q(glob)}`);

  const grepFlags: string[] = [ci, '-rE'];
  if (mode === 'files_with_matches') grepFlags.push('-l');
  else if (mode === 'count') grepFlags.push('-c');
  else grepFlags.push('-n');
  if (glob) grepFlags.push(`--include=${q(glob)}`);

  const rgCmd = `rg ${rgFlags.filter(Boolean).join(' ')} ${q(pattern)} ${q(where)} 2>/dev/null | head -500`;
  const grepCmd = `grep ${grepFlags.filter(Boolean).join(' ')} ${q(pattern)} ${q(where)} 2>/dev/null | head -500`;
  const cmd = `if command -v rg >/dev/null 2>&1; then ${rgCmd}; else ${grepCmd}; fi || true`;
  return run(exec, cwd, cmd);
}

async function globTool(exec: ExecFn, cwd: string, input: Record<string, unknown>): Promise<string> {
  const pattern = String(input.pattern ?? '');
  const base = input.path ? resolvePath(cwd, String(input.path)) : cwd;

  // Translate glob to find: handle '**/' (recursive) and plain subdir prefixes
  let searchRoot = base;
  let namePart = pattern;
  const doubleIdx = pattern.indexOf('**/');
  if (doubleIdx !== -1) {
    const prefix = pattern.slice(0, doubleIdx).replace(/\/$/, '');
    namePart = pattern.slice(doubleIdx + 3);
    if (prefix) searchRoot = resolvePath(base, prefix);
  } else if (pattern.includes('/')) {
    const lastSlash = pattern.lastIndexOf('/');
    namePart = pattern.slice(lastSlash + 1);
    searchRoot = resolvePath(base, pattern.slice(0, lastSlash));
  }

  const cmd = `find ${q(searchRoot)} -type f -name ${q(namePart)} | head -500`;
  return run(exec, cwd, cmd);
}

async function lsTool(exec: ExecFn, cwd: string, input: Record<string, unknown>): Promise<string> {
  const p = resolvePath(cwd, String(input.path ?? '.'));
  return run(exec, cwd, `ls -la ${q(p)}`);
}

async function bashTool(exec: ExecFn, cwd: string, input: Record<string, unknown>): Promise<string> {
  const cmd = String(input.command ?? '');
  return run(exec, cwd, cmd);
}

async function editTool(exec: ExecFn, cwd: string, input: Record<string, unknown>): Promise<string> {
  const fp = resolvePath(cwd, String(input.file_path ?? ''));
  const oldStr = String(input.old_string ?? '');
  const newStr = String(input.new_string ?? '');
  const replaceAll = input.replace_all === true;

  if (oldStr.length === 0) throw new Error('old_string must not be empty');

  const { stdout } = await exec(cwd, `cat ${q(fp)}`);
  const content = stdout;

  const count = countOccurrences(content, oldStr);
  if (count === 0) throw new Error(`old_string not found in ${fp}`);
  if (count > 1 && !replaceAll) throw new Error(`old_string appears ${count} times — pass replace_all=true or expand context to make it unique`);

  const updated = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);

  await writeFile(exec, cwd, fp, updated);
  return `Edited ${fp} — ${count} occurrence${count === 1 ? '' : 's'} replaced`;
}

async function writeTool(exec: ExecFn, cwd: string, input: Record<string, unknown>): Promise<string> {
  const fp = resolvePath(cwd, String(input.file_path ?? ''));
  const content = String(input.content ?? '');
  await writeFile(exec, cwd, fp, content);
  return `Wrote ${fp} (${Buffer.byteLength(content, 'utf8')} bytes)`;
}

async function writeFile(exec: ExecFn, cwd: string, fp: string, content: string): Promise<void> {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  // base64 → file, via stdin-less echo pipeline
  const cmd = `printf %s ${q(b64)} | base64 -d > ${q(fp)}`;
  const { stderr } = await exec(cwd, cmd);
  if (stderr) throw new Error(stderr.trim());
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { count++; i += needle.length; }
  return count;
}
