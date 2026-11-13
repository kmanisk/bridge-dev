# Completion audit

## Baseline: 2026-11-13, fdda245

The clean local checkout was fast-forwarded from 78007bf to GitHub main fdda245.
Remote heads: main and archive/go-prototype (archive f3c9319), preserved.
Prior Actions policy and portable workflows passed:
https://github.com/kmanisk/bridge-dev/actions/runs/43433697045
https://github.com/kmanisk/bridge-dev/actions/runs/43433697040

Before product edits: build passed; all fourteen existing test scripts (the
thirteen pnpm test scripts plus policy-upstream-readonly) passed in a disposable
HOME with fixture policy/context, OAuth, shell, audit and XDG paths. Production
management commands were shadowed by refusing fixtures. No live gateway or tunnel
was accessed. Baseline raw results were retained locally in
/tmp/bridge-baseline-results.json; this file records the reproducible outcome.

Audit findings: imports exposed all tools by default; provider metadata acquisition
could execute providers; direct proxies lacked bounded names and complete schema
validation; portable CLI fell back to managed production paths; SIGTERM skipped
cleanup; config writes were non-atomic; optional corrupted provider config could
prevent startup. Source installation, managed content lifecycle and proposal APIs
were absent. Native tools, policy signatures and audit-chain checks already worked.

## Phase 1

Added standard bearer authentication at /mcp with legacy token URLs retained;
startup refuses an empty/unsafe token. Portable CLI no longer probes production
services/tunnels/config paths and cannot stop/restart a managed service. Shutdown
handles SIGINT/SIGTERM and awaits sessions, upstream transports and HTTP listeners.
An invalid optional provider config is quarantined in memory without modifying the
file or blocking core startup. The public test commands run within disposable
HOME/XDG/config/data and policy state. No dependencies added.

Verified: full baseline suite, policy suite, CLI suite, portable workspace suite,
actual portable HTTP startup/authentication and native tools inventory.
Production services, installed code, credentials, Funnel and VM state unchanged.
