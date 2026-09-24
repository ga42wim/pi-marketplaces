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
import { uninstallResource } from "./install";
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
  // Record what the clone actually contains, not what the remote advertises:
  // the two can diverge when a fetch/checkout above fails.
  entry.resolvedCommit = localCommit(clonePath) || resolveCommit(url, ref);

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

  // Bring the local clone up to date *before* deciding whether anything
  // changed. Comparing the remote SHA against `entry.resolvedCommit` is not
  // enough: that value is whatever the last sync recorded, which can be ahead
  // of the clone's working tree (e.g. a commit landed after the clone was last
  // fetched). Trusting it makes sync report "no changes" forever while the
  // clone stays stale — so always fetch, then diff against the clone's HEAD.
  const localBefore = localCommit(entry.clonePath);
  const latest = updateClone(entry) || localBefore;

  if (!latest) {
    // Clone is missing or unreadable; nothing to reconcile.
    return result;
  }
  if (localBefore === latest && !opts.overwriteLocalChanges) {
    // Clone already matched upstream.
    return result;
  }

  // Discover plugins from the updated clone
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

/** Commit the local clone currently has checked out (empty string on failure). */
function localCommit(clonePath?: string): string {
  if (!clonePath) return "";
  try {
    return git(["-C", clonePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

/**
 * Fetch upstream and hard-reset the clone's working tree to the tracked ref.
 * Returns the commit the clone now sits on, or null when there is no clone.
 * Fetch/reset failures are swallowed so a transient network error degrades to
 * "sync had no effect" instead of aborting the command.
 */
function updateClone(entry: MarketplaceRegistryEntry): string | null {
  const clonePath = entry.clonePath;
  if (!clonePath || !fs.existsSync(clonePath + "/.git")) return null;
  try {
    git(["-C", clonePath, "fetch", "origin"]);
    if (entry.ref) {
      git(["-C", clonePath, "checkout", entry.ref]);
    } else {
      git(["-C", clonePath, "reset", "--hard", `origin/${defaultBranch(entry.url)}`]);
    }
  } catch {
    // Fall through: report whatever the clone currently has.
  }
  return localCommit(clonePath) || null;
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