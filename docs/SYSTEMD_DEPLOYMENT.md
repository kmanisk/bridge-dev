# Hardened Linux Systemd Deployment

This runbook outlines how to install BridgeDev as a hardened, isolated systemd service on Linux (Arch/CachyOS, Debian/Ubuntu, Fedora).

## Architectural Principles

1. **Dedicated Unprivileged Service Account:** Runs under `bridgedev` (or existing `localcoder`) with no login shell and no general sudo.
2. **Read-Only Code and Configuration:** `/opt/bridge-dev` and `/etc/bridge-dev` are owned by root and mounted read-only (`ReadOnlyPaths=/opt/bridge-dev`).
3. **Scoped Workspace Boundaries:** Writable paths are restricted to `/srv/bridge-dev/workspace` and explicitly mapped project directories.
4. **Append-Only Forensic Ledger:** Audit logs at `/var/log/bridge-dev/audit.jsonl` are protected with Linux file attribute `+a` (append-only) and root ownership.
5. **Independent Operator Boundary:** Ed25519 signing keys for privilege escalation live in `/etc/bridge-dev/operator-private.pem` (mode `0400` root:root) and cannot be read by the service account.

## Step-by-Step Setup

### 1. Create Dedicated Service Account
```bash
sudo useradd -r -s /usr/bin/nologin -d /var/lib/bridge-dev bridgedev
```

### 2. Create Directory Structure
```bash
sudo mkdir -p /opt/bridge-dev
sudo mkdir -p /etc/bridge-dev
sudo mkdir -p /var/lib/bridge-dev/home
sudo mkdir -p /var/lib/bridge-dev/approvals
sudo mkdir -p /var/log/bridge-dev
sudo mkdir -p /srv/bridge-dev/workspace
sudo mkdir -p /srv/bridge-dev/projects
```

### 3. Set Permissions
```bash
# Service directories owned by service user
sudo chown -R bridgedev:bridgedev /var/lib/bridge-dev /srv/bridge-dev
sudo chmod 0750 /var/lib/bridge-dev /srv/bridge-dev

# Configuration and release owned by root
sudo chown -R root:root /opt/bridge-dev /etc/bridge-dev
sudo chmod 0755 /opt/bridge-dev /etc/bridge-dev

# Audit directory owned by root:bridgedev mode 0750
sudo chown root:bridgedev /var/log/bridge-dev
sudo chmod 0750 /var/log/bridge-dev
```

### 4. Initialize Audit Ledger & Append-Only Attribute
```bash
sudo touch /var/log/bridge-dev/audit.jsonl
sudo chown root:bridgedev /var/log/bridge-dev/audit.jsonl
sudo chmod 0660 /var/log/bridge-dev/audit.jsonl
sudo chattr +a /var/log/bridge-dev/audit.jsonl
```

### 5. Generate Operator Keypair
```bash
sudo node /opt/bridge-dev/scripts/policygate-operator.mjs keygen
```

### 6. Install Systemd Service Unit
Copy `deployment/bridge-dev-policygate.service.example` to `/etc/systemd/system/bridge-dev.service`, adjust environment variables as needed, and start:

```bash
sudo systemctl daemon-reload
sudo systemctl start bridge-dev.service
bridge-dev status
```
