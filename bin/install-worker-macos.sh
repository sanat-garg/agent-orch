#!/usr/bin/env bash
# agent-orch worker installer for macOS (launchd). Design: .agent-orch/CLUSTER.md; README "Adding machines".
# One line from the head's "Add machine" (a one-time code is valid 10 minutes; a multi-use code pairs up to N Macs
# within an hour, the same line on each, and every Mac names itself, e.g. "MacBook Pro (Sanat-MBP-2)"):
#   curl -fsSL https://<head>/install/worker-macos.sh | sudo bash -s -- --controller https://<head> --code ABCD-1234
# The worker runs as a dedicated standard user, 'agentorch', created here with sysadminctl: agents run autonomously
# with full permissions, and under their own account they can't read your documents, keychain, browser profiles or
# SSH keys. How it starts (--service):
#   daemon (default, recommended): a LaunchDaemon starts it at boot as agentorch, whether or not anyone is logged in.
#   login: your own LaunchAgent starts it as agentorch when you log in (a sudoers rule allows exactly that one
#          command), and it stops when you log out.
# Either way launchd restarts it if it stops. Power policy (the head sends it; change it per Mac in Machines → Power):
# new tasks on AC power or above 50% battery, none at heavy thermal pressure, at most cores − 1 tasks with 3 GB of RAM
# left for you, and while tasks run on AC power the worker keeps the Mac awake with `caffeinate -i -w <worker pid>`.
# Installs Node 22 if missing (nvm when present, else the official tarball in ~/.local/node), clones or updates
# github.com/sanat-garg/agent-orch into ~/agent-orch-worker with the gh login, runs npm ci, optionally installs agent
# CLIs and pairs the machine. Idempotent: re-running updates everything; without --code an existing pairing is kept.
# Only the worker service: no agent-orch web service, Caddy or ttyd (workers are compute-only; the head runs those).
#   --controller URL  --code CODE  --name NAME (default: "<model> (<host name>)")  --agents claude,codex
#   --service daemon|login  --user NAME (dedicated user, default agentorch)
#   --no-dedicated-user (run as yourself from your own LaunchAgent, without sudo; not advised)
#   --status-window (also open the live status view, worker.mjs status, in a Terminal window at every login)
#   --dry-run (print what would run, change nothing)  --uninstall [--purge] (also delete the worker home)
set -euo pipefail

REPO=sanat-garg/agent-orch
LABEL=com.agent-orch.worker
LAUNCHER=/usr/local/bin/agent-orch-worker-run
SUDOERS=/etc/sudoers.d/agent-orch-worker
DAEMON_PLIST=/Library/LaunchDaemons/$LABEL.plist
# --status-window: a root-owned script that opens the status view as the worker's user (a sudoers rule allows exactly
# that one command), and your LaunchAgent that opens it in Terminal when you log in.
STATUS_LABEL=$LABEL.status
STATUS_BIN=/usr/local/bin/agent-orch-worker-status
STATUS_SUDOERS=/etc/sudoers.d/agent-orch-worker-status
CONTROLLER='' CODE='' NAME='' AGENTS='' WUSER=agentorch SERVICE='' SELF=0 DRY=0 UNINSTALL=0 PURGE=0 STATUS_WINDOW=0 STATUS_NOTE=''

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
# run CMD…: runs it, or prints it under --dry-run. stdin is /dev/null so a `curl … | bash` install never feeds the
# rest of this script to a child.
run() { if ((DRY)); then printf '+ %s\n' "$*"; else "$@" </dev/null; fi; }
# tty_run CMD…: an interactive step (gh auth login). Its prompts can leave the terminal in raw mode, where every later
# line starts where the last one ended; stty sane puts it back either way.
tty_run() {
  if ((DRY)); then printf '+ %s\n' "$*"; return; fi
  local rc=0
  "$@" </dev/tty || rc=$?
  stty sane </dev/tty 2>/dev/null || true
  return "$rc"
}
# write FILE: stdin → FILE (printed under --dry-run).
write() { if ((DRY)); then printf '+ write %s:\n' "$1"; sed 's/^/    /'; else cat >"$1"; fi; }
# write_root FILE MODE [check]: stdin → a root:wheel FILE (check = validate as sudoers first).
write_root() {
  if ((DRY)); then printf '+ write %s (mode %s, root):\n' "$1" "$2"; sed 's/^/    /'; return; fi
  local tmp; tmp="$(mktemp)"; cat >"$tmp"
  if [[ "${3:-}" == check ]] && ! visudo -cf "$tmp" >/dev/null; then rm -f "$tmp"; die "$1 failed validation"; fi
  mkdir -p "$(dirname "$1")"; install -m "$2" -o root -g wheel "$tmp" "$1"; rm -f "$tmp"
}
# ~NAME, or /Users/NAME for an account that doesn't exist (yet).
home_of() { local h; h="$(eval echo "~$1")"; [[ "$h" == "~"* ]] && h="/Users/$1"; echo "$h"; }

