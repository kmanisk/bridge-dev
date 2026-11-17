# Android / Termux device tools through BridgeDev (optional Super Bridge provider)

BridgeDev can **already consume another MCP server** through its reviewed
upstream-provider mechanism. [Super Bridge](https://github.com/CyberCipherSight/superbridge)
is an independent MIT-licensed MCP device router with a Linux/Termux client.
This guide shows how to connect it without adding Android permissions, a root
controller, or a mandatory dependency to BridgeDev.

**Status:** Verified on Arch Linux with BridgeDev's `McpUpstreamManager` and
Super Bridge 0.3.1. A Redmi K50i (Android 13) was additionally connected to
Arch via the Super Bridge LAN relay and exercised through BridgeDev's actual
MCP provider: read-only device listing and file read, an explicitly authorized
disposable write/read/delete, non-root `id`, duplicate receipt handling and
root-denial enforcement all passed on 2026-11-17. No existing user files were
modified. Native Windows-to-WSL2 and physical Windows-to-Android tests have
**not** been run. Android/Termux remains experimental within BridgeDev itself.

## Architecture

```text
BridgeDev on Linux / native Windows
    |
    | explicitly reviewed stdio upstream, R/W/X tool policy
    v
Super Bridge MCP stdio frontend (Linux / WSL2 Ubuntu)
    |
    | private local Unix socket (never exposed over LAN)
    v
Super Bridge broker/server
    |
    | paired, authenticated TLS connection on trusted LAN
    v
Android / Termux Super Bridge client
    |
    | client-selected workspace / filesystem + root policy
    v
Android filesystem and commands
```

Super Bridge's own OAuth/HTTPS endpoint is **not required** for this local
stdio arrangement. The stdio process and broker socket must belong to the same
trusted Linux user. Do not pass this socket over a public network. Using
BridgeDev's native MCP endpoint to reach this provider is a separate, reviewed
authorization boundary.

## 1. Prepare Super Bridge on a Linux machine

Install Super Bridge **separately** following its
[official instructions](https://github.com/CyberCipherSight/superbridge#quick-start-linux).
It is not installed, updated or started by BridgeDev. Use version 0.3.1 or a
later version with the documented `stdio --device-relay` support.

Start a Super Bridge **Server** interactively using its versioned launcher,
typically:

```sh
~/.local/opt/superbridge/releases/0.3.1/launcher.sh
```

Choose **Server**. The running broker creates a private socket such as:

```text
~/.local/state/superbridge/router/bridge.sock
```

Resolve both the **binary** and **socket** to real absolute Linux paths (not
`~`, `$HOME`, or guessed locations) before editing the example files.
Keep the server's terminal available for pairing and local approvals.

## 2. Pair an Android Termux client (optional)

On a device you own, install Termux and the appropriate ARM64 Super Bridge
release, following
[Super Bridge's Termux guide](https://github.com/CyberCipherSight/superbridge/blob/main/docs/TERMUX_PEERS.md).
Start **Client** in Termux, select the Linux server discovered on your
trusted Wi-Fi/LAN, and compare the first-pairing code displayed on both
devices. Approve **only** the matching code locally in another server
terminal:

```sh
superbridge approve CODE
```

If auto discovery fails, select manual IP and enter the **server's LAN
address**, not `127.0.0.1` from the Android device. NAT, VPN, hotspot and
firewall rules may block discovery or pairing. Never forward LAN pairing
ports to the public Internet.

Start with **read-only workspace and root disabled**. The client, not
BridgeDev, chooses whether it grants writes, arbitrary commands or root.
Termux's Android UID, storage permissions and optional Magisk `su` still
apply independently. Read/write command execution is **not** a sandbox.

## 3. Import as a disabled BridgeDev MCP provider (Linux)

Copy and edit
[`superbridge-local.mcp.example.json`](../examples/superbridge-local.mcp.example.json)
in your private workspace. Replace BOTH `YOUR_LINUX_USER` placeholders with
the actual owner of the running Super Bridge server.

Open BridgeDev's own portable gateway or authorized Admin UI. In a private
operator terminal, import the edited provider file:

```sh
bridge-dev mcp import /absolute/path/to/your/superbridge-local.mcp.json
```

**Import does not install, execute, enable or expose this provider.** Review
the exact proposal through BridgeDev's operator UI or its
`bridge-dev approve <proposal-id>` command. Then use
`bridge-dev mcp test superbridge` to confirm MCP initialization and
tool discovery. These operator commands require a running BridgeDev
instance and its own Admin authorization.

To expose only two non-mutating tools, request a separate reviewed
allowlist:

```sh
bridge-dev mcp enable superbridge --tools bridge_status,devices_list --permission R
bridge-dev approve <enable-proposal-id>
```

BridgeDev may expose names such as `superbridge__bridge_status`. More tools
must be individually reviewed and accurately classified: filesystem reads
as R, writes as W, and command execution or privilege-affecting tools as X.
Do **not** grant an entire unknown inventory R based on upstream annotations.
Super Bridge's device-side policy remains authoritative after BridgeDev
approval. Reconnect your MCP client if its tool list was cached.

## 4. Native Windows BridgeDev with Super Bridge in WSL2 (untested pathway)

BridgeDev runs **natively** on supported Windows systems; Super Bridge 0.3.1
does not. Use WSL2 Ubuntu for the Super Bridge broker, server and worker
while BridgeDev remains a native Windows/Node application.

1. Install and run Super Bridge **inside Ubuntu WSL2**, under a Linux
   account with a private home directory. Pair Android to that server as
   above. WSL2 NAT/Windows firewall can block LAN inbound traffic; check
   WSL networking and prefer verified mirrored-networking settings or
   consciously configured forwarding.
2. Copy
   [`superbridge-wsl.mcp.example.json`](../examples/superbridge-wsl.mcp.example.json)
   to a Windows-local private directory. Replace BOTH
   `YOUR_WSL_USER` placeholders. If your distribution name differs
   from `Ubuntu`, update `-d Ubuntu`.
3. Import the example into **native Windows BridgeDev** as a disabled
   provider. Review and enable only selected tools using the same local
   approval workflow as in Step 3.
4. Test read-only `bridge_status` before granting writes or command
   execution.

The example invokes the Linux stdio frontend through the standard
`C:\Windows\System32\wsl.exe` executable. Use the actual Windows system
directory if it differs. BridgeDev's provider child has a restricted
environment, so do not assume interactive PATH expansion. This pathway
requires **real native Windows/WSL2 integration testing** before claiming
production support. Windows Administrator, Linux `root` in WSL2, and
Android Magisk `su` are three unrelated privilege contexts.

## 5. Optional Linux interoperability smoke test

On a Linux machine that has **both** BridgeDev built from source and
Super Bridge already running, supply absolute paths:

```sh
SUPERBRIDGE_BIN=/absolute/path/to/superbridge \
SUPERBRIDGE_RELAY_SOCKET=/absolute/path/to/router/bridge.sock \
node scripts/test-superbridge-provider.mjs
```

Without those environment variables, this test only validates the two
disabled-by-default import examples and requires no Super Bridge installation.

The default live test uses a disposable local provider configuration, exposes
only `bridge_status` and `devices_list`, and verifies that an unapproved
`device_exec` call is rejected before the provider is invoked. It does not
perform writes, root requests, pairing, or Android shell commands.

To additionally exercise the **connected physical device's read-only file API**,
set `SUPERBRIDGE_REQUIRE_DEVICE=1` in the same command and, if more than one
client is connected, `SUPERBRIDGE_DEVICE_NAME=<exact-client-name>`. The test
then requests `device_fs_list` for `.`, polls its durable receipt, and validates
that the operation completed. It does not print file names or contents and never
requests writes, command execution or root. A client configured to approve each
operation must approve this exact read-only request locally.

**Android SELinux caveat:** During one real-device test, an Android client
launched by `adb su <app-UID>` had the Termux UID but inherited the Magisk
SELinux domain rather than Termux's normal `untrusted_app` domain. That is
**not** proof of standard Android app sandboxing. For production usage, launch
the client normally from the Termux application, not by dropping the UID of a
root shell. The test also used a temporary ADB reverse tunnel as a diagnostic;
a separate client later connected directly over LAN. Android root confirmation
and Windows/WSL2 have not been independently validated through this PR.

## Troubleshooting and security

- **No devices:** Run and pair the separate Super Bridge Android client;
  BridgeDev connecting successfully does not prove that a phone is online.
- **Socket not found:** Check that the Super Bridge server and broker are
  running under the correct Linux account. Windows paths cannot point to
  a WSL Unix socket directly; use the WSL stdio wrapper.
- **Provider denied:** Imports are disabled. Authorize provider registration,
  test, tool selection and R/W/X classification separately.
- **Windows launcher fails:** Check WSL distro, absolute Linux binary/socket
  paths, Windows process environment and system directory. Do not grant
  new privileges merely to work around the launch failure.
- **Access denied on Android:** The Android client may have chosen a narrow
  permission mode or OS restrictions. Do not treat an upstream tool
  classification as permission to bypass device-side approval.
- **Public endpoint:** This guide intentionally avoids a public device
  controller. If remote ChatGPT access is required, expose only a separately
  authenticated, reviewed HTTPS MCP endpoint, never a raw pairing socket or
  Admin UI.

BridgeDev's standard provider lifecycle, audit and approval policy remain in
effect. Neither project guarantees isolation from arbitrary commands approved
under a user's OS identity.
