import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  createProjectNotice,
  dismissProjectNoticeState,
  showProjectNoticeState,
  type ProjectNotice,
} from './project-notice';
import { ProjectNoticeBannerView } from './components/ProjectNoticeBanner';

describe('project notice state', () => {
  const notice = (id: string, message = id): ProjectNotice =>
    createProjectNotice({ projectId: 'parent', message }, id);

  it('latest notice wins', () => {
    const first = notice('n1', 'first');
    const second = notice('n2', 'second');

    expect(showProjectNoticeState(first, second)).toBe(second);
  });

  it('dismiss clears the current notice', () => {
    expect(dismissProjectNoticeState(notice('n1'), 'n1')).toBeNull();
  });

  it('stale timeout token does not clear the latest notice', () => {
    const latest = notice('n2');

    expect(dismissProjectNoticeState(latest, 'n1')).toBe(latest);
  });
});

describe('ProjectNoticeBannerView', () => {
  it('renders the message and a dismiss button', () => {
    const html = renderToStaticMarkup(React.createElement(ProjectNoticeBannerView, {
      notice: { id: 'n1', projectId: 'parent', message: 'Merged feature → main and closed the worktree' },
      onDismiss: () => {},
    }));

    expect(html).toContain('role="status"');
    expect(html).toContain('Merged feature → main and closed the worktree');
    expect(html).toContain('aria-label="Dismiss notice"');
  });
});