usage() { sed -n '2,23p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; }

parse() {
  while (($#)); do
    case "$1" in
      --controller) CONTROLLER="${2:?--controller needs a URL}"; shift ;;
      --code) CODE="${2:?--code needs a value}"; shift ;;
      --name) NAME="${2:?--name needs a value}"; shift ;;
      --agents) AGENTS="${2:?--agents needs a list}"; shift ;;
      --service) SERVICE="${2:?--service needs daemon or login}"; shift ;;
      --user) WUSER="${2:?--user needs a name}"; shift ;;
      --no-dedicated-user) SELF=1 ;;
      --status-window) STATUS_WINDOW=1 ;;
      --dry-run) DRY=1 ;;
      --uninstall) UNINSTALL=1 ;;
      --purge) PURGE=1 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
    shift
  done
  [[ -z "$CONTROLLER" || "$CONTROLLER" =~ ^https?://[^[:space:]]+$ ]] || die "--controller must be an http(s) URL"
  [[ -z "$AGENTS" || "$AGENTS" =~ ^(claude|codex)(,(claude|codex))*$ ]] || die "--agents takes a comma list of: claude, codex"
  [[ "$WUSER" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] || die "--user must be a short lowercase account name"
  [[ -z "$SERVICE" || "$SERVICE" =~ ^(daemon|login)$ ]] || die "--service takes daemon (a LaunchDaemon, the default) or login (starts at your login)"
  ((!SELF)) || [[ "$SERVICE" != daemon ]] || die "--no-dedicated-user runs the worker from your own LaunchAgent; a LaunchDaemon needs the dedicated user"
  SERVICE="${SERVICE:-daemon}"
}

why_user() {
  cat <<'EOF'
Why a dedicated user: agent-orch runs coding agents autonomously with full permissions (no approval prompts).
Under your own account they could read your documents, photos, keychain, browser profiles and SSH keys. Under a
separate standard (non-admin) account, macOS keeps your files out of reach and the agents can't install system
software. It costs nothing: the account is hidden from the login window, and launchd starts the worker for it.
EOF
}

# ---------------------------------------------------------------- worker stage (runs AS the worker account)
# These functions go to the worker account's own bash as text (declare -f, see main). macOS's /bin/bash is 3.2, and its
# declare -f reprints a here-document piped into a command (`cat <<EOF | cmd`) with the pipe after EOF, which no bash
# can parse back ("syntax error near unexpected token `|'"): so nothing in this file pipes a here-document; feed it
# straight in (`cmd <<EOF`). test/install-scripts.test.mjs checks both.
WORKER_FUNCS=(say warn die run tty_run node_major ensure_node ensure_gh ensure_checkout install_agents pair worker_stage node_path)
# Everything here uses $HOME, so the same functions serve the dedicated user (via sudo -u … -H) and --no-dedicated-user.

node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

ensure_node() {
  export PATH="$HOME/.local/node/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
  if (($(node_major) >= 22)); then say "Node $(node -v) found"; return; fi
  if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
    say "Installing Node 22 with nvm"
    if ((DRY)); then echo "+ nvm install 22"; return; fi
    # shellcheck disable=SC1091
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"; nvm install 22 </dev/null; nvm use 22 >/dev/null; return
  fi
  local arch; case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64) arch=x64 ;; *) die "unsupported CPU: $(uname -m)" ;; esac
  say "Installing Node 22 (official darwin-$arch tarball) into ~/.local/node"
  local base=https://nodejs.org/dist/latest-v22.x
  if ((DRY)); then echo "+ curl $base/node-v22.*-darwin-$arch.tar.gz | tar -xz -C ~/.local/node --strip-components=1"; return; fi
  local file; file="$(curl -fsSL "$base/SHASUMS256.txt" | grep -o "node-v22[.0-9]*-darwin-$arch\.tar\.gz" | head -1)"
  [[ -n "$file" ]] || die "could not find a Node 22 tarball for darwin-$arch"
  rm -rf "$HOME/.local/node" && mkdir -p "$HOME/.local/node"
  curl -fsSL "$base/$file" | tar -xz -C "$HOME/.local/node" --strip-components=1
  (($(node_major) >= 22)) || die "Node install failed"
}

