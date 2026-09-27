#!/usr/bin/env node
// Screenshot a URL with Playwright's cached Chromium. Files saved under .agent-orch/shots/ show up in the owner's chat.
// Usage: node bin/shot.mjs <url> [out.png] [--full] [--width=1280] [--height=800] [--mobile] (390×844 unless --width/--height) [--wait=ms] [--dark] [--cookie=name=value]
//   [--storage=key=value] (localStorage before load) [--click=selector] (clicked in order after load)
// CW_SHOT_COOKIE (`name=value`, or a bare token meaning cw_session=<token>) is sent too, e.g. to log into agent-orch.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const USAGE = 'usage: node bin/shot.mjs <url> [out.png] [--full] [--width=1280] [--height=800] [--mobile] [--wait=ms] [--dark] [--cookie=name=value] [--storage=key=value] [--click=selector]';
const opts = { width: 0, height: 0, wait: 0, full: false, mobile: false, dark: false, cookies: [], storage: [], clicks: [] };
const pos = [];
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([a-z]+)(?:=(.*))?$/);
  if (!m) { pos.push(a); continue; }
  const [, k, v] = m;
  if (k === 'full' || k === 'mobile' || k === 'dark') opts[k] = true;
  else if (k === 'width' || k === 'height' || k === 'wait') opts[k] = Number(v);
  else if (k === 'cookie' && v) opts.cookies.push(v);
  else if (k === 'storage' && v?.includes('=')) opts.storage.push(v);
  else if (k === 'click' && v) opts.clicks.push(v);
  else if (k === 'help') { console.log(USAGE); process.exit(0); }
  else { console.error(`unknown option ${a}\n${USAGE}`); process.exit(2); }
}
const [url, outArg] = pos;
if (!url || !/^https?:\/\//.test(url) || [opts.width, opts.height, opts.wait].some((n) => !Number.isFinite(n) || n < 0)) {
  console.error(USAGE); process.exit(2);
}
if (process.env.CW_SHOT_COOKIE) opts.cookies.push(process.env.CW_SHOT_COOKIE.includes('=') ? process.env.CW_SHOT_COOKIE : `cw_session=${process.env.CW_SHOT_COOKIE}`);

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const slug = url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'page';
const out = path.resolve(outArg || path.join('.agent-orch', 'shots', `${stamp}-${slug}.png`));
fs.mkdirSync(path.dirname(out), { recursive: true });

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ colorScheme: opts.dark ? 'dark' : 'light', ...(opts.mobile
    ? { viewport: { width: opts.width || 390, height: opts.height || 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' }
    : { viewport: { width: opts.width || 1280, height: opts.height || 800 } }) });
  if (opts.cookies.length) {
    await context.addCookies(opts.cookies.map((c) => {
      const i = c.indexOf('=');
      return { name: c.slice(0, i), value: c.slice(i + 1), url };
    }));
  }
  if (opts.storage.length) {
    await context.addInitScript((kv) => { for (const e of kv) { const i = e.indexOf('='); localStorage.setItem(e.slice(0, i), e.slice(i + 1)); } }, opts.storage);
  }
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(async (e) => {
    if (!/Timeout/.test(e.message)) throw e; // pages with long-lived connections (WebSocket, polling) never go idle
    await page.waitForLoadState('load');
  });
  for (const sel of opts.clicks) await page.locator(sel).first().click({ timeout: 10000 });
  if (opts.wait) await page.waitForTimeout(opts.wait);
  await page.screenshot({ path: out, fullPage: opts.full });
  console.log(out);
} catch (e) {
  console.error(`shot failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
