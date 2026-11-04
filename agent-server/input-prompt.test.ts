import { describe, expect, it } from 'vitest';
import { AGENT_INPUT_SOURCE, AGENT_REPLY_REQUIREMENT, createAgentInputMessage } from '@shared/agent-input';
import { inputPromptForDispatch, modelInputPrompt } from './input-prompt';

describe('per-message reply requirements', () => {
  const built = createAgentInputMessage({ source: { kind: AGENT_INPUT_SOURCE.TELEGRAM }, content: '  original text\n', replyRequirement: AGENT_REPLY_REQUIREMENT.BRIEF_PLAIN_TEXT });
  if (!built.ok) throw new Error(built.error);
  const input = { prompt: built.message.content, inputMessage: built.message };

  it('prepares shared instructions without modifying the original message', () => {
    const prompt = modelInputPrompt(input);
    expect(prompt).toContain('Plain text only');
    expect(prompt).toContain('Keep it short');
    expect(prompt).toContain('topic titles');
    expect(prompt).toContain('see Shelf');
    expect(prompt.startsWith(input.inputMessage.content)).toBe(true);
    expect(input.inputMessage.content).toBe('  original text\n');
  });
  it.each(['/model', '/model new', '/mcp', '/skills', '/clear', '/compact', '/unknown'])('preserves native command syntax: %s', prompt => {
    expect(modelInputPrompt(input, prompt)).toBe(prompt);
  });
  it('applies guidance to trailing text after provider-owned clear handling', () => {
    expect(modelInputPrompt(input, 'continue here')).toContain('continue here\n\n[System note:');
  });
  it('does not change ordinary input or silently accept unknown requirements', () => {
    expect(modelInputPrompt({ prompt: 'unchanged' })).toBe('unchanged');
    expect(() => modelInputPrompt({ ...input, inputMessage: { ...input.inputMessage, replyRequirement: 'unknown' as never } })).toThrow('Unknown Agent reply requirement');
  });
  it('normalizes padded commands at dispatch without trimming ordinary text or changing the message', () => {
    expect(inputPromptForDispatch({ ...input, prompt: '  /model new  ' })).toBe('/model new');
    expect(inputPromptForDispatch(input)).toBe('  original text\n');
    expect(input.inputMessage.content).toBe('  original text\n');
    expect(inputPromptForDispatch({ prompt: '/help\n' })).toBe('/help\n');
  });
});
