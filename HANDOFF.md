# Phase 2 handoff

M8-M10 verified: module rename, reversible configuration preferences, pinned upstream
source comparison and local Git initialization. See REQUIREMENTS.md and NOTES.md.
Current Phase 2 specification overrides old bans on local milestone commits and
requests future authorized remote privilege; these changes are tracked explicitly
in docs/SUPERSEDED_RESTRICTIONS.md. M11-M15 are not yet complete. Connect/wizard and terminal OAuth/client sessions
are implemented; tool approvals/deduplication, privileges and reliability are next.

The Phase 1 filesystem jail, official SDK, durable workers and local OAuth still
pass full regression. Runtime requests remain on-demand. Do not create a remote,
push, expose real tunnels in tests, run real sudo in tests or install permanent
services. All test state and fake executables belong in temporary directories.
Source reference is ignored under .research; generated tools/build/log output is
ignored. Check test-output/m8-* for local proof; no web account claim is made.