ensure_gh() {
  command -v gh >/dev/null || ((DRY)) || die "the GitHub CLI is missing: install it (brew install gh, or https://cli.github.com) and re-run"
  if ((DRY)); then echo "+ gh auth status || gh auth login   (interactive, as $(id -un))"; echo "+ gh auth setup-git"; return; fi
  if ! gh auth status >/dev/null 2>&1; then
    say "GitHub isn't signed in for $(id -un): sign in (the worker clones and pushes task branches with it)"
    tty_run gh auth login --git-protocol https
  fi
  run gh auth setup-git
}

ensure_checkout() {
  local dir="$HOME/agent-orch-worker"
  if [[ -d "$dir/.git" ]]; then say "Updating $dir"; run git -C "$dir" pull --ff-only
  else say "Cloning $REPO into $dir"; run gh repo clone "$REPO" "$dir"; fi
  if ((DRY)); then echo "+ (cd $dir && npm ci)"; else (cd "$dir" && npm ci </dev/null); fi
}

# The same commands as .agent-orch/AGENTS.md; an agent already on PATH is left alone. Both land in the worker's own
# ~/.local/bin (on its PATH here and in the launchd service): Claude's installer puts it there, and codex goes there
# with --prefix, because npm -g would write to the Node's own prefix, which under Homebrew (/opt/homebrew) belongs to
# the Mac's admin, not to the worker account (EACCES). A failed install warns and the rest carries on: the machine
# pairs, and the head shows the agent as missing until it is installed.
install_agents() {
  [[ -n "$AGENTS" ]] || return 0
  local a ok
  for a in ${AGENTS//,/ }; do
    if command -v "$a" >/dev/null; then say "$a already installed ($(command -v "$a"))"; continue; fi
    say "Installing $a into ~/.local/bin"
    ok=1
    case "$a" in
      claude) if ((DRY)); then echo "+ curl -fsSL https://claude.ai/install.sh | bash"; else curl -fsSL https://claude.ai/install.sh | bash </dev/null || ok=0; fi ;;
      codex) run npm i -g --prefix "$HOME/.local" @openai/codex || ok=0 ;;
    esac
    ((ok)) || warn "couldn't install $a; the worker still pairs without it. Install it later as $(id -un) (the same command) and re-run this installer."
  done
}

