import { validSkillCommandSelection, type SkillCommandSelection } from './skill-invocation';
import type { AgentAttachment } from './types';
import { CONFIG_EDIT_KEYS, type ConfigEditKey } from './config-ack';

export const AGENT_INPUT_SOURCE = {
  AGENT_VIEW: 'agent-view',
  TELEGRAM: 'telegram',
  AGENT: 'agent',
} as const;

export const AGENT_REPLY_REQUIREMENT = {
  NONE: 'none',
  BRIEF_PLAIN_TEXT: 'brief-plain-text',
} as const;

export const AGENT_INPUT_ATTACHMENT_KIND = { FILE: 'file', IMAGE: 'image' } as const;
export type AgentInputAttachmentKind = typeof AGENT_INPUT_ATTACHMENT_KIND[keyof typeof AGENT_INPUT_ATTACHMENT_KIND];

export type AgentReplyRequirement = typeof AGENT_REPLY_REQUIREMENT[keyof typeof AGENT_REPLY_REQUIREMENT];
export type AgentInputSource =
  | { readonly kind: typeof AGENT_INPUT_SOURCE.AGENT_VIEW }
  | { readonly kind: typeof AGENT_INPUT_SOURCE.TELEGRAM }
  | { readonly kind: typeof AGENT_INPUT_SOURCE.AGENT; readonly agentViewId: string; readonly displayName: string };

export interface AgentInputMessage {
  readonly msgId: string;
  readonly source: AgentInputSource;
  readonly content: string;
  readonly attachments: AgentAttachment[];
  readonly replyRequirement: AgentReplyRequirement;
}

export type AgentInputRequest =
  | { inputMessage: AgentInputMessage; commandSelection?: SkillCommandSelection; configEdit?: never }
  | { configEdit: { key: ConfigEditKey; value: string }; inputMessage?: never; commandSelection?: never };

type Result<T> = { ok: true; message: T } | { ok: false; error: string };
type MessageData = Omit<AgentInputMessage, 'msgId'>;
type MessageDraft = Omit<MessageData, 'attachments' | 'replyRequirement'> & Partial<Pick<MessageData, 'attachments' | 'replyRequirement'>>;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateData(value: unknown): Result<MessageData> {
  if (!record(value)) return { ok: false, error: 'Message must be an object' };
  if (Object.keys(value).some(key => !['msgId', 'source', 'content', 'attachments', 'replyRequirement'].includes(key))) return { ok: false, error: 'Unexpected message fields' };
  if (typeof value.content !== 'string') return { ok: false, error: 'Message content must be a string' };
  if (!record(value.source)) return { ok: false, error: 'Message source is required' };
  let source: AgentInputSource;
  switch (value.source.kind) {
    case AGENT_INPUT_SOURCE.AGENT_VIEW:
    case AGENT_INPUT_SOURCE.TELEGRAM:
      if (Object.keys(value.source).some(key => key !== 'kind')) return { ok: false, error: 'Unexpected source identity fields' };
      source = { kind: value.source.kind };
      break;
    case AGENT_INPUT_SOURCE.AGENT:
      if (Object.keys(value.source).some(key => !['kind', 'agentViewId', 'displayName'].includes(key))) return { ok: false, error: 'Unexpected Agent source fields' };
      if (!nonEmpty(value.source.agentViewId) || !nonEmpty(value.source.displayName)) return { ok: false, error: 'Agent source identity is required' };
      source = { kind: value.source.kind, agentViewId: value.source.agentViewId, displayName: value.source.displayName };
      break;
    default: return { ok: false, error: 'Unknown message source' };
  }
  if (!Array.isArray(value.attachments)) return { ok: false, error: 'Message attachments must be an array' };
  const attachments: AgentAttachment[] = [];
  for (const attachment of value.attachments) {
    if (!record(attachment) || (attachment.kind !== AGENT_INPUT_ATTACHMENT_KIND.FILE && attachment.kind !== AGENT_INPUT_ATTACHMENT_KIND.IMAGE)
      || !nonEmpty(attachment.path) || !nonEmpty(attachment.displayPath) || !nonEmpty(attachment.name)
      || (attachment.mimeType !== undefined && typeof attachment.mimeType !== 'string')
      || (attachment.size !== undefined && (typeof attachment.size !== 'number' || !Number.isFinite(attachment.size) || attachment.size < 0))) {
      return { ok: false, error: `Invalid attachment at index ${attachments.length}` };
    }
    attachments.push({ kind: attachment.kind, path: attachment.path, displayPath: attachment.displayPath, name: attachment.name,
      ...(attachment.mimeType !== undefined ? { mimeType: attachment.mimeType } : {}),
      ...(attachment.size !== undefined ? { size: attachment.size } : {}) });
  }
  if (!value.content.trim() && attachments.length === 0) return { ok: false, error: 'Content or attachments are required' };
  if (!Object.values(AGENT_REPLY_REQUIREMENT).includes(value.replyRequirement as AgentReplyRequirement)) return { ok: false, error: 'Unknown reply requirement' };
  return { ok: true, message: { source, content: value.content, attachments, replyRequirement: value.replyRequirement as AgentReplyRequirement } };
}

