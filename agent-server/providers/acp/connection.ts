// ACP connection lifecycle — the transport half of the shared acp/ toolkit.
//
// Semantics-free: opens an ACP CLIENT connection to an agent, either over a
// spawned child process's stdio (production: codex-acp) or in-process against a
// mock AgentApp (tests). Knows nothing about codex specifics.

import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  client,
  ndJsonStream,
  methods,
  type AgentApp,
  type ClientContext,
  type Stream,
  type ClientRequestHandlersByMethod,
} from '@agentclientprotocol/sdk';

/** Handle over a live ACP connection. `agent` drives agent-side methods. */
export interface AcpConnection {
  /** Client context: buildSession(), request(), notify(). */
  readonly agent: ClientContext;
  /** Resolves when the connection closes (stream end / child exit). */
  readonly closed: Promise<void>;
  /** Aborts when the connection closes. */
  readonly signal: AbortSignal;
  /** Close the connection (and the child process, if any). */
  close(error?: unknown): void;
}

/** Handler for `session/request_permission` (Phase 2 wires this to the wire). */
export type PermissionHandler = ClientRequestHandlersByMethod[typeof methods.client.session.requestPermission];

export interface OpenAcpConnectionOptions {
  name?: string;
  /** Bridges an agent permission request to the client UI. Omit → default deny. */
  onRequestPermission?: PermissionHandler;
}

/**
 * Open an ACP client connection to `target` (a stdio `Stream` for a spawned
 * agent, or an in-process `AgentApp` for tests). Registers client-side handlers
 * BEFORE connecting.
 */
export function openAcpConnection(
  target: Stream | AgentApp,
  opts: OpenAcpConnectionOptions = {},
): AcpConnection {
  const app = client({ name: opts.name ?? 'shelf' });
  if (opts.onRequestPermission) {
    app.onRequest(methods.client.session.requestPermission, opts.onRequestPermission);
  }
  // Overload resolves by runtime type (Stream vs AgentApp) — the SDK accepts both.
  const conn = app.connect(target as Stream);
  return {
    agent: conn.agent,
    closed: conn.closed,
    signal: conn.signal,
    close: (error?: unknown) => conn.close(error),
  };
}

/** A spawned agent child + its ACP stdio stream. */
export interface SpawnedAgent {
  child: ChildProcess;
  stream: Stream;
}

/**
 * Spawn an ACP agent binary and wrap its stdio as an ndjson `Stream`.
 * stdin (we write requests) → agent; stdout (we read updates) ← agent.
 * stderr is left inheritable for diagnostics. The child is a DIRECT child of
 * this process (no detach), so it dies with the agent-server tree.
 */
export function spawnAgentStdio(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): SpawnedAgent {
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (!child.stdout || !child.stdin) {
    child.kill();
    throw new Error(`spawnAgentStdio: child "${command}" has no stdio pipes`);
  }
  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const readable = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(writable, readable);
  return { child, stream };
}
