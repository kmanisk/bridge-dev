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

## npm trusted publishing (operator-only setup)

1. Create or sign in to the npm account, configure account-level two-factor
   authentication and recovery factors, and ensure ownership of the package.
2. In npm package settings, configure **Trusted Publisher: GitHub Actions**
   using owner `kmanisk`, repository `bridge-dev`, workflow filename
   `npm-package-release.yml`. The initial package ownership/publication
   may require an operator-run first release if npm does not permit trusted
   publishing before the package exists.
3. After validating the trusted publisher, set the GitHub repository Actions
   variable `NPM_PUBLISH_ENABLED=true`. Leave it missing/false while
   testing the release workflow. This is an intentional opt-in.
4. No npm token is stored in source. Preferred path uses GitHub OIDC trusted
   publishing with `id-token: write`, npm's `--provenance` flag and
   official Actions. Do not paste tokens into logs or issue comments.
5. Review a version bump in `package.json` and `pnpm-lock.yaml` as applicable;
   merge the version change through the protected `main` pull-request and CI.
6. Confirm the exact main commit and package version from an independent
   operator terminal. Create a signed or annotated `vX.Y.Z` tag on that
   exact merged commit, and push the tag only after explicit publication
   approval. **This document does not authorize creating a tag.**
7. The tag workflow first runs Linux, Windows and macOS clean-install tests,
   full Linux regression, a version/tag check and protected-main ancestry
   check. It retains the reviewed .tgz as a GitHub artifact. Only when
   `NPM_PUBLISH_ENABLED=true` does it attempt `npm publish` with OIDC
   provenance. `workflow_dispatch` runs verification only.
8. Verify publication from a fresh terminal and prefix:
   `npm view bridge-dev version dist.integrity`, inspect provenance,
   then `npm install -g bridge-dev`, `bridge-dev --version`,
   `bridge-dev doctor`, and an explicit local portable gateway smoke test.

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
