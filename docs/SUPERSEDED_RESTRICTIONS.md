# Intentional Phase 2 changes

Authority: the user's Phase 2 implementation specification replaces earlier
Phase 2 prompts and conflicting Phase 1 restrictions. This file records changes,
not permission to skip authorization or regression tests.

| Previous restriction/behavior | Replacement and reason | Activation milestone |
| --- | --- | --- |
| Fresh confirmation for every future privileged command; no privileged session-class approvals | Latest policy semantics permit automatic authorized calls under approve=none and class-session a; startup/session/scope/expiry still bind privilege | M11/M12 |
| CIMD mandatory in an older Phase 2 addendum | Latest section 14 makes CIMD optional; DCR is required and implemented, CIMD is not advertised | M10/M15 |
| Disconnect automatically revokes pending application authorization | Stateless sockets are transient; explicit application sessions expire/revoke independently, while origin changes invalidate credentials | M10/M14 |
| No commits | Verified local milestone commits authorized; no remote/push/publication | M8 |
| example.com module / separate display branding | github.com/kmanisk/bridge-dev; one temporary product-name constant | M8 |
| Configuration assumes selected privilege is immediately usable | Saved mode is a preference; effective privilege requires startup authorization | M8/M12 |
| Remote sudo/dangerous categorically rejected | OAuth plus authenticated effective session, startup authorization and selected approval policy | M12 |
| Dangerous acknowledgment can be saved by ordinary config paths | Wizard never writes ack_privileged=true; explicit manual choice may suppress startup phrase | M9/M12 |
| Sudo always has a mandatory command allowlist | sudo_exec unrestricted by default in authorized sudo mode; explicit sudo_commands remains optional | M12 |
| Dangerous still has root/command restrictions | No normal path jail/command policy; correctness, audit and explicit technical bounds remain | M12 |
| Only local pairing-code browser consent | Terminal-confirmed OAuth consent default; pairing flow retained as auth=code | M10 |
| Tunnels limited to one-shot Quick Tunnel | Optional quick/named/custom third-party transports with verified origin/recovery | M9/M14 |
| No hosted relay wording | No Bridge-operated relay; Cloudflare is an optional external hosted relay and trust boundary | M8 |
| Bounded registration/token counts could resemble usage policy | Only documented configurable technical/abuse bounds; no billing counters or tool-call quotas | M10/M15 |
| Whole-file reads and name-only search | Add bounded slices, explicit continuation and content search without weakening jail | M14 |
| Bash manual | Fish commands/completions, syntax-checked without live shell installation | M15 |
| Web account testing implied by local OAuth | Real account results separate; ChatGPT best-effort, never a release blocker | All |

A row describes the requested final replacement; REQUIREMENTS.md records whether
it is currently implemented and tested. All listed local milestones have now passed. External account/platform evidence
is still explicitly pending; no restriction is silently weakened.

## Final integration sprint authorization

The user's final sprint supersedes the earlier no-remote/no-push rule: creating
and pushing verified history only to PRIVATE kmanisk/bridge-dev is now authorized.
One controlled real readonly Quick Tunnel is authorized separately from automated
regression tests. Existing working sessions must be inspected before any necessary
restart. No public visibility, permanent service, real sudo/dangerous test, unrelated
repository push, credential publication or workstation configuration change is
allowed. The product name is now bridge-dev, without a rename in this sprint.
