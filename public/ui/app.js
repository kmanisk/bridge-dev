"use strict";
// All untrusted values enter the document through textContent or form values.
// Credentials and theme are deliberately never stored in browser storage.
const $ = (id) => document.getElementById(id),
  screen = $("screen");
const sections = [
  "overview",
  "monitor",
  "marketplace",
  "custom",
  "extensions",
  "skills",
  "instructions",
  "packs",
  "approvals",
  "audit",
  "connection",
  "settings",
  "security",
];
let adminSessionReady = false;
let section = "overview",
  health = {},
  extensions = {},
  auditOffset = 0,
  sorts = new Map(),
  pendingGo = 0;
function el(tag, text, attrs = {}) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = String(text);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else n.setAttribute(k, String(v));
  }
  return n;
}
function showError(error) {
  $("notice").textContent = error.message || String(error);
  $("notice").className = "error";
}
function notice(text) {
  $("notice").textContent = text;
  $("notice").className = "";
}
async function api(url, body, method) {
  const token = $("admin-credential").value.trim(); // optional manual fallback only
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const r = await fetch(url, {
    method: method || (body === undefined ? "GET" : "POST"),
    cache: "no-store",
    credentials: "same-origin",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await r.json();
  if (!r.ok) {
    const error = new Error(data.error || `HTTP ${r.status}`);
    error.status = r.status;
    throw error;
  }
  return data.ok && Object.prototype.hasOwnProperty.call(data, "data")
    ? data.data
    : data;
}
function action(text, fn, attrs = {}) {
  const b = el("button", text, { type: "button", ...attrs });
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await fn();
    } catch (e) {
      showError(e);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}
function pre(value) {
  return el(
    "pre",
    typeof value === "string" ? value : JSON.stringify(value, null, 2),
  );
}
function heading(title, parent = screen) {
  parent.append(el("h2", title));
}
function details(title, ...nodes) {
  $("detail-title").textContent = title;
  $("detail-body").replaceChildren(...nodes);
  if (!$("detail").open) $("detail").showModal();
}
function pairs(values, parent = screen) {
  const dl = el("dl");
  for (const [k, v] of Object.entries(values)) {
    dl.append(
      el("dt", k),
      el(
        "dd",
        typeof v === "object" && v !== null
          ? JSON.stringify(v)
          : (v ?? "unavailable"),
      ),
    );
  }
  parent.append(dl);
}
function table(headers, rows, name = "table", parent = screen) {
  if (!rows.length) {
    parent.append(el("p", "No entries.", { class: "empty" }));
    return;
  }
  const wrapper = el("div", undefined, {
      class: "scroll",
      tabindex: "0",
      "aria-label": name,
    }),
    t = el("table"),
    head = el("thead"),
    hr = el("tr"),
    body = el("tbody");
  let sorted = [...rows];
  const ordering = sorts.get(name);
  if (ordering)
    sorted.sort(
      (a, b) =>
        String(
          a[ordering.col]?.textContent ?? a[ordering.col] ?? "",
        ).localeCompare(
          String(b[ordering.col]?.textContent ?? b[ordering.col] ?? ""),
          undefined,
          { numeric: true },
        ) * ordering.direction,
    );
  headers.forEach((h, i) => {
    const th = el("th", undefined, { scope: "col" });
    th.append(
      action(h, () => {
        const old = sorts.get(name);
        sorts.set(name, {
          col: i,
          direction: old?.col === i ? -old.direction : 1,
        });
        wrapper.remove();
        table(headers, rows, name, parent);
      }),
    );
    hr.append(th);
  });
  head.append(hr);
  for (const row of sorted) {
    const tr = el("tr");
    for (const value of row) {
      const td = el("td");
      value instanceof Node
        ? td.append(value)
        : (td.textContent = String(value ?? "—"));
      tr.append(td);
    }
    tr.dataset.filter = tr.textContent.toLowerCase();
    tr.hidden = !tr.dataset.filter.includes($("filter").value.toLowerCase());
    body.append(tr);
  }
  t.append(head, body);
  wrapper.append(t);
  parent.append(wrapper);
}
function controls(...buttons) {
  const n = el("div", undefined, { class: "actions" });
  n.append(...buttons);
  return n;
}
function state(value) {
  return value ? "yes" : "no";
}
function showPairingRequired() {
  // An expired/revoked browser cookie is not evidence that the host's Admin
  // token is invalid. Never attempt an unauthenticated localhost token bootstrap.
  adminSessionReady = false;
  $("admin-credential").value = "";
  health = {};
  extensions = {};
  section = "security";
  stopActivity();
  $("security-panel").hidden = false;
  $("title").textContent = "Access & Security";
  $("section-filter-toolbar").hidden = true;
  $("filter").value = "";
  document.querySelectorAll("nav button").forEach((button) => {
    if (button.dataset.tab === "security") button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  screen.replaceChildren(
    el("h2", "Local Admin session needs pairing"),
    el("p", "The running gateway is not necessarily offline. Your browser session may have expired or been invalidated by Admin-token rotation."),
    el("p", "In your private local terminal, run:"),
    pre("bridge-dev dashboard"),
    el("p", "This opens a one-use, 60-second signed pairing link without typing or displaying the long-lived Admin token. If this CLI is older, run bridge-dev access and open its local pairing link instead."),
  );
  notice("Re-pair this browser locally to restore the dashboard.");
}
async function refreshAll() {
  try {
    health = await api("/health");
    adminSessionReady = true;
    extensions = await api("/api/extensions");
    await render();
    if ($("notice").className === "error" || $("notice").textContent.includes("Open the short-lived pairing link")) notice("");
    $("sync-status").textContent = "Updated " + new Date().toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}) + " · manual";
  } catch (e) {
    adminSessionReady = false;
    $("sync-status").textContent = e.status === 401 ? "Re-pair required" : "Refresh failed";
    if (e.status === 401) showPairingRequired();
    else showError(e);
  }
}
async function navigate(name) {
  stopActivity();
  section = name;
  notice("");
  $("security-panel").hidden = name !== "security";
  $("title").textContent = name[0].toUpperCase() + name.slice(1);
  const filterable = new Set([
    "extensions",
    "skills",
    "instructions",
    "packs",
    "approvals",
    "audit",
  ]);
  $("section-filter-toolbar").hidden = !filterable.has(name);
  $("filter").value = "";
  document.querySelectorAll("nav button").forEach((b) => {
    if (b.dataset.tab === name) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  await refreshAll();
}
function addFlow(kind) {
  const form = el("form", undefined, { class: "add marketplace-add-card", id: "add-flow" }),
    title = el("h3", "Add Custom GitHub Repo, Skill .md, or MCP Server"),
    sub = el("p", "Type or paste any GitHub URL (e.g. https://github.com/morluto/rea), local directory/file path, or NPM package."),
    chips = el("div", undefined, { class: "chip-row" }),
    chipList = [
      { label: "GitHub Repo", val: "https://github.com/" },
      { label: "Local Skill / .md", val: "" },
      { label: "NPM MCP Server", val: "npm:@modelcontextprotocol/server-" },
    ],
    row = el("div", undefined, { class: "actions" }),
    label = el("label", "Source", { for: "extension-source" }),
    input = el("input", undefined, {
      id: "extension-source",
      placeholder: "HTTPS URL, package or local path",
      required: "",
    }),
    scope = el("select", undefined, { "aria-label": "Install scope" });
  for (const s of ["project", "user"])
    scope.append(el("option", s, { value: s }));
  const b = el("button", "Detect", { id: "extension-discover" }),
    out = el("div", undefined, { id: "extension-preview" });

  for (const c of chipList) {
    const chipBtn = el("button", c.label, { type: "button", class: "chip-btn", "aria-label": "Quick template: " + c.label });
    chipBtn.addEventListener("click", () => {
      input.value = c.val;
      input.focus();
    });
    chips.append(chipBtn);
  }

  row.append(label, input, scope, b);
  form.append(title, sub, chips, row, out);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    b.disabled = true;
    try {
      const r = await api("/api/extensions/discover", {
        source: input.value,
        scope: scope.value,
      });
      out.replaceChildren();
      await discovered(r, out, input.value, scope.value, kind);
    } catch (error) {
      out.replaceChildren(pre(error.message));
    } finally {
      b.disabled = false;
    }
  });
  screen.append(form);
}
async function discovered(data, parent, source, scope, kind) {
  if (data.id) {
    parent.append(
      pre({
        action: data.action,
        scope: data.scope,
        selection: data.selection,
        source: data.discovery?.source,
        resolved: data.discovery?.resolved,
        digest: data.discovery?.digest,
        permissions: data.discovery?.components?.map((c) => ({
          component: c.id,
          requirements: c.requirements,
          permissions: c.permissions,
          provider: c.provider,
        })),
        diff: data,
      }),
    );
    parent.append(
      controls(
        action("Request operator approval", async () => {
          await navigate("approvals");
          notice("Exact proposal saved. Review and confirm in Approvals.");
        }),
        action("Install & Enable Now", async () => {
          try {
            await api("/api/extensions/apply", { id: data.id });
            notice("Extension applied and active.");
            await refreshAll();
          } catch (e) {
            notice("Approval error: " + e.message);
          }
        }),
      ),
    );
    return;
  }
  const inputs = [];
  parent.append(
    el("p", "Select components. Detection never executes repository commands."),
  );
  for (const c of data.components || []) {
    const check = el("input", undefined, {
      type: "checkbox",
      value: c.kind + ":" + c.id,
    });
    check.checked = !kind || c.kind === kind;
    const label = el("label", undefined, { class: "field" });
    label.append(check, el("span", c.kind + ":" + c.id));
    parent.append(
      label,
      pre({
        requirements: c.requirements,
        permissions: c.permissions,
        description: c.description,
      }),
    );
    inputs.push(check);
  }
  parent.append(
    action("Preview selection", async () => {
      const r = await api("/api/extensions/discover", {
        source,
        scope,
        selection: inputs.filter((i) => i.checked).map((i) => i.value),
      });
      parent.replaceChildren();
      await discovered(r, parent, source, scope, kind);
    }),
  );
}
async function render() {
  screen.replaceChildren();
  if (section === "marketplace") return marketplaceView();
  if (section === "custom") return customView();
  if (section === "overview") return overview();
  if (section === "monitor") return monitorPage();
  if (section === "extensions") return providers();
  if (["skills", "instructions", "packs"].includes(section)) return contents();
  if (section === "approvals") return approvals();
  if (section === "audit") return audit();
  if (section === "connection") return connection();
  if (section === "settings") return settings();
  if (section === "security") return securityPage();
}
function securityPage() {
  heading("Admin session");
  screen.append(
    el("p", adminSessionReady
      ? "Authenticated locally. Your session cookie is HttpOnly and survives page reloads and gateway restarts. It expires after 7 days or when the Admin token is rotated."
      : "Not authenticated. Run bridge-dev access in a private terminal and open its one-use dashboard pairing link."),
    el("p", "Disconnect clears the browser cookie. Credentials and signed operator modes are managed separately."),
  );
}

async function monitorPage() {
  heading("Activity monitor");
  pairs({
    "Gateway": health.status || "unavailable",
    "Policy": health.policy_mode || "unavailable",
    "Full machine access": state(health.full_machine_access),
    "MCP sessions": health.active_sessions ?? "unknown",
    "Running PID": health.pid ?? "unknown",
    "Current release": health.commit || "unknown",
  });
  screen.append(
    el("p","On-demand monitoring only. Live streaming starts only when you choose it and pauses when the tab is hidden."),
    controls(
      action("Open live activity & history", activityDialog),
      action("Refresh monitor", async () => await refreshAll()),
      action("View durable audit", async () => await navigate("audit")),
    ),
  );
  heading("Recent tool calls");
  const activity=await api("/api/activity?limit=30");
  const items=Array.isArray(activity.entries)?activity.entries:[];
  table(
    ["Time","Type","Tool / event","Status","Summary"],
    items.map(a=>[a.time||"",a.kind||"",a.tool||a.action||"",a.status||"",
      a.summary||a.target||""]),
    "Recent BridgeDev activity",
  );
  heading("Optional desktop shortcut");
  screen.append(
    el("p","Use bridge-dev monitor to launch the installed local Sway scratchpad/TUI, or open this localhost dashboard on other desktops. You may bind any unused shortcut in your own window manager."),
    pre("bridge-dev monitor\nbridge-dev monitor shortcut --key Mod4+Mod1+d --install-desktop\nbridge-dev update --check"),
    el("p","Shortcut registration is optional; it never modifies Sway configuration or installs a persistent daemon."),
  );
}

async function overview() {
  const [service, audit, queue] = await Promise.all([
    api("/api/service/status"),
    api("/api/audit?limit=1"),
    api("/api/extensions/proposals"),
  ]);
  pairs({
    Gateway: "● " + health.status,
    Version: health.version,
    Commit: health.commit || "unmarked source build",
    Runtime: health.runtime_mode,
    Policy: health.policy_mode,
    "Full Machine Access": state(health.full_machine_access),
    "Uptime (seconds)": health.uptime_seconds,
    Service: service.unit
      ? service.unit + " / " + service.state
      : "foreground or transient",
    "Service restarts": service.restarts ?? "unavailable",
    "MCP listener": "127.0.0.1:" + health.mcp_port,
    "Admin listener": location.host + " (local only)",
    "Public exposure": health.public_url || "none detected",
    "MCP connections": health.active_sessions,
    Audit: audit.integrity.entries + " entries / verified",
    "Rollback release": service.previous || "none recorded",
    Workspace: health.default_cwd,
  });
  heading("Pending approvals");
  screen.append(
    el(
      "p",
      `${queue.proposals.length} reviewed proposals; ${queue.requests.length} model requests.`,
    ),
    action("Open approvals", () => navigate("approvals")),
  );
  heading("Software update");
  const updateResult = el("div", undefined, { id: "main-update-result", "aria-live": "polite" });
  screen.append(
    el("p", "Checks are manual. No scheduled update service, polling or automatic root-capable deployment."),
    controls(
      action("Check GitHub main", async () => {
        updateResult.replaceChildren(el("p", "Checking GitHub main…"));
        const result = await api("/api/update/check");
        const status = result.update_available === true ? "Update available" :
          result.update_available === false ? "Up to date" : "Installed commit unknown";
        updateResult.replaceChildren(
          el("p", status),
          pre({
            installed: result.installed_commit || "unknown",
            main: result.main_commit,
            checked_at: result.checked_at,
            command: result.update_available ? "bridge-dev update" : "No update required",
          }),
        );
      }),
    ),
    updateResult,
    el("p", "Run bridge-dev update from your local terminal. With an active indefinite YOLO lease, the CLI verifies and stages first, coordinates temporary STANDARD acceptance, tracks the deployment job and asks for independent local confirmation before restoring YOLO. On failure it stays STANDARD. No manual mode-switch commands needed."),
  );
}
async function customView() {
  const data = await api("/api/custom/resources");
  const skills = Array.isArray(data.skills) ? data.skills : [];
  heading("Personal resources");
  screen.append(el("p", "Local skills discovered from this account's .agents/skills directory. These are not public Marketplace listings, verified installations, or enabled tools. Discovery is read-only."));
  const summary = el("div", undefined, {class:"catalog-summary"});
  summary.append(el("strong", skills.length + " local skills found"), el("span", "Only visible to the authenticated local operator"));
  screen.append(summary);
  const grid = el("div", undefined, {class:"catalog-grid"});
  for (const skill of skills) {
    const registered = (extensions.entries || []).find((entry) => entry.component?.kind === "skill" &&
      (entry.component.id === skill.id || entry.source === skill.source));
    const card = el("article", undefined, {class:"catalog-card"});
    const top = el("div", undefined, {class:"catalog-card-top"});
    top.append(el("span", "LOCAL SKILL", {class:"catalog-type"}),
      el("span", registered ? (registered.enabled ? "Enabled" : "Registered") : "Detected only", {class:"catalog-state"}));
    const title = el("h3", skill.name);
    const description = el("p", skill.description || "Locally maintained SKILL.md resource", {class:"catalog-description"});
    const source = el("p", skill.source, {class:"catalog-meta"});
    const footer = el("div", undefined, {class:"catalog-card-footer"});
    footer.append(action("Inspect", () => details(skill.name, pre({source:skill.source, registered:!!registered,
      enabled:registered?.enabled || false, kind:"local skill"}))));
    if (!registered) footer.append(action("Review import", async () => {
      const proposal = await api("/api/extensions/discover", {source:skill.source,scope:"user"});
      details("Import proposal: " + skill.name, pre(proposal),
        action("Open approvals", () => { $("detail").close(); return navigate("approvals"); }));
    }));
    card.append(top, title, description, source, footer);
    grid.append(card);
  }
  if (!skills.length) grid.append(el("p", "No local SKILL.md directories found. You can still add sources manually below.", {class:"empty"}));
  screen.append(grid);
  heading("Add your own resource");
  addFlow("skill");
}

async function providers() {
  heading("Extensions Store & MCP Providers");
  screen.append(el("p", "Browse the portable, reviewed catalog in Marketplace. Personal-machine skills belong in Custom."), controls(action("Browse Marketplace", () => navigate("marketplace")), action("Open Custom", () => navigate("custom"))));
  heading("Custom GitHub Repo, Local Skill, or NPM MCP Server");
  addFlow("mcp");
  heading("Configured Providers & Upstreams");
  const installed = new Set(
    (extensions.entries || [])
      .filter((e) => e.component.kind === "mcp")
      .map((e) => e.component.id),
  );
  table(
    [
      "Name",
      "Source",
      "Version / commit",
      "Installed",
      "Registered",
      "Enabled",
      "Connected",
      "Exposed",
      "Details",
    ],
    (extensions.providers || []).map((p) => {
      const entry = extensions.entries?.find((e) => e.component.id === p.id);
      return [
        p.name || p.id,
        entry?.source || p.url || p.transport,
        entry?.resolved || "registered endpoint",
        state(installed.has(p.id)),
        "yes",
        state(p.enabled),
        state(p.health === "connected"),
        p.proxied_tools?.length || 0,
        action("Inspect", () => providerDetails(p)),
      ];
    }),
    "MCP providers",
  );
  heading("Configuration import");
  screen.append(
    el(
      "p",
      "Cursor, Claude Code, OpenCode and compatible JSON files. Imported executables stay disabled until reviewed.",
    ),
  );
  const source = el("select", undefined, { "aria-label": "Import format" });
  for (const type of ["cursor", "claude", "opencode", "file"])
    source.append(el("option", type, { value: type }));
  const file = el("input", undefined, {
    placeholder: "Optional configuration path",
    "aria-label": "Import path",
  });
  screen.append(
    controls(
      source,
      file,
      action("Inspect available sources", async () =>
        details(
          "Detected configuration files",
          pre(await api("/api/import/sources")),
        ),
      ),
      action("Import disabled providers", async () => {
        if (
          !confirm(
            "Import these provider definitions as disabled? Existing provider permissions remain unchanged.",
          )
        )
          return;
        const r = await api("/api/import/" + source.value, {
          ...(file.value ? { path: file.value } : {}),
          enable: false,
          merge: true,
        });
        details("Import result", pre(r));
        await refreshAll();
      }),
    ),
  );
  screen.append(
    action("Advanced provider definition", () =>
      jsonEditor(
        "Provider definition",
        "/api/upstream",
        "server",
        "POST",
        {
          id: "",
          name: "",
          transport: "stdio",
          command: "",
          args: [],
          enabled: false,
          expose: "none",
        },
        true,
      ),
    ),
  );
}
async function providerDetails(p) {
  const [tools, configuration] = await Promise.all([
    api("/api/extensions/provider-tools?name=" + encodeURIComponent(p.id)),
    api("/api/upstream"),
  ]);
  const reviewed =
      configuration.config.servers.find((server) => server.id === p.id) || {},
    content = el("div");
  pairs(
    {
      Provider: p.id,
      Transport: p.transport,
      Health: p.health,
      "Last error": p.last_error || "none",
      Origin: "Untrusted provider metadata",
    },
    content,
  );
  content.append(pre(p));
  if (tools.rejected?.length) {
    heading("Unsupported tools (not exposed)", content);
    content.append(pre(tools.rejected));
  }
  const allow = [];
  heading("Tool permissions", content);
  content.append(el("p", "Review the complete compatible tool set once. Your selection stays pinned across restarts and updates. New or incompatible tools require another review; newly included tools default to approval-required X unless already classified."));
  for (const tool of tools.tools || []) {
    const label = el("label", undefined, { class: "field" }),
      check = el("input", undefined, { type: "checkbox", value: tool.name });
    check.checked = (reviewed.tools || []).includes(tool.name);
    label.append(
      check,
      el("span", tool.name + " — " + (tool.description || "")),
    );
    content.append(label);
    allow.push(check);
  }
  const permission = el("select", undefined, {
    "aria-label": "Granted tool permission",
  });
  permission.append(el("option", "Preserve reviewed classes", { value: "" }));
  for (const v of ["R", "W", "X"])
    permission.append(el("option", v, { value: v }));
  permission.value = "";
  content.append(
    controls(
      permission,
      action("Select all compatible", () => {
        for(const box of allow) box.checked = true;
      }),
      action("Preview full provider access", async () => {
        if (!tools.tools?.length) {
          throw Error("No validated tools are cached. Use Test connection first, then reopen these details.");
        }
        if (!confirm(`Review all ${tools.tools.length} schema-valid tools from ${p.id}? This includes tools that may write files or execute commands. The unvalidated ${tools.rejected?.length || 0} tools are excluded. Operator approval is required.`)) return;
        const proposal = await api("/api/extensions/provider-review", {
          name: p.id,
          enabled: true,
          all_tools: true,
        });
        details("Full tool-access proposal", pre(proposal),
          action("Open approvals", () => { $("detail").close(); return navigate("approvals"); }));
      }),
      action("Preview allowlist", async () => {
        const proposal = await api("/api/extensions/provider-review", {
          name: p.id,
          enabled: Boolean(p.enabled),
          tools: allow.filter((x) => x.checked).map((x) => x.value),
          ...(permission.value ? { permission: permission.value } : {}),
        });
        details(
          "Permission proposal",
          pre(proposal),
          action("Open approvals", () => {
            $("detail").close();
            return navigate("approvals");
          }),
        );
      }),
      action(p.enabled ? "Preview disable" : "Preview enable", async () => {
        const firstEnableAll = !p.enabled && !(reviewed.tools || []).length;
        if (firstEnableAll && !tools.tools?.length) {
          throw Error("Test the provider first so BridgeDev can review its full validated tool inventory.");
        }
        if (firstEnableAll && !confirm(`Enable all ${tools.tools.length} validated tools from ${p.id}? Tools may modify data or execute commands; independent approval is still required.`)) return;
        const proposal = await api("/api/extensions/provider-review", {
          name: p.id,
          enabled: !p.enabled,
          ...(firstEnableAll ? { all_tools: true } : {}),
        });
        details(
          "Lifecycle proposal",
          pre(proposal),
          action("Open approvals", () => {
            $("detail").close();
            return navigate("approvals");
          }),
        );
      }),
      action("Test connection", async () => {
        if (
          !confirm(
            "Connect to this reviewed provider? This can start its configured executable.",
          )
        )
          return;
        details(
          "Provider test",
          pre(await api("/api/extensions/provider-test", { name: p.id })),
        );
      }),
      action("Logs", async () =>
        details(
          "Provider logs",
          pre(
            await api(
              "/api/extensions/provider-logs?name=" + encodeURIComponent(p.id),
            ),
          ),
        ),
      ),
      action("Edit definition", async () => {
        const cfg = await api("/api/upstream");
        const server = cfg.config.servers.find((s) => s.id === p.id);
        await jsonEditor(
          "Provider definition",
          "/api/upstream",
          "server",
          "POST",
          server,
          true,
        );
      }),
    ),
  );
  if (p.transport === "http")
    content.append(
      controls(
        action("OAuth status", async () =>
          details(
            "OAuth status",
            pre(
              await api(
                "/api/upstream/" + encodeURIComponent(p.id) + "/oauth/status",
              ),
            ),
          ),
        ),
        action("Start OAuth", async () => {
          if (!confirm("Start this provider’s OAuth flow?")) return;
          const r = await api(
            "/api/upstream/" + encodeURIComponent(p.id) + "/oauth/start",
            { reset: true },
          );
          const url = r.status?.authorization_url;
          if (url && /^https?:/.test(url)) {
            const a = el("a", "Open provider authorization", {
              href: url,
              target: "_blank",
              rel: "noopener noreferrer",
            });
            details("OAuth authorization", a);
          } else details("OAuth status", pre(r));
        }),
        action("Disconnect OAuth", async () => {
          if (confirm("Disconnect provider authorization?"))
            details(
              "OAuth disconnected",
              pre(
                await api(
                  "/api/upstream/" +
                    encodeURIComponent(p.id) +
                    "/oauth/disconnect",
                  {},
                ),
              ),
            );
        }),
      ),
    );
  const entry = extensions.entries?.find((e) => e.key === "mcp:" + p.id);
  if (entry) content.append(controls(...entryActions(entry)));
  else
    content.append(
      action("Remove registered provider", async () => {
        const proposal = await api("/api/extensions/provider-remove", {
          name: p.id,
        });
        details(
          "Removal proposal",
          pre(proposal),
          action("Open approvals", () => {
            $("detail").close();
            return navigate("approvals");
          }),
        );
      }),
    );
  details("Provider: " + p.id, content);
}
function entryActions(e) {
  return ["update", e.enabled ? "disable" : "enable", "remove"].map((name) =>
    action("Preview " + name, async () => {
      const p = await api("/api/extensions/action", {
        action: name,
        key: e.key,
        scope: e.scope,
      });
      details(
        "Extension proposal",
        pre(p),
        action("Open approvals", () => {
          $("detail").close();
          return navigate("approvals");
        }),
      );
    }),
  );
}
async function contents() {
  const kind = { skills: "skill", instructions: "instructions", packs: "pack" }[
    section
  ];
  addFlow(kind);
  const entries = (extensions.entries || []).filter(
    (e) => e.component.kind === kind,
  );
  const validations =
    kind === "skill" ? await api("/api/extensions/validate") : null;
  table(
    [
      "Name",
      "Source",
      "Version / commit",
      "Scope",
      "Enabled",
      "Validation",
      "Details",
    ],
    entries.map((e) => [
      e.component.id,
      e.source,
      e.resolved,
      e.scope + (e.overrides_user ? " (overrides user)" : ""),
      state(e.enabled),
      validations?.results?.find((v) => v.key === e.key)?.valid === false
        ? "invalid"
        : kind === "skill"
          ? "valid"
          : "reviewed content",
      action("Inspect", async () => {
        const content = el("div");
        content.append(
          el(
            "p",
            "Untrusted guidance. Content is displayed as plain text; it cannot grant permissions.",
          ),
        );
        pairs(
          {
            Source: e.source,
            Resolved: e.resolved,
            Digest: e.digest,
            Scope: e.scope,
          },
          content,
        );
        for (const [name, text] of Object.entries(e.component.files || {})) {
          heading(name, content);
          content.append(pre(text));
        }
        content.append(controls(...entryActions(e)));
        details(e.key, content);
      }),
    ]),
    section,
  );
  if (section === "instructions") {
    heading("Project context");
    screen.append(
      action("Load instruction snapshot", async () => {
        const r = await api("/api/instructions/preview");
        details("Project context", pre(r.summary), pre(r.preview));
      }),
    );
  }
}
async function approvals() {
  const r = await api("/api/extensions/proposals");
  screen.append(el("p", r.native_approvals));
  heading("Model requests");
  table(
    ["Created", "Action", "Source / key", "Review"],
    r.requests.map((q) => [
      new Date(q.created_at).toISOString(),
      q.action,
      q.source || q.key,
      action("Inspect and prepare", async () => {
        const p = await api("/api/extensions/review", { id: q.id });
        details(
          "Request review",
          pre(p),
          action("Refresh approvals", () => {
            $("detail").close();
            return refreshAll();
          }),
        );
      }),
    ]),
    "Model requests",
  );
  heading("Operator proposals");
  table(
    ["Created", "Action", "Scope", "Source / key", "Decision"],
    r.proposals.map((p) => [
      new Date(p.created_at).toISOString(),
      p.action,
      p.scope,
      p.discovery?.source || p.key,
      action("Review exact proposal", () => {
        const content = el("div");
        content.append(
          pre(p),
          controls(
            action(
              "Approve and apply",
              async () => {
                if (
                  !confirm(
                    "Apply this exact proposal? Executable providers require separately reviewed enablement and tool permissions.",
                  )
                )
                  return;
                await api("/api/extensions/apply", { id: p.id });
                $("detail").close();
                await refreshAll();
                notice("Applied reviewed proposal.");
              },
              { id: "extension-approve" },
            ),
            action("Reject", async () => {
              if (!confirm("Reject this proposal?")) return;
              await api("/api/extensions/reject", { id: p.id });
              $("detail").close();
              await refreshAll();
            }),
          ),
        );
        details("Operator approval", content);
      }),
    ]),
    "Operator proposals",
  );
}
async function audit() {
  const r = await api(
    "/api/audit?offset=" +
      auditOffset +
      "&filter=" +
      encodeURIComponent($("filter").value),
  );
  pairs({
    Integrity: r.integrity.ok ? "verified" : "FAILED",
    Entries: r.integrity.entries,
    Showing: `${r.offset + 1}–${Math.min(r.offset + r.limit, r.total)} of ${r.total}`,
  });
  screen.append(
    controls(
      action("Previous", async () => {
        auditOffset = Math.max(0, auditOffset - 50);
        await render();
      }),
      action("Next", async () => {
        auditOffset = Math.min(Math.max(0, r.total - 1), auditOffset + 50);
        await render();
      }),
      action("Filter ledger", () => {
        auditOffset = 0;
        return render();
      }),
    ),
  );
  table(
    ["Time", "Actor / session", "Action", "Outcome", "Details"],
    r.entries.map((e) => [
      e.time,
      e.actor || e.session || "gateway",
      e.phase || e.tool || "event",
      e.outcome || e.status || e.decision || "recorded",
      action("Inspect redacted record", () => details("Audit record", pre(e))),
    ]),
    "Audit records",
  );
  heading("Runtime activity");
  screen.append(action("Load activity and history", activityDialog));
}
let activityAbort = null,
  activityWanted = false,
  activityResume = null;
function stopActivity() {
  activityWanted = false;
  activityAbort?.abort();
  activityAbort = null;
  activityResume = null;
}
async function activityDialog() {
  const content = el("div"),
    kind = el("select", undefined, { "aria-label": "Activity kind" }),
    status = el("select", undefined, { "aria-label": "Activity status" }),
    search = el("input", undefined, {
      "aria-label": "Activity search",
      placeholder: "Tool or text",
    }),
    view = el("div");
  for (const value of ["all", "tool", "mcp", "session", "system"])
    kind.append(el("option", value, { value }));
  for (const value of ["all", "ok", "error", "blocked"])
    status.append(el("option", value, { value }));
  let rows = [];
  const render = () => {
    view.replaceChildren();
    table(
      ["Time", "Kind", "Tool / action", "Status", "Summary"],
      rows
        .filter(
          (r) =>
            (kind.value === "all" || r.kind === kind.value) &&
            (status.value === "all" || r.status === status.value) &&
            JSON.stringify(r)
              .toLowerCase()
              .includes(search.value.toLowerCase()),
        )
        .map((r) => [
          r.time,
          r.kind,
          r.tool || r.action,
          r.status,
          r.summary || r.target || "",
        ]),
      "Runtime activity",
      view,
    );
  };
  const live = action(
    "Live: off",
    () => {
      if (activityWanted) {
        stopActivity();
        live.textContent = "Live: off";
        return;
      }
      activityWanted = true;
      live.textContent = "Live: on";
      activityResume = start;
      start();
    },
    { id: "activity-live" },
  );
  const start = () => {
    if (document.visibilityState === "hidden" || !activityWanted) return;
    activityAbort?.abort();
    const controller = new AbortController();
    activityAbort = controller;
    void (async () => {
      try {
        const fallback = $("admin-credential").value.trim();
        const response = await fetch("/api/activity/stream", {
          credentials: "same-origin",
          headers: fallback ? { Authorization: "Bearer " + fallback } : {},
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw Error("Activity stream refused");
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        let pending = "";
        while (!controller.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          pending += decoder.decode(chunk.value, { stream: true });
          if (pending.length > 131072) throw Error("Activity event size limit");
          let end;
          while ((end = pending.indexOf("\n\n")) >= 0) {
            const frame = pending.slice(0, end);
            pending = pending.slice(end + 2);
            if (frame.startsWith("data: ")) {
              rows = [JSON.parse(frame.slice(6)), ...rows].slice(0, 100);
              render();
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) showError(error);
      }
    })();
  };
  for (const field of [kind, status, search])
    field.addEventListener("input", render);
  content.append(
    controls(
      kind,
      status,
      search,
      action("Refresh activity", async () => {
        rows = (await api("/api/activity?limit=100")).entries;
        render();
      }),
      live,
      action("Load durable history", async () => {
        rows = (await api("/api/activity/history?limit=100")).entries;
        render();
      }),
      action("Clear this view", () => {
        rows = [];
        render();
      }),
    ),
    el(
      "p",
      "Live is opt-in and pauses while hidden. Clearing this view does not change the ledger.",
    ),
    view,
  );
  details("Runtime activity", content);
  rows = (await api("/api/activity?limit=100")).entries;
  render();
}
async function connection() {
  heading("Curated Tailscale Connection for ChatGPT Web");
  screen.append(
    el(
      "p",
      "Everything is pre-configured and curated on your Tailscale Funnel. ChatGPT connects directly through this URL without extra configuration.",
    ),
  );

  const card = el("div", undefined, { class: "marketplace-add-card" });
  card.append(
    el("h3", "Curated Tailscale Connection"),
    el(
      "p",
      "Click the button below to copy the complete connection link. In ChatGPT Web, choose 'Server URL' and set Authentication to 'None'.",
    ),
  );

  const input = el("input", undefined, {
    id: "connection-url",
    readonly: "",
    "aria-label": "Connection URL",
  });
  input.value =
    (health.public_url || "http://127.0.0.1:" + health.mcp_port) + "/mcp";

  const copyFullBtn = el("button", "Copy Full ChatGPT Connection URL", {
    type: "button",
    class: "market-action-btn btn-install",
    "aria-label": "Copy Full ChatGPT Connection URL",
  });
  copyFullBtn.addEventListener("click", async () => {
    try {
      copyFullBtn.disabled = true;
      const r = await api("/api/access");
      const fullUrl = (health.public_url || "http://127.0.0.1:" + health.mcp_port) + "/mcp/" + r.mcp_token;
      input.value = fullUrl;
      input.setAttribute("aria-label", "Connection URL with revealed credential");
      await navigator.clipboard.writeText(fullUrl);
      notice("Copied full Tailscale ChatGPT connection URL to clipboard.");
    } catch (e) {
      showError(e);
    } finally {
      copyFullBtn.disabled = false;
    }
  });

  card.append(input, controls(
    copyFullBtn,
    action("Reveal URL credential", async () => {
      const r = await api("/api/access");
      input.value =
        (health.public_url || "http://127.0.0.1:" + health.mcp_port) +
        "/mcp/" +
        r.mcp_token;
      input.setAttribute(
        "aria-label",
        "Connection URL with revealed credential",
      );
    }),
    action("Hide credential", () => {
      input.value =
        (health.public_url || "http://127.0.0.1:" + health.mcp_port) + "/mcp";
    }),
    action("Copy displayed URL", () =>
      navigator.clipboard.writeText(input.value),
    ),
  ));
  screen.append(card);

  pairs({
    "MCP endpoint":
      (health.public_url || "http://127.0.0.1:" + health.mcp_port) + "/mcp",
    "Admin UI": location.origin + "/ui/",
    Authentication: "Independent MCP bearer credential or explicit URL token",
    Exposure:
      "Funnel configuration is unchanged by service commands. A stopped gateway yields public upstream errors.",
  });
  heading("Acceptance in a new chat");
  screen.append(
    pre(
      '1. Check the tool list.\n2. system_context({docs:["agents","current_state"]})\n3. run_command({command:"pwd"})\n4. mcp_list({})\n5. skills_validate({})',
    ),
  );
}
async function jsonEditor(
  title,
  url,
  key,
  method = "PUT",
  initial,
  forceDisabled = false,
) {
  const r = initial === undefined ? await api(url) : null;
  let value = initial ?? r[key];
  if (key === "values")
    value = Object.fromEntries(
      Object.entries(value || {}).filter(([key]) =>
        [
          "CHATGPT_TOOL_PROFILE",
          "SHELL_TIMEOUT",
          "CHECKPOINT_ENABLED",
        ].includes(key),
      ),
    );
  const text = el("textarea", undefined, {
    "aria-label": title + " JSON",
    spellcheck: "false",
  });
  text.value = JSON.stringify(value, null, 2);
  const preview = el("div"),
    content = el("div");
  content.append(
    el(
      "p",
      "Validate and review the exact diff before applying. Protected authentication, policy and signing settings require an offline operator change.",
    ),
    text,
    action("Preview changes", () => {
      const next = JSON.parse(text.value);
      if (!next || typeof next !== "object" || Array.isArray(next))
        throw Error("Expected a JSON object.");
      if (forceDisabled) {
        next.enabled = false;
        next.expose = "none";
        if (JSON.stringify(next).includes("[REDACTED]"))
          throw Error(
            "Redacted credentials cannot be resubmitted. Use the protected operator configuration.",
          );
      }
      preview.replaceChildren(
        pre({ before: value, after: next }),
        action("Confirm and apply", async () => {
          if (!confirm("Apply these exact reviewed settings?")) return;
          const result = await api(url, { [key]: next }, method);
          details("Settings result", pre(result));
        }),
      );
    }),
    preview,
  );
  details(title, content);
}
async function settings() {
  const service = await api("/api/service/status");
  heading("Service (read only)");
  pairs({
    Unit: service.unit || "not installed",
    State: service.state || "unmanaged",
    Commit: service.current || health.commit,
    Restarts: service.restarts ?? "unavailable",
    Linger: service.linger_status || "unavailable",
    Rollback: service.previous || "none",
  });
  screen.append(
    pre(
      "bridge-dev service status\nbridge-dev service restart\nbridge-dev service update <sha-or-tag>\nbridge-dev service rollback",
    ),
  );
  heading("Configuration");
  screen.append(
    controls(
      action("Safe environment settings", () =>
        jsonEditor("Environment settings", "/api/config/env", "values"),
      ),
      action("Local tool visibility", () =>
        jsonEditor("Local tools", "/api/local-tools", "overrides"),
      ),
      action("Computer use plugin", async () => {
        const r = await api("/api/plugins");
        if (!r.available.computer_use) {
          details("Computer use", el("p", "Unsupported on this platform."));
          return;
        }
        return jsonEditor("Computer use plugin", "/api/plugins", "config");
      }),
      action("Trusted Codex hooks", async () => {
        const r = await api("/api/codex-hooks"),
          container = el("div"),
          checks = [];
        for (const hook of r.hooks) {
          const label = el("label", undefined, { class: "field" }),
            check = el("input", undefined, {
              type: "checkbox",
              value: hook.id,
            });
          check.checked = hook.enabled;
          check.disabled = !hook.supported;
          label.append(
            check,
            el("span", hook.plugin + " / " + hook.event + " / " + hook.command),
          );
          container.append(label);
          checks.push(check);
        }
        container.append(
          action("Preview hook selection", () => {
            const enabled = checks.filter((c) => c.checked).map((c) => c.value);
            details(
              "Hook preview",
              pre({ enabled }),
              action("Confirm hook selection", async () => {
                if (confirm("Enable this exact trusted hook selection?"))
                  details(
                    "Hooks saved",
                    pre(await api("/api/codex-hooks", { enabled }, "PUT")),
                  );
              }),
            );
          }),
        );
        details("Trusted hooks", container);
      }),
    ),
  );
  heading("Raw status");
  screen.append(pre(health));
}
$("login").addEventListener("submit", (e) => {
  e.preventDefault();
  void refreshAll();
});
$("refresh").addEventListener("click", () => void refreshAll());
$("disconnect").addEventListener("click", async () => {
  stopActivity();
  try { await api("/api/auth/logout", {}); } catch {}
  $("admin-credential").value = "";
  adminSessionReady = false;
  health = {};
  extensions = {};
  screen.replaceChildren();
  if ($("detail").open) $("detail").close();
  $("detail-body").replaceChildren();
  notice("Signed out. To reconnect, use the short-lived pairing link from bridge-dev access.");
});
document
  .querySelectorAll("nav button")
  .forEach((b) =>
    b.addEventListener("click", () => void navigate(b.dataset.tab)),
  );
function applySectionFilter() {
  const query = $("filter").value.toLowerCase();
  screen
    .querySelectorAll("tr[data-filter]")
    .forEach(
      (r) =>
        (r.hidden = !r.dataset.filter.includes(query)),
    );
  if (section === "audit") {
    void audit();
  }
}
$("filter").addEventListener("input", applySectionFilter);
$("section-filter-toolbar").addEventListener("submit", (e) => {
  e.preventDefault();
  applySectionFilter();
});
$("help").addEventListener("click", () => $("help-dialog").showModal());
$("theme").addEventListener("click", () => {
  const themes = ["system", "light", "dark"],
    next =
      themes[
        (themes.indexOf(document.documentElement.dataset.theme || "system") +
          1) %
          3
      ];
  if (next === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  $("theme").textContent = "Theme: " + next;
});
document.addEventListener("keydown", (e) => {
  if (
    e.ctrlKey ||
    e.altKey ||
    e.metaKey ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)
  )
    return;
  if (e.key === "g") {
    pendingGo = Date.now();
    return;
  }
  if (
    Date.now() - pendingGo < 1000 &&
    { o: "overview", e: "extensions", s: "skills", a: "approvals" }[e.key]
  ) {
    pendingGo = 0;
    e.preventDefault();
    void navigate(
      { o: "overview", e: "extensions", s: "skills", a: "approvals" }[e.key],
    );
    return;
  }
  if (e.key === "/") {
    e.preventDefault();
    const marketSearch = $("marketplace-search");
    if (marketSearch && !marketSearch.hidden && marketSearch.offsetParent !== null) {
      marketSearch.focus();
    } else if (!$("section-filter-toolbar").hidden) {
      $("filter").focus();
    }
  }
  if (e.key === "?") $("help-dialog").showModal();
});
async function initializeAdminSession() {
  const params = new URLSearchParams(location.hash.slice(1));
  const pairing = params.get("pair");
  const legacy = params.get("token") || params.get("admin_token");
  // Remove any fragment before asynchronous work or browser navigation.
  if (location.hash || location.search) history.replaceState(null, "", location.pathname);
  if (pairing) {
    const response = await fetch("/api/auth/pair", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "X-BridgeDev-Pair": "1" },
      body: JSON.stringify({ code: pairing }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw Error(result.error || "Operator pairing failed or expired");
    // A stale session puts the UI on Access & Security. Successful local
    // pairing must restore Overview instead of leaving the authenticated
    // user stranded on the recovery screen.
    $("admin-credential").value = "";
    await navigate("overview");
    return;
  }
  // Old explicitly supplied fragment is a legacy manual fallback, not persisted.
  if (legacy) $("admin-credential").value = legacy;
  await refreshAll();
}
function showPairingError(error) {
  if (error.status === 401 || /^LOCAL_PAIRING_/.test(error.message || "")) {
    showPairingRequired();
    return;
  }
  showError(error);
}
void initializeAdminSession().catch(showPairingError);
window.addEventListener("hashchange", () => {
  // Opening a fresh pairing link in an existing tab is a same-document
  // navigation; run pairing explicitly instead of waiting for a page reload.
  if (new URLSearchParams(location.hash.slice(1)).has("pair"))
    void initializeAdminSession().catch(showPairingError);
});

$("detail").addEventListener("close", stopActivity);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    activityAbort?.abort();
    activityAbort = null;
  } else if (activityWanted && $("detail").open && section === "audit")
    activityResume?.();
});

// The catalog is inert metadata. Browsing never contacts package registries or providers.
const SVG_ICONS = {
  mcp: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
  skill: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  tool: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  observability: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  memory: '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><line x1="8.5" y1="7.5" x2="15.5" y2="7.5"/><line x1="7.5" y1="8.5" x2="10.5" y2="15.5"/><line x1="16.5" y1="8.5" x2="13.5" y2="15.5"/>',
  filesystem: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  chip: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="15" x2="23" y2="15"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="15" x2="4" y2="15"/>',
  cloud: '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
  box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  git: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 9v12"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  ai: '<path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>',
  keyboard: '<rect x="2" y="4" width="20" height="16" rx="2"/><line x1="6" y1="8" x2="6" y2="8"/><line x1="10" y1="8" x2="10" y2="8"/><line x1="14" y1="8" x2="14" y2="8"/><line x1="18" y1="8" x2="18" y2="8"/><line x1="6" y1="12" x2="6" y2="12"/><line x1="10" y1="12" x2="10" y2="12"/><line x1="14" y1="12" x2="14" y2="12"/><line x1="18" y1="12" x2="18" y2="12"/><line x1="7" y1="16" x2="17" y2="16"/>',
  bluetooth: '<polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/>',
  speed: '<path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
};

function createSvgIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = SVG_ICONS[name] || SVG_ICONS.mcp;
  return svg;
}

function getFallbackIconName(entry) {
  const cat = (entry.category || "").toLowerCase();
  const id = (entry.id || "").toLowerCase();
  const type = (entry.type || "").toLowerCase();
  const desc = (entry.description || "").toLowerCase();

  if (cat.includes("reverse") || id.includes("rea") || desc.includes("decompile") || desc.includes("binary")) return "chip";
  if (id.includes("keyboard") || desc.includes("keyboard") || desc.includes("ergonomic")) return "keyboard";
  if (id.includes("bluetooth") || desc.includes("bluetooth")) return "bluetooth";
  if (id.includes("performance") || id.includes("cachyos") || desc.includes("gpu")) return "speed";
  if (cat.includes("database") || id.includes("sql") || id.includes("postgres") || id.includes("sqlite") || id.includes("mongo") || id.includes("redis")) return "database";
  if (cat.includes("browser") || id.includes("puppeteer") || id.includes("playwright") || id.includes("fetch") || desc.includes("web")) return "globe";
  if (cat.includes("observability") || cat.includes("monitoring") || id.includes("sentry") || desc.includes("telemetry")) return "observability";
  if (cat.includes("memory") || id.includes("memory") || desc.includes("knowledge graph")) return "memory";
  if (id.includes("filesystem") || cat.includes("local development") || desc.includes("filesystem")) return "filesystem";
  if (cat.includes("container") || cat.includes("devops") || id.includes("docker") || id.includes("kubernetes")) return "box";
  if (cat.includes("cloud") || id.includes("aws") || id.includes("gcp") || id.includes("azure") || id.includes("cloudflare")) return "cloud";
  if (cat.includes("git") || id.includes("github") || id.includes("gitlab")) return "git";
  if (cat.includes("ai") || cat.includes("machine learning")) return "ai";
  if (type === "skill") return "skill";
  if (type === "tool") return "tool";
  return "mcp";
}

function renderMarketplaceIcon(entry) {
  const wrap = el("div", undefined, { class: "catalog-card-icon" });
  const fallback = getFallbackIconName(entry);
  if (entry.icon) {
    if (entry.icon.startsWith("data:") || entry.icon.startsWith("/")) {
      const img = el("img", undefined, {
        src: entry.icon,
        alt: "",
        width: "36",
        height: "36",
        loading: "lazy",
      });
      img.onerror = () => { img.replaceWith(createSvgIcon(fallback)); };
      wrap.append(img);
      return wrap;
    }
    if (SVG_ICONS[entry.icon]) {
      wrap.append(createSvgIcon(entry.icon));
      return wrap;
    }
  }
  wrap.append(createSvgIcon(fallback));
  return wrap;
}

let marketQuery = { offset: 0, limit: 20 },
  marketData;
async function marketplaceView() {
  const data = await api(
    "/api/marketplace?" + new URLSearchParams(marketQuery),
  );
  marketData = data;
  heading("Integration marketplace");
  screen.append(
    action("Client integration preferences", globalIntegrationPreferences),
  );
  screen.append(el("p", "Explore reviewed MCP servers, skills and tools. Catalog entries are not proof of installation or compatibility; inspect the requirements before requesting a proposal.", {class:"catalog-intro"}));
  const form = el("form", undefined, {
    class: "actions marketplace-toolbar",
    id: "marketplace-filter",
  });
  const searchGroup = el("div", undefined, { class: "market-search-group" });
  const query = el("input", undefined, {
    "aria-label": "Search catalog",
    placeholder: "Search all integrations",
    id: "marketplace-search",
  });
  query.value = marketQuery.query || "";
  const searchBtn = el("button", "Search", { type: "submit" });
  searchGroup.append(query, searchBtn);
  form.append(searchGroup);

  const filterGroup = el("div", undefined, { class: "market-filter-dropdowns" });
  for (const [key, options] of [
    ["category", data.categories],
    ["type", ["mcp", "skill", "tool"]],
    ["platform", data.platforms],
    ["maintainer", data.maintainers],
    ["view", ["all", "installed", "connected", "available", "recommended"]],
  ]) {
    const select = el("select", undefined, { "aria-label": "Catalog " + key });
    select.append(
      el("option", key === "view" ? "All views" : "Any " + key, {
        value: key === "view" ? "all" : "",
      }),
    );
    for (const option of options)
      select.append(el("option", option, { value: option }));
    select.value = marketQuery[key] || (key === "view" ? "all" : "");
    select.addEventListener("change", async () => {
      marketQuery[key] = select.value;
      if (!select.value) delete marketQuery[key];
      marketQuery.offset = 0;
      await render();
    });
    filterGroup.append(select);
  }
  form.append(filterGroup);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    marketQuery.query = query.value;
    marketQuery.offset = 0;
    await render();
  });
  screen.append(form);
  const summary = el("div", undefined, {class:"catalog-summary"});
  summary.append(el("strong", data.total + " matching resources"),
    el("span", data.catalog_total + " in reviewed catalog · metadata only · no automatic installation"));
  screen.append(summary);
  const grid = el("div", undefined, {class:"catalog-grid"});
  for (const entry of data.entries) {
    const card = el("article", undefined, {class:"catalog-card"});
    const header = el("div", undefined, {class:"catalog-card-header"});
    const icon = renderMarketplaceIcon(entry);
    const headingBox = el("div", undefined, {class:"catalog-card-heading"});
    const top = el("div", undefined, {class:"catalog-card-top"});
    const status = entry.state.connected ? "Connected · " + entry.state.exposed.length + " tools" :
      entry.state.registered ? (entry.state.enabled ? "Enabled" : "Registered") :
      entry.state.installed ? "Installed" : "Not installed";
    top.append(el("span", entry.type.toUpperCase(), {class:"catalog-type"}),
      el("span", status, {class:"catalog-state"}));
    headingBox.append(top, el("h3", entry.name));
    header.append(icon, headingBox);
    card.append(header, el("p", entry.description, {class:"catalog-description"}));
    const meta = el("p", entry.category + " · " + entry.maintainer + " · " + entry.version,
      {class:"catalog-meta"});
    card.append(meta);
    const footer = el("div", undefined, {class:"catalog-card-footer"});
    footer.append(el("span", "Source checked " + entry.verified_at, {class:"catalog-verified"}),
      action("Details", () => marketplaceDetails(entry)));
    card.append(footer);
    grid.append(card);
  }
  if (!data.entries.length) grid.append(el("p", "No resources match this search. Clear filters to browse the catalog.", {class:"empty"}));
  screen.append(grid);
  screen.append(
    el(
      "p",
      `${data.total} matching / ${data.catalog_total} entries. Page ${Math.floor(data.offset / data.limit) + 1}.`,
    ),
  );
  screen.append(
    controls(
      action(
        "Previous",
        async () => {
          marketQuery.offset = Math.max(0, data.offset - data.limit);
          await render();
        },
        {},
      ),
      action(
        "Next",
        async () => {
          marketQuery.offset = data.offset + data.limit;
          await render();
        },
        {},
      ),
    ),
  );
  // Avoid setting a boolean HTML attribute to the string "undefined".
  const paging = screen.lastChild.querySelectorAll("button");
  paging[0].disabled = data.offset === 0;
  paging[1].disabled = data.offset + data.limit >= data.total;
}
async function marketplaceDetails(entry) {
  const body = el("div");
  pairs(
    {
      Name: entry.name,
      Type: entry.type,
      Maintainer: entry.maintainer,
      Source: entry.source,
      License: entry.license,
      Version: entry.version,
      Platforms: entry.platforms,
      Requirements: entry.requirements,
      Credentials: entry.credentials,
      Permissions: entry.permissions,
      Maintenance: entry.maintenance,
      Verified: entry.verified_at + " / " + entry.evidence.level,
      "Tool inventory": entry.tools.verified
        ? entry.tools
        : "Not runtime-verified; connect and test before claiming callable tools",
      State: entry.state,
      Recommendation: entry.recommendation.reason,
    },
    body,
  );
  body.append(el("p", entry.installation.instructions));
  const pref = el("select", undefined, { "aria-label": "Preferred Provider" });
  for (const [value, label] of [
    ["auto", "Auto / Prefer ChatGPT"],
    ["prefer-bridgedev", "Prefer BridgeDev"],
    ["chatgpt-only", "ChatGPT only"],
    ["bridgedev-only", "BridgeDev only"],
    ["disabled", "Disabled"],
  ])
    pref.append(el("option", label, { value }));
  pref.value = entry.preference?.preference || "auto";
  const availability = el("select", undefined, {
    "aria-label": "Declared ChatGPT availability",
  });
  for (const x of ["unknown", "connected", "not-connected"])
    availability.append(el("option", x, { value: x }));
  availability.value = entry.preference?.availability || "unknown";
  const kind = el("select", undefined, { "aria-label": "ChatGPT plugin kind" });
  for (const x of ["official", "third-party"])
    kind.append(el("option", x, { value: x }));
  kind.value = entry.preference?.native_kind || "official";
  const capabilities = el("input", undefined, {
    "aria-label": "Verified ChatGPT capabilities",
    placeholder: entry.capabilities.join(", "),
  });
  capabilities.value = entry.preference?.capabilities.join(", ") || "";
  const provider = el("select", undefined, {
    "aria-label": "Bind registered BridgeDev provider",
  });
  provider.append(el("option", "No provider binding", { value: "" }));
  for (const p of extensions.providers || [])
    provider.append(el("option", p.id, { value: p.id }));
  provider.value = entry.preference?.provider_id || "";
  body.append(
    el(
      "p",
      "Connection is a user declaration. List only capabilities you have verified. ChatGPT only / Disabled blocks the explicitly bound BridgeDev provider; Auto never silently disables it.",
    ),
    pref,
    availability,
    kind,
    capabilities,
    provider,
    action("Save provider preference", async () => {
      await api("/api/marketplace/preferences", {
        service: entry.native_alternative?.service || entry.id,
        preference: pref.value,
        availability: availability.value,
        native_kind: kind.value,
        capabilities: capabilities.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        ...(provider.value ? { provider_id: provider.value } : {}),
      });
      $("detail").close();
      await refreshAll();
      notice(
        "Provider preference saved. Reconnect clients to refresh tool lists.",
      );
    }),
  );
  if (
    entry.recommendation.offer_local &&
    entry.installation.mechanism !== "native"
  )
    body.append(
      action("Preview installation proposal", async () => {
        const proposal = await api("/api/marketplace/propose", {
          id: entry.id,
          scope: "project",
        });
        body.append(
          pre(proposal),
          action("Review in Approvals", async () => {
            $("detail").close();
            await navigate("approvals");
          }),
        );
      }),
    );
  if (entry.recommendation.offer_local && entry.type === "mcp")
    body.append(
      action("Configure installed executable or endpoint", () =>
        providerDefinition(entry),
      ),
    );
  details(entry.name, body);
}
function providerDefinition(entry) {
  const form = el("form", undefined, { class: "form-grid" }),
    fields = {};
  for (const [key, label, value] of [
    ["id", "Provider ID", entry?.id || ""],
    ["name", "Display name", entry?.name || ""],
    ["command", "Installed executable (absolute path)", ""],
    ["args", "Arguments (one per line; no shell interpolation)", ""],
    ["env", "Explicit non-secret environment (NAME=value per line)", ""],
    ["cwd", "Working directory", ""],
    ["url", "HTTP MCP URL", ""],
    ["bearer_token_env_var", "Existing credential environment reference", ""],
  ]) {
    const input = el(
      ["args", "env"].includes(key) ? "textarea" : "input",
      undefined,
      { "aria-label": label, id: "provider-definition-" + key },
    );
    input.value = value;
    fields[key] = input;
    form.append(el("label", label, { for: input.id }), input);
  }
  const transport = el("select", undefined, {
    "aria-label": "Provider transport",
  });
  for (const x of ["stdio", "http"])
    transport.append(el("option", x, { value: x }));
  form.prepend(transport);
  const auth = el("select", undefined, { "aria-label": "HTTP authentication" });
  for (const x of ["none", "oauth", "auto"])
    auth.append(el("option", x, { value: x }));
  form.append(auth);
  form.append(
    el(
      "p",
      "No executable is downloaded or launched here. Registration is disabled. Review prerequisites and credential references; connection and tool exposure require separate approval. Never paste secrets into arguments or URLs.",
    ),
  );
  const out = el("div");
  form.append(
    el("button", "Preview disabled registration", { type: "submit" }),
    out,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const body = {
        id: fields.id.value,
        name: fields.name.value,
        transport: transport.value,
        scope: "project",
      };
      if (transport.value === "stdio") {
        body.command = fields.command.value;
        if (fields.env.value) {
          body.env = Object.fromEntries(
            fields.env.value
              .split("\n")
              .filter(Boolean)
              .map((line) => {
                const i = line.indexOf("=");
                if (i < 1) throw Error("Environment requires NAME=value");
                return [line.slice(0, i), line.slice(i + 1)];
              }),
          );
        }
        body.args = fields.args.value.split("\n").filter(Boolean);
        if (fields.cwd.value) body.cwd = fields.cwd.value;
      } else {
        body.url = fields.url.value;
        body.auth = { type: auth.value };
        if (fields.bearer_token_env_var.value)
          body.bearer_token_env_var = fields.bearer_token_env_var.value;
      }
      const p = await api("/api/extensions/provider-definition", body);
      out.replaceChildren(
        pre(p),
        action("Review in Approvals", async () => {
          $("detail").close();
          await navigate("approvals");
        }),
      );
    } catch (error) {
      out.replaceChildren(pre(error.message));
    }
  });
  details("Configure provider", form);
}

