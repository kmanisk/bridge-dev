# Bridge development rules

The latest Phase 2 specification supersedes Phase 1 restrictions listed in
docs/SUPERSEDED_RESTRICTIONS.md. Preserve existing functionality and user data.
Product naming belongs in internal/identity. Keep the official MCP SDK.
Commits and pushes require explicit user approval, passing applicable regression,
a focused diff/credential review, and updated requirement evidence. The earlier
private-only final integration restriction is historical: the existing
kmanisk/bridge-dev repository was verified PUBLIC on 2026-11-11 and the user
authorized a direct source fix and push to its current main branch. Never change
repository visibility without explicit permission. Do not publish runtime secrets.
Automated tests must not use a live tunnel, real sudo or user data; use PATH shims
and isolated temporary XDG directories. Never start permanent services or alter
live clients for testing. Run make check, path fuzzing and cross-builds when
the required environment is available; record incomplete gates precisely.
Update NOTES.md, REQUIREMENTS.md, TEST_REPORT.md and HANDOFF.md at milestones.
