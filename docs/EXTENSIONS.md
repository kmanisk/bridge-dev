# Skills, Markdown and reference links

BridgeDev does not require a fixed workstation profile. Project context is provided by \`AGENTS.md\`, \`CLAUDE.md\`, optional Markdown files and discovered skills.

## Configure extensions

Create \`.bridge-dev/extensions.json\` in your **workspace**, using [the example](../examples/extensions.example.json):

~~~json
{
  "version": 1,
  "instructions": ["AGENTS.md", ".bridge-dev/instructions.md"],
  "skill_directories": [".bridge-dev/skills"],
  "links": [
    {"title": "Project API documentation", "url": "https://example.com/docs.md"}
  ]
}
~~~

- \`instructions\`: workspace-relative \`.md\` files, up to 64 KiB each (maximum 16 files). Files outside the workspace or via escaping symlinks are not loaded. Sensitive paths like \`.env\` and \`.ssh\` are rejected.
- \`skill_directories\`: workspace-relative directories of skill subdirectories containing \`SKILL.md\`. Up to 16 additional roots; default discovery also includes \`.bridge-dev/skills\`, \`.agents/skills\` and \`.claude/skills\`.
- \`links\`: HTTPS references for agents to cite/look up on request. **Never fetched automatically** at startup, never treated as executable instructions. Copy a reviewed remote Markdown document into an approved workspace if you want its content loaded.

Example skill:

~~~text
my-project/.bridge-dev/skills/code-review/SKILL.md
~~~

~~~md
---
name: code-review
description: Review changes and run relevant tests
---
# Code review
Inspect the diff, check test coverage, and describe risks before editing.
~~~

Clients call \`list_skills\` then \`load_skill\` by exact name. Merely adding a skill does not grant filesystem, network or privileged access. Skills are treated as task guidance and are subordinate to policy and explicit user instructions.

## Portability and privacy

Portable mode never auto-loads personal home-directory CLAUDE files or default workstation snapshots. The host-specific system context module is opt-in for managed operators through \`BRIDGEDEV_SYSTEM_CONTEXT_DIR\` (or legacy \`LOCAL_CODER_CHEZMOI_SOURCE_DIR\`).

No plugins, watchers or auto-downloaded binaries are installed. Enabling a provider or a skill does not change the MCP service's operating-system UID, permissions or sandbox.
