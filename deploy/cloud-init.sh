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

cat >/etc/systemd/system/gaffer-agents.service <<'UNIT'
[Unit]
Description=GAFFER autonomous trading agents (detector, market-maker, clv-tracker, arena)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=GAFFER_API=https://gaffer-cyan.vercel.app
Environment=INTERVAL=45
Environment=REFRESH_SECS=300
WorkingDirectory=/opt/gaffer
ExecStart=/usr/bin/node /opt/gaffer/agents/worker.mjs
Restart=always
RestartSec=10
StandardOutput=append:/var/log/gaffer-agents.log
StandardError=append:/var/log/gaffer-agents.log

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now gaffer-agents
