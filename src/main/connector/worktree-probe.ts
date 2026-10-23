import type { Connector } from './types';
import type { WorktreeIdentity } from '@shared/worktree';

export const PathProbe = { DIRECTORY: 'directory', MISSING: 'missing', OTHER: 'other' } as const;
type PathProbeResult = typeof PathProbe[keyof typeof PathProbe];
const q = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
const psq = (value: string) => `'${value.replace(/'/g, "''")}'`;
export function powershellCommand(script: string): string {
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from("$ErrorActionPreference='Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); " + script, 'utf16le').toString('base64')}`;
}
/** Probe on the connector target; never use host fs for a remote checkout. */
export class WorktreeProbe {
  constructor(private connector: Pick<Connector, 'exec'>, private anchor: string, private windows: boolean) {}
  async git(cwd: string, ...args: string[]): Promise<string> {
    const command = this.windows
      ? powershellCommand(`& git ${args.map(psq).join(' ')}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`)
      : `git ${args.map(q).join(' ')}`;
    const output = (await this.connector.exec(cwd, command)).stdout;
    // Windows PowerShell's native-command pipeline appends a line ending to
    // the single NUL-delimited record stream. Remove only that transport suffix.
    return this.windows && args.includes('-z') ? output.replace(/(\0\0)\r?\n$/, '$1') : output;
  }
  async path(path: string): Promise<PathProbeResult> {
    const script = this.windows ? powershellCommand(`
      try { $a=[System.IO.File]::GetAttributes(${psq(path)}); if (($a -band [System.IO.FileAttributes]::Directory) -ne 0) { '${PathProbe.DIRECTORY}' } else { '${PathProbe.OTHER}' } }
      catch [System.IO.FileNotFoundException] { '${PathProbe.MISSING}' }
      catch [System.IO.DirectoryNotFoundException] { '${PathProbe.MISSING}' }
    `) : `
      shelf_probe_path() {
        if [ -d "$1" ]; then
          if [ -r "$1" ] && [ -x "$1" ]; then printf '${PathProbe.DIRECTORY}'; else echo 'Directory is inaccessible' >&2; return 1; fi
        elif [ -e "$1" ] || [ -L "$1" ]; then printf '${PathProbe.OTHER}';
        else
          shelf_parent=$(dirname -- "$1") || return 1
          if [ "$shelf_parent" = "$1" ]; then echo 'Cannot inspect path root' >&2; return 1; fi
          shelf_parent_result=$(shelf_probe_path "$shelf_parent") || return 1
          if [ "$shelf_parent_result" = '${PathProbe.DIRECTORY}' ] || [ "$shelf_parent_result" = '${PathProbe.MISSING}' ]; then printf '${PathProbe.MISSING}';
          else echo 'Path ancestor is not a directory' >&2; return 1; fi
        fi
      }
      shelf_probe_path ${q(path)}`;
    const result = (await this.connector.exec(this.anchor, script)).stdout.trim();
    if (!Object.values(PathProbe).includes(result as PathProbeResult)) throw new Error(`Unexpected path probe result for ${path}: ${result}`);
    return result as PathProbeResult;
  }
  async identity(cwd: string): Promise<WorktreeIdentity | null> {
    if (await this.path(cwd) !== PathProbe.DIRECTORY) return null;
    try {
      const values: string[] = [];
      for (const flag of ['--show-toplevel', '--git-dir', '--git-common-dir']) {
        const value = (await this.git(cwd, 'rev-parse', '--path-format=absolute', flag)).replace(/\r?\n$/, '');
        if (!value || value.includes('\0')) throw new Error(`Invalid Git identity: ${flag}`);
        values.push(value);
      }
      return { checkoutPath: values[0], gitDir: values[1], commonDir: values[2] };
    } catch (error) {
      // Prove a normal non-repository independently: Git is executable and no
      // ancestor contains repository metadata. A broken .git is an error.
      await this.git(this.anchor, '--version');
      let dir = cwd.replace(/[\\/]+$/, '') || '/';
      while (true) {
        if (await this.path(`${dir}/.git`) !== PathProbe.MISSING) throw error;
        if (await this.path(`${dir}/HEAD`) !== PathProbe.MISSING && await this.path(`${dir}/objects`) !== PathProbe.MISSING) throw error;
        const parent = dir.replace(/[\\/][^\\/]*$/, '') || '/';
        if (parent === dir || /^[A-Za-z]:$/.test(dir)) break;
        dir = parent;
      }
      return null;
    }
  }
}
