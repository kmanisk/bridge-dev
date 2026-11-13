# Local Coder Linux enhancements — Development verification handoff

Status: **development feature-complete, regression tests passed, awaiting user acceptance of live runtime.** This document describes code in the Local Coder development branch, **not an accepted kmanisk/dots workstation baseline**.

## Authoritative workstation context

Canonical docs live in `~/.local/share/chezmoi/docs/`, mirrored by the `kmanisk/dots` repository. Their accepted state must not be rewritten from conjecture or a development test alone.

- MCP startup instructions read `AGENTS.md`, `docs/system/SYSTEM_CONTEXT.md`, `docs/system/system-philosophy.md`, and `docs/system/SUBSYSTEM_MAP.md` from the actual chezmoi source. They are live-read at each server start, not copied into ChatGPT personal memory.
- `system_context` is a single read-only tool for refreshing current docs and targeted owning subsystem Markdown files on demand. Source docs are authoritative only as accepted baselines, superseded by fresh verified live output and the user's current instructions.
- `system_inspect` returns compact structured read-only JSON for resources, GPU, storage, failed services, Sway state, PipeWire devices, Bluetooth logs, and chezmoi configuration drift.
- The `documentation` field of native editor outputs and the drift inspector presents owning documentation requirements as `pending_user_acceptance`. Do not update `SYSTEM_CONTEXT.md` or `SYSTEM_CHANGELOG.md` with an intended future state. After the user rigorously tests and accepts the new configuration, update the owning docs and context/changelog per `AGENTS.md`.

## Phase 3 — Candidate validation

- `src/lib/config-validator.ts` is invoked before native safe-edit staging. JSON, Fish, Bash, and systemd unit candidate syntax is validated without running scripts, starting a service, or changing active state.
- Sway fragments and chezmoi `.tmpl` files are reported `pending` full rendered validation; this is deliberate, not a claimed pass.
- `src/lib/post-edit-hooks.ts` uses a direct executable and argv array, not interpolated shell commands. The opt-in hooks profile stays disabled by default.

## Phase 4 — Configuration and documentation drift

- The drift section reads Git porcelain state and `chezmoi status`. It never resets, stages, commits, applies, or silently repairs changes.
- `src/lib/docs-routing.ts` recommends the relevant owning docs with a clear test-and-approval gate. Unknown subsystems point to `SUBSYSTEM_MAP.md` for manual route selection.

## Phase 5 — Structured system inspection

- One read-only `system_inspect` tool combines direct procfs/sysfs measurements with bounded, timeout-controlled existing CLI queries.
- Unavailable sections return explicit errors. No watchers, databases, daemons, additional packages or services.

## Phase 6 — Recoverable systemd user jobs

- One `system_job` tool supports start, status, logs, stop, list for uniquely identified transient user units.
- Per-job metadata, command, exit code and logs persist under `~/.local/state/chatgpt-local-coder/jobs/`; each job is separate from Local Coder's process-manager lifetime.
- Jobs run with `NoNewPrivileges=yes`, `RestrictSUIDSGID=yes`, bounded runtime and `Restart=no`. Tested real job exit code 0 and `NoNewPrivs: 1` inside the process.
- Stop is opt-in with explicit confirmation. No systemd linger or permanent user service is enabled.
- Treat command authorization as advisory: shell-command classification remains heuristic and the main Local Coder account still has unrestricted root access outside jobs. Avoid credentials in job commands, which are recorded to user-owned metadata files.

## Phase 7 — Sway

- Live focus, windows and output modes from read-only `swaymsg` queries. Window titles omitted by default; no focus changes or reloads.

## Phase 8 — Audio and Bluetooth

- `wpctl` devices and default sink are returned as structured JSON.
- Bluetooth devices and recent BlueZ/WirePlumber/kernel event logs are sampled on demand, without playback, reconnect, codec changes or service restarts.
- Transport loss is not equated to physical speaker power cycling.

## Phase 9 — Integration

- Development compilation: `pnpm run build`.
- Regression: `pnpm test`.
- Isolated MCP session and discovery: `MCP_TOKEN= pnpm run test:all`.
- Tests verify a **fresh MCP session** receives canonical initialization instructions, lists the new tools, and can call `system_context` and `system_inspect` without a series of shell commands.
- Regression covers security/chezmoi source routing, candidate validation, invalid edits, command-free post-edit hooks, documentation routing, system inspection and job metadata.
- Production source, original MCP token and Tailscale Funnel must be preserved during any subsequent cutover.

## Known limitations and production gate

1. The current Phase 1 policy is an **application-layer** classifier. The existing main Local Coder user has unrestricted passwordless sudo; arbitrary shell commands can bypass heuristic classification. This is not a kernel-enforced sandbox. Full privilege isolation requires a separate unprivileged account or restricted sudo design; not installed or changed here.
2. No authoritative Markdown under `kmanisk/dots/docs/` is promoted solely from these automated tests. Wait for user-performed testing and explicit acceptance, then follow the synchronous documentation contract.
3. No `chezmoi apply`, Sway reload, service restart, git commit, push, or deployment should be done implicitly by ordinary editing operations.
4. MCP instructions guide a model but cannot guarantee that every ChatGPT response follows the guidance; a short global personalization pointer remains a useful backup.
5. Generated outputs without explicit do-not-edit headers may not be detected. Targeted edits require source-aware diff checks, not raw overwrites.

## User acceptance smoke checklist (after authorized test release)

1. Start a fresh ChatGPT chat with only Local Coder connected and ask for `system_context` and current Sway/resources. Verify the assistant reads canonical instructions and uses `system_inspect`.
2. Request a **dry-run** targeted edit to a managed config; confirm it resolves to a source and does not write the live target.
3. Verify the expected owning docs are listed as pending verification, not modified.
4. Request system Bluetooth/audio inspection; verify no devices disconnect or sound plays.
5. Run an innocuous transient job and check its ID/log/exit status from a different chat.
6. Verify production on-demand service state, token authentication, and all existing workloads remain stable.
7. Explicitly approve accepted runtime changes, then update canonical docs and changelog. Do not promote untested changes.
