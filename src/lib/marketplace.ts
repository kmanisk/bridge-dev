import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ExtensionStore } from "./extension-store.js";
import type { McpUpstreamManager } from "./mcp-upstream-manager.js";
import {
  readIntegrationPreferences,
  resolveIntegration,
} from "./integration-preferences.js";

const https = z
  .string()
  .url()
  .refine((s) => {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password;
  });
export const catalogEntry = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,80}$/),
    name: z.string().min(1).max(120),
    description: z.string().max(1000),
    category: z.string().max(80),
    maintainer: z.string().min(1).max(150),
    type: z.enum(["mcp", "skill", "tool"]),
    source: https,
    license: z.string().min(1).max(200),
    version: z.string().min(1).max(100),
    platforms: z.array(z.string().max(80)).min(1),
    requirements: z.array(z.string().max(500)),
    credentials: z.array(z.string().max(500)),
    permissions: z.array(z.string().max(500)),
    installation: z
      .object({
        mechanism: z.enum(["npm", "pypi", "git", "native"]),
        source: z.string().max(2048),
        instructions: z.string().max(2000),
      })
      .strict(),
    tools: z
      .object({
        count: z.number().int().nonnegative().nullable(),
        verified: z.boolean(),
        names: z.array(z.string().max(256)),
      })
      .strict(),
    maintenance: z.string().max(500),
    verified_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    evidence: z
      .object({
        url: https,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        level: z.enum(["package-metadata", "source-metadata", "bundled"]),
        repository_url: https,
        repository_verified: z.literal(true),
      })
      .strict(),
    native_alternative: z
      .object({ service: z.string(), url: https })
      .strict()
      .nullable(),
    priority: z.enum(["prefer-chatgpt", "local", "fallback"]),
    capabilities: z.array(z.string().max(100)).min(1),
    related_skills: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
      .max(16)
      .default([]),
    icon: z.string().max(2048).optional(),
  })
  .strict();
export type CatalogEntry = z.infer<typeof catalogEntry>;
const catalogSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(catalogEntry).min(1).max(1000),
  })
  .strict();
let cached: Promise<z.infer<typeof catalogSchema>> | undefined;
export function loadMarketplace() {
  return (cached ??= (async () => {
    const bytes = await fs.readFile(
      fileURLToPath(
        new URL("../../profiles/marketplace.v1.json", import.meta.url),
      ),
      "utf8",
    );
    if (Buffer.byteLength(bytes) > 4 * 1048576)
      throw Error("MARKETPLACE_SIZE_LIMIT");
    const data = catalogSchema.parse(JSON.parse(bytes));
    if (new Set(data.entries.map((e) => e.id)).size !== data.entries.length)
      throw Error("MARKETPLACE_DUPLICATE_ID");
    return data;
  })());
}
export const marketplaceQuery = z
  .object({
    query: z.string().max(128).default(""),
    category: z.string().max(80).optional(),
    type: z.enum(["mcp", "skill", "tool"]).optional(),
    platform: z.string().max(80).optional(),
    maintainer: z.string().max(150).optional(),
    view: z
      .enum(["all", "installed", "connected", "available", "recommended"])
      .default("all"),
    offset: z.coerce.number().int().min(0).max(10000).default(0),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    capability: z.string().max(100).optional(),
  })
  .strict();
export async function marketplace(manager: McpUpstreamManager, raw: unknown) {
  const q = marketplaceQuery.parse(raw),
    catalog = await loadMarketplace(),
    preferences = await readIntegrationPreferences();
  const store = new ExtensionStore(undefined, undefined, manager),
    installed = await store.list(),
    statuses = manager.listStatusesCached();
  const entries = catalog.entries
    .map((entry) => {
      const preference = preferences.services.find(
        (p) => p.service === (entry.native_alternative?.service || entry.id),
      );
      const component = installed.find(
        (e) =>
          e.component.kind === entry.type &&
          (e.source === entry.installation.source ||
            (entry.type === "mcp" &&
              preference?.provider_id === e.component.id)),
      );
      const provider = statuses.find(
        (p) => p.id === (preference?.provider_id || component?.component.id),
      );
      const recommendation = resolveIntegration(
        preference,
        q.capability || entry.capabilities[0],
        entry.priority === "local",
      );
      return {
        ...entry,
        preference: preference || null,
        recommendation,
        state: {
          available: true,
          installed: !!component || entry.installation.mechanism === "native",
          registered: !!provider,
          enabled: provider?.enabled ?? component?.enabled ?? false,
          connected: provider?.connected || false,
          exposed: provider?.proxied_tools || [],
          discovered_tools: provider?.tool_count ?? null,
          last_error: provider?.last_error || null,
          duplicate_warning:
            !!provider && recommendation.provider === "chatgpt",
          native_availability: preference?.availability || "unknown",
          requirements_verified: false,
          configuration_required: entry.type === "mcp" && !provider,
          related_skills: entry.related_skills.map((name) => {
            const skill = installed.find(
              (e) => e.component.kind === "skill" && e.component.id === name,
            );
            return {
              name,
              installed: !!skill,
              enabled: skill?.enabled || false,
              provenance: skill?.source || null,
            };
          }),
        },
      };
    })
    .filter(
      (e) =>
        (!q.query ||
          [e.name, e.description, e.id, e.maintainer]
            .join(" ")
            .toLowerCase()
            .includes(q.query.toLowerCase())) &&
        (!q.category || e.category === q.category) &&
        (!q.type || e.type === q.type) &&
        (!q.platform || e.platforms.includes(q.platform)) &&
        (!q.maintainer || e.maintainer === q.maintainer) &&
        (q.view === "all" ||
          (q.view === "installed" && e.state.installed) ||
          (q.view === "connected" && e.state.connected) ||
          (q.view === "available" && !e.state.installed) ||
          (q.view === "recommended" && e.recommendation.offer_local)),
    );
  return {
    version: 1,
    total: entries.length,
    catalog_total: catalog.entries.length,
    offset: q.offset,
    limit: q.limit,
    entries: entries.slice(q.offset, q.offset + q.limit),
    categories: [...new Set(catalog.entries.map((e) => e.category))].sort(),
    maintainers: [...new Set(catalog.entries.map((e) => e.maintainer))].sort(),
    platforms: [...new Set(catalog.entries.flatMap((e) => e.platforms))].sort(),
    inventory_source:
      "User declarations only; BridgeDev cannot inspect ChatGPT account plugins",
    verification:
      "Catalog metadata is verified separately from installation, connection and tool invocation",
  };
}