# A one-time or a multi-use code: the same command pairs each Mac as a machine of its own. Without --name the worker
# names it "<model> (<local host name>)"; the head makes names unique, and the owner can rename machines there.
pair() {
  local cfg="${AGENT_ORCH_WORKER_HOME:-$HOME/.agent-orch-worker}/config.json"
  if [[ -n "$CODE" ]]; then
    [[ -n "$CONTROLLER" ]] || ((DRY)) || die "--code needs --controller (the head's URL, as in its \"Add machine\" line)"
    [[ -f "$cfg" ]] && say "Already paired; pairing again as a new machine (remove the old one in the head's UI)"
    if [[ -n "$NAME" ]]; then say "Pairing as \"$NAME\""
    else say "Pairing: this Mac names itself \"<model> (<host name>)\" (rename it in the head's Machines view)"; fi
    local args=(pair --controller "${CONTROLLER:-https://<controller>}" --code "$CODE")
    [[ -n "$NAME" ]] && args+=(--name "$NAME")
    run node "$HOME/agent-orch-worker/worker.mjs" "${args[@]}"
  elif [[ -f "$cfg" ]]; then say "Already paired (keeping it)"
  elif ((DRY)); then echo "+ (no --code: pairing skipped)"
  else die "not paired yet: pass --controller <url> --code <code> from the head's \"Add machine\""; fi
}

worker_stage() {
  ensure_node
  ensure_gh
  ensure_checkout
  install_agents
  pair
}
# The node binary the worker stage settled on, for launchd.
node_path() {
  ensure_node >/dev/null
  if ((DRY)) && (($(node_major) < 22)); then echo "$HOME/.local/node/bin/node"; else command -v node; fi
}

# ---------------------------------------------------------------- the service (launchd)

# plist PROGRAM-ARGS… (env: LOG, KEYS = extra <key> lines). ProcessType Standard with Nice 5: the worker gets every core
# (Background would confine it to the efficiency cores) but yields to your apps; its policy caps what it takes.
plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
$(for a in "$@"; do printf '    <string>%s</string>\n' "$a"; done)
  </array>
${KEYS:-}  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Standard</string>
  <key>Nice</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
}
env_keys() { # env_keys HOME PATH [USER]
  printf '  <key>EnvironmentVariables</key>\n  <dict>\n    <key>HOME</key><string>%s</string>\n    <key>PATH</key><string>%s</string>\n' "$1" "$2"
  [[ -n "${3:-}" ]] && printf '    <key>USER</key><string>%s</string>\n' "$3"
  printf '  </dict>\n'
}
worker_path() { echo "$(dirname "$1"):$2/.local/bin:$2/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"; }

# A LaunchAgent lives in a GUI login session: it runs while that user is logged in.
load_agent() { # load_agent USER PLIST [LABEL]
  local uid; uid="$(id -u "$1")"
  run launchctl bootout "gui/$uid/${3:-$LABEL}" 2>/dev/null || true
  run launchctl bootstrap "gui/$uid" "$2"
}

# --service daemon: launchd starts the worker at boot as $WUSER, whether or not anyone is logged in.
install_daemon() { # install_daemon OWNER NODE WORKER-HOME
  remove_login "$1"
  local LOG="$3/Library/Logs/agent-orch-worker.log"
  run sudo -u "$WUSER" mkdir -p "$3/Library/Logs"
  say "Installing the LaunchDaemon $DAEMON_PLIST: it starts the worker at boot as $WUSER, whether or not anyone is logged in"
  KEYS="$(printf '  <key>UserName</key><string>%s</string>\n  <key>GroupName</key><string>staff</string>\n  <key>InitGroups</key><true/>\n  <key>WorkingDirectory</key><string>%s</string>\n' "$WUSER" "$3/agent-orch-worker")
$(env_keys "$3" "$(worker_path "$2" "$3")" "$WUSER")
" plist "$2" "$3/agent-orch-worker/worker.mjs" run | write_root "$DAEMON_PLIST" 0644
  run launchctl bootout "system/$LABEL" 2>/dev/null || true
  run launchctl enable "system/$LABEL"
  run launchctl bootstrap system "$DAEMON_PLIST"
  FINISH="Done. The worker runs as $WUSER from boot (LaunchDaemon $LABEL), whether or not anyone is logged in; launchd restarts it if it stops. Log: $LOG"
}

