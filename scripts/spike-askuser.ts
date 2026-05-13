/**
 * Spike: can we intercept AskUserQuestion via canUseTool deny+message hack?
 *
 * Hypothesis: when SDK fires AskUserQuestion tool_use, canUseTool callback
 * gets invoked. If we return { behavior: 'deny', message: <JSON answer> },
 * the model sees the deny message as tool_result content and parses it.
 *
 * Run: npx tsx scripts/spike-askuser.ts
 *
 * What to look for in output:
 *   - [canUseTool] called with toolName=AskUserQuestion → callback fires
 *   - Model continues turn after deny → message reaches model
 *   - Model responds based on our fake answer → hack works
 *   - vs:
 *   - canUseTool never called for AskUserQuestion → CLI bypasses it
 *   - Model treats deny as error → hack fails
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

const PROMPT = `Use the AskUserQuestion tool to ask the user ONE question:
"What is your favorite color?" with options ["Red", "Blue", "Green"].
After you get the answer, respond with one sentence acknowledging the choice.`;

async function main() {
  console.log('--- spike start ---');
  console.log('prompt:', PROMPT);
  console.log();

  let askUserCalled = false;
  let askUserInput: any = null;

  const q = query({
    prompt: PROMPT,
    options: {
      model: 'claude-sonnet-4-5',
      canUseTool: async (toolName, input, opts) => {
        console.log(`[canUseTool] toolName=${toolName}`);
        console.log(`[canUseTool] input=`, JSON.stringify(input, null, 2));

        if (toolName === 'AskUserQuestion') {
          askUserCalled = true;
          askUserInput = input;
          // Hack: deny with JSON answer in message field
          const fakeAnswer = {
            questions: (input as any).questions,
            answers: { 'What is your favorite color?': 'Blue' },
          };
          console.log('[canUseTool] denying with fake answer JSON');
          return {
            behavior: 'deny',
            message: JSON.stringify(fakeAnswer),
          };
        }

        // Allow everything else
        return { behavior: 'allow' };
      },
    },
  });

  for await (const msg of q) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          console.log(`[assistant text]`, block.text);
        } else if (block.type === 'tool_use') {
          console.log(`[assistant tool_use] name=${block.name}`);
          console.log(`  input=`, JSON.stringify(block.input, null, 2));
        }
      }
    } else if (msg.type === 'user') {
      // tool_result is delivered as user message
      const content: any = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            console.log(`[tool_result] tool_use_id=${block.tool_use_id} is_error=${block.is_error}`);
            console.log(`  content=`, JSON.stringify(block.content, null, 2));
          }
        }
      }
    } else if (msg.type === 'result') {
      console.log(`[result] subtype=${(msg as any).subtype}`);
      console.log(`  duration_ms=${(msg as any).duration_ms}`);
      console.log(`  num_turns=${(msg as any).num_turns}`);
    } else if (msg.type === 'system') {
      console.log(`[system] subtype=${(msg as any).subtype}`);
    }
  }

  console.log();
  console.log('--- spike end ---');
  console.log(`AskUserQuestion canUseTool invoked? ${askUserCalled}`);
  if (askUserInput) {
    console.log('AskUserQuestion input received:', JSON.stringify(askUserInput, null, 2));
  }
}

main().catch((err) => {
  console.error('spike error:', err);
  process.exit(1);
});
