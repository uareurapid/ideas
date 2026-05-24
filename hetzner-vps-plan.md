# Hetzner VPS Deployment Plan

## Purpose
Deploy this project to a Hetzner Cloud VPS with frontend and backend together, persistent SQLite, HTTPS, and stable operations.

This plan includes:
- Infrastructure steps in Hetzner.
- Server hardening.
- App deployment.
- Reverse proxy + TLS.
- Backups and update workflow.

## Outcome Checklist
- [ ] VPS is provisioned and secured.
- [ ] Domain points to VPS.
- [ ] App runs as a system service.
- [ ] HTTPS is active.
- [ ] `/api/health` returns `ok: true`.
- [ ] Data is persistent and backed up.

---

## 1. Hetzner Infrastructure Setup

### 1.1 Create project and server
- [ ] Create Hetzner Cloud project.
- [ ] Create server (Ubuntu 24.04 LTS recommended).
- [ ] Add SSH key during server creation.
- [ ] Pick location near your users.

Suggested starting size:
- 2 vCPU / 4 GB RAM is safe for this app.

### 1.2 Attach volume for persistent data
- [ ] Create volume (10-20 GB to start).
- [ ] Attach to the server.
- [ ] Note device path (`/dev/disk/by-id/...`).

### 1.3 Configure Hetzner firewall
Allow inbound:
- [ ] TCP 22 (SSH)
- [ ] TCP 80 (HTTP)
- [ ] TCP 443 (HTTPS)

---

## 2. DNS Setup
- [ ] Create A record: `ideas.yourdomain.com -> <VPS_IP>`
- [ ] Optional AAAA record if IPv6 enabled.
- [ ] Wait for propagation before TLS issuance.

---

## 3. Initial Server Hardening

SSH in as root first, then:

### 3.1 Create deploy user
```bash
adduser deploy
usermod -aG sudo deploy
```

### 3.2 Harden SSH
- [ ] Disable root login.
- [ ] Disable password auth.
- [ ] Keep key auth only.

Edit `/etc/ssh/sshd_config`:
- `PermitRootLogin no`
- `PasswordAuthentication no`

Restart SSH:
```bash
systemctl restart ssh
```

### 3.3 OS security tools
```bash
apt update && apt upgrade -y
apt install -y ufw fail2ban curl git build-essential ca-certificates
```

UFW:
```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

---

## 4. Prepare Persistent Volume

If new empty volume:
```bash
mkfs.ext4 /dev/<YOUR_VOLUME_DEVICE>
mkdir -p /var/lib/business-ideas
echo '/dev/<YOUR_VOLUME_DEVICE> /var/lib/business-ideas ext4 defaults,nofail 0 2' >> /etc/fstab
mount -a
```

Create app data dirs:
```bash
mkdir -p /var/lib/business-ideas/data
mkdir -p /opt/business-ideas
chown -R deploy:deploy /var/lib/business-ideas /opt/business-ideas
```

---

## 5. Install Node.js Runtime

Install Node.js 20:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v
npm -v
```

---

## 6. Deploy App Code

As deploy user:
```bash
sudo -u deploy git clone <YOUR_REPO_URL> /opt/business-ideas
cd /opt/business-ideas
sudo -u deploy npm ci
sudo -u deploy node --check /opt/business-ideas/server.js
```

---

## 7. Configure Production Environment

Create env file:
```bash
sudo -u deploy cp /opt/business-ideas/.env.example /opt/business-ideas/.env
sudo -u deploy nano /opt/business-ideas/.env
```

Set required values:
- `HOST=0.0.0.0`
- `PORT=3737`
- `VOTES_DB_PATH=/var/lib/business-ideas/data/votes.sqlite`
- `ADMIN_USERNAME=<your_admin_username>`
- `ADMIN_PASSWORD=<your_admin_password>`
- `VOTER_COOKIE_SECURE=1`
- `ADMIN_COOKIE_SECURE=1`

Tighten permissions:
```bash
chown deploy:deploy /opt/business-ideas/.env
chmod 600 /opt/business-ideas/.env
```

---

## 8. Create and Run System Service

