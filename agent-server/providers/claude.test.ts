import { describe, it, expect } from 'vitest';
import { mergeClaudeModels } from './claude';
import type { ProviderModel } from '../../src/shared/types';

describe('mergeClaudeModels', () => {
  it('returns SDK models unchanged when no customs', () => {
    const sdk = [
      { value: 'opus', displayName: 'Opus' },
      { value: 'sonnet', displayName: 'Sonnet' },
    ];
    const merged = mergeClaudeModels(sdk, []);
    expect(merged).toEqual([
      { value: 'opus', displayName: 'Opus', vision: true },
      { value: 'sonnet', displayName: 'Sonnet', vision: true },
    ]);
  });

  it('appends custom models that are not in SDK list', () => {
    const sdk = [{ value: 'opus', displayName: 'Opus' }];
    const customs: ProviderModel[] = [
      { id: 'claude-opus-4-6', contextWindow: 200_000 },
    ];
    const merged = mergeClaudeModels(sdk, customs);
    expect(merged).toEqual([
      { value: 'opus', displayName: 'Opus', vision: true },
      { value: 'claude-opus-4-6', displayName: 'claude-opus-4-6', vision: true },
    ]);
  });

  it('user custom overrides SDK entry of the same id', () => {
    const sdk = [{ value: 'opus', displayName: 'Opus' }];
    const customs: ProviderModel[] = [
      { id: 'opus', contextWindow: 1_000_000 },
    ];
    const merged = mergeClaudeModels(sdk, customs);
    expect(merged).toHaveLength(1);
    expect(merged[0].value).toBe('opus');
  });

  it('handles empty SDK list (only customs)', () => {
    const sdk: { value: string; displayName: string }[] = [];
    const customs: ProviderModel[] = [
      { id: 'claude-opus-4-7', contextWindow: 200_000 },
    ];
    const merged = mergeClaudeModels(sdk, customs);
    expect(merged).toEqual([
      { value: 'claude-opus-4-7', displayName: 'claude-opus-4-7', vision: true },
    ]);
  });

  it('handles undefined customs', () => {
    const sdk = [{ value: 'opus', displayName: 'Opus' }];
    const merged = mergeClaudeModels(sdk, undefined);
    expect(merged).toEqual([{ value: 'opus', displayName: 'Opus', vision: true }]);
  });
});