async function globalIntegrationPreferences() {
  const current = await api("/api/marketplace/preferences"),
    form = el("form", undefined, { class: "form-grid" });
  const service = el("select", undefined, {
    "aria-label": "Integration service",
  });
  const services = [
    ...new Set([
      "github",
      "google-drive",
      "gmail",
      "google-calendar",
      "notion",
      "figma",
      "slack",
      "linear",
      "jira",
      ...current.services.map((s) => s.service),
    ]),
  ].sort();
  for (const x of services) service.append(el("option", x, { value: x }));
  const choice = el("select", undefined, {
    "aria-label": "Preferred Provider",
  });
  for (const [v, label] of [
    ["auto", "Auto / Prefer ChatGPT"],
    ["prefer-bridgedev", "Prefer BridgeDev"],
    ["chatgpt-only", "ChatGPT only"],
    ["bridgedev-only", "BridgeDev only"],
    ["disabled", "Disabled"],
  ])
    choice.append(el("option", label, { value: v }));
  const availability = el("select", undefined, {
    "aria-label": "Declared ChatGPT availability",
  });
  for (const v of ["unknown", "connected", "not-connected"])
    availability.append(el("option", v, { value: v }));
  const kind = el("select", undefined, { "aria-label": "ChatGPT plugin kind" });
  for (const v of ["official", "third-party"])
    kind.append(el("option", v, { value: v }));
  const capabilities = el("input", undefined, {
    "aria-label": "Verified ChatGPT capabilities",
    placeholder: "Comma-separated capability identifiers",
  });
  const provider = el("select", undefined, {
    "aria-label": "Bind registered BridgeDev provider",
  });
  provider.append(el("option", "No provider binding", { value: "" }));
  for (const p of extensions.providers || [])
    provider.append(el("option", p.id, { value: p.id }));
  function load() {
    const p = current.services.find((s) => s.service === service.value);
    choice.value = p?.preference || "auto";
    availability.value = p?.availability || "unknown";
    kind.value = p?.native_kind || "official";
    capabilities.value = p?.capabilities.join(", ") || "";
    provider.value = p?.provider_id || "";
  }
  service.addEventListener("change", load);
  load();
  form.append(
    el(
      "p",
      "User declarations only. BridgeDev cannot inspect ChatGPT account plugins. Exact supported capability names are required; connection alone does not establish task coverage. Bind an existing provider to enforce ChatGPT only / Disabled locally.",
    ),
    service,
    choice,
    availability,
    kind,
    capabilities,
    provider,
    el("button", "Save preference", { type: "submit" }),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/marketplace/preferences", {
        service: service.value,
        preference: choice.value,
        availability: availability.value,
        native_kind: kind.value,
        capabilities: capabilities.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        ...(provider.value ? { provider_id: provider.value } : {}),
      });
      $("detail").close();
      await refreshAll();
      notice(
        "Preference saved. Refresh connector tool lists when provider exposure changed.",
      );
    } catch (error) {
      showError(error);
    }
  });
  details("Client integration preferences", form);
}
