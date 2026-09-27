#!/usr/bin/env bash
# agent-orch worker installer for macOS (launchd). Design: .agent-orch/CLUSTER.md; README "Adding machines".
# One line from the head's "Add machine" (the code is one-time, valid 10 minutes):
#   curl -fsSL https://<head>/install/worker-macos.sh | sudo bash -s -- --controller https://<head> --code ABCD-1234
# Strongly recommended (the default under sudo): the worker runs as a dedicated standard user, 'agentorch', created
# here with sysadminctl. Agents run autonomously with full permissions; under their own account they can't read your
# documents, keychain, browser profiles or SSH keys. Your own LaunchAgent starts it (via a sudoers rule that allows
# exactly that one command), so it runs only while you are logged in, and KeepAlive restarts it.
# Installs Node 22 if missing (nvm when present, else the official tarball in ~/.local/node), clones or updates
# github.com/sanat-garg/agent-orch into ~/agent-orch-worker with the gh login, runs npm ci, optionally installs agent
# CLIs and pairs the machine. Idempotent: re-running updates everything; without --code an existing pairing is kept.
#   --controller URL  --code CODE  --name NAME (default: this Mac's name)  --agents claude,codex
#   --user NAME (dedicated user, default agentorch)  --no-dedicated-user (run as yourself, without sudo; not advised)
#   --dry-run (print what would run, change nothing)  --uninstall [--purge] (also delete the worker home)
set -euo pipefail

REPO=sanat-garg/agent-orch
LABEL=com.agent-orch.worker
LAUNCHER=/usr/local/bin/agent-orch-worker-run
CONTROLLER='' CODE='' NAME='' AGENTS='' WUSER=agentorch SELF=0 DRY=0 UNINSTALL=0 PURGE=0

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
# run CMD…: runs it, or prints it under --dry-run. stdin is /dev/null so a `curl … | bash` install never feeds the
# rest of this script to a child.
run() { if ((DRY)); then printf '+ %s\n' "$*"; else "$@" </dev/null; fi; }
tty_run() { if ((DRY)); then printf '+ %s\n' "$*"; else "$@" </dev/tty; fi; }
# write FILE: stdin → FILE (printed under --dry-run).
write() { if ((DRY)); then printf '+ write %s:\n' "$1"; sed 's/^/    /'; else cat >"$1"; fi; }
# write_root FILE MODE [check]: stdin → a root:wheel FILE (check = validate as sudoers first).
write_root() {
  if ((DRY)); then printf '+ write %s (mode %s, root):\n' "$1" "$2"; sed 's/^/    /'; return; fi
  local tmp; tmp="$(mktemp)"; cat >"$tmp"
  if [[ "${3:-}" == check ]] && ! visudo -cf "$tmp" >/dev/null; then rm -f "$tmp"; die "$1 failed validation"; fi
  mkdir -p "$(dirname "$1")"; install -m "$2" -o root -g wheel "$tmp" "$1"; rm -f "$tmp"
}

usage() { sed -n '2,16p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; }

parse() {
  while (($#)); do
    case "$1" in
      --controller) CONTROLLER="${2:?--controller needs a URL}"; shift ;;
      --code) CODE="${2:?--code needs a value}"; shift ;;
      --name) NAME="${2:?--name needs a value}"; shift ;;
      --agents) AGENTS="${2:?--agents needs a list}"; shift ;;
      --user) WUSER="${2:?--user needs a name}"; shift ;;
      --no-dedicated-user) SELF=1 ;;
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
  [[ -n "$NAME" ]] || NAME="$(scutil --get ComputerName 2>/dev/null || hostname -s)"
}

why_user() {
  cat <<'EOF'
Why a dedicated user: agent-orch runs coding agents autonomously with full permissions (no approval prompts).
Under your own account they could read your documents, photos, keychain, browser profiles and SSH keys. Under a
separate standard (non-admin) account, macOS keeps your files out of reach and the agents can't install system
software. It costs nothing: the account is hidden from the login window and your own login starts the worker.
EOF
}

# ---------------------------------------------------------------- worker stage (runs AS the worker account)
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

# The same commands as .agent-orch/AGENTS.md; an agent already on PATH is left alone. npm -g goes to the Node
# installed above (~/.local/node or nvm) or needs no sudo under Homebrew.
install_agents() {
  [[ -n "$AGENTS" ]] || return 0
  local a
  for a in ${AGENTS//,/ }; do
    if command -v "$a" >/dev/null; then say "$a already installed"; continue; fi
    say "Installing $a"
    case "$a" in
      claude) if ((DRY)); then echo "+ curl -fsSL https://claude.ai/install.sh | bash"; else curl -fsSL https://claude.ai/install.sh | bash </dev/null; fi ;;
      codex) run npm i -g @openai/codex ;;
    esac
  done
}

