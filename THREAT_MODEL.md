# Threat model

Assets are user data, process/root authority, durable task outcomes, client grants,
OAuth/bearer secrets and audit integrity. The human chooses roots, mode, native
executables, providers and approval policy. A correct implementation cannot make
an untrusted AI or provider trustworthy.

| Threat/failure | Boundary and response |
| --- | --- |
| Prompt injection | Untrusted content may influence tool use; narrow modes/roots and human approval help, but do not sandbox interpreters |
| Unauthenticated client | Explicit bearer locally or OAuth remotely; no MCP tool access from health/discovery |
| Misleading provider name | OAuth client ID is authenticated; initialize.clientInfo and registration display name remain self-reported |
| OAuth interception/replay | PKCE S256, single-use code, exact redirect, resource/scope/session/expiry binding, refresh rotation/revocation |
| Consent phishing/CSRF | Local terminal match code and confirmation, one prompt at a time, short expiry, host allowlist, cookies/CSRF/state |
| Stale/elevated capability | Per-call and pre-launch checks; timed tokens/grants and dynamic registry; queued work cannot use expired grants |
| Guess/replay/modify approval | Random ID, exact digest, identity/session binding and durable at-most-once automatic dispatch |
| Crash during dispatch/result | Unknown remains unknown; no automatic retry under an ambiguous key |
| Path/symlink/mount race | Linux pinned descriptors/openat2; Darwin os.Root/no-follow/device checks with unverified native runtime gate |
| Hard-link mutation | Restricted writes reject links and rename a fresh inode under a pinned parent |
| Huge/special file or runaway output | Configurable sizes, regular-file checks, timeouts/concurrency; explicit dangerous-only unlimited bounds |
| Unrelated process termination | Owned unreaped group cleanup; task control files; verified process identities; no arbitrary PID kill tool |
| Server/tunnel/client disconnect | Independent task worker and durable completion metadata; application authorization differs from socket lifetime |
| systemd collection | Worker saves final exit independently before normal collection |
| Reboot/worker force-kill/disk loss | Lost/unknown outcome; no fabricated code or blind signal; audit failure refuses dispatch |
| Tunnel hostname rotation | Verified canonical origin; old tokens and elevated grants invalidated; connector must be updated |
| Cloudflare/AI vendor observation | Separate external trust boundaries; Bridge owns no relay/accounts, but providers see their traffic |
| sudo cache context mismatch | sudo -n in actual context, explicit failure rather than background password prompt; deliberate scoped sudoers option |
| Secret leakage | No token URLs/logs/argv/password handling; private XDG state; metadata-only rotated audit |
| Same OS account/root compromise | Outside scope: can inspect memory, modify binary/state, or bypass Bridge |

Read/write authority and command allowlists are not operating-system sandboxes.
Dangerous remote access can compromise the machine. There is no Bridge-operated
telemetry, account or hosted relay and no monthly/tool-call billing quota. There
are technical abuse/resource bounds. Aggregate task and deduplication metadata
storage still requires operator care; deleting tombstones weakens retry safety.
Native macOS, real web accounts, real Cloudflare and real sudo contexts are manual
gates. Local passing tests do not prove Internet-facing security or provider access.
