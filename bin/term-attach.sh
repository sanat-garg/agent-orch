#!/bin/bash
# Attaches a browser terminal tab to the tmux session it names (created if new).
# The name comes from the page URL, so only a safe character set is accepted.
name="${1:-term-1}"
[[ "$name" =~ ^[A-Za-z0-9_-]{1,32}$ ]] || name="term-1"
exec tmux new-session -A -s "$name" -c /home/ubuntu/workspace "bash -l"
