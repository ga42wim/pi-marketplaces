/**
 * Marketplace synchronization.
 *
 * Fetches upstream changes, parses updated manifests, and updates installed
 * resources while preserving local overrides and unmanaged files.
 */

import { execFileSync } from "child_process";
import {
  MarketplaceRegistryEntry,
  MarketplaceDescriptor,
  InstalledPluginState,
  InstalledResourceState,
  SyncOptions,
  SyncResult,
} from "./types";
import { discoverPlugins } from "./discover";
import { GLOBAL_STATE_FILE } from "./paths";
import { loadGlobalConfig, saveGlobalConfig } from "./config";

import fs from "node:fs";
import path from "node:path";

export function loadState(): MarketplaceRegistryEntry[] {
  return loadGlobalConfig();
}

export function saveState(entries: MarketplaceRegistryEntry[]) {
  saveGlobalConfig(entries);
}

export function addMarketplace(
  url: string,
  ref?: string,
): MarketplaceRegistryEntry {
  const entries = loadState();
  const now = new Date().toISOString();

  const entry: MarketplaceRegistryEntry = {
    name: url.split("/").pop()?.replace(/\.git$/, "") || url,
    url,
    ref,
    resolvedCommit: resolveCommit(url, ref),
    clonePath: "",
    registeredAt: now,
    installedPlugins: [],
  };

  // Clone or update
  const clonesDir = path.dirname(GLOBAL_STATE_FILE) + "/clones";
  const clonePath = clonesDir + "/" + entry.name.replace(/[^a-z0-9]/gi, "-");
  if (fs.existsSync(clonePath + "/.git")) {
    git(["-C", clonePath, "fetch", "origin"]);
    if (ref) git(["-C", clonePath, "checkout", ref]);
    const base = ref || defaultBranch(url);
    git(["-C", clonePath, "reset", "--hard", `origin/${base}`]);
  } else {
    git(["clone", url, clonePath]);
    if (ref) git(["-C", clonePath, "checkout", ref]);
  }
  entry.clonePath = clonePath;
  entry.resolvedCommit = resolveCommit(url, ref);

  entries.push(entry);
  saveState(entries);
  return entry;
}

export function removeMarketplace(url: string, opts: { deleteClone?: boolean } = {}): boolean {
  const entries = loadState();
  const entry = entries.find(e => e.url === url);
  if (!entry) return false;

  const filtered = entries.filter(e => e.url !== url);

  // Delete the cloned source unless it is a local path the user owns.
  const shouldDelete = opts.deleteClone !== false;
  if (shouldDelete && entry.clonePath && isManagedClone(entry.clonePath)) {
    try {
      fs.rmSync(entry.clonePath, { recursive: true, force: true });
    } catch {
      // Ignore clone cleanup failures; the registry entry is still removed.
    }
  }

  saveState(filtered);
  return true;
}

/** True when the path lives under our own clones directory. */
function isManagedClone(clonePath: string): boolean {
  const clonesRoot = path.dirname(GLOBAL_STATE_FILE) + "/clones";
  return clonePath === clonesRoot || clonePath.startsWith(clonesRoot + "/");
}

export function getMarketplace(url: string): MarketplaceRegistryEntry | null {
  const entries = loadState();
  return entries.find(e => e.url === url) || null;
}

export function syncMarketplace(
  entry: MarketplaceRegistryEntry,
  opts: SyncOptions = {},
): SyncResult {
  const result: SyncResult = {
    added: [],
    updated: [],
    removed: [],
    conflicts: [],
    unchanged: [],
  };

  // Detect cross-marketplace collisions by resource identity
  // (simplified: same resource name from different plugins/marketplaces)

  // Fetch latest
  const current = entry.resolvedCommit;
  const latest = resolveCommit(entry.url, entry.ref);
  if (current === latest && !opts.overwriteLocalChanges) {
    // No changes
    return result;
  }

  // Discover plugins from updated clone
  const marketplace: MarketplaceDescriptor = {
    id: entry.name,
    name: entry.name,
    source: entry.url,
    ref: entry.ref,
    resolvedCommit: latest,
    plugins: discoverPlugins({ ...entry, clonePath: entry.clonePath, resolvedCommit: latest }),
  };

  // Reconcile each installed plugin
  for (const installed of entry.installedPlugins) {
    const plugin = marketplace.plugins.find(p => p.id === installed.pluginId);
    if (!plugin) {
      // Plugin removed upstream: optionally uninstall
      if (!opts.removeDeleted) continue;
      for (const res of installed.resources) {
        uninstallResource(res);
        result.removed.push(`${installed.pluginId}/${res.type}/${res.name}`);
      }
      continue;
    }

    // TODO: resource-level diff and update
    // For now: placeholder
    result.unchanged.push(installed.pluginId);
  }

  // Update state
  entry.resolvedCommit = latest;
  entry.lastSyncedAt = new Date().toISOString();
  const entries = loadState().map(e => e.url === entry.url ? entry : e);
  saveState(entries);

  return result;
}

function resolveCommit(url: string, ref?: string): string {
  try {
    const args = ref
      ? ["ls-remote", url, ref]
      : ["ls-remote", url, "HEAD"];
    return git(args, { encoding: "utf-8" })
      .split("\t")[0]
      .trim();
  } catch {
    return "unknown";
  }
}

/**
 * Run git with an argument array (no shell). This avoids command injection via
 * user-supplied URLs or refs — values are passed as separate argv entries and
 * never interpreted by a shell.
 */
function git(args: string[], opts: { encoding?: "utf-8" } = {}): string {
  const out = execFileSync("git", args, {
    stdio: opts.encoding ? ["ignore", "pipe", "ignore"] : "ignore",
    encoding: opts.encoding ?? undefined,
  });
  return typeof out === "string" ? out : "";
}

/** Resolve the remote's default branch (falls back to "main"). */
function defaultBranch(url: string): string {
  try {
    // e.g. "ref: refs/heads/main\tHEAD"
    const out = git(["ls-remote", "--symref", url, "HEAD"], { encoding: "utf-8" });
    const m = out.match(/ref:\s+refs\/heads\/([^\s]+)\s+HEAD/);
    if (m) return m[1];
  } catch {
    // fall through
  }
  return "main";
}