import { describe, it, expect } from 'vitest';
import { webTabLabelOnNav } from './store';

// Web tab label on navigation: the host is the default, but a user-renamed
// (pinned) label must survive subsequent navigation.
describe('webTabLabelOnNav', () => {
  it('uses the page host when the label is not pinned', () => {
    expect(webTabLabelOnNav({ label: 'Web' }, 'https://kibana.corp.com/app')).toBe('kibana.corp.com');
  });

  it('keeps a user-pinned label and ignores the host', () => {
    expect(webTabLabelOnNav({ label: 'My Kibana', labelPinned: true }, 'https://kibana.corp.com/app'))
      .toBe('My Kibana');
  });

  it('falls back to "Web" for an unparseable URL when not pinned', () => {
    expect(webTabLabelOnNav({ label: 'Web' }, 'not a url')).toBe('Web');
  });

  it('keeps the pinned label even for an unparseable URL', () => {
    expect(webTabLabelOnNav({ label: 'My Kibana', labelPinned: true }, 'not a url')).toBe('My Kibana');
  });
});