Create service file:
```bash
tee /etc/systemd/system/business-ideas.service > /dev/null <<'EOF'
[Unit]
Description=Business Ideas App
After=network.target

[Service]
Type=simple
User=deploy
Group=deploy
WorkingDirectory=/opt/business-ideas
EnvironmentFile=/opt/business-ideas/.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

Enable/start:
```bash
systemctl daemon-reload
systemctl enable business-ideas
systemctl start business-ideas
systemctl status business-ideas --no-pager
```

Local health test:
```bash
curl -sS http://127.0.0.1:3737/api/health
```

---

## 9. HTTPS Reverse Proxy (Caddy)

Install Caddy:
```bash
apt install -y caddy
```

Set Caddyfile:
```bash
tee /etc/caddy/Caddyfile > /dev/null <<'EOF'
ideas.yourdomain.com {
  reverse_proxy 127.0.0.1:3737
}
EOF
```

Restart and enable:
```bash
systemctl restart caddy
systemctl enable caddy
```

Validation:
```bash
curl -sS https://ideas.yourdomain.com/api/health
curl -sS https://ideas.yourdomain.com/api/admin/me
```

---

## 10. App Functional Verification

In browser:
- [ ] Open `https://ideas.yourdomain.com/`
- [ ] Submit visitor idea.
- [ ] Login to moderation board.
- [ ] Approve/reject submission.
- [ ] Confirm approved idea appears immediately.
- [ ] Confirm voting sync in another browser/incognito.

---

## 11. Backups and Restore

### 11.1 Backup script
```bash
tee /usr/local/bin/backup-business-ideas.sh > /dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

DB="/var/lib/business-ideas/data/votes.sqlite"
DIR="/var/lib/business-ideas/data/backups"
TS="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$DIR"
cp "$DB" "$DIR/votes-$TS.sqlite"
find "$DIR" -type f -name 'votes-*.sqlite' -mtime +21 -delete
EOF
```

```bash
chmod +x /usr/local/bin/backup-business-ideas.sh
```

### 11.2 Cron job
```bash
crontab -e
```
Add:
```cron
15 3 * * * /usr/local/bin/backup-business-ideas.sh
```

### 11.3 Restore test (important)
- [ ] Stop service.
- [ ] Copy backup file over live DB.
- [ ] Start service.
- [ ] Verify app and data integrity.

---

## 12. Ongoing Deploy Procedure

For each update:
```bash
cd /opt/business-ideas
sudo -u deploy git pull
sudo -u deploy npm ci
sudo systemctl restart business-ideas
curl -sS http://127.0.0.1:3737/api/health
```

If content source changed and you want immediate regenerated data:
```bash
cd /opt/business-ideas
sudo -u deploy node generate.js
sudo systemctl restart business-ideas
```

---

## 13. Optional: Docker on Hetzner Instead of systemd

If you prefer containers, use existing project files:
- `Dockerfile`
- `.dockerignore`

Suggested run command:
```bash
docker run -d \
  --name business-ideas \
  -p 127.0.0.1:3737:3737 \
  -e HOST=0.0.0.0 \
  -e PORT=3737 \
  -e VOTES_DB_PATH=/data/votes.sqlite \
  -e ADMIN_USERNAME=<your_admin_username> \
  -e ADMIN_PASSWORD=<your_admin_password> \
  -e VOTER_COOKIE_SECURE=1 \
  -e ADMIN_COOKIE_SECURE=1 \
  -v /var/lib/business-ideas/data:/data \
  business-ideas
```

Keep Caddy as reverse proxy on host.

---

## 14. Security and Reliability Checklist
- [ ] SSH key auth only.
- [ ] Root login disabled.
- [ ] UFW active with least-open ports.
- [ ] fail2ban active.
- [ ] HTTPS active and automatic renewals working.
- [ ] Daily backups and monthly restore test.
- [ ] OS patching routine (weekly).
- [ ] App update routine documented.

---

## 15. Rollback Procedure
- [ ] Keep note of last known good commit.
- [ ] On failure:
1. `git checkout <last_good_commit>`
2. `npm ci`
3. `systemctl restart business-ideas`
- [ ] If DB issue, restore latest valid backup and restart service.
