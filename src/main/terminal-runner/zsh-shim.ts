import { createHash, randomUUID } from 'crypto';
import type { ExecResult } from '../connector';
import { shellSingleQuote } from '../connector/file-utils';

export const ZSH_SHIM_VERSION_MARKER = 'shelf-zsh-shim-v1';

export const ZSH_SHIM_CONTENT = [
  '# shelf-zsh-shim-v1',
  'if [[ -n ${SHELF_ORIGINAL_ZDOTDIR:-} ]]; then',
  '  export ZDOTDIR="$SHELF_ORIGINAL_ZDOTDIR"',
  '  [[ -r "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"',
  'else',
  '  unset ZDOTDIR',
  '  [[ -r "$HOME/.zshenv" ]] && source "$HOME/.zshenv"',
  'fi',
  'unset SHELF_ORIGINAL_ZDOTDIR',
  '',
  'autoload -Uz add-zsh-hook',
  'function __shelf_terminal_init() {',
  '  add-zsh-hook -d precmd __shelf_terminal_init',
  '  local __shelf_runner_token="$SHELF_INIT_RUNNER_READY"',
  '  if [[ -z "$SHELF_HISTORY_FILE" ]] || ! builtin fc -p "$SHELF_HISTORY_FILE" || [[ "$HISTFILE" != "$SHELF_HISTORY_FILE" ]]; then',
  '    __shelf_runner_token="$SHELF_INIT_RUNNER_UNCONFIRMED"',
  '  fi',
  '  (( HISTSIZE > 0 )) || HISTSIZE=10000',
  '  (( SAVEHIST > 0 )) || SAVEHIST=10000',
  "  builtin printf '\\033]6973;terminal-init;1;%s\\007' \"$__shelf_runner_token\"",
  '',
  '  local __shelf_directive',
  '  IFS= read -r __shelf_directive',
  '  if [[ "$__shelf_directive" == ": __SHELF_INIT_DIRECTIVE__ ${SHELF_INIT_NONCE} normal" && -n "$SHELF_INIT_SCRIPT" ]]; then',
  '    builtin eval -- "$SHELF_INIT_SCRIPT"',
  '    local __shelf_status=$?',
  '    if (( __shelf_status == 0 )); then',
  "      builtin printf '\\033]6973;terminal-init;1;%s\\007' \"$SHELF_INIT_SCRIPT_SUCCESS\"",
  '    elif (( __shelf_status == 130 )); then',
  "      builtin printf '\\033]6973;terminal-init;1;%s\\007' \"$SHELF_INIT_SCRIPT_CANCELLED\"",
  '    else',
  "      builtin printf '\\033]6973;terminal-init;1;%s\\007' \"$SHELF_INIT_SCRIPT_FAILURE\"",
  '    fi',
  '  fi',
  '',
  '  unset SHELF_INIT_NONCE SHELF_INIT_RUNNER_READY SHELF_INIT_RUNNER_UNCONFIRMED',
  '  unset SHELF_INIT_SCRIPT SHELF_INIT_SCRIPT_SUCCESS SHELF_INIT_SCRIPT_FAILURE SHELF_INIT_SCRIPT_CANCELLED',
  '  unset SHELF_HISTORY_FILE __shelf_runner_token __shelf_directive __shelf_status',
  '  unfunction __shelf_terminal_init',
  '}',
  'add-zsh-hook precmd __shelf_terminal_init',
  '',
].join('\n');

export const ZSH_SHIM_SHA256 = createHash('sha256').update(ZSH_SHIM_CONTENT).digest('hex');

interface ZshShimRuntime {
  exec(cwd: string, cmd: string): Promise<ExecResult>;
  putFile(remotePath: string, buffer: Buffer): Promise<void>;
}

const installs = new WeakMap<object, Map<string, Promise<void>>>();

export function installZshShim(
  runtime: ZshShimRuntime,
  home: string,
  shimPath: string,
): Promise<void> {
  let byPath = installs.get(runtime);
  if (!byPath) {
    byPath = new Map();
    installs.set(runtime, byPath);
  }
  let pending = byPath.get(shimPath);
  if (!pending) {
    pending = installOnce(runtime, home, shimPath);
    byPath.set(shimPath, pending);
  }
  return pending;
}

async function installOnce(runtime: ZshShimRuntime, home: string, shimPath: string): Promise<void> {
  const quotedPath = shellSingleQuote(shimPath);
  const verify = [
    `grep -F -q -- ${shellSingleQuote(ZSH_SHIM_VERSION_MARKER)} ${quotedPath}`,
    `__shelf_hash=$(if command -v sha256sum >/dev/null 2>&1; then sha256sum ${quotedPath} | awk '{print $1}'; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 ${quotedPath} | awk '{print $1}'; elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 ${quotedPath} | awk '{print $NF}'; else exit 1; fi)`,
    `[ "$__shelf_hash" = ${shellSingleQuote(ZSH_SHIM_SHA256)} ]`,
    'unset __shelf_hash',
  ].join(' && ');
  try {
    await runtime.exec(home, verify);
    return;
  } catch {
    // Versioned target is absent; install through an app-owned temporary path.
  }

  const temporaryPath = `${shimPath}.tmp-${randomUUID()}`;
  await runtime.putFile(temporaryPath, Buffer.from(ZSH_SHIM_CONTENT, 'utf8'));
  const shimDir = shimPath.slice(0, shimPath.lastIndexOf('/'));
  await runtime.exec(home, [
    'umask 077',
    `mkdir -p ${shellSingleQuote(shimDir)}`,
    `if [ ! -e ${shellSingleQuote(shimPath)} ]; then mv ${shellSingleQuote(temporaryPath)} ${shellSingleQuote(shimPath)}; else rm -f ${shellSingleQuote(temporaryPath)}; fi`,
    verify,
  ].join(' && '));
}
