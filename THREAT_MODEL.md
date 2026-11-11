# Threat model

Assets: local data, command authority, privileged authority, process identity,
task results, OAuth/bearer credentials and audit integrity. The owner chooses
roots, executables, permission mode, client access and whether to open a tunnel.

| Actor or failure | Boundary and response |
| --- | --- |
| Prompt-injected model/tool input | Typed SDK arguments, registry mode gating, path/argv validation; annotations never authorize |
| Unauthenticated remote requester | No MCP access; public health is minimal; OAuth grants require local human consent |
| Malicious website/DNS rebinding | Exact Host and Origin, loopback binding; proxy headers do not relax policy |
| Traversal/symlink/magic-link race | Pinned root/parent descriptors and Linux openat2; explicit Darwin constraints |
| Special file/FIFO or huge file | Linux O_PATH type check before data open, nonblocking backend opens, byte limits |
| Concurrent hard-link/path replacement during write | Fresh inode + descriptor-relative atomic rename; no escaped-target truncation |
| Runaway command/output | Timeout, fresh process group, bounded output and task logs; background children cleaned on exit |
| MCP crash/disconnection | Independent task worker and durable records; no transport-owned task process |
| Reused/stale task PID | Process identity check; stops use worker control file, never stored PID signaling |
| systemd collection | Final status written independently before normal worker exit |
| Worker crash/reboot/storage loss | Lost/unknown state preserved, no fabricated exit code or blind process signal |
| OAuth code interception | S256 PKCE, code expiry/single use, exact callback/client/resource binding |
| Consent/CSRF/phishing | Request-specific local code, exact display, browser cookie + CSRF token, state echo; human must verify intent |
| Stolen refresh token/replay | Hashed storage, rotation, expiry, replay-family revocation |
| Audit secret leak | No argv/content/env/header fields; local bounded JSONL only |
| Compromised same OS account/root | Outside scope; it can inspect memory, alter executables/state, or bypass server policy |
| Trusted executable used maliciously | Explicit execution delegation; command policy is not an OS sandbox |

Availability limits are deliberate but not complete DoS protection. HTTP handlers
and request bodies, registrations, pending grants and tokens are bounded. File
search visits at most 10,000 entries/depth 32 and returns at most 200 matches;
listing returns at most 200 entries without pagination in this build. Read/write
operations are at most 1 MiB. The owner must manage completed tasks and total disk
space. No automatic hosted monitoring or background cleanup daemon exists.

Residual risks: independent security review, macOS runtime verification, full
client compatibility, aggregate task storage quota, stronger OAuth abuse limits,
crash-finalization for forcibly killed workers,
and command sandboxing are not proven by this build's tests. Each is a distinct
limit; local unit/integration results do not establish Internet-facing safety.
