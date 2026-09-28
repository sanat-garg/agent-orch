// Static WCAG contrast check of public/app.css's colour tokens (UI-REVIEW #6), no browser: parses the light `:root` block
// and the `prefers-color-scheme: dark` `:root` block, then asserts faint text and filled buttons clear 4.5:1 in both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');

function tokens(block) {
  const out = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

// The first top-level `:root { … }` is the light theme; the `:root` inside the dark media query overrides it.
function themes(css) {
  const light = css.match(/^:root\s*\{([^}]*)\}/m);
  const dark = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/);
  assert.ok(light, 'light :root block found');
  assert.ok(dark, 'dark :root block found');
  const l = tokens(light[1]);
  return { light: l, dark: { ...l, ...tokens(dark[1]) } };
}

function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(m, `${hex} is a 6-digit hex colour`);
  const [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('WCAG contrast formula matches known values', () => {
  assert.equal(contrast('#000000', '#ffffff').toFixed(1), '21.0');
  assert.equal(contrast('#ffffff', '#ffffff'), 1);
  assert.equal(contrast('#9a968c', '#faf9f5').toFixed(1), '2.8');
  assert.equal(contrast('#ffffff', '#c96442').toFixed(1), '3.9');
});

const { light, dark } = themes(CSS);

for (const [name, t] of Object.entries({ light, dark })) {
  test(`${name} theme: --faint text clears 4.5:1 on --bg`, () => {
    const r = contrast(t['--faint'], t['--bg']);
    assert.ok(r >= 4.5, `--faint ${t['--faint']} on --bg ${t['--bg']} is ${r.toFixed(2)}:1`);
  });

  test(`${name} theme: --faint text clears 4.5:1 on --panel`, () => {
    const r = contrast(t['--faint'], t['--panel']);
    assert.ok(r >= 4.5, `--faint ${t['--faint']} on --panel ${t['--panel']} is ${r.toFixed(2)}:1`);
  });

  test(`${name} theme: --accent-text on --accent-strong (and its hover) clears 4.5:1`, () => {
    for (const bg of ['--accent-strong', '--accent-strong-hover']) {
      assert.ok(t[bg], `${bg} is defined`);
      const r = contrast(t['--accent-text'], t[bg]);
      assert.ok(r >= 4.5, `--accent-text ${t['--accent-text']} on ${bg} ${t[bg]} is ${r.toFixed(2)}:1`);
    }
  });
}

test('light theme: hover darkens the filled-button background', () => {
  assert.ok(luminance(light['--accent-strong-hover']) < luminance(light['--accent-strong']));
});

test('filled buttons use --accent-strong, not --accent', () => {
  const rule = sel => {
    const m = CSS.match(new RegExp(`^${sel.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`, 'm'));
    assert.ok(m, `${sel} rule found`);
    return m[1];
  };
  assert.match(rule('.btn.primary'), /background:\s*var\(--accent-strong\)/);
  assert.match(rule('.btn.primary:hover'), /background:\s*var\(--accent-strong-hover\)/);
  assert.match(rule('.send'), /background:\s*var\(--accent-strong\)/);
});
