# Desktop Commander source comparison

Reviewed 2026-11-11 at upstream commit
`9d5afdf5da6bdee4d4c52caf9a78128235a1b0d4`. Source archive was downloaded for
read-only research; no npm packages, build scripts or Node processes were run.
Upstream LICENSE is MIT, copyright Eduard Ruzga and contributors. This project
adopts interface/design lessons, not copied implementation or prose.

All source links below are pinned to the reviewed commit. Classification:
A = adequate in Bridge; B = adopt in this phase; C = later; D = excluded.

| Feature | Desktop Commander approach | Current bridge-dev behavior | Improvement needed | Decision | Implementation status |
| --- | --- | --- | --- | --- | --- |
| Tool inputs | [Zod schemas](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/9d5afdf5da6bdee4d4c52caf9a78128235a1b0d4/src/tools/schemas.ts) specify offsets, lengths and per-process waits | Typed Go SDK handlers with per-tool schemas | Keep precise inputs and explicit continuation | A/B | Existing schemas; continuation planned M14 |
| Large reads | [filesystem handlers](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/9d5afdf5da6bdee4d4c52caf9a78128235a1b0d4/src/handlers/filesystem-handlers.ts) select configured line limits and distinguish omitted length | Entire regular files up to a fixed byte bound | Offset/length reads and next offsets reduce repeated calls/failures | B | Planned M14 |
| Search | [search handlers](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/9d5afdf5da6bdee4d4c52caf9a78128235a1b0d4/src/handlers/search-handlers.ts) start/poll/stop sessions with paged results | Bounded synchronous filename substring search | Add content matches and bounded continuation; avoid separate search daemon | B | Planned M14 |
| Editing | [edit implementation](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/9d5afdf5da6bdee4d4c52caf9a78128235a1b0d4/src/tools/edit.ts) normalizes text, tries exact matches, then fuzzy matching | Exactly-one literal replacement with atomic write | Keep exact behavior; helpful mismatch diagnostics | A/C | Exact editing retained; fuzzy deferred for ambiguity/security |
| Atomic files | [atomic writer](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/9d5afdf5da6bdee4d4c52caf9a78128235a1b0d4/src/utils/atomic-write.ts) syncs temporary data, renames, syncs parent, serializes writes | Fresh inode and descriptor-relative rename/sync, hard-link rejection | Preserve stronger Linux jail and path-race tests | A | Phase 1 retained |
| Root restrictions | [filesystem validation](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/9d5afdf5da6bdee4d4c52caf9a78128235a1b0d4/src/tools/filesystem.ts), [directory tests](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/9d5afdf5da6bdee4d4c52caf9a78128235a1b0d4/test/test-allowed-directories.js) include unrestricted empty roots | Empty ordinary roots reject; Linux openat2 prevents traversal/symlink/mount escapes | Never import unrestricted-empty behavior into readonly/user | A/D | Only explicit dangerous removes jail |
| Interactive processes | [terminal manager](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/9d5afdf5da6bdee4d4c52caf9a78128235a1b0d4/src/terminal-manager.ts) maintains PID/session maps, stdin, retained output and capped waits | Independent recoverable workers, systemd units and durable logs/results | Retain durability; expose clear pending/poll outcomes | A/B/C | Interactive stdin/PTY deferred; approvals use pending polling |
| Output bounds | Same [terminal manager](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/9d5afdf5da6bdee4d4c52caf9a78128235a1b0d4/src/terminal-manager.ts) caps wait time and retained output, evicts oldest lines | Explicit truncation flag, bounded output and byte log cursors | Configurable technical bounds; fixed 25s HTTP polling | B | Planned M8/M15 |
| Termination | [process tool](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/9d5afdf5da6bdee4d4c52caf9a78128235a1b0d4/src/tools/process.ts) handles managed sessions then arbitrary positive PID | Only owned workers; identity verification; unreaped group leader during cleanup | Do not add arbitrary kill-by-PID tools | A/D | Existing stronger ownership checks retained |
| Configuration recovery | [config manager](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/9d5afdf5da6bdee4d4c52caf9a78128235a1b0d4/src/config-manager.ts) persists JSON and can recover/read defaults with warnings | Strict TOML fails closed | Atomic reversible migration and wizard; never permissive fallback | B | M8 |
| Client install/remove | [setup](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/9d5afdf5da6bdee4d4c52caf9a78128235a1b0d4/setup-claude-server.js), [uninstall](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/9d5afdf5da6bdee4d4c52caf9a78128235a1b0d4/uninstall-claude-server.js) integrate Claude with broader installation flow | Manual CLI registration instructions only | Preview, ask, modify only owned entries and preserve others | B | Planned M13 |
| Local history | [tool history](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/9d5afdf5da6bdee4d4c52caf9a78128235a1b0d4/src/utils/toolHistory.ts) queues append-only JSONL and trims retained history | Cross-process locked and rotated metadata JSONL | Structured decisions, paths and approval transitions; omit sensitive args | B | Planned M11/M14 |
| Telemetry and product usage | [usage tracker](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/9d5afdf5da6bdee4d4c52caf9a78128235a1b0d4/src/utils/usageTracker.ts), [capture](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/9d5afdf5da6bdee4d4c52caf9a78128235a1b0d4/src/utils/capture.ts), installer tracking paths | No telemetry or billing counters | Exclude rather than port | D | Intentionally absent |
| Rich file formats/UI | [file handler factory](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/9d5afdf5da6bdee4d4c52caf9a78128235a1b0d4/src/utils/files/factory.ts) chooses text/image/document handlers | UTF-8 and lossless base64 regular files | No document conversion/UI dependencies needed for connect | C | Deferred |
| Regression patterns | [atomic tests](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/9d5afdf5da6bdee4d4c52caf9a78128235a1b0d4/test/test-atomic-write.js) inspect write/sync ordering; schemas validate boundary inputs | Real built SDK clients, race/fuzz, systemd collection and crash tests | Add prompt/approval/origin/crash-transition tests and subprocess coverage | A/B | Planned M8-M15 |

For this project, a CGO-free Go executable and native systemd/detached workers
fit on-demand operation without a Node runtime, npm dependency installation or a
resident process manager. This is a fit to Bridge's requirements, not a general
claim that Go is superior. Keep independent task result persistence; adopting
upstream's in-memory session ownership would lose a core Phase 1 guarantee.

Adopt bounded slices, content-search pages, clear continuation/error results,
atomic configuration updates, explicit install previews and informative terminal
events. Do not expand this phase into document converters, fuzzy edits, PTYs,
arbitrary process control, rich widgets, telemetry or a hosted remote platform.
