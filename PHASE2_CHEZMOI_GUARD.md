# Phase 2 — Chezmoi-aware native filesystem guard (development only)

Status: implemented and tested only in the isolated `dev-phase1` worktree, **not deployed**. Production, Tailscale, and the canonical chezmoi tree are unchanged.

## Objective

Automatically route **targeted native edits** on managed live files to their canonical chezmoi sources while preserving existing changes. The edited source remains unapplied until the user explicitly authorizes `chezmoi apply` for the intended target(s). Never reload Sway/services, commit, push, or deploy automatically. Unmanaged regular files remain editable, subject to Phase 1 policy.

## Implementation

- `src/lib/chezmoi-guard.ts`: uses the installed `chezmoi source-path` CLI to resolve destination paths. Invokes the CLI with argument arrays (no shell interpolation), canonicalizes parents and symlinks, reports template source paths, checks source-specific Git status, and optionally checks target status. `resolveChezmoiEditTarget` automatically routes targeted edits to the source; full replacement of managed targets is guarded by explicit source hash, clean-source state, and template protection.
- `src/tools/chezmoi.ts`: one slim-profile, **read-only** `chezmoi_inspect` tool. Result includes `kind`, `sourcePath`, `sourceDirty`, `sourceIsTemplate`, optional `targetStatus` and guidance.
- `src/lib/safe-edit.ts`: preflight on native single-file edits.
- `src/lib/patch.ts`: preflight **all** file paths before a multi-file patch mutates any file; targeted updates resolve to sources. Managed-file deletion and creation remain blocked. Concurrent target/source duplicate resolution is rejected.
- `src/tools/filesystem.ts`: directs `edit_file`, `multi_edit`, `replace_regex`, single-file and multi-file patch updates to their canonical source, with pre-image hashing to detect races. `write_file` and `write_file_base64` require a clean, non-template source and exact `expected_hash` when targeting managed live files. Native delete/create-directory/copy/move paths remain guarded; deletes/moves are never treated as safe automatic source edits.
- `src/lib/checkpoint.ts`: preflight all affected paths before any checkpoint restore.
- `src/lib/tool-profile.ts`, `src/server-factory.ts`: add only `chezmoi_inspect` (one additional tool) to the slim profile.
- `src/lib/security-policy.ts`: direct `chezmoi ... apply` shell commands are classified high risk and require a separately issued authorization token. This remains **heuristic** and is not an enforceable shell boundary.
- `scripts/test-phase2-chezmoi.mjs`: fixture-based tests, including actual registered filesystem handlers and uncommitted-source preservation. `package.json` and `scripts/run-all-tests.mjs` run the tests.

## Classification and behavior

| Result | Native filesystem mutation |
| --- | --- |
| `managed_target` | Targeted edit auto-routes to **canonical chezmoi source**, preserving unrelated existing lines. Full overwrite requires exact source hash, clean source, and no templates. Delete/move remain blocked |
| `generated_target` | Block if an existing target starts with a comment identifying it as generated and says not to edit |
| `source` | Allow explicitly requested source edits, subject to Phase 1 safety checks; never auto-apply to live file |
| `unmanaged` | Allow normal edits; never auto-adopt |
| `outside_destination` | Follow ordinary filesystem policy |
| `unavailable` | Fail closed rather than guessing ownership |

Generated-file detection uses only an explicit do-not-edit header in the first five lines. Generated files without that marker are not necessarily detected; owning subsystem docs still take precedence.

The implementation never invokes `chezmoi add`, `chezmoi apply`, service reloads, package installs, background watchers, Git commits or pushes. Applying edited sources requires **separate, explicit approval for the exact live-target change**, as does production deployment. No new dependency is required beyond existing `chezmoi`, `git` and Node.

## Development tests

Use disposable local directories and explicit test-only overrides:

```sh
pnpm run build
node scripts/test-phase2-chezmoi.mjs
pnpm test
MCP_TOKEN= pnpm run test:all
```

Fixtures exercise managed and unmanaged targets, templates, generated headers, symlink aliases, refusal without mutation, auto-routing by `edit_file`, `multi_edit`, `replace_regex`, single and multi-file patches, preservation of pre-existing uncommitted source lines, full-replacement safeguards, refusal to delete managed targets, direct `chezmoi apply` classification, and fail-closed lookup errors.

`LOCAL_CODER_CHEZMOI_SOURCE_DIR` and `LOCAL_CODER_CHEZMOI_DESTINATION_DIR` only select the source/destination roots for a **separately launched testing process**. They are not needed in production.

## Important limitations

1. This is a **guard for native file mutations**, not a kernel-enforced security boundary. Arbitrary shell commands, Git, bridged MCP tools and a process with unrestricted passwordless sudo can bypass it. Do not describe it as complete host-wide enforcement.
2. The Phase 1 command classifier is still regex/heuristic-based. It should not be considered safe against adversarial shell commands or untrusted prompts. A dedicated unprivileged OS account is necessary for a genuine boundary.
3. A source edit is not automatically validated against all downstream rendered files. Phase 3 post-edit validators and a deliberate apply workflow must be designed independently.
4. A dirty chezmoi source is reported and may receive **targeted context-aware edits**, but full-file replacement is forbidden. Always read and patch the current source rather than replacing it wholesale. If source and target contents differ, old-text edits based only on the live target may fail; inspect and patch the source content instead.
5. Approval for `chezmoi apply` is a **separate human decision**, not granted by approving this development implementation. Direct shell command recognition is advisory and incomplete; never claim this blocks arbitrary shell or code execution. A trusted approval/UI workflow is still required before production promotion.
6. No test needs to write to the workstation's actual `~/.local/share/chezmoi` or `~/.config/sway`.

## Gate before deployment

Require full regression and integration passes, a review of remaining Phase 1 security gaps, confirmation that the live source and service state were unchanged, and explicit user authorization for any production cutover. After a verified deployment, reconcile the authoritative docs in `kmanisk/dots` under `AGENTS.md`'s documentation contract.
