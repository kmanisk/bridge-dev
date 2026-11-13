import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { documentationPlanForPaths } from "./docs-routing.js";

export type InspectionSection = "resources" | "gpu" | "storage" | "services" | "sway" | "audio" | "bluetooth" | "drift";
export const INSPECTION_SECTIONS: InspectionSection[] = ["resources", "gpu", "storage", "services", "sway", "audio", "bluetooth", "drift"];

export interface CommandResult { ok: boolean; exit_code: number | null; stdout: string; stderr: string }

export function runReadOnly(command: string, args: string[], timeoutMs = 4000, maxChars = 10000): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "", stderr = "";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const finish = (code: number | null, error = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0 && !error, exit_code: code, stdout, stderr: (stderr + (error ? "\n" + error : "")).trim() });
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(null, "timeout"); }, timeoutMs);
    child.stdout.on("data", (b: Buffer) => { stdout = (stdout + b.toString()).slice(0, maxChars); });
    child.stderr.on("data", (b: Buffer) => { stderr = (stderr + b.toString()).slice(0, 1200); });
    child.on("error", (e) => finish(null, e.message));
    child.on("close", (code) => finish(code));
  });
}

function parsedJson(result: CommandResult): unknown {
  if (!result.ok) return { unavailable: result.stderr || "Command failed", exit_code: result.exit_code };
  try { return JSON.parse(result.stdout); } catch { return { unavailable: "Invalid JSON response" }; }
}
async function resources() {
  const [mem, load, uptime] = await Promise.all([
    fs.readFile("/proc/meminfo", "utf8"), fs.readFile("/proc/loadavg", "utf8"), fs.readFile("/proc/uptime", "utf8"),
  ]);
  const metrics = Object.fromEntries([...mem.matchAll(/^([A-Za-z_()]+):\s+(\d+) kB$/gm)].map((m) => [m[1], Number(m[2])]));
  let battery: object | undefined;
  try {
    const candidates = (await fs.readdir("/sys/class/power_supply")).filter((x) => x.startsWith("BAT"));
    if (candidates.length) {
      const folder = path.join("/sys/class/power_supply", candidates[0]);
      battery = {
        device: candidates[0],
        capacity_percent: Number((await fs.readFile(path.join(folder, "capacity"), "utf8")).trim()),
        status: (await fs.readFile(path.join(folder, "status"), "utf8")).trim(),
      };
    }
  } catch {}
  return {
    timestamp: new Date().toISOString(), source: "/proc & /sys",
    memory: {
      total_bytes: (metrics.MemTotal || 0) * 1024,
      available_bytes: (metrics.MemAvailable || 0) * 1024,
      swap_total_bytes: (metrics.SwapTotal || 0) * 1024,
      swap_free_bytes: (metrics.SwapFree || 0) * 1024,
    },
    load_average: load.trim().split(/\s+/).slice(0, 3).map(Number),
    uptime_seconds: Number(uptime.trim().split(/\s+/)[0]),
    battery,
  };
}
async function gpu() {
  const result = await runReadOnly("nvidia-smi", ["--query-gpu=name,driver_version,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw", "--format=csv,noheader,nounits"], 4500, 3000);
  if (!result.ok) return { unavailable: result.stderr || "nvidia-smi unavailable" };
  return { source: "nvidia-smi", units: { temperature: "C", utilization: "percent", memory: "MiB", power: "W" }, rows: result.stdout.trim().split("\n").map((r) => {
    const [name, driver, temperature, utilization, used, total, power] = r.split(/,\s*/);
    const val = (x?: string) => x && /^\d+(\.\d+)?$/.test(x) ? Number(x) : null;
    return { name, driver, temperature_c: val(temperature), utilization_percent: val(utilization), memory_used_mib: val(used), memory_total_mib: val(total), power_w: val(power) };
  }) };
}
async function storage() {
  const result = await runReadOnly("df", ["-P", "-B1", "/", os.homedir()], 4000);
  return { source: "df -P -B1 / $HOME", result: result.ok ? result.stdout.trim().split("\n").slice(0, 3).map((row, i) => {
    if (i === 0) return { header: row };
    const fields = row.trim().split(/\s+/);
    return { filesystem: fields[0], total_bytes: Number(fields[1]), used_bytes: Number(fields[2]), available_bytes: Number(fields[3]), use_percent: fields[4], mountpoint: fields.slice(5).join(" ") };
  }) : { unavailable: result.stderr } };
}
async function services() {
  const [failedUser, failedSystem] = await Promise.all([
    runReadOnly("systemctl", ["--user", "--failed", "--no-pager", "--plain", "--no-legend"], 5000, 4000),
    runReadOnly("systemctl", ["--failed", "--no-pager", "--plain", "--no-legend"], 5000, 4000),
  ]);
  return { source: "systemctl --failed", user_failed: failedUser.ok ? failedUser.stdout.trim().split("\n").filter(Boolean).slice(0, 15) : { unavailable: failedUser.stderr }, system_failed: failedSystem.ok ? failedSystem.stdout.trim().split("\n").filter(Boolean).slice(0, 15) : { unavailable: failedSystem.stderr } };
}
function summarizeTree(node: any): any {
  if (!node || typeof node !== "object") return undefined;
  if (node.focused) return { id: node.id, app_id: node.app_id, window_class: node.window_properties?.class, workspace: node.workspace, rect: node.rect, floating: node.floating, fullscreen_mode: node.fullscreen_mode };
  for (const child of [...(node.nodes || []), ...(node.floating_nodes || [])]) {
    const focused = summarizeTree(child);
    if (focused) return focused;
  }
}
async function sway() {
  const [tree, workspaces, outputs] = await Promise.all([
    runReadOnly("swaymsg", ["-t", "get_tree", "-r"], 4000, 250000),
    runReadOnly("swaymsg", ["-t", "get_workspaces", "-r"], 4000, 30000),
    runReadOnly("swaymsg", ["-t", "get_outputs", "-r"], 4000, 50000),
  ]);
  const ws = parsedJson(workspaces) as any;
  const out = parsedJson(outputs) as any;
  return {
    source: "swaymsg (read-only)",
    focused_window: tree.ok ? summarizeTree(parsedJson(tree)) || null : { unavailable: tree.stderr },
    workspaces: Array.isArray(ws) ? ws.slice(0, 20).map((x) => ({ name: x.name, focused: x.focused, output: x.output, visible: x.visible, num: x.num })) : ws,
    outputs: Array.isArray(out) ? out.slice(0, 8).map((x) => ({ name: x.name, active: x.active, current_mode: x.current_mode, scale: x.scale, transform: x.transform, rect: x.rect })) : out,
  };
}
async function audio() {
  const [wp, sink] = await Promise.all([
    runReadOnly("wpctl", ["status"], 4500, 12500), runReadOnly("wpctl", ["get-volume", "@DEFAULT_AUDIO_SINK@"], 3500, 1500),
  ]);
  if (!wp.ok) return { source: "wpctl", unavailable: wp.stderr || "wpctl status failed" };
  const devices: Array<{ id: number; name: string; kind: string; default: boolean }> = [];
  let kind = "";
  let inAudio = false;
  for (const line of wp.stdout.split("\n")) {
    if (line.trim() === "Audio") { inAudio = true; continue; }
    if (line.trim() === "Video") break;
    if (!inAudio) continue;
    const heading = line.match(/(?:Devices|Sinks|Sources|Filters|Streams):\s*$/);
    if (heading) { kind = heading[0].replace(":",""); continue; }
    if (!["Devices", "Sinks", "Sources"].includes(kind)) continue;
    const match = line.match(/(\*)?\s*(\d+)\.\s+(.+?)(?:\s+\[(?:vol|alsa|bluez5)[^\]]*\])?\s*$/);
    if (match) devices.push({ id: Number(match[2]), name: match[3].trim().replace(/\s+\[[^\]]+\]$/, ""), kind, default: match[1] === "*" });
  }
  return {
    source: "wpctl", pipewire_header: wp.stdout.split("\n")[0],
    devices: devices.slice(0, 40),
    default_sink_volume: sink.ok ? sink.stdout.trim() : { unavailable: sink.stderr },
    note: "Only visible wpctl devices; routes and DSP components require further focused inspection.",
  };
}
async function bluetooth() {
  const [devices, bluez, wireplumber, kernel] = await Promise.all([
    runReadOnly("bluetoothctl", ["devices", "Connected"], 4000, 1800),
    runReadOnly("journalctl", ["-u", "bluetooth.service", "-n", "50", "--no-pager", "--output=short-iso"], 4000, 7500),
    runReadOnly("journalctl", ["--user", "-u", "wireplumber.service", "-n", "75", "--no-pager", "--output=short-iso"], 4000, 10500),
    runReadOnly("journalctl", ["-k", "-n", "100", "--no-pager", "--output=short-iso"], 4000, 13000),
  ]);
  const filter = (output: string) => output.split("\n").filter((x) => /bluetooth|bluez|a2dp|transport|media|pipewire|wireplumber|btusb|firmware|codec|reconnect|completion report|sink/i.test(x)).slice(-45);
  const timeline = [
    ...((bluez.ok ? filter(bluez.stdout) : []).map((line) => ({source:"bluez",line}))),
    ...((wireplumber.ok ? filter(wireplumber.stdout) : []).map((line) => ({source:"wireplumber",line}))),
    ...((kernel.ok ? filter(kernel.stdout) : []).map((line) => ({source:"kernel",line}))),
  ].map(({source,line}) => {
    const timestamp = line.match(/^\S+/)?.[0] || "";
    const ms = Date.parse(timestamp);
    const kind = /error|fail|missing completion|terminat|timeout|disconnect/i.test(line)
      ? "failure" : /reconnect|connect|route|sink/i.test(line) ? "transition" : "observation";
    return {source, timestamp, epoch_ms:Number.isFinite(ms) ? ms : undefined, kind, line:line.slice(0,400)};
  }).filter((x) => x.epoch_ms !== undefined).sort((a,b) => a.epoch_ms! - b.epoch_ms!);
  const incidents = timeline.filter((entry)=>entry.kind==="failure").slice(-12).map((failure)=>({
    time:failure.timestamp,
    trigger:failure,
    correlated:timeline.filter((candidate)=>candidate!==failure && Math.abs(candidate.epoch_ms! - failure.epoch_ms!) <= 6000).slice(0,8),
  }));
  return {
    source: "bluetoothctl + journalctl (read-only)", timestamp: new Date().toISOString(),
    connected: devices.ok ? devices.stdout.split("\n").filter(Boolean).slice(0, 15) : { unavailable: devices.stderr },
    bluez_events: bluez.ok ? filter(bluez.stdout) : { unavailable: bluez.stderr },
    wireplumber_events: wireplumber.ok ? filter(wireplumber.stdout) : { unavailable: wireplumber.stderr },
    kernel_events: kernel.ok ? filter(kernel.stdout) : { unavailable: kernel.stderr },
    incidents,
    interpretation: "Incidents group log events within 6 seconds for investigation, not causal proof. Transport loss does not prove speaker power cycling.",
  };
}
async function drift() {
  const root = process.env.LOCAL_CODER_CHEZMOI_SOURCE_DIR || path.join(os.homedir(), ".local/share/chezmoi");
  const status = await runReadOnly("git", ["-C", root, "status", "--porcelain=v1"], 5000, 32000);
  const lines = status.stdout.split("\n").filter(Boolean);
  const changedSource = lines.filter((s) => !s.slice(3).trim().startsWith("docs/"))
    .map((s) => ({ git_status: s.slice(0, 2), path: s.slice(3).trim() }));
  const plan = documentationPlanForPaths(changedSource.map((item) => path.join(root, item.path)));
  const statuses = await runReadOnly("chezmoi", ["--source", root, "status"], 8500, 30000);
  return {
    source: "git porcelain + chezmoi status",
    changes_count: lines.length,
    documentation_plan: plan,
    changed_source: changedSource.slice(0, 70),
    changed_source_truncated: changedSource.length > 70,
    chezmoi_status_lines: statuses.ok ? statuses.stdout.split("\n").filter(Boolean).slice(0, 45) : { unavailable: statuses.stderr },
    docs_required_after_user_acceptance: ["Owning docs under docs/", "docs/system/SYSTEM_CONTEXT.md when verified cross-agent baseline changes", "docs/system/SYSTEM_CHANGELOG.md for durable commits"],
    caveat: "Git dirty state is not evidence that a change was validated. This is a documentation routing proposal, not a verified-state update.",
  };
}
export async function inspectSections(sections: InspectionSection[]) {
  const methods: Record<InspectionSection, () => Promise<any>> = { resources, gpu, storage, services, sway, audio, bluetooth, drift };
  const selected = [...new Set(sections)].filter((x) => x in methods);
  const results = await Promise.all(selected.map(async (name) => {
    try { return [name, await methods[name]()] as const; }
    catch (error) { return [name, { unavailable: error instanceof Error ? error.message : String(error) }] as const; }
  }));
  return { timestamp: new Date().toISOString(), sections: Object.fromEntries(results), read_only: true };
}
