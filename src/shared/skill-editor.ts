import type { SkillCommandDraft, SkillCommandRegistration, SkillCommandResult } from './skill-commands';

export const SKILL_EDITOR_MAIN_FILE = 'SKILL.md';
export interface SkillEditorSaveRequest {
  name: string;
  activeFile: string;
  content: string;
  commandDraft: SkillCommandDraft | null;
}
export interface SkillEditorSaveResult {
  ok: boolean;
  name: string;
  saved: { content: boolean; command: boolean };
  /** Readback could not establish the persisted state; refresh before retrying. */
  uncertain?: boolean;
  error?: string;
  contentChanged: boolean;
  commandChanged: boolean;
}
export interface SkillEditorState {
  content: string;
  command: SkillCommandResult<SkillCommandRegistration | null>;
}
