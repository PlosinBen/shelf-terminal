/**
 * Types shared across the OpenAI-compat agent engine and its adapters. Keep
 * pure — this file must not import anything electron- or main-specific so it
 * can be bundled into agent-server (remote) too.
 */

export interface ModelInfo {
  id: string;
  displayName: string;
  contextWindow: number;
  vision: boolean;
  effortLevels?: string[];
}

export interface SlashCommand {
  name: string;
  description: string;
}

/** How the UI should surface "this provider needs credentials" to the user.
 * Discriminated by `kind`; each branch declares what the UI should render
 * and what command/URL to link to. */
export type AuthMethod =
  | {
      kind: 'api-key';
      /** Environment variable the backend also reads as a fallback. */
      envVar: string;
      /** Optional link to where the user obtains the key. */
      setupUrl?: string;
      /** Placeholder for the input field (e.g. "sk-..." / "AIza..."). */
      placeholder?: string;
    }
  | {
      kind: 'oauth';
      /** Ordered list of ways the user can sign in; UI renders them as bullets. */
      instructions: Array<{ label: string; command?: string }>;
    }
  | {
      kind: 'sdk-managed';
      instructions: Array<{ label: string; command?: string }>;
    }
  | { kind: 'none' };

/** Source of an OpenAI-compat API credential. Static = API key from file/env.
 * Dynamic = token refreshed per request (e.g. Copilot session). */
export type CredentialSource =
  | { type: 'static'; envVar: string }
  | { type: 'dynamic'; resolve: () => Promise<{ apiKey: string; baseURL?: string }> };

export type ModelCatalog =
  | { type: 'static'; list: ModelInfo[] }
  | {
      type: 'fetch';
      /** Path appended to adapter.baseURL or full URL. */
      url: string;
      /** Optional custom parser — defaults to OpenAI's `{data:[...]}` shape. */
      parse?: (raw: unknown) => ModelInfo[];
    };

/** Declarative description of a single OpenAI-compat provider. Adapters are
 * intentionally pure data — no methods, no side effects — so they can be
 * bundled into the remote agent-server unchanged. */
export interface OpenAIAdapter {
  id: string;
  displayName: string;
  baseURL: string;
  defaultModel: string;
  defaultHeaders?: Record<string, string>;
  credential: CredentialSource;
  models: ModelCatalog;
  authMethod: AuthMethod;
  /** Peek HTTP response headers for quota / rate-limit info. Optional. */
  fetchInterceptor?: (response: Response) => void;
}
