import { describe, expect, it } from 'vitest';
import { formatTabLogId } from './tab-id';

describe('formatTabLogId', () => {
  it('keeps tabs with the same timestamp prefix distinguishable', () => {
    const first = 'tab-1785125000756-10';
    const second = 'tab-1785132147910-12';

    expect(first.slice(0, 8)).toBe(second.slice(0, 8));
    expect(formatTabLogId(first)).not.toBe(formatTabLogId(second));
  });

  it('is deterministic and preserves the grep-able tab id', () => {
    const tabId = 'tab-1785125000756-10';

    expect(formatTabLogId(tabId)).toBe(tabId);
    expect(formatTabLogId(tabId)).toBe(formatTabLogId(tabId));
  });
});
