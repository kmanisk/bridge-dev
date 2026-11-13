# BridgeDev — Agent Instructions

This repository contains the TypeScript-based BridgeDev MCP policy gateway. Preserve and follow the existing security model, operator-authorized approvals, immutable deployed runtime, and audit chain. Read relevant documentation before changing code. Never disable authorization to pass a test. Do not commit secrets or change production services from repository operations. Run `pnpm test`, `pnpm run test:policy`, and `pnpm run test:cli` before publishing changes. Keep the MIT copyright attribution in LICENSE.

## Product rules

BridgeDev must be useful without the author's workstation, chezmoi setup, root privilege, Windows paths or vendor-specific MCP servers. Keep the portable core distinct from managed Linux host modules. Do not weaken the Policy Gateway for portability. Skills and Markdown are optional, workspace-scoped and non-executable by default. Public MCP samples must be disabled until an operator reviews them.

For source changes, verify `pnpm run test:portable`, `pnpm run test:cli`, `pnpm run test:policy`, and `node scripts/sync-tool-counts.mjs --check-manifest profiles/native-tool-counts.json`. Preserve compatibility with existing operator-owned policies and protected audit ledgers. Never deploy or restart existing live services as part of GitHub source updates.
