import { AGENT_REPLY_REQUIREMENT, type AgentInputMessage } from '@shared/agent-input';
import { parseSlashPrefix } from '@shared/slash-prefix';

const BRIEF_PLAIN_TEXT_GUIDANCE =
  '\n\n[System note: your reply is delivered into a compact plain-text chat. '
  + 'Plain text only — no Markdown (no **bold**, _italics_, # headings, `code`, code fences, tables). '
  + 'Keep it short. If the answer spans multiple topics or issues, just list the topic titles and let me ask which to expand — do not explain them all at once. '
  + 'For long code or command output, say "see Shelf" instead of pasting it.]';

type PromptInput = { prompt: string; inputMessage?: AgentInputMessage };

/** Preserve the old UI command trimming without modifying canonical content. */
export function inputPromptForDispatch(input: PromptInput): string {
  const trimmed = input.prompt.trim();
  return input.inputMessage && parseSlashPrefix(trimmed) ? trimmed : input.prompt;
}

/** agent-config-flow#15: apply shared guidance only after native slash dispatch. */
export function modelInputPrompt(input: PromptInput, content = inputPromptForDispatch(input)): string {
  const requirement = input.inputMessage?.replyRequirement ?? AGENT_REPLY_REQUIREMENT.NONE;
  switch (requirement) {
    case AGENT_REPLY_REQUIREMENT.NONE: return content;
    // Preserve native command syntax; never turn a bare slash into a command
    // with invented arguments. Providers may pass post-/clear trailing text here.
    case AGENT_REPLY_REQUIREMENT.BRIEF_PLAIN_TEXT: return parseSlashPrefix(content) ? content : content + BRIEF_PLAIN_TEXT_GUIDANCE;
    default: throw new Error(`Unknown Agent reply requirement: ${String(requirement)}`);
  }
}
