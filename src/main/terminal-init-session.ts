import type { Shell } from './connector';
import { ShelfOscRouter, type ShelfOscFrame } from '@shared/shelf-osc';
import {
  TERMINAL_INIT_OSC_ROUTE,
  TERMINAL_INIT_PHASE,
  TERMINAL_INIT_RESULT,
  decodeTerminalInitFrame,
  type TerminalInitPhase,
} from '@shared/terminal-init-osc';
import {
  EXTERNAL_URL_OSC_ROUTE,
  decodeExternalUrlOscFrame,
} from '@shared/external-url-osc';

const RUNNER_FALLBACK_MS = 10_000;
const HIDDEN_CAPTURE_MAX_BYTES = 32 * 1024;
const HIDDEN_CAPTURE_TRUNCATED = '\r\n[Earlier hidden terminal output truncated]\r\n';

export const TERMINAL_SESSION_PHASE = {
  runnerInitializing: 'runner-initializing',
  initScript: 'init-script',
  tabCommand: 'tab-command',
  ready: 'ready',
  failed: 'failed',
  disposed: 'disposed',
} as const;

export type TerminalSessionPhase = typeof TERMINAL_SESSION_PHASE[keyof typeof TERMINAL_SESSION_PHASE];
export type TerminalInitMode = 'explicit' | 'native';

export interface TerminalInitSessionOptions {
  readonly shell: Shell;
  readonly nonce: string;
  readonly mode: TerminalInitMode;
  readonly directiveMode?: 'shell' | 'none';
  readonly initScript?: string;
  readonly tabCmd?: string;
  readonly onVisibleData: (data: string) => void;
  readonly onPhase: (phase: TerminalSessionPhase) => void;
  readonly onStartupFailure: (reason: string) => void;
  readonly onProtocolAnomaly?: (reason: string) => void;
  readonly onIsolationUnconfirmed?: () => void;
  readonly onExternalUrl?: (url: string) => void;
}

/** Main-owned input/output gate and automatic-command state machine. */
export class TerminalInitSession {
  private readonly router = new ShelfOscRouter();
  private phase: TerminalSessionPhase = TERMINAL_SESSION_PHASE.runnerInitializing;
  private hiddenCapture = '';
  private hiddenCaptureTruncated = false;
  private fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false;

