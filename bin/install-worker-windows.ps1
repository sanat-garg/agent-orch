# agent-orch worker installer for Windows 10/11 (WSL2). Design: .agent-orch/CLUSTER.md; README "Adding machines".
# The worker is the Linux one (install-worker.sh), run in a WSL2 distro of its own, "agent-orch": Ubuntu 24.04 with
# systemd, a passwordless-sudo user "agentorch" and no Windows PATH (so Windows' own node, git or claude never mix in).
# One line from the head's "Add machine", in PowerShell (it asks for administrator rights when it needs them):
#   & ([scriptblock]::Create((irm https://<head>/install/worker-windows.ps1))) -Controller https://<head> -Code ABCD-1234
# Steps: install WSL if missing (then Windows needs a restart: run the same line again after it), import the distro
# (checksum-verified Ubuntu WSL image), run install-worker.sh in it (Node 22, gh sign-in, checkout, pairing, the
# systemd service), and add a scheduled task "agent-orch worker" that keeps the distro running from Windows sign-in on
# (WSL stops an idle distro, services and all). Idempotent: re-running updates the worker; without -Code the pairing is kept.
#   -Controller URL  -Code CODE  -Name NAME (default: the computer name)  -Agents claude,codex
#   -DryRun (print what would run, change nothing)  -Uninstall (removes the task and the whole distro, pairing included)
# Windows PowerShell 5.1 compatible: no ternaries, ?? or && here.
param(
  [string]$Controller = '',
  [string]$Code = '',
  [string]$Name = $env:COMPUTERNAME,
  [string]$Agents = '',
  [switch]$DryRun,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is many times slower with its progress bar
$env:WSL_UTF8 = '1'                       # wsl.exe prints UTF-16 otherwise
$Distro = 'agent-orch'
$User = 'agentorch'
$TaskName = 'agent-orch worker'
$DistroDir = Join-Path $env:LOCALAPPDATA 'agent-orch\wsl'

function Say([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Die([string]$m) { Write-Host "error: $m" -ForegroundColor Red; exit 1 }
function Run([string]$what, [scriptblock]$do) { if ($DryRun) { Write-Host "+ $what" } else { & $do } }

if ($Controller -and $Controller -notmatch '^https?://[^\s''"]+$') { Die '-Controller must be an http(s) URL' }
$Controller = $Controller.TrimEnd('/')
if ($Code -and $Code -notmatch '^[A-Za-z0-9-]+$') { Die '-Code takes the code from the head''s "Add machine"' }
if ($Agents -and $Agents -notmatch '^(claude|codex)(,(claude|codex))*$') { Die '-Agents takes a comma list of: claude, codex' }
if (-not $Uninstall -and -not $Controller) { Die '-Controller is needed (the head''s address, as "Add machine" shows it)' }
$Name = ($Name -replace '[^A-Za-z0-9 ._()-]', '').Trim()
if (-not $Name) { $Name = 'Windows PC' }

# Not elevated: start this same line again as administrator (WSL setup and the scheduled task need it).
$admin = $DryRun -or ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  if (-not $Controller) { Die 'run this in a PowerShell opened with "Run as administrator"' }
  Say 'Asking for administrator rights (a new window continues the install)'
  $args2 = "-Controller '$Controller' -Name '$Name'"
  if ($Code) { $args2 += " -Code '$Code'" }
  if ($Agents) { $args2 += " -Agents '$Agents'" }
  if ($Uninstall) { $args2 += ' -Uninstall' }
  $cmd = "& ([scriptblock]::Create((irm '$Controller/install/worker-windows.ps1'))) $args2; Read-Host 'Press Enter to close'"
  Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $cmd)
  exit 0
}

# wsl.exe with its output passed through. Windows PowerShell 5.1 turns a native command's stderr into errors, which
# 'Stop' would make fatal: callers check $LASTEXITCODE instead.
function Wsl { $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; try { & wsl.exe @args } finally { $ErrorActionPreference = $old } }
# Runs a bash script in the distro as $as. Passed base64-encoded so no Windows quoting can mangle it.
function InDistro([string]$as, [string]$script) {
  if ($DryRun) { Write-Host "+ wsl -d $Distro -u ${as}:"; Write-Host (($script -split "`n" | ForEach-Object { "    $_" }) -join "`n"); return }
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($script -replace "`r", '')))
  Wsl -d $Distro -u $as --cd '~' --exec bash -c "echo $b64 | base64 -d | bash -l"
  if ($LASTEXITCODE -ne 0) { Die "the step in WSL failed (exit $LASTEXITCODE): see the output above" }
}
function DistroExists { (Wsl -l -q 2>$null | ForEach-Object { $_.Trim([char]0, ' ') }) -contains $Distro }

if ($Uninstall) {
  Say "Removing the scheduled task '$TaskName'"
  Run "Unregister-ScheduledTask '$TaskName'" { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue }
  if (DistroExists) {
    Say "Removing the WSL distro '$Distro' (the worker, its checkout and its pairing)"
    Run "wsl --unregister $Distro" { Wsl --unregister $Distro | Out-Null }
  }
  Say 'Done. Remove the machine in the head''s UI too (Machines -> the machine -> Remove from cluster).'
  exit 0
}