# --service login: a root-owned launcher sets PATH (sudo resets it; agents need node, git, gh, claude and codex), and the
# owner's LaunchAgent may start exactly that one command as $WUSER, nothing else. It runs while the owner is logged in.
launcher() { # launcher NODE WORKER-HOME
  printf '#!/bin/sh\n# agent-orch worker launcher (install-worker-macos.sh): started by the owner'"'"'s LaunchAgent as %s.\n' "$WUSER"
  printf 'export PATH="%s"\nexec "%s" "%s/agent-orch-worker/worker.mjs" run\n' "$(worker_path "$1" "$2")" "$1" "$2"
}
install_login() { # install_login OWNER NODE WORKER-HOME
  remove_daemon
  say "Installing $LAUNCHER and allowing $1 to start it as $WUSER ($SUDOERS)"
  launcher "$2" "$3" | write_root "$LAUNCHER" 0755
  printf '%s ALL=(%s) NOPASSWD: %s\n' "$1" "$WUSER" "$LAUNCHER" | write_root "$SUDOERS" 0440 check
  local ohome; ohome="$(home_of "$1")"
  local LOG="$ohome/Library/Logs/agent-orch-worker.log" plistf="$ohome/Library/LaunchAgents/$LABEL.plist"
  run sudo -u "$1" mkdir -p "$ohome/Library/LaunchAgents" "$ohome/Library/Logs"
  KEYS='  <key>LimitLoadToSessionType</key><string>Aqua</string>
' plist /usr/bin/sudo -n -u "$WUSER" -H "$LAUNCHER" | write "$plistf"
  run chown "$1" "$plistf"
  load_agent "$1" "$plistf"
  FINISH="Done. The worker runs as $WUSER while you're logged in (your LaunchAgent $LABEL) and restarts if it stops. Log: $LOG"
}

# The other mode's pieces, so one install never leaves two workers running on the same token.
remove_login() { # remove_login OWNER
  local plistf; plistf="$(home_of "$1")/Library/LaunchAgents/$LABEL.plist"
  [[ -f "$plistf" || -f "$LAUNCHER" || -f "$SUDOERS" ]] || return 0
  say "Removing the login-mode LaunchAgent, launcher and sudoers rule"
  run launchctl bootout "gui/$(id -u "$1")/$LABEL" 2>/dev/null || true
  run rm -f "$plistf" "$LAUNCHER" "$SUDOERS"
}
remove_daemon() {
  [[ -f "$DAEMON_PLIST" ]] || return 0
  say "Removing the LaunchDaemon $DAEMON_PLIST"
  run launchctl bootout "system/$LABEL" 2>/dev/null || true
  run rm -f "$DAEMON_PLIST"
}

# --status-window: the live status view (worker.mjs status, q quits) opens in a Terminal window each time OWNER logs in:
# their LaunchAgent runs `open -a Terminal SCRIPT` once per login. With the dedicated user, SCRIPT is root-owned and
# re-runs itself as that user (the status socket is theirs, 0600) under a sudoers rule for exactly it.
status_script() { # status_script NODE WORKER-HOME [RUN-AS]
  printf '#!/bin/sh\n# agent-orch worker status (install-worker-macos.sh --status-window): the live view of this Mac'"'"'s worker; q quits.\n'
  if [[ -n "${3:-}" ]]; then printf '[ "$(id -un)" = %s ] || exec /usr/bin/sudo -u %s -H "$0" "$@"\n' "$3" "$3"; fi
  printf 'exec "%s" "%s/agent-orch-worker/worker.mjs" status "$@"\n' "$1" "$2"
}
install_status_window() { # install_status_window OWNER NODE WORKER-HOME
  local ohome script; if ((SELF)); then ohome="$HOME"; else ohome="$(home_of "$1")"; fi
  local plistf="$ohome/Library/LaunchAgents/$STATUS_LABEL.plist"
  if ((SELF)); then
    script="$3/.agent-orch-worker/status.command"
    say "Adding the status view to your logins ($script, opened in Terminal)"
    run mkdir -p "$3/.agent-orch-worker"
    status_script "$2" "$3" | write "$script"
    run chmod 0755 "$script"
  else
    script="$STATUS_BIN"
    say "Installing $STATUS_BIN and allowing $1 to run it as $WUSER ($STATUS_SUDOERS); it opens in Terminal at each login"
    status_script "$2" "$3" "$WUSER" | write_root "$STATUS_BIN" 0755
    printf '%s ALL=(%s) NOPASSWD: %s\n' "$1" "$WUSER" "$STATUS_BIN" | write_root "$STATUS_SUDOERS" 0440 check
  fi
  if ((SELF)); then run mkdir -p "$ohome/Library/LaunchAgents"; else run sudo -u "$1" mkdir -p "$ohome/Library/LaunchAgents"; fi
  write "$plistf" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$STATUS_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-a</string>
    <string>Terminal</string>
    <string>$script</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
EOF
  run chown "$1" "$plistf"
  load_agent "$1" "$plistf" "$STATUS_LABEL"
  STATUS_NOTE="The status view also opens in Terminal each time $1 logs in ($STATUS_LABEL)."
}

