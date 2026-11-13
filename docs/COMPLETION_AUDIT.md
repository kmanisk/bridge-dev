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

## Phase 2

Provider imports are disabled and deny exposure even if imported metadata requests
enabling. Registry writes validate schema, IDs and namespace collisions, use an
exclusive bounded file lock, an atomic rename and a private rollback snapshot.
Invalid optional registries remain untouched and report initializationError.
Provider HTTP uses DNS validation and pinned connection addresses; private/plain
HTTP requires explicit allow_private_network. Redirects are not followed by the
provider transport. Source downloads revalidate each redirect separately.

Names are ASCII and at most 64 characters, with SHA-256 suffixes for normalization
or truncation. Provider metadata/results have count/size limits, origin labels and
control-character filtering. Original input schemas validate every forwarded call;
regex and referenced schemas fail closed as unsupported. Disabled/removed and
non-allowlisted tools are refused even through the legacy mcp_call fallback.
All unclassified proxies retain X classification and signed per-call approvals;
provider read-only annotations alone never grant policy permission.

Stdio uses an explicit-only environment and an owned process group (Windows uses
taskkill /T). STRICT refuses stdio without an independently reviewed sandbox.
Requests time out, reconnect attempts back off on demand, and shutdown invalidates
pending connections. There are no provider polling loops. Portable gateway-owned
.bridge-dev configuration is protected from native workspace writes.

Verified on Linux: independent SDK client through both HTTP and stdio providers,
namespace collision refusal, invalid arguments, SSRF targets, safe persistence,
stale-call denial after disable, removal, corrupted config and provider/child PID
cleanup. Existing full suite, policy, CLI, portable and native inventory gates pass.
No new dependencies. Windows/macOS execution follows in phase 6.

## Phase 3

Implemented extensible SourceAdapter detection/discovery with content-addressed
previews and update checks. Local directories/files, local Git working trees,
GitHub/GitLab repository URLs, generic HTTPS Git URLs, raw Markdown/JSON URLs,
GitHub blob URLs, HTTPS endpoints, tar/tgz/ZIP artifacts, npm metadata and PyPI
wheel metadata use generic component mechanisms. Ambiguous repositories require
component selection; a README alone is never interpreted as an installer.

Remote Git runs without checkout, hooks, submodules, credential helpers or filters
through an on-demand smart-HTTP relay. The relay pins validated public addresses,
refuses redirects and caps each response and total transfer. It closes after the
operation. Archives reject traversal, links, special files, excess counts, large
entries and decompression bombs. ZIP checks CRC; tar checks header checksum.

Operator proposals bind the reviewed content, resolved commit/version, artifact
hashes, permissions, scope and entrypoints. Applying an executable package leaves
its provider disabled. npm installation extracts a verified dependency-free
artifact without scripts. Python uses a reviewed wheel in a dedicated venv with
pip --no-index --no-deps --only-binary; no source builds. Missing runtimes report
the process error. Dependency graphs currently require independent installation
and a local MCP definition. SSH Git, private repository credentials and community
registry adapters are not implemented. No registry API formats were guessed.

Verified with local fixtures only: actual HTTPS Git smart protocol, multi-component
selection, pinned Git provenance, Markdown HTTPS, npm tarball installation, Python
wheel installation, endpoint registration, update detection, disabled registration,
removal and reference/symlink rejection. Node's test-only module mocks redirect
remote transports to the fixture server; production exposes no TLS/SSRF bypass.
Required full, policy, CLI, portable and inventory gates pass. No dependencies added.

## Phase 4

Managed skills, instructions and version-1 packs share reviewed proposals and
private scope lockfiles. Project entries override the same user key explicitly,
even when disabled. Installed content starts disabled; updates require fresh
review and enable. Pack members retain ownership across individual updates, and
removing a pack removes its owned members without removing user-scope overrides.
Content snapshots are bounded and validated, relative references remain inside
skills, and no embedded scripts execute. Native list_skills/load_skill and startup
instruction context load enabled managed guidance with untrusted-origin labels.
Corrupted optional content reports warnings instead of preventing core startup.
Removal cleans owned content/package artifacts after provider shutdown.

Verified: mixed pack preview, disabled provider registration, skill load through
the existing interface, Markdown loading, validation, user/project precedence,
update pinning, fresh enable, disable, stale-proposal denial and removal. Test
scripts now receive separate disposable state from one another. Full, policy,
CLI, portable, provider, source and inventory gates pass. No dependencies added.
