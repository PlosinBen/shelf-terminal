import type { AgentEvent } from '../agent/types';

/**
 * Accumulates `reply` content within a single agent turn and emits the joined
 * text when the turn ends (status idle).
 *
 * Design contract — implements the bridge's "telegram needs one complete
 * message" display constraint (frequent edits are wasteful; Markdown parser
 * needs the full string at once). Lives separate from the dispatchEvent layer
 * because that layer is pure transport — each listener owns its own display
 * strategy. The renderer's strategy is "stream as it arrives + finalize"; the
 * telegram bridge's is "buffer and flush once."
 *
 * Streaming-status agnostic. Earlier versions used "first streaming starts a
 * turn" to gate the buffer reset, but providers (claude) emit additional
 * `status streaming` events mid-turn to refresh token counts — which would
 * wipe the just-collected reply. This implementation simply:
 *   - appends every `reply` event's content to the buffer
 *   - flushes on `idle`
 *   - relies on the caller's explicit `reset()` (in routeMessageToAgent) for
 *     turn-start cleanup, so streaming events are completely ignored here.
 */
export class AgentReplyAccumulator {
  private buffer: string[] = [];

  reset(): void {
    this.buffer = [];
  }

  /** Returns `{ flush: <joined text> }` iff this event ends the turn. */
  onEvent(event: AgentEvent): { flush: string } | null {
    if (event.type === 'message' && event.payload.type === 'reply') {
      this.buffer.push(event.payload.content);
      return null;
    }
    if (event.type === 'status' && event.payload.state === 'idle') {
      const text = this.buffer.join('');
      this.buffer = [];
      return { flush: text };
    }
    return null;
  }
}