pair() {
  local cfg="${AGENT_ORCH_WORKER_HOME:-$HOME/.agent-orch-worker}/config.json"
  if [[ -n "$CODE" ]]; then
    [[ -n "$CONTROLLER" ]] || die "--code needs --controller"
    [[ -f "$cfg" ]] && say "Already paired; pairing again as a new machine (remove the old one in the head's UI)"
    say "Pairing as \"$NAME\""
    run node "$HOME/agent-orch-worker/worker.mjs" pair --controller "$CONTROLLER" --code "$CODE" --name "$NAME"
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
# The node binary the worker stage settled on, for the LaunchAgent.
node_path() {
  ensure_node >/dev/null
  if ((DRY)) && (($(node_major) < 22)); then echo "$HOME/.local/node/bin/node"; else command -v node; fi
}

# ---------------------------------------------------------------- owner stage (the logged-in owner's LaunchAgent)

plist() { # plist PROGRAM-ARGS… (as <string> lines) — env: WHOME_DIR, LOG
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
$([[ -n "${PLIST_PATH:-}" ]] && printf '  <key>EnvironmentVariables</key><dict><key>PATH</key><string>%s</string></dict>\n' "$PLIST_PATH" || true)
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
}

worker_path() { echo "$(dirname "$1"):$2/.local/bin:$2/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"; }
launcher() { # launcher NODE WORKER-HOME
  printf '#!/bin/sh\n# agent-orch worker launcher (install-worker-macos.sh): started by the owner'"'"'s LaunchAgent as %s.\n' "$WUSER"
  printf 'export PATH="%s"\nexec "%s" "%s/agent-orch-worker/worker.mjs" run\n' "$(worker_path "$1" "$2")" "$1" "$2"
}

# A LaunchAgent lives in the owner's GUI session, so the worker runs only while the owner is logged in.
load_agent() { # load_agent OWNER PLIST
  local uid; uid="$(id -u "$1")"
  run launchctl bootout "gui/$uid/$LABEL" 2>/dev/null || true
  run launchctl bootstrap "gui/$uid" "$2"
}

uninstall() {
  local owner="${SUDO_USER:-$(id -un)}" ohome; ohome="$(eval echo "~$owner")"
  local plistf="$ohome/Library/LaunchAgents/$LABEL.plist"
  say "Removing the LaunchAgent $LABEL"
  run launchctl bootout "gui/$(id -u "$owner")/$LABEL" || true
  run rm -f "$plistf"
  local home="$HOME"
  if ((EUID == 0)) && ((!SELF)); then
    run rm -f /etc/sudoers.d/agent-orch-worker "$LAUNCHER"
    home="$(eval echo "~$WUSER")"
  fi
  say "Removing $home/agent-orch-worker"
  run rm -rf "$home/agent-orch-worker"
  if ((PURGE)); then say "Removing $home/.agent-orch-worker"; run rm -rf "$home/.agent-orch-worker"; fi
  if ((EUID == 0)) && ((!SELF)); then say "The '$WUSER' account is kept. Delete it with: sudo sysadminctl -deleteUser $WUSER"; fi
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
    PLIST_PATH="$(worker_path "$node_bin" "$HOME")" plist "$node_bin" "$HOME/agent-orch-worker/worker.mjs" run | write "$plistf"
    load_agent "$(id -un)" "$plistf"
    finish "$HOME"
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
    whome="$(eval echo "~$WUSER")"
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
    sudo -u "$WUSER" -H bash -c "set -euo pipefail; $vars; $(declare -f); cd; worker_stage"
    node_bin="$(sudo -u "$WUSER" -H bash -c "set -euo pipefail; $vars; $(declare -f); cd; node_path" </dev/null)"
  fi
  [[ "$node_bin" == /* ]] || die "the worker stage didn't report a node binary"

  # A root-owned launcher sets PATH (sudo resets it; agents need node, git, gh, claude and codex), and the owner's
  # LaunchAgent may start exactly that one command as $WUSER, nothing else.
  say "Installing $LAUNCHER and allowing $owner to start it as $WUSER (/etc/sudoers.d/agent-orch-worker)"
  launcher "$node_bin" "$whome" | write_root "$LAUNCHER" 0755
  printf '%s ALL=(%s) NOPASSWD: %s\n' "$owner" "$WUSER" "$LAUNCHER" | write_root /etc/sudoers.d/agent-orch-worker 0440 check

  local ohome; ohome="$(eval echo "~$owner")"
  local LOG="$ohome/Library/Logs/agent-orch-worker.log" plistf="$ohome/Library/LaunchAgents/$LABEL.plist"
  run sudo -u "$owner" mkdir -p "$ohome/Library/LaunchAgents" "$ohome/Library/Logs"
  plist /usr/bin/sudo -n -u "$WUSER" -H "$LAUNCHER" | write "$plistf"
  run chown "$owner" "$plistf"
  load_agent "$owner" "$plistf"
  finish "$whome"
}

finish() {
  say "Done. The worker runs while you're logged in and restarts if it stops. Log: $LOG"
  say "Status: node $1/agent-orch-worker/worker.mjs status"
  say "Next: sign the agents in on this machine (the head's Connections window)."
}

main "$@"
