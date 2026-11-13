# Source discovery and installation

## Implemented adapters

`SourceAdapter` exposes detection and bounded discovery; `SourceCatalog` selects an
adapter, lists components and computes update information. Adapters can be supplied
without changing gateway routing. Discovery returns a source, adapter ID, resolved
commit/version, SHA-256 digest, requirements, permissions and component candidates.
It does not grant execution permission. Fetching currently examines bounded source
snapshots rather than selectively fetching arbitrary files from large repositories.

| Source | Implemented format | Restrictions |
| --- | --- | --- |
| GitHub/GitLab repository | `https://github.com/owner/repo`, `https://gitlab.com/owner/repo` | Compatible manifests or skills required; public HTTPS only |
| Other Git hosts | `git+https://host/path/repo.git`, `https://host/path/repo.git` | Smart HTTP, bounded transfers; `#branch`/`#tag` selects a ref |
| Git working tree | `./local-checkout` | Files inspected without executing hooks; current HEAD recorded |
| Individual files | raw HTTPS Markdown/JSON, GitHub `/blob/` and GitLab `/-/blob/` URLs | Direct skills must include valid metadata; missing relative references are rejected |
| Release artifacts | versioned HTTPS `.tar`, `.tar.gz`, `.tgz`, `.zip` URLs | Hash pinned; reviewed content only, no automatic native binary installer |
| HTTP MCP endpoint | `https://example.com/mcp` | Registered as an unverified endpoint candidate; operator test required |
| Local MCP definition | JSON `mcpServers` exports or version-1 BridgeDev registry/manifest | Import always disabled, with no exposure |
| Local content | skill directories, standalone `.md` files | Symlinks, special files and sensitive local files refused/excluded |
| npm | `npm:name`, `npm:@scope/name@1.2.3` | Node entrypoint, artifact integrity and platform inspected; automatic install only without dependencies |
| PyPI | `pypi:name`, `pypi:name@1.2.3` | Universal `py3-none-any.whl`, console entrypoint and no dependencies; Python/venv/pip required |

Examples use placeholder owners and URLs; substitute sources you have reviewed.
Literal hosted URL shapes and package flows are tested against local HTTPS/Git
fixtures. Tests never contact GitHub, npm, PyPI or another public registry.

Plain Markdown is instructions. A `SKILL.md` must have a lowercase skill name and
single-line description in frontmatter. A repository is never assumed to be an MCP
server merely because its README mentions MCP. MCP repositories need a reliable
provider definition; build-only repositories can fail with an exact missing-entrypoint
or manifest blocker. Native prerequisites are displayed rather than installed.

## Review flow

```sh
bridge-dev add <source>
bridge-dev add <source> --select skill:review,mcp:example --scope project
bridge-dev approve <exact-id>
```

Multiple candidates require selection. Preview includes source, resolved commit or
version, hashes, files, command/arguments, requirements and requested permissions.
Normal CLI previews summarize file sizes; `--verbose` or `--json` includes full
content. Applying requires the independent authenticated admin API. Content and
providers start disabled; enabling is another reviewed operation.

An executable package is fetched again at apply and must match the reviewed hash.
npm archives are extracted without package scripts. Python installs a wheel in a
dedicated venv with `pip --no-index --no-deps --only-binary`; no source builds run.
Packages with dependencies return `PACKAGE_DEPENDENCIES_REQUIRE_REVIEW`. Install
such dependencies independently, then import a reviewed local executable definition.
This does not claim general npm/PyPI environment installation.

The package metadata formats were checked against the primary
[npm Registry API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md) and
[PyPI JSON API](https://docs.pypi.org/api/json/). No community MCP registry adapter is
implemented, and no registry format is guessed. `search` currently searches installed
metadata, explicitly labeled as such.

## Network and archive policy

Source downloads require public HTTPS without embedded credentials. Every hop
resolves and validates all addresses, pins the connection address and revalidates
redirects. Loopback, private, link-local, mapped IPv6, reserved and tunneling targets
are refused. HTTP providers can use private/plain HTTP only with explicit
`allow_private_network:true`; this does not relax source-download policy.

Git uses a short-lived smart-HTTP relay and a bare checkout. No hooks, credential
helpers, filters, submodules, build commands, GitHub Actions or README installers
execute. The relay closes after discovery. Git responses are capped at 16 MiB and
32 MiB total; source snapshots at 512 entries and 8 MiB, with 1 MiB per file.
Large repositories outside these limits require a smaller reviewed source/export.

Archives cap counts, entry sizes and decompressed bytes. Absolute/traversing paths,
symlinks, hardlinks, devices, duplicate entries and unsupported special headers are
rejected. tar header checksums and ZIP CRC are checked. No archive-supplied hooks run.

## Unsupported and experimental

- SSH Git and private repository credential adapters are not implemented; use a reviewed local checkout or public HTTPS source.
- Community MCP registry search/install is not implemented.
- General dependency graphs, native npm entrypoints, non-universal Python wheels and source distributions are not automatically installed.
- A bare local executable should be supplied through a compatible MCP definition with explicit command/argument arrays.
- OS keychain integration is not implemented. OAuth/registry secrets use private files; Windows relies on the account's actual filesystem ACLs.
- Provider schemas using references or regex patterns fail closed as unsupported.
- Actual public source availability, private credentials, client accounts and Android hardware are not exercised by fixture tests.
