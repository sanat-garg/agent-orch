// Keep fixture servers from discovering installed agent CLIs or downloading their caches.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function isolatedPath(bin) {
  for (const name of ['bash', 'git', 'which']) {
    const target = execFileSync('which', [name], { encoding: 'utf8' }).trim();
    fs.symlinkSync(target, path.join(bin, name));
  }
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  return bin;
}
