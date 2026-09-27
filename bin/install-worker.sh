#!/usr/bin/env bash
# agent-orch worker installer for Linux (systemd). Design: .agent-orch/CLUSTER.md; README "Adding machines".
# One line from the head's "Add machine" (a one-time code lasts 10 minutes; a multi-use one pairs several in 1 h):
#   curl -fsSL https://<head>/install/worker-linux.sh | bash -s -- --controller https://<head> --code ABCD-1234
# Installs Node 22 if missing (nvm when present, else the official tarball in ~/.local/node), clones or updates
# github.com/sanat-garg/agent-orch into ~/agent-orch-worker with the gh login, runs npm ci, optionally installs agent
# CLIs, pairs the machine and installs agent-orch-worker.service (Restart=always, MemoryHigh leaves headroom).
# Idempotent: re-running updates the checkout and the unit; without --code an existing pairing is kept.
# Only the worker service: no agent-orch web service, Caddy or ttyd (workers are compute-only; the head runs those).
#   --controller URL  --code CODE  --name NAME (default: hostname)  --agents claude,codex
#   --dry-run (print what would run, change nothing)  --uninstall [--purge] (also delete ~/.agent-orch-worker)
set -euo pipefail

REPO=sanat-garg/agent-orch
DIR="$HOME/agent-orch-worker"
WHOME="${AGENT_ORCH_WORKER_HOME:-$HOME/.agent-orch-worker}"
UNIT=agent-orch-worker.service
UNIT_FILE=/etc/systemd/system/$UNIT
CONTROLLER='' CODE='' NAME="$(hostname -s 2>/dev/null || hostname)" AGENTS='' DRY=0 UNINSTALL=0 PURGE=0

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
# run CMD…: runs it, or prints it under --dry-run. Non-interactive commands get stdin from /dev/null so a
# `curl … | bash` install never feeds the rest of this script to them.
run() { if ((DRY)); then printf '+ %s\n' "$*"; else "$@" </dev/null; fi; }
tty_run() { if ((DRY)); then printf '+ %s\n' "$*"; else "$@" </dev/tty; fi; }
# write_root FILE: stdin → FILE via sudo (printed under --dry-run).
write_root() { if ((DRY)); then printf '+ write %s:\n' "$1"; sed 's/^/    /'; else sudo tee "$1" >/dev/null; fi; }
SUDO() { if ((EUID == 0)); then run "$@"; else run sudo "$@"; fi; }

usage() { sed -n '2,11p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; }

parse() {
  while (($#)); do
    case "$1" in
      --controller) CONTROLLER="${2:?--controller needs a URL}"; shift ;;
      --code) CODE="${2:?--code needs a value}"; shift ;;
      --name) NAME="${2:?--name needs a value}"; shift ;;
      --agents) AGENTS="${2:?--agents needs a list}"; shift ;;
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
}

uninstall() {
  say "Removing $UNIT"
  SUDO systemctl disable --now "$UNIT" || true
  SUDO rm -f "$UNIT_FILE"
  SUDO systemctl daemon-reload
  say "Removing $DIR"
  run rm -rf "$DIR"
  if ((PURGE)); then say "Removing $WHOME (pairing, caches, logs)"; run rm -rf "$WHOME"
  else say "Kept $WHOME (pairing token, caches, logs); --purge deletes it. Remove the machine in the head's UI too."; fi
}

node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

ensure_node() {
  export PATH="$HOME/.local/node/bin:$PATH"
  if (($(node_major) >= 22)); then say "Node $(node -v) found"; return; fi
  if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
    say "Installing Node 22 with nvm"
    if ((DRY)); then echo "+ nvm install 22"; return; fi
    # shellcheck disable=SC1091
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"; nvm install 22 </dev/null; nvm use 22 >/dev/null; return
  fi
  local arch; case "$(uname -m)" in aarch64|arm64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) die "unsupported CPU: $(uname -m)" ;; esac
  say "Installing Node 22 (official linux-$arch tarball) into ~/.local/node"
  local base=https://nodejs.org/dist/latest-v22.x
  if ((DRY)); then echo "+ curl $base/node-v22.*-linux-$arch.tar.xz | tar -xJ -C ~/.local/node --strip-components=1"; return; fi
  local file; file="$(curl -fsSL "$base/SHASUMS256.txt" | grep -o "node-v22[.0-9]*-linux-$arch\.tar\.xz" | head -1)"
  [[ -n "$file" ]] || die "could not find a Node 22 tarball for linux-$arch"
  rm -rf "$HOME/.local/node" && mkdir -p "$HOME/.local/node"
  curl -fsSL "$base/$file" | tar -xJ -C "$HOME/.local/node" --strip-components=1
  (($(node_major) >= 22)) || die "Node install failed"
}

