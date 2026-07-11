#!/bin/bash
# DigitalOcean droplet provisioning for the GAFFER autonomous agents (Track 3).
#
# Runs once, unattended, when the droplet first boots (passed as user_data). Installs Node, clones the
# public repo, and starts the agent supervisor under systemd so it runs 24/7 and restarts on crash or
# reboot. The agents call the deployed GAFFER API (which proxies the signed TxLINE feed), so there are no
# secrets on this box and no npm dependencies to install — just Node and the repo.
set -euxo pipefail

curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git

rm -rf /opt/gaffer
git clone --depth 1 https://github.com/Pratiikpy/gaffer /opt/gaffer

# NOTE: the heredoc delimiter is UNQUOTED so ${EAR_COMMIT_SECRET} expands to its real value as the file is
# written. A quoted <<'UNIT' would bake the literal string "${EAR_COMMIT_SECRET:-}" into the unit — systemd
# would then hand the Ear a bogus secret, every /api/commit-ear + /api/keeper poke would 401, and both
# on-chain anchoring AND unattended settlement would silently die. Keep it unquoted.
cat >/etc/systemd/system/gaffer-agents.service <<UNIT
[Unit]
Description=GAFFER autonomous agents (Ear, detector, market-maker, clv-tracker, arena, Read)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=GAFFER_API=https://gaffer-cyan.vercel.app
Environment=INTERVAL=45
Environment=REFRESH_SECS=300
# EAR_COMMIT_SECRET authenticates the Ear's on-chain commit and the worker's settle poke (must match the
# prod env var of the same name). The agents still run and log without it, but the Ear cannot anchor and
# pools fall back to the daily cron. See deploy/README.md.
Environment=EAR_COMMIT_SECRET=${EAR_COMMIT_SECRET:-}
WorkingDirectory=/opt/gaffer
ExecStart=/usr/bin/node /opt/gaffer/agents/worker.mjs
Restart=always
RestartSec=10
StandardOutput=append:/var/log/gaffer-agents.log
StandardError=append:/var/log/gaffer-agents.log

[Install]
WantedBy=multi-user.target
UNIT

# The keeper as its own always-on unit: sweeps every open pool on a 20s tick and settles the instant the
# oracle has a proof, rather than leaning on the once-a-day Vercel cron. Authenticates with the same
# EAR_COMMIT_SECRET (the keeper route accepts x-ear-key), so no second secret to provision.
cat >/etc/systemd/system/gaffer-keeper.service <<UNIT
[Unit]
Description=GAFFER keeper — unattended on-chain settler (20s sweep)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=GAFFER_API=https://gaffer-cyan.vercel.app
Environment=EAR_COMMIT_SECRET=${EAR_COMMIT_SECRET:-}
WorkingDirectory=/opt/gaffer
ExecStart=/usr/bin/node /opt/gaffer/agents/keeper-service.mjs --interval 20
Restart=always
RestartSec=10
StandardOutput=append:/var/log/gaffer-keeper.log
StandardError=append:/var/log/gaffer-keeper.log

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now gaffer-agents
systemctl enable --now gaffer-keeper
