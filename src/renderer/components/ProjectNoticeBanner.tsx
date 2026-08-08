import { useEffect } from 'react';
import { useStore, dismissProjectNotice, expireProjectNotice } from '../store';
import { PROJECT_NOTICE_AUTO_DISMISS_MS, type ProjectNotice } from '../project-notice';

export function ProjectNoticeBannerView({ notice, onDismiss }: { notice: ProjectNotice; onDismiss: () => void }) {
  return (
    <div className="project-notice-banner" role="status">
      <span>{notice.message}</span>
      <button
        className="project-notice-dismiss"
        aria-label="Dismiss notice"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}

export function ProjectNoticeBanner() {
  const { projects, activeProjectIndex, projectNotice } = useStore();
  const activeProjectId = projects[activeProjectIndex]?.id;

  useEffect(() => {
    if (!projectNotice) return;
    const id = projectNotice.id;
    const timer = window.setTimeout(() => expireProjectNotice(id), PROJECT_NOTICE_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [projectNotice?.id]);

  if (!projectNotice || projectNotice.projectId !== activeProjectId) return null;

  return (
    <ProjectNoticeBannerView
      notice={projectNotice}
      onDismiss={() => dismissProjectNotice(projectNotice.id)}
    />
  );
}
