import path from 'path';
import type { Connection } from '@shared/types';
import { createConnector } from '../../connector';
import { shellSingleQuote } from '../../connector/file-utils';
import type { Connector } from '../../connector/types';

const MAX_OUTPUT = 100 * 1024; // 100KB — truncate tool output to keep tokens sane

export interface ToolExecutor {
  execute(name: string, input: Record<string, unknown>, cwd: string): Promise<string>;
}

export function createToolExecutor(connection: Connection): ToolExecutor {
  const connector = createConnector(connection);

  return {
    async execute(name, input, cwd) {
      switch (name) {
        case 'Read':  return readTool(connector, cwd, input);
        case 'Grep':  return grepTool(connector, cwd, input);
        case 'Glob':  return globTool(connector, cwd, input);
        case 'Ls':    return lsTool(connector, cwd, input);
        case 'Bash':  return bashTool(connector, cwd, input);
        case 'Edit':  return editTool(connector, cwd, input);
        case 'Write': return writeTool(connector, cwd, input);
        default:      throw new Error(`Unknown tool: ${name}`);
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

async function run(c: Connector, cwd: string, cmd: string): Promise<string> {
  const { stdout, stderr } = await c.exec(cwd, cmd);
  if (stderr && !stdout) throw new Error(stderr.trim());
  return truncate(stderr ? `${stdout}\n[stderr]\n${stderr}` : stdout);
}

async function readTool(c: Connector, cwd: string, input: Record<string, unknown>): Promise<string> {
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
  return run(c, cwd, cmd);
}

async function grepTool(c: Connector, cwd: string, input: Record<string, unknown>): Promise<string> {
  const pattern = String(input.pattern ?? '');
  const where = input.path ? resolvePath(cwd, String(input.path)) : '.';
  const mode = String(input.output_mode ?? 'files_with_matches');
  const glob = input.glob ? String(input.glob) : undefined;
  const insensitive = input.case_insensitive ? '-i' : '';

  const flags: string[] = [insensitive];
  if (mode === 'files_with_matches') flags.push('-l');
  else if (mode === 'count') flags.push('-c');
  else flags.push('-n');
  if (glob) flags.push(`--glob ${q(glob)}`);

  const cmd = `rg ${flags.filter(Boolean).join(' ')} ${q(pattern)} ${q(where)} 2>&1 | head -500 || true`;
  return run(c, cwd, cmd);
}

async function globTool(c: Connector, cwd: string, input: Record<string, unknown>): Promise<string> {
  const pattern = String(input.pattern ?? '');
  const base = input.path ? resolvePath(cwd, String(input.path)) : cwd;
  // Use bash globstar to evaluate the pattern; return paths sorted by mtime
  const cmd = `cd ${q(base)} && shopt -s globstar nullglob && printf '%s\\n' ${pattern} 2>/dev/null | head -500`;
  return run(c, cwd, `bash -c ${q(cmd)}`);
}

async function lsTool(c: Connector, cwd: string, input: Record<string, unknown>): Promise<string> {
  const p = resolvePath(cwd, String(input.path ?? '.'));
  return run(c, cwd, `ls -la ${q(p)}`);
}

async function bashTool(c: Connector, cwd: string, input: Record<string, unknown>): Promise<string> {
  const cmd = String(input.command ?? '');
  return run(c, cwd, cmd);
}

async function editTool(c: Connector, cwd: string, input: Record<string, unknown>): Promise<string> {
  const fp = resolvePath(cwd, String(input.file_path ?? ''));
  const oldStr = String(input.old_string ?? '');
  const newStr = String(input.new_string ?? '');
  const replaceAll = input.replace_all === true;

  if (oldStr.length === 0) throw new Error('old_string must not be empty');

  const { stdout } = await c.exec(cwd, `cat ${q(fp)}`);
  const content = stdout;

  const count = countOccurrences(content, oldStr);
  if (count === 0) throw new Error(`old_string not found in ${fp}`);
  if (count > 1 && !replaceAll) throw new Error(`old_string appears ${count} times — pass replace_all=true or expand context to make it unique`);

  const updated = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);

  await writeFile(c, cwd, fp, updated);
  return `Edited ${fp} — ${count} occurrence${count === 1 ? '' : 's'} replaced`;
}

async function writeTool(c: Connector, cwd: string, input: Record<string, unknown>): Promise<string> {
  const fp = resolvePath(cwd, String(input.file_path ?? ''));
  const content = String(input.content ?? '');
  await writeFile(c, cwd, fp, content);
  return `Wrote ${fp} (${Buffer.byteLength(content, 'utf8')} bytes)`;
}

async function writeFile(c: Connector, cwd: string, fp: string, content: string): Promise<void> {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  // base64 → file, via stdin-less echo pipeline
  const cmd = `printf %s ${q(b64)} | base64 -d > ${q(fp)}`;
  const { stderr } = await c.exec(cwd, cmd);
  if (stderr) throw new Error(stderr.trim());
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { count++; i += needle.length; }
  return count;
}
