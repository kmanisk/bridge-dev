# BridgeDev npm release procedure

The npm tarball is a precompiled JavaScript CLI and gateway, not a system installer.
Node.js >=22 is required on the consumer machine. It includes the Admin UI,
reviewed metadata profiles, and the lease verification / service acceptance
helpers needed by the code. npm resolves the five production JavaScript packages;
there are no required native Node addons, postinstall scripts, persistent
services, host-root grants, credential copies, or automatically started servers.

## Package name and ownership

The intended public name is `bridge-dev` (version 2.0.0 is the current source
baseline). On 2026-11-17, `npm view bridge-dev` returned E404, **not proof of
permanent name reservation**. Before first publication, independently check
`npm view bridge-dev` from the operator's terminal, then register/login to
[npmjs.com](https://www.npmjs.com/). If another account owns the name, use
`@kmanisk/bridge-dev` with `--access public`, update `package.json`,
all hardcoded npm commands and package tests, and inspect the changed tarball.
Never publish an unreviewed third-party package under the intended name.

## Local preflight (no publication)

From a clean feature branch:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run test:package
pnpm test
pnpm run test:policy
pnpm run test:portable
pnpm run test:cli
pnpm run test:extensions
pnpm run test:integration
pnpm run test:all
node scripts/sync-tool-counts.mjs --check-manifest profiles/native-tool-counts.json
git diff --check
npm pack --dry-run
```

The packaged test creates a disposable npm installation with its own HOME,
configuration, workspace, ports and tokens; it starts an isolated gateway,
checks an authenticated MCP session and local Admin UI, and removes fixtures.
It must not attach to a running managed service or inherit its signed YOLO
lease. Inspect the tarball file list and source diff before approving a release.

## npm publishing (operator-only setup)

1. Create or sign in to npm, enable account-level two-factor authentication,
   configure recovery factors and confirm the package name is available.
2. Configure a protected GitHub Actions environment named `npm-release`,
   with a required operator reviewer before publishing.
3. **First publication:** npm requires a package to exist before its trusted
   publisher can be configured. Create a short-lived npm publication token
   with appropriate publish privileges and save it as a GitHub Actions
   repository secret `NPM_TOKEN`. For a one-time, independently approved
   release, set repository variables `NPM_BOOTSTRAP_ENABLED=true` and
   `NPM_PUBLISH_ENABLED=true`; leave `NPM_TRUSTED_PUBLISH_READY` unset.
   The tag workflow then publishes its *verified tarball* using that token
   with provenance from CI, not from the developer's laptop.
4. Immediately after the first release, **revoke the bootstrap token** and
   set `NPM_BOOTSTRAP_ENABLED=false`. In the npm package's Trusted Publisher
   settings, register GitHub Actions owner `kmanisk`, repository `bridge-dev`,
   workflow filename `npm-package-release.yml`, allowing release
   publication. Set `NPM_TRUSTED_PUBLISH_READY=true` only after validating
   the link. Keep `NPM_PUBLISH_ENABLED=false` until the next release
   is independently approved.
5. Subsequent releases use **tokenless GitHub OIDC** with `id-token: write`,
   Node.js 24, npm CLI 11.5.1+, and provenance. The OIDC job deliberately
   avoids a `setup-node` `registry-url` option because an empty .npmrc
   auth token may suppress the trusted-publisher exchange. Do not install
   an npm token for these releases.
6. Review the version bump in `package.json` and `pnpm-lock.yaml` as
   applicable; merge via the protected `main` pull request and CI.
   Confirm the exact merged main commit and package version locally.
   Create a signed or annotated `vX.Y.Z` tag on that exact commit and push
   it **only after explicit publication approval**. This document does
   not authorize creating a tag or publishing automatically.
7. The tag workflow runs Linux, Windows and macOS clean-install tests,
   full Linux regression, a tag/version and main ancestry check, and
   uploads the verified .tgz artifact. Publishing occurs only if
   `NPM_PUBLISH_ENABLED=true` *and* the corresponding one-time bootstrap
   or trusted-publisher flag is set. Manual `workflow_dispatch` only verifies.
8. From a fresh terminal inspect `npm view bridge-dev version dist.integrity`
   and provenance, then `npm install -g bridge-dev`,
   `bridge-dev --version`, `bridge-dev doctor` and an explicit portable
   gateway smoke test. Never paste private credentials into logs.

## Upgrade, recovery and rollback

- npm installation: `npm install -g bridge-dev@latest` executed manually as
  the owner; no background updates. For a known good version use
  `npm install -g bridge-dev@X.Y.Z`.
- A verified managed Linux service is **not** upgraded by npm. It uses
  `bridge-dev update`, its GitHub CI artifact, shadow tests, controlled
  systemd cutover, preserved operator-signed lease and rollback.
- GitHub-source portable installer: rerun the reviewed `install.sh` or
  `install.ps1`; its previous built app is retained separately.
- npm versions are immutable: do **not** overwrite a published version.
  For an incorrect release, use `npm deprecate bridge-dev@X.Y.Z
  "Reason; use X.Y.Z+1"` and publish a new patch version through a new,
  reviewed tag. Follow npm policy for rare unpublish emergencies.
- Never update a running production gateway merely to test npm packaging.
