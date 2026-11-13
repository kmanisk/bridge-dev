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

## Phase 5

Added one CLI interface for add/mcp/skills/instructions/pack with structured output,
component selection, scope, previews and exact proposal IDs. Applying proposals
requires the independent authenticated admin API; MCP has no approval/signing tool.
MCP proposal tools create inert requests without downloading code. Read-only tools
inspect cached metadata; mcp_test binds a provider fingerprint and requires signed
policy approval. CLI/admin tests run under explicit operator authentication.

The admin login assets are loopback-only and public; data and actions require the
independent bearer admin token. Tokens stay in browser memory. Host/origin guards,
CSP and safe DOM rendering protect the interface. It supports source discovery,
selection, full proposal review, exact apply, pending model requests, scoped content
management and provider permissions. Existing provider forms remain available.
Activity streaming uses authenticated fetch without polling fallback. Configuration
editing rejects newline injection and runtime changes to immutable security paths.
Native shell children no longer inherit gateway authentication/approval authority.

Portable tools may receive operator-declared per-tool R/W/X permissions. Managed
Linux deployments continue to require their root-owned proxy policy classifications.
Portable strict/standard changes and lifecycle stop require admin authentication;
YOLO remains managed Linux-only. Registration, enabling, connection and exposure
are reported separately. Native inventory is now 51 slim / 73 full registrations.

Verified by independent HTTP MCP client and real CLI subprocesses: no-provider
startup, preview without installation, operator approval, disabled registration,
provider test, allowlist and permission review, forwarded calls, skills loading,
inert model requests, self-approval rejection, stale-call refusal, persistence after
restart and removal. All required baseline and new suites pass; admin JavaScript
syntax checks pass. Browser visual/interaction acceptance has not been executed.
No dependencies added; production unchanged.

## Phase 6

The aggregate suite now executes every baseline test plus portable startup, source,
managed content, extension security, network fixtures and both independent/legacy
HTTP integration scenarios under separate temporary HOME/XDG/policy/config state.
Legacy integration tests were repaired for bearer auth and explicit operator cache
warming; stale-session tests require an explicitly supplied disposable gateway.
The existing stale-session scenario found and fixed missing internal bearer auth.
No assertion was removed to conceal that regression.

New negative/recovery coverage includes crashed providers and descendant cleanup,
command updates requiring fresh enable review, model self-approval, proposal
mutation, concurrent install/lock races, corrupted locks, DNS pinning/rebinding,
mixed-address DNS, redirect SSRF, IPv4/IPv6 encodings, tar/ZIP traversal/links,
decompression bombs, oversized responses, referenced schemas and secret scrubbing.
Windows cleanup uses a bounded PowerShell process-tree snapshot to retain ancestry
after parent exit. It is cleanup, not an OS sandbox or a Job Object guarantee.

Local Linux full aggregate, extensions, sources, policy, CLI, portable and inventory
gates passed. GitHub workflows now run native Linux/Windows/macOS HTTP and extension
scenarios plus Debian, Fedora and Arch disposable-container core tests. Actual
remote results are recorded in phase 7 after the jobs execute. Android/Termux,
real client accounts and deployed privileged-host acceptance remain unverified.
Setup dependencies are installed before tests; the tests contact only fixtures.
No new application dependencies and no production changes.

### Phase 6 CI corrections

The first expanded CI run passed Ubuntu core and Linux source/integration tests but
exposed macOS canonical-path comparison, Windows environment defaults/shutdown-test
assumptions and container orphan reaping failures. The failures were retained and
fixed: CLI path assertions compare canonical paths; Windows stdio explicitly blanks
libuv's automatically inherited variables and includes reviewed SYSTEMROOT/WINDIR
OS requirements; shutdown tests use the authenticated lifecycle API on every OS.
Docker container jobs use --init so PID 1 reaps terminated orphan descendants.
No process-cleanup assertion was relaxed. A stale keep-alive control socket during
rapid restart was removed by closing lifecycle control connections explicitly.