# The power policy the worker follows (the head sends it: power.mjs). Nothing to install: caffeinate and pmset ship with
# macOS, and caffeinate needs no root.
power_policy() {
  say "Power policy (the defaults; change them per Mac in the head's Server details → Machines → Power):"
  cat <<'EOF'
    - new tasks only on AC power, or on battery above 50%; none while the Mac runs hot (heavy thermal pressure)
    - at most cores − 1 tasks at once (Max tasks: Auto), leaving 3 GB of RAM free for you
    - while tasks run on AC power the worker keeps the Mac awake: caffeinate -i -w <worker pid> (idle sleep only; it
      ends with the last task or the worker)
    - closing the lid still sleeps the Mac: the head shows it asleep and moves its tasks to another machine after 5 min
EOF
  [[ -x /usr/bin/caffeinate ]] || ((DRY)) || say "Warning: /usr/bin/caffeinate is missing, so the Mac may sleep while tasks run"
}

uninstall() {
  local owner="${SUDO_USER:-$(id -un)}"
  say "Removing the service $LABEL"
  if ((EUID == 0 || DRY)) && ((!SELF)); then
    run launchctl bootout "system/$LABEL" 2>/dev/null || true
    run rm -f "$DAEMON_PLIST" "$SUDOERS" "$LAUNCHER" "$STATUS_BIN" "$STATUS_SUDOERS"
  fi
  run launchctl bootout "gui/$(id -u "$owner")/$LABEL" 2>/dev/null || true
  run launchctl bootout "gui/$(id -u "$owner")/$STATUS_LABEL" 2>/dev/null || true
  run rm -f "$(home_of "$owner")/Library/LaunchAgents/$LABEL.plist" "$(home_of "$owner")/Library/LaunchAgents/$STATUS_LABEL.plist"
  local home="$HOME"
  if ((EUID == 0 || DRY)) && ((!SELF)); then home="$(home_of "$WUSER")"; fi
  say "Removing $home/agent-orch-worker"
  run rm -rf "$home/agent-orch-worker"
  if ((PURGE)); then say "Removing $home/.agent-orch-worker"; run rm -rf "$home/.agent-orch-worker"; fi
  if ((EUID == 0 || DRY)) && ((!SELF)); then say "The '$WUSER' account is kept. Delete it with: sudo sysadminctl -deleteUser $WUSER"; fi
  say "Remove the machine in the head's UI too."
}

# ---------------------------------------------------------------- main

