# Skills, instructions and packs

## Managed CLI

```text
bridge-dev skills list|search|info|add|remove|enable|disable|update|validate|sources
bridge-dev instructions list|info|add|remove|enable|disable|update
bridge-dev pack list|info|add|update|remove
```

`add <source>` discovers and previews. With several candidates, use `--select
skill:name,instructions:name,pack:name`. Each change returns an exact proposal ID.
`bridge-dev approve <id>` applies it through the authenticated operator API. The CLI
reads `.env` in its current directory; use the same directory/configuration as serve.
`--json` returns structured data, and `--verbose` shows complete file previews.
Successful commands exit 0; failed operations exit nonzero. CLI error objects use
`BRIDGEDEV_ERROR`. Provider installation is separate from runtime prerequisites.

Installed content starts disabled. `skills enable name` and `instructions enable
name` create review proposals; approve these before loading content. Updates fetch a
new bounded snapshot, pin its commit/hash and reset enablement for renewed review.
`skills update --all` produces individual proposals. No automatic update watcher runs.

Native `list_skills`/`load_skill` and the management `skills_list`/`skills_info`/
`skills_validate` expose enabled content or metadata. Text is labeled untrusted and
never grants permissions or executes scripts. Relative skill references must remain
inside the skill and resolve; external links must be HTTPS. Imported scripts remain
inert reference files. Plain Markdown is distinct from structured `SKILL.md`.

```md
---
name: code-review
description: Inspect changes and report verification
---
# Review
Read the diff and relevant tests before proposing a change.
```

## Scope and storage

Default scope is project; use `--scope user` for user content. Effective keys are
`kind:id`. A project key overrides the same user key, including a disabled project
entry. Inspection reports `overrides_user:true`; explicit `--scope` lists that scope.
MCP enable/disable targets the effective provider; an explicit hidden user-scope
provider is refused until the project override is removed. Same-scope duplicates fail rather
than overwriting content silently. Legacy workspace skill discovery remains active.

| State | Path |
| --- | --- |
| User state | `$HOME/.bridge-dev/state`, overridable with `BRIDGEDEV_STATE_DIR` |
| User lock | `<state>/extensions/user/lock.json` |
| Project lock | `<workspace>/.bridge-dev/managed/lock.json` |
| Proposals / inert client requests | `<state>/extensions/proposals/`, `requests/` |
| Reviewed snapshots | Scope `content/<digest>/<kind>-<id>/` |
| Package artifacts | Scope `packages/<digest>/<id>/` |

Lock schema version 1 records key, scope, source, adapter, resolved commit/version,
discovery digest, component metadata, enablement and installation timestamp. Pack
members additionally record their owner. Unknown/corrupted versions fail closed;
optional content produces startup warnings instead of blocking the core.

Registry/lock changes use exclusive bounded locks and atomic private writes with
`.bak` snapshots. Proposals and inert requests are bound to the canonical workspace;
approval from a different project is refused. A stale proposal or changed provider
fingerprint is refused.
There is no automatic schema migration from an unknown future version. Inspect a
backup before any operator-controlled rollback; backups are inert, never auto-run.
Removal stops owned providers and removes owned content/artifacts. It does not
uninstall independently installed native applications. Inspect ownership before
recovering a stale `.lock` directory; concurrent operations return a bounded busy
error rather than guessing whether another process is dead.

## Extension packs

A repository can contain `bridge-dev.json` or `.bridge-dev/pack.json`:

```json
{
  "version": 1,
  "pack": {"name": "development-pack", "description": "Reviewed development guidance"},
  "skills": ["skills/code-review"],
  "instructions": ["notes.md"],
  "requirements": ["Review the optional provider's native requirements"],
  "servers": [{
    "id": "example", "name": "Example MCP", "transport": "http",
    "url": "https://example.com/mcp", "enabled": false, "expose": "none"
  }]
}
```

Pack preview lists members and permissions. Applying a pack registers its providers
and content disabled; each executable/tool allowance requires separate operator
review. Removing a pack removes its owned members, preserving independent user-scope
entries. Updating an owned member preserves pack ownership. Existing same-scope
members cause an explicit conflict rather than being silently adopted.

Requirements are descriptive. Links or configuration templates retained in the
manifest are review material; the installer does not merge arbitrary templates into
host configuration, install native dependencies or execute installation instructions.

## Existing project configuration

Optional `.bridge-dev/extensions.json` remains compatible:

```json
{
  "version": 1,
  "instructions": ["NOTES.md"],
  "skill_directories": [".bridge-dev/skills"],
  "links": [{"title": "API reference", "url": "https://example.com/docs"}]
}
```

These paths stay within the workspace, are bounded and reject escaping symlinks.
Links are listed without being fetched at startup. Skills are also found under
`.agents/skills` and `.claude/skills`. Portable mode does not read personal
workstation-wide agent guidance. Managed host context remains explicitly opt-in.

## Admin UI and model requests

Open the loopback `/ui/` login shell, enter the independent admin token and Refresh.
Authenticated controls discover sources, select components, review exact proposals,
manage scope/enablement/permissions and apply approved changes. The token stays in
browser memory. Requests from MCP clients appear for operator review; clients cannot
approve or sign them. Imported text and tool metadata are untrusted even when viewed
inside the admin UI. Cached clients may need reconnecting after changes.

## Structured validation results

MCP `skills_validate` returns the native `{ ok, tool, summary, data }` envelope.
Its `data` is `{ results: [{ key, valid, error? }], ok, count }`; `data.ok` reports
whether every installed skill validated, while the outer `ok` reports whether
validation ran. An empty installation returns `results: []`, `ok: true`, `count: 0`.
This fixes the former invalid array at `data`; MCP consumers must read
`data.results`. The declared schema includes these fields.

`bridge-dev skills validate --json` preserves its existing `{ ok: true, data: [] }`
array contract. The Admin UI uses extension metadata endpoints and does not
consume the MCP validation payload; its response format is unchanged.