ensure_gh() {
  if ! command -v gh >/dev/null; then
    say "Installing the GitHub CLI (gh)"
    command -v apt-get >/dev/null || die "install gh (https://cli.github.com) and re-run"
    SUDO apt-get install -y gh
  fi
  if ((DRY)); then echo "+ gh auth status || gh auth login   (interactive)"; echo "+ gh auth setup-git"; return; fi
  if ! gh auth status >/dev/null 2>&1; then
    say "GitHub isn't signed in on this machine: sign in (the worker clones and pushes task branches with it)"
    tty_run gh auth login --git-protocol https
  fi
  run gh auth setup-git
}

ensure_checkout() {
  if [[ -d "$DIR/.git" ]]; then
    say "Updating $DIR"
    run git -C "$DIR" pull --ff-only
  else
    say "Cloning $REPO into $DIR"
    run gh repo clone "$REPO" "$DIR"
  fi
  if ((DRY)); then echo "+ (cd $DIR && npm ci)"; else (cd "$DIR" && npm ci </dev/null); fi
}

# The same commands as .agent-orch/AGENTS.md; an agent already on PATH is left alone.
install_agents() {
  [[ -n "$AGENTS" ]] || return 0
  local a g=()
  [[ -w "$(npm prefix -g 2>/dev/null || echo /usr)" ]] || g=(sudo)
  for a in ${AGENTS//,/ }; do
    if command -v "$a" >/dev/null; then say "$a already installed"; continue; fi
    say "Installing $a"
    case "$a" in
      claude) if ((DRY)); then echo "+ curl -fsSL https://claude.ai/install.sh | bash"; else curl -fsSL https://claude.ai/install.sh | bash </dev/null; fi ;;
      codex) run "${g[@]}" npm i -g @openai/codex ;;
    esac
  done
}

pair() {
  if [[ -n "$CODE" ]]; then
    [[ -n "$CONTROLLER" ]] || die "--code needs --controller"
    [[ -f "$WHOME/config.json" ]] && say "Already paired; pairing again as a new machine (remove the old one in the head's UI)"
    say "Pairing as \"$NAME\""
    run node "$DIR/worker.mjs" pair --controller "$CONTROLLER" --code "$CODE" --name "$NAME"
  elif [[ -f "$WHOME/config.json" ]]; then say "Already paired (keeping it)"
  elif ((DRY)); then echo "+ (no --code: pairing skipped)"
  else die "not paired yet: pass --controller <url> --code <code> from the head's \"Add machine\""; fi
}

# MemoryHigh throttles (never kills) the worker and its agents before the machine itself runs short.
unit() {
  local node_bin; node_bin="$(command -v node || echo "$HOME/.local/node/bin/node")"
  cat <<EOF
[Unit]
Description=agent-orch worker (dials out to the head; runs orchestrator tasks)
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
WorkingDirectory=$DIR
Environment=HOME=$HOME
Environment=PATH=$(dirname "$node_bin"):$HOME/.local/bin:$HOME/.local/node/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$node_bin $DIR/worker.mjs run
Restart=always
RestartSec=5
MemoryHigh=85%

[Install]
WantedBy=multi-user.target
EOF
}

install_service() {
  command -v systemctl >/dev/null || die "systemd not found; run it yourself: node $DIR/worker.mjs run"
  say "Installing $UNIT"
  unit | write_root "$UNIT_FILE"
  SUDO systemctl daemon-reload
  SUDO systemctl enable "$UNIT"
  SUDO systemctl restart "$UNIT"
}

main() {
  parse "$@"
  ((DRY)) && say "Dry run: nothing is changed"
  [[ "$(uname -s)" == Linux ]] || ((DRY)) || die "this is the Linux installer; on a Mac use install-worker-macos.sh"
  if ((UNINSTALL)); then uninstall; exit 0; fi
  ((EUID != 0)) || say "Warning: running as root; the worker and its agents will run as root. A normal sudo user is safer."
  command -v git >/dev/null || SUDO apt-get install -y git
  ensure_node
  ensure_gh
  ensure_checkout
  install_agents
  pair
  install_service
  say "Done. Status: node $DIR/worker.mjs status · logs: journalctl -u $UNIT -f"
  say "Next: sign the agents in on this machine (the head's Connections window, or run \`claude\` / \`codex login --device-auth\` here)."
}

main "$@"
