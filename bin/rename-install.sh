#!/bin/bash
# One-shot move of the live install from /home/ubuntu/claude-web to /home/ubuntu/agent-orch:
# the directory, the systemd units, paths in the orchestrator DB and convos.json, and the Claude Code
# session dir (so chats can still resume). Idempotent: every step checks whether it is already done.
# Usage: bin/rename-install.sh [--dry-run]    (run as ubuntu with sudo available, or as root)
set -euo pipefail

OLD=/home/ubuntu/claude-web
NEW=/home/ubuntu/agent-orch
UNITS=(claude-web:agent-orch claude-shell:agent-orch-shell claude-tmux:agent-orch-tmux)
UNIT_DIR=/etc/systemd/system
SESS_OLD=/home/ubuntu/.claude/projects/-home-ubuntu-claude-web
SESS_NEW=/home/ubuntu/.claude/projects/-home-ubuntu-agent-orch
CADDYFILE=/etc/caddy/Caddyfile

DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  '') ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

SUDO=; [[ $EUID -eq 0 ]] || SUDO=sudo
say() { echo "==> $*"; }
# Runs a command, or only prints it with --dry-run.
run() { if ((DRY)); then echo "    [dry-run] $*"; else echo "    + $*"; "$@"; fi; }

main() {
  ((DRY)) && say "dry run: nothing will be changed"
  # Stopping claude-tmux/claude-shell would kill a browser terminal running this script halfway through.
  if ((!DRY)) && [[ -n ${TMUX:-} ]]; then echo "run this over ssh, not inside tmux (the browser terminal)" >&2; exit 1; fi

  # 1) Stop the web app (the orchestrator runs inside it), so the DB and convos.json are quiescent.
  say "1) stop claude-web.service"
  if [[ -f $UNIT_DIR/claude-web.service ]] && systemctl is-active --quiet claude-web; then
    run $SUDO systemctl stop claude-web
  else echo "    claude-web.service not running; skip"; fi

  # 2) Move the install directory.
  say "2) move $OLD -> $NEW"
  if [[ -d $OLD && ! -e $NEW ]]; then run mv "$OLD" "$NEW"
  elif [[ -d $OLD && -e $NEW ]]; then echo "    both $OLD and $NEW exist; resolve by hand" >&2; exit 1
  else echo "    already moved; skip"; fi
  # Where the data lives right now (the old dir during a dry run, before the move).
  local root=$NEW; [[ -d $NEW ]] || root=$OLD

  # 3) Rename the systemd units, rewriting paths and unit references.
  say "3) rename systemd units"
  local pair old new
  for pair in "${UNITS[@]}"; do
    old=${pair%%:*} new=${pair##*:}
    if [[ -f $UNIT_DIR/$old.service ]]; then
      if [[ -f $UNIT_DIR/$new.service ]]; then echo "    $new.service exists; keep it"
      else
        echo "    write $UNIT_DIR/$new.service (from $old.service)"
        local body
        body=$(sed -e "s#$OLD#$NEW#g" -e 's/claude-tmux\.service/agent-orch-tmux.service/g' \
                   -e 's/claude-web\.service/agent-orch.service/g' -e 's/claude-shell\.service/agent-orch-shell.service/g' \
                   -e 's/Claude Web/agent-orch/g' "$UNIT_DIR/$old.service")
        if ((DRY)); then sed 's/^/      | /' <<<"$body"
        else $SUDO tee "$UNIT_DIR/$new.service" >/dev/null <<<"$body"; fi
      fi
      run $SUDO systemctl disable --now "$old.service"
      run $SUDO rm -f "$UNIT_DIR/$old.service"
    else
      [[ -f $UNIT_DIR/$new.service ]] && echo "    $old -> $new already done; skip" \
        || echo "    WARNING: neither $old.service nor $new.service exists" >&2
    fi
  done

  # 4+5) Orchestrator DB and convos.json path prefixes (node:sqlite; there is no sqlite3 CLI).
  say "4) update orchestrator DB   5) update data/convos.json"
  DRY=$DRY ROOT=$root OLD=$OLD NEW=$NEW node --no-warnings --input-type=module <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const { DRY, ROOT, OLD, NEW } = process.env, dry = DRY === '1';
const tag = dry ? '    [dry-run]' : '    +';
const moved = v => typeof v === 'string' && (v === OLD || v.startsWith(OLD + '/')) ? NEW + v.slice(OLD.length) : null;

const dir = path.join(ROOT, 'data/orchestrator');
const dbFile = ['agent-orch.db', 'ao2.db'].map(f => path.join(dir, f)).find(f => fs.existsSync(f));
if (!dbFile) console.log('    no orchestrator DB; skip');
else {
  const db = new DatabaseSync(dbFile, { readOnly: dry });
  let n = 0;
  for (const p of db.prepare('SELECT id, name FROM projects WHERE path = ?').all(OLD)) {
    console.log(`${tag} ${path.basename(dbFile)}: projects #${p.id} path ${OLD} -> ${NEW}, name ${p.name} -> agent-orch`);
    if (!dry) db.prepare('UPDATE projects SET path = ?, name = ? WHERE id = ?').run(NEW, 'agent-orch', p.id);
    n++;
  }
  // Any other path-like column (cwd, *_path, *_cwd, *_dir) holding the old prefix.
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name);
  for (const t of tables) for (const { name: c } of db.prepare(`PRAGMA table_info("${t}")`).all()) {
    if (!/^(path|cwd)$|_(path|cwd|dir)$/.test(c) || (t === 'projects' && c === 'path')) continue;
    const rows = db.prepare(`SELECT rowid AS r, "${c}" AS v FROM "${t}" WHERE "${c}" = ? OR "${c}" LIKE ? ESCAPE '\\'`)
      .all(OLD, OLD.replace(/[\\%_]/g, '\\$&') + '/%');
    if (!rows.length) continue;
    console.log(`${tag} ${path.basename(dbFile)}: ${t}.${c}: ${rows.length} row(s) ${OLD}/... -> ${NEW}/...`);
    if (!dry) { const u = db.prepare(`UPDATE "${t}" SET "${c}" = ? WHERE rowid = ?`); for (const r of rows) u.run(moved(r.v), r.r); }
    n += rows.length;
  }
  if (!n) console.log('    DB already up to date; skip');
  db.close();
}

const convos = path.join(ROOT, 'data/convos.json');
if (!fs.existsSync(convos)) console.log('    no data/convos.json; skip');
else {
  const list = JSON.parse(fs.readFileSync(convos, 'utf8'));
  const hits = list.filter(c => moved(c.cwd));
  for (const c of hits) { console.log(`${tag} convos.json: ${c.id} (${c.title}) cwd ${c.cwd} -> ${moved(c.cwd)}`); c.cwd = moved(c.cwd); }
  if (!hits.length) console.log('    convos.json already up to date; skip');
  else if (!dry) { fs.writeFileSync(convos + '.tmp', JSON.stringify(list, null, 2)); fs.renameSync(convos + '.tmp', convos); }
}
JS

  # 6) Claude Code keys session history by cwd, so rename its project dir for resume to keep working.
  say "6) rename $SESS_OLD -> $SESS_NEW"
  if [[ -d $SESS_OLD && ! -e $SESS_NEW ]]; then run mv "$SESS_OLD" "$SESS_NEW"
  elif [[ -d $SESS_OLD ]]; then
    echo "    both exist; merge without overwriting"
    run find "$SESS_OLD" -mindepth 1 -maxdepth 1 -exec mv -n -t "$SESS_NEW" {} +
    run rmdir --ignore-fail-on-non-empty "$SESS_OLD"
  else echo "    already renamed (or no sessions); skip"; fi

  if [[ -f $CADDYFILE ]] && grep -q "$OLD" "$CADDYFILE"; then
    echo "    WARNING: $CADDYFILE still mentions $OLD; update it by hand" >&2
  else echo "    Caddyfile has no old paths"; fi

  # 7) Start the new units.
  say "7) reload systemd, enable and start the new units"
  run $SUDO systemctl daemon-reload
  run $SUDO systemctl enable --now agent-orch-tmux.service agent-orch-shell.service agent-orch.service
  if ((DRY)); then echo "    [dry-run] systemctl status agent-orch agent-orch-shell agent-orch-tmux"
  else systemctl --no-pager status agent-orch agent-orch-shell agent-orch-tmux || true; fi
  say "done"
}

main "$@"
