# Bridge development rules

The latest Phase 2 specification supersedes Phase 1 restrictions listed in
docs/SUPERSEDED_RESTRICTIONS.md. Preserve existing functionality and user data.
Product naming belongs in internal/identity. Keep the official MCP SDK.
Local milestone commits are authorized only after complete passing regression,
diff/credential review and updated requirement evidence. Never push or add a
remote. Never launch real public tunnels or real sudo in tests. Use PATH shims
and isolated temporary XDG directories. No permanent services or live client
configuration changes during tests. Run make check, path fuzzing and cross-builds.
Update NOTES.md, REQUIREMENTS.md, TEST_REPORT.md and HANDOFF.md at milestones.