  constructor(private readonly options: TerminalInitSessionOptions) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.options.onPhase(this.phase);
    if (this.options.mode === 'native') {
      this.discardHiddenCapture();
      this.submitNativeAutomaticCommands();
      return;
    }
    if (this.options.directiveMode !== 'none') {
      this.fallbackTimer = setTimeout(() => this.enterFallback(), RUNNER_FALLBACK_MS);
    }
  }

  handleData(data: string): void {
    if (this.phase === TERMINAL_SESSION_PHASE.disposed) return;
    const result = this.router.push(data, {
      [TERMINAL_INIT_OSC_ROUTE]: (frame) => this.handleTerminalInitFrame(frame),
      [EXTERNAL_URL_OSC_ROUTE]: (frame) => this.handleExternalUrlFrame(frame),
    });
    for (const anomaly of result.anomalies) {
      this.options.onProtocolAnomaly?.(`${anomaly.kind}:${anomaly.route ?? 'unknown'}`);
    }
    if (!result.visible) return;

    if (this.phase === TERMINAL_SESSION_PHASE.runnerInitializing) {
      this.captureHidden(result.visible);
    } else {
      this.options.onVisibleData(result.visible);
    }
  }

  currentPhase(): TerminalSessionPhase {
    return this.phase;
  }

  writeUser(data: string): void {
    switch (this.phase) {
      case TERMINAL_SESSION_PHASE.initScript: {
        const interrupts = [...data].filter((character) => character === '\x03').join('');
        if (interrupts) this.options.shell.write(interrupts);
        return;
      }
      case TERMINAL_SESSION_PHASE.ready:
        this.options.shell.write(data);
        return;
      default:
        return;
    }
  }

  failStartup(reason: string): void {
    if (this.phase === TERMINAL_SESSION_PHASE.failed
      || this.phase === TERMINAL_SESSION_PHASE.disposed) return;
    this.clearFallback();
    const diagnostic = this.takeHiddenCapture();
    if (diagnostic) this.options.onVisibleData(diagnostic);
    this.setPhase(TERMINAL_SESSION_PHASE.failed);
    this.options.onStartupFailure(reason);
  }

  dispose(): void {
    if (this.phase === TERMINAL_SESSION_PHASE.disposed) return;
    this.clearFallback();
    this.discardHiddenCapture();
    this.setPhase(TERMINAL_SESSION_PHASE.disposed);
  }

  private handleTerminalInitFrame(frame: ShelfOscFrame): boolean {
    if (this.phase === TERMINAL_SESSION_PHASE.ready
      || this.phase === TERMINAL_SESSION_PHASE.failed
      || this.phase === TERMINAL_SESSION_PHASE.disposed) return false;

    const expectedPhase = this.expectedProtocolPhase();
    if (!expectedPhase) return false;
    const decoded = decodeTerminalInitFrame(frame, this.options.nonce, expectedPhase);
    if (!decoded.ok) {
      if (decoded.reason === 'unsupported-version') return false;
      this.options.onProtocolAnomaly?.(decoded.reason);
      return true;
    }

    if (decoded.payload.phase === TERMINAL_INIT_PHASE.runner) {
      this.onRunnerResult(decoded.payload.result);
    } else {
      this.onInitScriptResult(decoded.payload.result);
    }
    return true;
  }

  private handleExternalUrlFrame(frame: ShelfOscFrame): boolean {
    const decoded = decodeExternalUrlOscFrame(frame);
    if (!decoded.ok && decoded.reason === 'unsupported-version') return false;
    if (!decoded.ok) {
      this.options.onProtocolAnomaly?.('external-url:invalid-payload');
      return true;
    }
    if (this.phase !== TERMINAL_SESSION_PHASE.runnerInitializing) {
      this.options.onExternalUrl?.(decoded.url);
    }
    return true;
  }

  private expectedProtocolPhase(): TerminalInitPhase | undefined {
    if (this.phase === TERMINAL_SESSION_PHASE.runnerInitializing) return TERMINAL_INIT_PHASE.runner;
    if (this.phase === TERMINAL_SESSION_PHASE.initScript) return TERMINAL_INIT_PHASE.initScript;
    return undefined;
  }

  private onRunnerResult(result: string): void {
    this.clearFallback();
    this.discardHiddenCapture();
    if (result === TERMINAL_INIT_RESULT.isolationUnconfirmed) {
      this.options.onIsolationUnconfirmed?.();
    }

    const normalDirective = this.options.directiveMode === 'none' ? '' : this.directive('normal');
    if (this.options.initScript) {
      this.setPhase(TERMINAL_SESSION_PHASE.initScript);
      this.options.shell.write(normalDirective);
      return;
    }

    const command = `${normalDirective}${line(this.options.tabCmd)}`;
    if (command) this.options.shell.write(command);
    this.setPhase(TERMINAL_SESSION_PHASE.ready);
  }

  private onInitScriptResult(result: string): void {
    if (result === TERMINAL_INIT_RESULT.success && this.options.tabCmd) {
      this.setPhase(TERMINAL_SESSION_PHASE.tabCommand);
      this.options.shell.write(line(this.options.tabCmd));
    }
    this.setPhase(TERMINAL_SESSION_PHASE.ready);
  }

  private submitNativeAutomaticCommands(): void {
    const commands = `${line(this.options.initScript)}${line(this.options.tabCmd)}`;
    if (commands) this.options.shell.write(commands);
    this.setPhase(TERMINAL_SESSION_PHASE.ready);
  }

  private enterFallback(): void {
    if (this.phase !== TERMINAL_SESSION_PHASE.runnerInitializing) return;
    this.fallbackTimer = undefined;
    this.discardHiddenCapture();
    const commands = `${this.directive('fallback')}${line(this.options.initScript)}${line(this.options.tabCmd)}`;
    this.options.shell.write(commands);
    this.setPhase(TERMINAL_SESSION_PHASE.ready);
  }

  private directive(result: 'normal' | 'fallback'): string {
    return `: __SHELF_INIT_DIRECTIVE__ ${this.options.nonce} ${result}\n`;
  }

  private setPhase(phase: TerminalSessionPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.options.onPhase(phase);
  }

  private clearFallback(): void {
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    this.fallbackTimer = undefined;
  }

  private captureHidden(data: string): void {
    if (this.hiddenCaptureTruncated) return;
    const combined = this.hiddenCapture + data;
    if (Buffer.byteLength(combined, 'utf8') <= HIDDEN_CAPTURE_MAX_BYTES) {
      this.hiddenCapture = combined;
      return;
    }
    const bytes = Buffer.from(combined, 'utf8').subarray(0, HIDDEN_CAPTURE_MAX_BYTES);
    this.hiddenCapture = Buffer.from(bytes).toString('utf8') + HIDDEN_CAPTURE_TRUNCATED;
    this.hiddenCaptureTruncated = true;
  }

  private takeHiddenCapture(): string {
    const capture = this.hiddenCapture;
    this.discardHiddenCapture();
    return capture;
  }

  private discardHiddenCapture(): void {
    this.hiddenCapture = '';
    this.hiddenCaptureTruncated = false;
  }
}

function line(command: string | undefined): string {
  return command ? `${command}\n` : '';
}
