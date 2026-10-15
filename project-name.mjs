// New project names (owner, 2026-10-08; two words since 2026-10-15): a project started from a message gets a fresh
// two-word hyphenated name such as "name-giver" picked by Haiku, which names its ~/workspace folder and so its GitHub
// repo (github.mjs uses the folder's basename). `projectName(text, opts)` resolves to that lowercase name, or null when
// Haiku is slow, signed out or answers with anything but two plain words (the caller then falls back to the message's
// first words). `taken` lists names already in use, so Haiku avoids them.
// The run is a tool-less single turn through helpers.mjs claudeHelperSpawn on the owner's subscription, never an API key.
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { claudeHelperSpawn } from './helpers.mjs';

export const NAME_MODEL = 'haiku';
export const NAME_TIMEOUT_MS = 12_000;
const NAME = /^[a-z]{2,12}-[a-z]{2,12}$/;

export function namePrompt(text, taken = []) {
  return `Name a new software project with exactly TWO short, memorable, lowercase English words joined by a hyphen (letters only, like "name-giver" or "penny-wise") that together evoke what it is for. Be inventive: avoid generic words such as app, project, tool, helper or tracker.${taken.length ? ` Do not use any of these names: ${taken.slice(0, 200).join(', ')}.` : ''} Reply with the name only.\n\nThe project's first message:\n"""\n${String(text).slice(0, 2000)}\n"""`;
}

// The reply as a usable name: two words (a space or underscore becomes the hyphen), lowercase, not already taken; else null.
export function cleanName(reply, taken = []) {
  const w = String(reply || '').trim().toLowerCase().replace(/^["'`*\s]+|["'`*.!\s]+$/g, '').replace(/[\s_]+/g, '-');
  return NAME.test(w) && !taken.includes(w) ? w : null;
}

export async function projectName(text, { taken = [], query = sdkQuery, bin, env, cwd, timeoutMs = NAME_TIMEOUT_MS } = {}) {
  if (!String(text || '').trim()) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let reply = '';
  try {
    const it = query({
      prompt: namePrompt(text, taken),
      options: {
        model: NAME_MODEL, maxTurns: 1, tools: [], settingSources: [], persistSession: false, strictMcpConfig: true, thinking: { type: 'disabled' }, cwd,
        systemPrompt: 'You name software projects. Answer with a two-word hyphenated name and nothing else.',
        pathToClaudeCodeExecutable: bin, env, abortController: ac, spawnClaudeCodeProcess: claudeHelperSpawn,
      },
    });
    for await (const m of it) {
      if (m.type === 'assistant' && !m.parent_tool_use_id) reply = (m.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('') || reply;
      if (m.type === 'result') break;
    }
  } catch { /* timed out or the CLI failed: the caller falls back */ } finally { clearTimeout(timer); ac.abort(); }
  return cleanName(reply, taken);
}
