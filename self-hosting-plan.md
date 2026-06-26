# Self Hosting Deployment Plan

## Purpose
Run this project on your own machine (home server, mini PC, NAS, or always-on Linux box) with frontend and backend together.

This plan is for the current app architecture:
- Node server: `server.js`
- Frontend served by Node: `index.html`, `data.js`
- Persistence: SQLite (`better-sqlite3`)

## Outcome Checklist
- [ ] App is reachable from your domain over HTTPS.
- [ ] `/api/health` returns JSON with `ok: true`.
- [ ] Visitor submission and admin moderation work.
- [ ] SQLite data survives restarts.
- [ ] Service auto-starts on reboot.
- [ ] Backups run daily.

---

## 1. Decide Network Exposure Method
Pick one method before setup:

### Option A (Recommended): Cloudflare Tunnel
Pros:
- No port forwarding on home router.
- TLS handled at edge.
- Cleaner security posture.

### Option B: Direct Reverse Proxy + Port Forwarding
Pros:
- No Cloudflare dependency.
- Full direct control.

For most self-hosting users, use Option A.

---

## 2. Machine Requirements
- Linux host (Ubuntu 22.04/24.04 recommended).
- At least 1 vCPU, 1 GB RAM.
- Reliable internet and uptime.
- Static LAN IP for the host.
- Domain name you control.

---

## 3. One-Time OS Setup

### 3.1 Update packages
```bash
sudo apt update && sudo apt upgrade -y
```

### 3.2 Install base tools
```bash
sudo apt install -y curl git build-essential ufw fail2ban ca-certificates
```

### 3.3 Install Node.js 20 LTS
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

---

## 4. Create App Directories and User

### 4.1 Create service user
```bash
sudo useradd --system --create-home --shell /bin/bash bizideas
```

### 4.2 Create app and data directories
```bash
sudo mkdir -p /opt/business-ideas
sudo mkdir -p /opt/business-ideas/data
sudo chown -R bizideas:bizideas /opt/business-ideas
```

---

## 5. Deploy Project Code

### 5.1 Clone repo
```bash
sudo -u bizideas git clone <YOUR_REPO_URL> /opt/business-ideas
```

### 5.2 Install dependencies
```bash
cd /opt/business-ideas
sudo -u bizideas npm ci
```

### 5.3 Quick syntax check
```bash
sudo -u bizideas node --check /opt/business-ideas/server.js
```

---

## 6. Configure Environment

### 6.1 Create production env file
```bash
sudo -u bizideas cp /opt/business-ideas/.env.example /opt/business-ideas/.env
```

### 6.2 Edit env
```bash
sudo -u bizideas nano /opt/business-ideas/.env
```

Set these values:
- `HOST=0.0.0.0`
- `PORT=3737`
- `VOTES_DB_PATH=/opt/business-ideas/data/votes.sqlite`
- `ADMIN_USERNAME=<strong_admin_username>`
- `ADMIN_PASSWORD=<strong_admin_password>`

Cookie flags:
- If HTTPS is active: set `VOTER_COOKIE_SECURE=1` and `ADMIN_COOKIE_SECURE=1`
- If testing plain HTTP only: temporarily use `0`

---

## 7. Run as a System Service (systemd)

Create service file:
```bash
sudo tee /etc/systemd/system/business-ideas.service > /dev/null <<'EOF'
[Unit]
Description=Business Ideas Node App
After=network.target

[Service]
Type=simple
User=bizideas
Group=bizideas
WorkingDirectory=/opt/business-ideas
EnvironmentFile=/opt/business-ideas/.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable business-ideas
sudo systemctl start business-ideas
sudo systemctl status business-ideas --no-pager
```

Logs:
```bash
sudo journalctl -u business-ideas -f
```

---

## 8. Publish the App

## Option A: Cloudflare Tunnel (Recommended)

### 8.1 Install cloudflared
Follow Cloudflare official package instructions for your distro.

### 8.2 Login and create tunnel
```bash
cloudflared tunnel login
cloudflared tunnel create business-ideas
```

### 8.3 Create tunnel config
Create `~/.cloudflared/config.yml`:
```yaml
tunnel: <TUNNEL_ID>
credentials-file: /home/<YOUR_USER>/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: ideas.yourdomain.com
    service: http://127.0.0.1:3737
  - service: http_status:404
```

### 8.4 Create DNS route
```bash
cloudflared tunnel route dns business-ideas ideas.yourdomain.com
```

### 8.5 Run tunnel as service
```bash
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

### 8.6 Final secure cookie check
Ensure these env values are `1`:
- `VOTER_COOKIE_SECURE=1`
- `ADMIN_COOKIE_SECURE=1`

Restart app:
```bash
sudo systemctl restart business-ideas
```

## Option B: Direct HTTPS Reverse Proxy (Caddy)

### 8.1 Install Caddy
```bash
sudo apt install -y caddy
```

### 8.2 Caddy config
```bash
sudo tee /etc/caddy/Caddyfile > /dev/null <<'EOF'
ideas.yourdomain.com {
  reverse_proxy 127.0.0.1:3737
}
EOF
```

### 8.3 Open firewall
```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
```

### 8.4 Start Caddy
```bash
sudo systemctl restart caddy
sudo systemctl enable caddy
```

### 8.5 Router port forwarding
Forward external ports 80 and 443 to this machine.

### 8.6 Final secure cookie check
Set both secure cookie env vars to `1` and restart app.

---

## 9. Verify End-to-End

Health:
```bash
curl -sS https://ideas.yourdomain.com/api/health
```

Admin session endpoint:
```bash
curl -sS https://ideas.yourdomain.com/api/admin/me
```

UI checks:
- [ ] Open homepage.
- [ ] Submit a visitor idea.
- [ ] Login to moderation board.
- [ ] Approve submission.
- [ ] Confirm approved idea appears immediately.
- [ ] Confirm votes sync between two different browsers.

---

## 10. Backups (SQLite)

Create backup script:
```bash
sudo tee /usr/local/bin/backup-business-ideas.sh > /dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

DB_PATH="/opt/business-ideas/data/votes.sqlite"
BACKUP_DIR="/opt/business-ideas/data/backups"
TS="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"
cp "$DB_PATH" "$BACKUP_DIR/votes-$TS.sqlite"
find "$BACKUP_DIR" -type f -name 'votes-*.sqlite' -mtime +14 -delete
EOF
```

```bash
sudo chmod +x /usr/local/bin/backup-business-ideas.sh
```

Schedule daily cron:
```bash
sudo crontab -e
```
Add:
```cron
30 2 * * * /usr/local/bin/backup-business-ideas.sh
```

---

## 11. Update Procedure

When you want to deploy latest code:
```bash
cd /opt/business-ideas
sudo -u bizideas git pull
sudo -u bizideas npm ci
sudo systemctl restart business-ideas
curl -sS http://127.0.0.1:3737/api/health
```

If needed, run generator manually:
```bash
cd /opt/business-ideas
sudo -u bizideas node generate.js
sudo systemctl restart business-ideas
```

---

## 12. Security and Maintenance
- [ ] Use long random admin password.
- [ ] Keep SSH key-only login.
- [ ] Keep fail2ban enabled.
- [ ] Run OS updates weekly.
- [ ] Rotate admin password periodically.
- [ ] Test backup restore monthly.

---

## 13. Rollback Plan
- [ ] Keep previous git commit hash before every update.
- [ ] If update fails:
1. `git checkout <last_good_commit>`
2. `npm ci`
3. `systemctl restart business-ideas`
- [ ] Restore latest SQLite backup only if data corruption occurred.
