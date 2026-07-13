# Deploying the GAFFER agents

The autonomous agents (Track 3) run as one always-on supervisor, `agents/worker.mjs`, which discovers
the live/soon fixtures from `/api/fixtures` and runs the four continuous agents against them:

- **detector** — flags sharp de-margined line moves
- **market-maker** — quotes a two-sided book, pulls on a decisive move
- **clv-tracker** — closing line value from entry to kickoff
- **arena** — favourite vs underdog, settled by the real final score

They read the signed TxLINE feed through the deployed GAFFER API, so the host holds **no secrets** and needs
**no npm install** — only Node 20 and this repo.

## DigitalOcean droplet (what the deploy does)

`cloud-init.sh` is passed as the droplet's `user_data`. On first boot it installs Node + git, clones this
repo to `/opt/gaffer`, and starts `gaffer-agents.service` under systemd (`Restart=always`, survives
reboots). Logs go to `/var/log/gaffer-agents.log` and the per-agent JSONL under `/opt/gaffer/logs/`.

Manage it over SSH or the DO console:

```bash
systemctl status gaffer-agents          # is it running
journalctl -u gaffer-agents -f          # live supervisor output
tail -f /var/log/gaffer-agents.log      # same, file
ls /opt/gaffer/logs/                     # per-agent decision logs

# update to the latest code
cd /opt/gaffer && git pull && systemctl restart gaffer-agents
```

## Pin a specific match (demo)

By default the worker follows the real schedule. To force it onto one fixture, set `FIXTURES`:

```bash
systemctl edit gaffer-agents      # add: Environment=FIXTURES=18213979
systemctl restart gaffer-agents
```

## Run it anywhere else

Any always-on host works — it is just one Node process:

```bash
GAFFER_API=https://www.mygaffer.xyz node agents/worker.mjs
```
