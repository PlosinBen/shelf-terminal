import { afterEach, describe, expect, it } from 'vitest';
import * as pty from 'node-pty';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BASH_PROMPT_COMMAND } from './runners';
import { ZSH_SHIM_CONTENT } from './zsh-shim';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('effective local shell history isolation', () => {
  it('persists and reuses zsh history per project without crossing namespaces', async () => {
    if (!fs.existsSync('/bin/zsh')) return;
    const root = makeTempDir();
    const shimDir = path.join(root, 'shim');
    const originalZdotdir = path.join(root, 'original-zdotdir');
    fs.mkdirSync(shimDir, { recursive: true });
    fs.mkdirSync(originalZdotdir, { recursive: true });
    fs.writeFileSync(path.join(shimDir, '.zshenv'), ZSH_SHIM_CONTENT);
    const globalHistory = path.join(root, 'global-zsh-history');
    fs.writeFileSync(globalHistory, 'GLOBAL_BEFORE\n');
    fs.writeFileSync(
      path.join(originalZdotdir, '.zshenv'),
      `HISTFILE=${JSON.stringify(globalHistory)}\nHISTSIZE=10000\nSAVEHIST=10000\n`,
    );
    const projectA = path.join(root, 'project-a-history');
    const projectB = path.join(root, 'project-b-history');
    fs.writeFileSync(projectA, '');
    fs.writeFileSync(projectB, '');

    await runShell('/bin/zsh', ['-l'], zshEnv(root, shimDir, projectA, originalZdotdir), 'echo ZSH_PROJECT_A');
    await runShell('/bin/zsh', ['-l'], zshEnv(root, shimDir, projectB, originalZdotdir), 'echo ZSH_PROJECT_B');
    await runShell('/bin/zsh', ['-l'], zshEnv(root, shimDir, projectA, originalZdotdir), 'echo ZSH_PROJECT_A_REUSED');

    const a = fs.readFileSync(projectA, 'utf8');
    const b = fs.readFileSync(projectB, 'utf8');
    expect(a).toContain('echo ZSH_PROJECT_A');
    expect(a).toContain('echo ZSH_PROJECT_A_REUSED');
    expect(a).not.toContain('ZSH_PROJECT_B');
    expect(b).toContain('echo ZSH_PROJECT_B');
    expect(b).not.toContain('ZSH_PROJECT_A');
    expect(fs.readFileSync(globalHistory, 'utf8')).toBe('GLOBAL_BEFORE\n');
  }, 20_000);

  it('persists and reuses bash history per project without crossing namespaces', async () => {
    if (!fs.existsSync('/bin/bash')) return;
    const root = makeTempDir();
    const projectA = path.join(root, 'project-a-history');
    const projectB = path.join(root, 'project-b-history');
    fs.writeFileSync(projectA, '');
    fs.writeFileSync(projectB, '');

    await runShell('/bin/bash', ['--noprofile', '--norc', '-i'], bashEnv(root, projectA), 'echo BASH_PROJECT_A');
    await runShell('/bin/bash', ['--noprofile', '--norc', '-i'], bashEnv(root, projectB), 'echo BASH_PROJECT_B');
    await runShell('/bin/bash', ['--noprofile', '--norc', '-i'], bashEnv(root, projectA), 'echo BASH_PROJECT_A_REUSED');

    const a = fs.readFileSync(projectA, 'utf8');
    const b = fs.readFileSync(projectB, 'utf8');
    expect(a).toContain('echo BASH_PROJECT_A');
    expect(a).toContain('echo BASH_PROJECT_A_REUSED');
    expect(a).not.toContain('BASH_PROJECT_B');
    expect(b).toContain('echo BASH_PROJECT_B');
    expect(b).not.toContain('BASH_PROJECT_A');
  }, 20_000);
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-history-test-'));
  tempDirs.push(dir);
  return dir;
}

function baseEnv(home: string): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    HOME: home,
    TERM: 'xterm-256color',
    SHELF_INIT_NONCE: 'fixed_nonce',
    SHELF_INIT_RUNNER_READY: 'runner_ready_token',
    SHELF_INIT_RUNNER_UNCONFIRMED: 'runner_unconfirmed_token',
    SHELF_INIT_SCRIPT: '',
    SHELF_INIT_SCRIPT_SUCCESS: 'init_success_token',
    SHELF_INIT_SCRIPT_FAILURE: 'init_failure_token',
    SHELF_INIT_SCRIPT_CANCELLED: 'init_cancelled_token',
  };
}

function zshEnv(
  home: string,
  shimDir: string,
  historyFile: string,
  originalZdotdir: string,
): Record<string, string> {
  return {
    ...baseEnv(home),
    ZDOTDIR: shimDir,
    SHELF_ORIGINAL_ZDOTDIR: originalZdotdir,
    SHELF_HISTORY_FILE: historyFile,
  };
}

function bashEnv(home: string, historyFile: string): Record<string, string> {
  return {
    ...baseEnv(home),
    HISTFILE: historyFile,
    SHELF_HISTORY_FILE: historyFile,
    SHELF_ORIGINAL_PROMPT_COMMAND: '',
    PROMPT_COMMAND: BASH_PROMPT_COMMAND,
  };
}

function runShell(
  executable: string,
  args: string[],
  env: Record<string, string>,
  command: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const shell = pty.spawn(executable, args, {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: env.HOME, env,
    });
    let output = '';
    let commandSent = false;
    const timeout = setTimeout(() => {
      shell.kill();
      reject(new Error(`shell history test timed out: ${output.slice(-1000)}`));
    }, 8_000);
    shell.onData((data) => {
      output += data;
      if (!commandSent && output.includes('runner_ready_token')) {
        commandSent = true;
        shell.write(`: __SHELF_INIT_DIRECTIVE__ fixed_nonce normal\n${command}\nexit\n`);
      }
    });
    shell.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode === 0) resolve(output);
      else reject(new Error(`shell exited ${exitCode}: ${output.slice(-1000)}`));
    });
  });
}
