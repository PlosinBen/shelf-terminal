import type { PmStreamChunk, PmToolCall } from '@shared/types';

export interface PmStreamState {
  streaming: boolean;
  streamText: string;
  streamToolCalls: PmToolCall[];
  error: string | null;
}

export const initialPmStreamState: PmStreamState = {
  streaming: false,
  streamText: '',
  streamToolCalls: [],
  error: null,
};

export type PmStreamAction =
  | { type: 'send_start' }
  | { type: 'clear_display' }
  | { type: 'dismiss_error' }
  | { type: 'chunk'; chunk: PmStreamChunk };

export function pmStreamReducer(state: PmStreamState, action: PmStreamAction): PmStreamState {
  if (action.type === 'send_start') {
    return { streaming: true, streamText: '', streamToolCalls: [], error: null };
  }

  if (action.type === 'clear_display') {
    return { ...state, streamText: '', streamToolCalls: [] };
  }

  if (action.type === 'dismiss_error') {
    return { ...state, error: null };
  }

  const { chunk } = action;

  // Any non-error chunk means the stream is making progress — drop any stale
  // retry banner left over from a prior attempt.
  const cleared: PmStreamState = chunk.type !== 'error' ? { ...state, error: null } : state;

  switch (chunk.type) {
    case 'text':
      return { ...cleared, streamText: cleared.streamText + (chunk.text ?? '') };

    case 'tool_start':
      if (!chunk.toolCall) return cleared;
      return { ...cleared, streamToolCalls: [...cleared.streamToolCalls, chunk.toolCall] };

    case 'tool_result':
      if (!chunk.toolCall) return cleared;
      return {
        ...cleared,
        streamToolCalls: cleared.streamToolCalls.map((tc) =>
          tc.id === chunk.toolCall!.id ? chunk.toolCall! : tc,
        ),
      };

    case 'done':
      return { ...initialPmStreamState };

    case 'error': {
      const errMsg = chunk.error ?? 'Unknown error';
      const isRetrying = errMsg.includes('Retrying in');
      if (isRetrying) return { ...state, error: errMsg };
      return { ...initialPmStreamState };
    }

    default:
      return cleared;
  }
}
