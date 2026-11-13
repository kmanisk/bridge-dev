# BridgeDev Troubleshooting & Recovery

This guide covers common connection, authorization, and runtime issues.

## Diagnostic Commands

Start by running the built-in diagnostic tool:

```bash
bridge-dev doctor
```

This verifies Node.js, daemon process, port listeners, Tailscale Funnel, operator signing keys, and audit ledger integrity.

---

## Common Issues & Solutions

### 1. Connection Refused / Port 3000 Not Responding
- **Symptom:** `bridge-dev status` reports `offline` or `connection refused`.
- **Cause:** Service stopped or crashed on startup due to missing environment file.
- **Resolution:**
  ```bash
  sudo systemctl status bridge-dev.service
  sudo journalctl -u bridge-dev.service -n 20 --no-pager
  ```

### 2. Authorization Token Mismatch
- **Symptom:** AI coding client returns `401 Unauthorized` or `Invalid token`.
- **Resolution:**
  Inspect the configured token:
  ```bash
  bridge-dev connect --show-token
  ```
  Ensure the exact Bearer token is provided in your client header:
  `Authorization: Bearer <MCP_TOKEN>`

### 3. Context Invalidation (`POLICYGATE_CONTEXT_REQUIRED`)
- **Symptom:** Tool calls fail with `POLICYGATE_CONTEXT_REQUIRED`.
- **Cause:** System configuration or canonical documentation changed out-of-band, invalidating previous session context.
- **Resolution:**
  Have your AI coding client execute `system_context` to refresh the session state before retrying file mutations or commands.

### 4. Privilege Escalation Denied (`sudo`)
- **Symptom:** Command fails with `SECURITY_PRIVILEGED_COMMAND_REQUIRED` or policy denial.
- **Cause:** Privileged system commands require signed operator approval in STANDARD mode.
- **Resolution:**
  - For a single command approval:
    Run `sudo node /opt/bridge-dev/scripts/policygate-operator.mjs approve <request-id>` in an interactive operator terminal.
  - For maintenance sessions:
    Activate temporary YOLO mode: `sudo bridge-dev mode yolo --duration 15`.

---

## Fast Rollback Procedure

If a migration or configuration update needs to be reverted:

```bash
# 1. Stop BridgeDev
sudo systemctl stop bridge-dev.service

# 2. Start legacy service
systemctl --user start chatgpt-local-coder.service

# 3. Verify health
curl -s http://127.0.0.1:3000/health
```
Rollback takes under 2 seconds.
