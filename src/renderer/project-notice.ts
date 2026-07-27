export const PROJECT_NOTICE_AUTO_DISMISS_MS = 6000;

export interface ProjectNotice {
  id: string;
  projectId: string;
  message: string;
}

export function createProjectNotice(input: { projectId: string; message: string }, id: string): ProjectNotice {
  return { id, projectId: input.projectId, message: input.message };
}

export function showProjectNoticeState(_current: ProjectNotice | null, next: ProjectNotice): ProjectNotice {
  return next;
}

export function dismissProjectNoticeState(current: ProjectNotice | null, id?: string): ProjectNotice | null {
  if (!current) return null;
  if (id && current.id !== id) return current;
  return null;
}
