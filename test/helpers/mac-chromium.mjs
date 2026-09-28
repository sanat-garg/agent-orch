// Chromium under a macOS LaunchDaemon (the MacBook worker: launchd's System domain, no window server) dies at launch in
// AppKit's WindowManagement XPC (_xpc_api_misuse, SIGILL). There, macChromiumEnv() builds a tiny shim that no-ops
// -[WMClientWindowManager sendWindowTransaction:] and returns the env that injects it into Playwright's own (unhardened)
// headless shell: {DYLD_INSERT_LIBRARIES, AGENT_ORCH_BROWSER_PATH}. Hardened Google Chrome ignores DYLD_*, so it can't be
// used there. Everywhere else (and when the shim can't be built) it returns {}.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHIM = `#import <objc/runtime.h>
#import <Foundation/Foundation.h>
#include <mach-o/dyld.h>
static void noop(id s, SEL c, id a) {}
static int done;
static void added(const struct mach_header *mh, intptr_t slide) {
  Class k = done ? nil : objc_getClass("WMClientWindowManager");
  Method m = k ? class_getInstanceMethod(k, sel_registerName("sendWindowTransaction:")) : NULL;
  if (m) { method_setImplementation(m, (IMP)noop); done = 1; }
}
__attribute__((constructor)) static void init(void) { _dyld_register_func_for_add_image(added); }
`;

function headlessShell() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), 'Library/Caches/ms-playwright');
  let dirs = [];
  try { dirs = fs.readdirSync(root).filter((d) => /^chromium_headless_shell-\d+$/.test(d)).sort((a, b) => b.split('-')[1] - a.split('-')[1]); } catch {}
  return dirs.flatMap((d) => ['chrome-headless-shell-mac-x64', 'chrome-headless-shell-mac-arm64'].map((m) => path.join(root, d, m, 'chrome-headless-shell')))
    .find((p) => fs.existsSync(p)) || null;
}

export function macChromiumEnv() {
  if (process.platform !== 'darwin') return {};
  try { if (execFileSync('launchctl', ['managername'], { encoding: 'utf8' }).trim() !== 'System') return {}; } catch { return {}; }
  const shell = headlessShell();
  if (!shell) return {};
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', '.cache', 'mac-chromium');
  const lib = path.join(dir, 'wm-shim.dylib');
  try {
    if (!fs.existsSync(lib)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'wm-shim.m'), SHIM);
      execFileSync('clang', ['-w', '-dynamiclib', '-framework', 'Foundation', '-o', `${lib}.${process.pid}`, path.join(dir, 'wm-shim.m')], { stdio: 'ignore' });
      fs.renameSync(`${lib}.${process.pid}`, lib);
    }
  } catch { return {}; }
  return { DYLD_INSERT_LIBRARIES: lib, AGENT_ORCH_BROWSER_PATH: shell };
}
