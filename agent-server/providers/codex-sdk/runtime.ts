import { resolveCodexNativeExecutable } from '../codex-shared/runtime';

/** Native `codex` executable path for @openai/codex-sdk's `codexPathOverride`. */
export function resolveCodexSdkCodexPathOverride(
  findNativeExecutable?: () => string | undefined,
): string {
  try {
    return resolveCodexNativeExecutable(findNativeExecutable);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Codex SDK codexPathOverride could not be resolved: ${detail}. Shelf uses the pinned @openai/codex native runtime and does not fall back to PATH.`,
    );
  }
}
