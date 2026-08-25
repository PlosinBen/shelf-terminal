import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_URL_OSC_PREFIX,
  ExternalUrlOscParser,
  encodeExternalUrlOscFrame,
} from './external-url-osc';

describe('ExternalUrlOscParser', () => {
  it('extracts an exact URL and strips its frame from visible output', () => {
    const parser = new ExternalUrlOscParser();
    const url = 'https://login.example.com/oauth?state=exact-private&code=A%2BB';

    expect(parser.push(`before${encodeExternalUrlOscFrame(url)}after`)).toEqual({
      visible: 'beforeafter',
      urls: [url],
      anomalies: [],
    });
  });

  it('handles a frame fragmented across prefix, payload, and terminator', () => {
    const parser = new ExternalUrlOscParser();
    const frame = encodeExternalUrlOscFrame('https://example.com/path');
    const first = parser.push(`prompt${frame.slice(0, 5)}`);
    const second = parser.push(frame.slice(5, -1));
    const third = parser.push(`${frame.slice(-1)}done`);

    expect(first).toEqual({ visible: 'prompt', urls: [], anomalies: [] });
    expect(second).toEqual({ visible: '', urls: [], anomalies: [] });
    expect(third).toEqual({
      visible: 'done',
      urls: ['https://example.com/path'],
      anomalies: [],
    });
  });

  it('extracts multiple frames from one chunk while preserving surrounding output', () => {
    const parser = new ExternalUrlOscParser();
    const one = 'https://one.example/path';
    const two = 'mailto:two@example.com?subject=Private';

    expect(parser.push(`a${encodeExternalUrlOscFrame(one)}b${encodeExternalUrlOscFrame(two)}c`))
      .toEqual({ visible: 'abc', urls: [one, two], anomalies: [] });
  });

  it('strips malformed frames and reports them without reflecting their payload', () => {
    const parser = new ExternalUrlOscParser();
    const result = parser.push(`left${EXTERNAL_URL_OSC_PREFIX}not+base64\x07right`);

    expect(result.visible).toBe('leftright');
    expect(result.urls).toEqual([]);
    expect(result.anomalies).toEqual(['invalid-payload']);
    expect(JSON.stringify(result.anomalies)).not.toContain('not+base64');
  });

  it('bounds unterminated frames and resumes parsing later output', () => {
    const parser = new ExternalUrlOscParser();
    const oversized = `${EXTERNAL_URL_OSC_PREFIX}${'A'.repeat(12_000)}`;

    expect(parser.push(oversized)).toEqual({
      visible: '',
      urls: [],
      anomalies: ['frame-too-long'],
    });
    expect(parser.push('visible again')).toEqual({
      visible: 'visible again',
      urls: [],
      anomalies: [],
    });
  });

  it('preserves unrelated OSC sequences unchanged', () => {
    const parser = new ExternalUrlOscParser();
    const title = '\x1b]0;terminal title\x07prompt';
    expect(parser.push(title)).toEqual({ visible: title, urls: [], anomalies: [] });
  });

  it('reports an unterminated Shelf frame at stream end but flushes a partial unrelated prefix', () => {
    const parser = new ExternalUrlOscParser();
    parser.push(`${EXTERNAL_URL_OSC_PREFIX}AAAA`);
    expect(parser.finish()).toEqual({ visible: '', urls: [], anomalies: ['unterminated-frame'] });

    const other = new ExternalUrlOscParser();
    other.push('text\x1b]69');
    expect(other.finish()).toEqual({ visible: '\x1b]69', urls: [], anomalies: [] });
  });
});