main() {
  parse "$@"
  ((DRY)) && say "Dry run: nothing is changed"
  [[ "$(uname -s)" == Darwin ]] || ((DRY)) || die "this is the macOS installer; on Linux use install-worker.sh"
  if ((UNINSTALL)); then uninstall; exit 0; fi

  if ((SELF)); then
    ((EUID != 0)) || die "--no-dedicated-user installs for yourself: run it without sudo"
    say "Warning: installing under your own account ($(id -un)). Agents will be able to read your files."
    why_user
    worker_stage
    local node_bin; node_bin="$(node_path)"
    local LOG="$HOME/Library/Logs/agent-orch-worker.log" plistf="$HOME/Library/LaunchAgents/$LABEL.plist"
    run mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    KEYS="  <key>LimitLoadToSessionType</key><string>Aqua</string>
$(env_keys "$HOME" "$(worker_path "$node_bin" "$HOME")")
" plist "$node_bin" "$HOME/agent-orch-worker/worker.mjs" run | write "$plistf"
    load_agent "$(id -un)" "$plistf"
    ((STATUS_WINDOW)) && install_status_window "$(id -un)" "$node_bin" "$HOME"
    power_policy
    FINISH="Done. The worker runs while you're logged in and restarts if it stops. Log: $LOG"
    finish "$HOME" ''
    return
  fi

  if ((EUID != 0)) && ((!DRY)); then
    why_user
    die "run it with sudo to set up the '$WUSER' account (recommended), or pass --no-dedicated-user to use yours"
  fi
  local owner="${SUDO_USER:-}"
  [[ -n "$owner" && "$owner" != root ]] || ((DRY)) || die "run it with sudo from your own (logged-in) account, not as root"
  owner="${owner:-$(id -un)}"
  why_user

  local whome="/Users/$WUSER"
  if id "$WUSER" >/dev/null 2>&1; then
    say "Using the existing '$WUSER' account"
    whome="$(home_of "$WUSER")"
  else
    say "Creating the standard user '$WUSER' (hidden from the login window)"
    local pw; pw="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32 || true)"
    if ((DRY)); then echo "+ sysadminctl -addUser $WUSER -fullName 'agent-orch worker' -home $whome -password <random>"
    else sysadminctl -addUser "$WUSER" -fullName 'agent-orch worker' -home "$whome" -password "$pw" </dev/null; fi
    run createhomedir -c -u "$WUSER"
    run dscl . -create "/Users/$WUSER" IsHidden 1
  fi

  say "Setting up the worker as '$WUSER'"
  local vars node_bin
  vars="$(declare -p REPO LABEL CONTROLLER CODE NAME AGENTS DRY)"
  if ((DRY)); then
    echo "+ sudo -u $WUSER -H bash -c '<worker stage>'   (as $WUSER, HOME=$whome):"
    HOME="$whome" worker_stage
    node_bin="$(HOME="$whome" node_path)"
  else
    sudo -u "$WUSER" -H bash -c "set -euo pipefail; $vars; $(declare -f "${WORKER_FUNCS[@]}"); cd; worker_stage"
    node_bin="$(sudo -u "$WUSER" -H bash -c "set -euo pipefail; $vars; $(declare -f "${WORKER_FUNCS[@]}"); cd; node_path" </dev/null)"
  fi
  [[ "$node_bin" == /* ]] || die "the worker stage didn't report a node binary"

  if [[ "$SERVICE" == daemon ]]; then install_daemon "$owner" "$node_bin" "$whome"; else install_login "$owner" "$node_bin" "$whome"; fi
  ((STATUS_WINDOW)) && install_status_window "$owner" "$node_bin" "$whome"
  power_policy
  finish "$whome" "sudo -u $WUSER -H "
}

# How to open the status view and set the one local setting, the cap on what this Mac lends (the head keeps to it).
finish() { # finish WORKER-HOME RUN-AS-PREFIX
  say "$FINISH"
  say "Live status (connection, cap, running tasks; q quits): ${2}node $1/agent-orch-worker/worker.mjs status"
  if [[ -n "$STATUS_NOTE" ]]; then say "$STATUS_NOTE"; else say "To open it in Terminal at every login, run this installer again with --status-window."; fi
  say "Cap what this Mac lends the cluster: ${2}node $1/agent-orch-worker/worker.mjs limit --cpu 4 --mem 8   (cores or %, GB or %; --show, --reset)"
  say "Next: sign the agents in on this machine (the head's Connections window)."
}

main "$@"