/** agent-config-flow#15: create identity here, never in Caller/Sender or validation. */
export function createAgentInputMessage(draft: MessageDraft): Result<AgentInputMessage> {
  if (draft && Object.prototype.hasOwnProperty.call(draft, 'msgId')) return { ok: false, error: 'Message ID belongs to the factory' };
  const checked = validateData({ ...draft,
    attachments: draft?.attachments === undefined ? [] : draft.attachments,
    replyRequirement: draft?.replyRequirement === undefined ? AGENT_REPLY_REQUIREMENT.NONE : draft.replyRequirement });
  if (!checked.ok) return checked;
  return { ok: true, message: { ...checked.message, msgId: globalThis.crypto.randomUUID() } };
}

/** Trust-boundary validation of an existing message, without minting a new ID. */
export function validateAgentInputMessage(value: unknown): Result<AgentInputMessage> {
  if (!record(value) || !nonEmpty(value.msgId)) return { ok: false, error: 'Message ID is required' };
  const checked = validateData(value);
  if (!checked.ok) return checked;
  return { ok: true, message: { ...checked.message, msgId: value.msgId } };
}

export function validateAgentInputRequest(value: unknown, expectedSource?: AgentInputSource['kind']): Result<AgentInputRequest> {
  if (!record(value)) return { ok: false, error: 'Input request must be an object' };
  if (expectedSource !== undefined && Object.keys(value).some(key => !['tabId', 'inputMessage', 'configEdit', 'commandSelection'].includes(key))) return { ok: false, error: 'Unexpected input envelope fields' };
  if (value.configEdit !== undefined) {
    const edit = value.configEdit;
    if (value.inputMessage !== undefined || value.commandSelection !== undefined || !record(edit)
      || !Object.values(CONFIG_EDIT_KEYS).includes(edit.key as ConfigEditKey) || typeof edit.value !== 'string') {
      return { ok: false, error: 'Invalid config edit request' };
    }
    return { ok: true, message: { configEdit: { key: edit.key as ConfigEditKey, value: edit.value } } };
  }
  if (value.commandSelection !== undefined && !validSkillCommandSelection(value.commandSelection)) return { ok: false, error: 'Invalid command selection' };
  const checked = validateAgentInputMessage(value.inputMessage);
  if (checked.ok && expectedSource !== undefined && checked.message.source.kind !== expectedSource) {
    return { ok: false, error: `Input source is not allowed at this entry: ${checked.message.source.kind}` };
  }
  return checked.ok ? { ok: true, message: { inputMessage: checked.message, ...(value.commandSelection !== undefined ? { commandSelection: value.commandSelection } : {}) } } : checked;
}