Provider inspection now redacts all granted environment/header values regardless
of key names. OAuth credential files use atomic private writes. Local source
scanning excludes credential files, and npm entrypoints/platform constraints are
checked before automatic Node execution is proposed. Local full aggregate and
focused source/extension/policy/CLI/inventory regressions pass after corrections.
Windows libuv behavior was checked against its primary implementation:
https://github.com/libuv/libuv/blob/v1.x/src/win/process.c

### Phase 6 streaming and native teardown

Debian/Arch passed after adding a real container init. Fedora's Node 22 then exposed
an SSE cancellation race in the Node Readable.toWeb adapter; safe HTTP now implements
explicit cancellation and backpressure, with byte limits retained. Windows showed
live-tree cleanup timing failures: live parents use bounded taskkill /T /F; crashed
parents use bounded ancestry inspection. Cleanup failures propagate and disabled
configuration becomes effective before shutdown. Client fixture control requests
close their connections across rapid gateway restarts.

The authenticated admin flow also passed in an isolated, preinstalled headless
Chromium-compatible browser: login, source discovery, exact preview, approval and
installed-state rendering. The optional test uses temporary HOME/profile/XDG data
and terminates its browser tree. Screenshot retained in /tmp/bridge-admin-browser.png.
No browser or application dependency was installed. Browser CLI commands:
BRIDGEDEV_TEST_BROWSER=/absolute/path/to/chromium pnpm run test:browser

The slim manifest now includes cached mcp_tools inspection: 52 slim / 73 full.
Local full, source, extension, browser, policy, CLI, portable and inventory checks
passed after these corrections. Native platform CI is rerun for the corrected SHA.

### Phase 6 final platform correction

At a009a0b, native macOS/Ubuntu and Debian/Fedora/Arch containers passed. Windows
startup, CLI and end-to-end extension management passed, but the WMI cleanup query
failed its bounded deadline after a provider crash. The Windows-only helper now
uses local Toolhelp process snapshots through the OS-provided .NET/PowerShell
runtime, with no WMI/WinRM or persistent helper. Live trees still use taskkill;
crashed roots are never killed again (avoiding a reused root PID). Descendants are
terminated and awaited. Local baseline and focused gates remain green; Windows
cleanup is verified only by the next native CI run.

CLI reads the same optional .env as serve, with test dotenv paths forced into each
disposable test root. Portable status/doctor use configured ports and application
state and do not require a Linux system service or inspect production host policy.
The interface regression verifies portable doctor against the isolated gateway.

The native snapshot helper's first Windows run also timed out while launching the
legacy powershell.exe host (exit=null, signal=SIGTERM, no script diagnostics).
Cleanup now prefers installed PowerShell 7, keeps a bounded legacy fallback and
captures only trusted helper diagnostics on failure. The provider-crash/child-PID
assertion remains required. Local required suites pass; native CI remains the gate.

### Verified phase 6 CI and source URL coverage

At 2295c88 all expanded native and distribution jobs passed:
https://github.com/kmanisk/bridge-dev/actions/runs/43446920786
https://github.com/kmanisk/bridge-dev/actions/runs/43446920352
https://github.com/kmanisk/bridge-dev/actions/runs/43446921264

The native matrix includes actual Windows/macOS HTTP startup/authentication, CLI,
aggregation, provider crash/descendant cleanup, scoped content, security and full
extension-management HTTP scenarios. The Linux source job installs fixture npm
artifacts and universal Python wheels without reaching public registries.

Source fixtures now exercise literal GitHub/GitLab repository, blob/raw SKILL.md
and GitHub release-artifact URL shapes against the disposable HTTPS fixture.
Archive discovery preserves multiple top-level directories instead of stripping
each root separately; SSH sources produce an explicit unsupported error.
Source tests and required policy/CLI/portable/inventory gates pass after this fix.
