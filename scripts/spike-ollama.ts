/**
 * Spike: validate ollama PM provider integration via @ai-sdk/openai.
 *
 * Three hypotheses verified here:
 *
 *   H1. createOpenAI({ apiKey: '' }) does not throw — ollama doesn't require an
 *       API key, and the SDK accepts an empty string.
 *       Result: ✅ PASS (no dummy fallback needed in llm-client.ts).
 *
 *   H2. Basic streaming text-delta works against /v1/chat/completions.
 *       Result: ✅ PASS (existing openai/gemini code path works as-is).
 *
 *   H3. tool_call events are emitted for OpenAI-style function calling.
 *       Result: ⚠️ MODEL-DEPENDENT.
 *         - qwen3:8b              → proper `tool-call` event ✅
 *         - qwen2.5-coder:7b/14b  → outputs JSON-as-text, no tool-call event ❌
 *
 * Run: npx tsx scripts/spike-ollama.ts
 *
 * When to re-run:
 *  - Upgrading @ai-sdk/openai or `ai` package
 *  - Upgrading ollama server version
 *  - Adding a new ollama model to the "verified working" list in GOTCHAS
 *
 * Prereq: ollama running on http://localhost:11434, models pulled.
 */
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, generateText } from 'ai';

const BASE_URL = 'http://localhost:11434/v1';

// Adjust this list to whatever you have pulled locally.
const MODELS = ['qwen3:8b', 'qwen2.5-coder:7b', 'qwen2.5-coder:14b'];

const provider = createOpenAI({ apiKey: '', baseURL: BASE_URL });

const tools = {
  multiply: {
    description: 'Multiply two integers and return the product',
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  } as any,
};

const toolPrompt = [{ role: 'user' as const, content: 'What is 7 times 13? Use the multiply tool.' }];

async function h1_emptyApiKey() {
  console.log('\n=== H1: createOpenAI({ apiKey: "" }) does not throw ===');
  try {
    createOpenAI({ apiKey: '', baseURL: BASE_URL });
    console.log('✅ PASS');
  } catch (e) {
    console.error('❌ FAIL:', (e as Error).message);
  }
}

async function h2_basicStream(model: string) {
  console.log(`\n=== H2: basic streaming (${model}) ===`);
  try {
    const result = streamText({
      model: provider(model),
      messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
    });
    let text = '';
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') text += part.text;
    }
    console.log(`✅ PASS — text="${text.trim()}"`);
  } catch (e) {
    console.error('❌ FAIL:', (e as Error).message);
  }
}

async function h3_toolCall(model: string) {
  console.log(`\n--- H3: tool_call (${model}) ---`);
  // streamText path (what PM actually uses)
  try {
    const result = streamText({ model: provider(model), messages: toolPrompt, tools });
    let toolCall = '';
    let textSample = '';
    for await (const part of result.fullStream) {
      if (part.type === 'tool-call') toolCall = `${part.toolName}(${JSON.stringify(part.input)})`;
      else if (part.type === 'text-delta' && !textSample) textSample = part.text;
    }
    if (toolCall) console.log(`  stream: ✅ tool-call=${toolCall}`);
    else console.log(`  stream: ❌ no tool-call (first text="${textSample}")`);
  } catch (e) {
    console.error('  stream threw:', (e as Error).message);
  }
  // non-stream cross-check
  try {
    const result = await generateText({ model: provider(model), messages: toolPrompt, tools });
    if (result.toolCalls.length > 0) {
      console.log(`  generate: ✅ toolCalls=${JSON.stringify(result.toolCalls.map(c => `${c.toolName}(${JSON.stringify(c.input)})`))}`);
    } else {
      console.log(`  generate: ❌ no toolCalls (text="${result.text.slice(0, 80)}")`);
    }
  } catch (e) {
    console.error('  generate threw:', (e as Error).message);
  }
}

async function main() {
  await h1_emptyApiKey();
  await h2_basicStream(MODELS[0]);

  console.log('\n=== H3: tool_call (model matrix) ===');
  for (const m of MODELS) {
    await h3_toolCall(m);
  }
}

main().catch((e) => {
  console.error('Unhandled:', e);
  process.exit(1);
});
