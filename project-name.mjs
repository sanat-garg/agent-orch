// New project names (owner, 2026-10-08): a project started from a message gets ONE fresh word picked by Haiku, which
// names its ~/workspace folder and so its GitHub repo (github.mjs uses the folder's basename). `projectWord(text, opts)`
// resolves to that lowercase word, or null when Haiku is slow, signed out or answers with anything but one plain word
// (the caller then falls back to the message's first words). `taken` lists names already in use, so Haiku avoids them.
// The run is a tool-less single turn through helpers.mjs claudeHelperSpawn on the owner's subscription, never an API key.
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { claudeHelperSpawn } from './helpers.mjs';

export const NAME_MODEL = 'haiku';
export const NAME_TIMEOUT_MS = 12_000;
const WORD = /^[a-z][a-z0-9]{2,19}$/;

export function namePrompt(text, taken = []) {
  return `Name a new software project in exactly ONE short, memorable, lowercase English word (letters only, 3 to 12 letters) that evokes what it is for. Be inventive: avoid generic words such as app, project, tool, helper or tracker.${taken.length ? ` Do not use any of these names: ${taken.slice(0, 200).join(', ')}.` : ''} Reply with the word only.\n\nThe project's first message:\n"""\n${String(text).slice(0, 2000)}\n"""`;
}

// The reply as a usable name: one word, lowercase, not already taken; else null.
export function cleanWord(reply, taken = []) {
  const w = String(reply || '').trim().toLowerCase().replace(/^["'`*\s]+|["'`*.!\s]+$/g, '');
  return WORD.test(w) && !taken.includes(w) ? w : null;
}

export async function projectWord(text, { taken = [], query = sdkQuery, bin, env, cwd, timeoutMs = NAME_TIMEOUT_MS } = {}) {
  if (!String(text || '').trim()) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let reply = '';
  try {
    const it = query({
      prompt: namePrompt(text, taken),
      options: {
        model: NAME_MODEL, maxTurns: 1, tools: [], settingSources: [], persistSession: false, strictMcpConfig: true, thinking: { type: 'disabled' }, cwd,
        systemPrompt: 'You name software projects. Answer with a single word and nothing else.',
        pathToClaudeCodeExecutable: bin, env, abortController: ac, spawnClaudeCodeProcess: claudeHelperSpawn,
      },
    });
    for await (const m of it) {
      if (m.type === 'assistant' && !m.parent_tool_use_id) reply = (m.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('') || reply;
      if (m.type === 'result') break;
    }
  } catch { /* timed out or the CLI failed: the caller falls back */ } finally { clearTimeout(timer); ac.abort(); }
  return cleanWord(reply, taken);
}
