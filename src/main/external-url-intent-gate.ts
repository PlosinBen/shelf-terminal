import {
  EXTERNAL_URL_INTENT_DECISIONS,
  type ExternalUrlIntentDecision,
  type ExternalUrlIntentInput,
  type ExternalUrlIntentRequest,
  type ValidatedExternalUrlIntent,
  validateExternalUrlIntent,
} from '@shared/external-url-intent';

export const EXTERNAL_URL_INTENT_TIMEOUT_MS = 5 * 60_000;

interface ExternalUrlIntentGateDependencies {
  hasWindow: () => boolean;
  sendRequest: (request: ExternalUrlIntentRequest) => void;
  sendClose: (requestId: string) => void;
  copyUrl: (url: string) => void | Promise<void>;
  openUrl: (url: string) => void | Promise<void>;
  logError: (message: string) => void;
}

interface PendingIntent {
  request: ExternalUrlIntentRequest;
  settle: (decision: ExternalUrlIntentDecision) => void;
  timer?: ReturnType<typeof setTimeout>;
}

function destinationLabel(intent: ValidatedExternalUrlIntent): string {
  return intent.destination.kind === 'web-origin'
    ? intent.destination.origin
    : intent.destination.address;
}

function isDecision(value: unknown): value is ExternalUrlIntentDecision {
  return value === EXTERNAL_URL_INTENT_DECISIONS.copy
    || value === EXTERNAL_URL_INTENT_DECISIONS.open
    || value === EXTERNAL_URL_INTENT_DECISIONS.cancel;
}

export class ExternalUrlIntentGate {
  private readonly queue: PendingIntent[] = [];
  private active: PendingIntent | null = null;
  private sequence = 0;

  constructor(private readonly dependencies: ExternalUrlIntentGateDependencies) {}

  request(input: ExternalUrlIntentInput | unknown): Promise<ExternalUrlIntentDecision> {
    const validation = validateExternalUrlIntent(input);
    if (!validation.ok) {
      this.dependencies.logError(`Rejected external URL intent: ${validation.code}`);
      return Promise.reject(new Error(`External URL intent rejected: ${validation.code}`));
    }

    this.sequence += 1;
    const request: ExternalUrlIntentRequest = {
      requestId: `external-url-${this.sequence}`,
      ...validation.intent,
    };

    return new Promise<ExternalUrlIntentDecision>((settle) => {
      this.queue.push({ request, settle });
      this.showNext();
    });
  }

  async resolve(requestId: string, decision: unknown): Promise<void> {
    const pending = this.active;
    if (!pending || pending.request.requestId !== requestId) {
      this.dependencies.logError('External URL decision does not match the active request');
      throw new Error('External URL decision does not match the active request');
    }
    if (!isDecision(decision)) {
      this.dependencies.logError(`Invalid external URL decision for ${requestId}`);
      throw new Error('Invalid external URL decision');
    }

    try {
      if (decision === EXTERNAL_URL_INTENT_DECISIONS.copy) {
        await this.dependencies.copyUrl(pending.request.url);
      } else if (decision === EXTERNAL_URL_INTENT_DECISIONS.open) {
        await this.dependencies.openUrl(pending.request.url);
      }
    } catch (error) {
      this.dependencies.logError(
        `External URL ${decision} action failed for ${destinationLabel(pending.request)}`,
      );
      throw error;
    }

    this.completeActive(decision, true);
  }

  private showNext(): void {
    if (this.active) return;
    const pending = this.queue.shift();
    if (!pending) return;
    this.active = pending;

    if (!this.dependencies.hasWindow()) {
      this.dependencies.logError(
        `External URL intent for ${destinationLabel(pending.request)} cancelled: no renderer window`,
      );
      this.completeActive(EXTERNAL_URL_INTENT_DECISIONS.cancel, false);
      return;
    }

    try {
      this.dependencies.sendRequest(pending.request);
    } catch {
      this.dependencies.logError(
        `External URL intent for ${destinationLabel(pending.request)} cancelled: renderer delivery failed`,
      );
      this.completeActive(EXTERNAL_URL_INTENT_DECISIONS.cancel, false);
      return;
    }

    pending.timer = setTimeout(() => {
      this.dependencies.logError(
        `External URL intent for ${destinationLabel(pending.request)} timed out`,
      );
      this.completeActive(EXTERNAL_URL_INTENT_DECISIONS.cancel, true);
    }, EXTERNAL_URL_INTENT_TIMEOUT_MS);
    pending.timer.unref?.();
  }

  private completeActive(decision: ExternalUrlIntentDecision, closeRenderer: boolean): void {
    const pending = this.active;
    if (!pending) {
      this.dependencies.logError('Cannot complete external URL intent: no active request');
      return;
    }

    this.active = null;
    if (pending.timer) clearTimeout(pending.timer);
    if (closeRenderer && this.dependencies.hasWindow()) {
      try {
        this.dependencies.sendClose(pending.request.requestId);
      } catch {
        this.dependencies.logError(
          `Failed to close external URL prompt for ${destinationLabel(pending.request)}`,
        );
      }
    }
    pending.settle(decision);
    this.showNext();
  }
}