# ---- 1. WSL itself (the Microsoft Store build: systemd needs it)
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { Die 'this Windows has no WSL: update to Windows 10 21H2 or later (or Windows 11) first' }
Wsl --version *> $null
if ($LASTEXITCODE -ne 0) {
  Say 'Installing WSL (Windows Subsystem for Linux)'
  Run 'wsl --install --no-distribution' {
    Wsl --install --no-distribution
    if ($LASTEXITCODE -ne 0) { Wsl --install } # an older wsl.exe without --no-distribution (it adds an Ubuntu too; harmless)
    if ($LASTEXITCODE -ne 0) { Die 'WSL did not install: turn on virtualization in the BIOS/UEFI and try again' }
  }
  Say 'Restart Windows, then run the same line again to finish (if the code expired, get a new one from "Add machine").'
  exit 0
}
Run 'wsl --update' { Wsl --update *> $null }

# ---- 2. The distro: Ubuntu 24.04's official WSL image, checked against Ubuntu's SHA256SUMS
if (DistroExists) { Say "WSL distro '$Distro' found" }
else {
  $arch = 'amd64'
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }
  $base = 'https://cloud-images.ubuntu.com/wsl/releases/24.04/current'
  $file = "ubuntu-noble-wsl-$arch-wsl.rootfs.tar.gz"
  $tar = Join-Path $env:TEMP $file
  Say "Downloading Ubuntu 24.04 for WSL ($arch)"
  Run "download $base/$file and check its SHA256" {
    Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile $tar
    $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS").Content
    $want = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($file) + '$' } | Select-Object -First 1) -replace '\s.*$', ''
    $got = (Get-FileHash -Algorithm SHA256 $tar).Hash
    if (-not $want -or $got -ne $want.ToUpper()) { Remove-Item $tar -Force; Die "the Ubuntu image's checksum does not match" }
  }
  Say "Creating WSL distro '$Distro' in $DistroDir"
  Run "wsl --import $Distro $DistroDir $tar --version 2" {
    New-Item -ItemType Directory -Force -Path $DistroDir | Out-Null
    Wsl --import $Distro $DistroDir $tar --version 2
    if ($LASTEXITCODE -ne 0) { Die 'wsl --import failed: is virtualization (Virtual Machine Platform) on?' }
    Remove-Item $tar -Force
  }
}

# ---- 3. Inside: systemd, the worker's user, no Windows PATH, the tools install-worker.sh expects
Say 'Setting up the distro (systemd, the agentorch user, git, curl, gh)'
InDistro 'root' @"
set -e
id -u $User >/dev/null 2>&1 || useradd -m -s /bin/bash $User
echo '$User ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/$User && chmod 440 /etc/sudoers.d/$User
printf '[boot]\nsystemd=true\n\n[user]\ndefault=$User\n\n[interop]\nappendWindowsPath=false\n' > /etc/wsl.conf
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates xz-utils sudo gh >/dev/null
"@
# wsl.conf is read when the distro starts: restart it so systemd runs.
Run "wsl --terminate $Distro" { Wsl --terminate $Distro | Out-Null }
InDistro 'root' 'systemctl is-system-running --wait >/dev/null 2>&1 || true; [ "$(ps -p 1 -o comm=)" = systemd ] || { echo "systemd did not start in WSL: run wsl --update and try again" >&2; exit 1; }'

# ---- 4. Keep the distro up: WSL stops an idle one, its systemd services included
Say "Adding the scheduled task '$TaskName' (keeps the worker running from Windows sign-in on)"
Run "Register-ScheduledTask '$TaskName' (at sign-in: wsl -d $Distro sleep infinity)" {
  $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command `"& wsl.exe -d $Distro -u root --exec sleep infinity`""
  $trig = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
  $who = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
  Register-ScheduledTask -TaskName $TaskName -Action $act -Trigger $trig -Settings $set -Principal $who -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
}

# ---- 5. The Linux worker installer, as agentorch (it asks to sign in to GitHub once, in this window)
$flags = "--name '$Name'"
if ($Controller) { $flags += " --controller '$Controller'" }
if ($Code) { $flags += " --code '$Code'" }
if ($Agents) { $flags += " --agents '$Agents'" }
Say 'Installing the worker in WSL'
InDistro $User "curl -fsSL '$Controller/install/worker-linux.sh' | bash -s -- $flags"

Say "Done. Status: wsl -d $Distro -- node ~/agent-orch-worker/worker.mjs status   Logs: wsl -d $Distro -- journalctl -u agent-orch-worker -f"
Say 'It runs while you are signed in to Windows and the PC is awake (set Sleep to Never in Settings -> System -> Power to keep it working).'
Say "WSL gives Linux half this PC's memory by default; raise it with memory=... in $env:USERPROFILE\.wslconfig."
