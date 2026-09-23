import crypto from "node:crypto";
/**
 * Resource installation.
 *
 * Installs agents and skills into Pi's standard global or project locations.
 * Tracks managed files for safe synchronization and uninstall.
 */

import {
  ResourceType,
  ResourceDescriptor,
  InstalledResourceState,
  InstallConflict,
  InstallPreview,
} from "./types";
import { GLOBAL_AGENTS_DIR, GLOBAL_SKILLS_DIR, PROJECT_AGENTS_DIR, PROJECT_SKILLS_DIR } from "./paths";
import { convertResourceToPiAgent } from "./cursor";

import fs from "node:fs";
import path from "node:path";

export const RULES_DIRNAME = "rules";
export const REFERENCES_DIRNAME = "references";

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyDir(src: string, dest: string) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src)) {
    const s = src + "/" + entry;
    const d = dest + "/" + entry;
    const stat = fs.statSync(s);
    if (stat.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function copyFile(src: string, dest: string) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

export function destinationFor(scope: "global" | "project", type: ResourceType, name: string): string {
  const base = scope === "global"
    ? (type === "agent" ? GLOBAL_AGENTS_DIR : GLOBAL_SKILLS_DIR)
    : (type === "agent" ? PROJECT_AGENTS_DIR : PROJECT_SKILLS_DIR);
  return base + "/" + name;
}

/** Directory that backs a resource type for a given scope. */
export function baseDirFor(scope: "global" | "project", type: ResourceType): string {
  if (type === "agent") return scope === "global" ? GLOBAL_AGENTS_DIR : PROJECT_AGENTS_DIR;
  if (type === "rule" || type === "reference") {
    const root = scope === "global"
      ? GLOBAL_AGENTS_DIR.replace(/\/agents$/, "")
      : PROJECT_AGENTS_DIR.replace(/\/agents$/, "");
    return root + "/" + (type === "rule" ? RULES_DIRNAME : REFERENCES_DIRNAME);
  }
  return scope === "global" ? GLOBAL_SKILLS_DIR : PROJECT_SKILLS_DIR;
}

export function previewInstall(
  scope: "global" | "project",
  resources: ResourceDescriptor[],
): InstallPreview {
  const conflicts: InstallConflict[] = [];
  const preview: InstallPreview = {
    marketplace: "",
    plugin: "",
    scope,
    resources,
    conflicts,
  };

  for (const r of resources) {
    const destName = r.isDirectory ? r.name : path.basename(r.sourcePath);
    const dest = baseDirFor(scope, r.type) + "/" + destName;
    if (fs.existsSync(dest)) {
      conflicts.push({
        resource: r,
        destination: dest,
        reason: "unmanaged",
        message: `Destination already exists: ${dest}`,
      });
    }
  }
  return preview;
}

/** Install a single resource. Returns false if blocked by a conflict. */
export function installResource(
  scope: "global" | "project",
  resource: ResourceDescriptor,
  opts: { nonInteractive?: boolean; projectRoot?: string } = {},
): InstalledResourceState | null {
  // For file-based resources (agents/rules/references) keep the source
  // filename so the extension (.md/.mdc) is preserved. Directories (skills)
  // use the resource name as the folder name.
  const destName = resource.isDirectory
    ? resource.name
    : path.basename(resource.sourcePath);
  const dest = baseDirFor(scope, resource.type) + "/" + destName;

  if (fs.existsSync(dest)) {
    if (opts.nonInteractive) return null;
    // In interactive mode the caller resolves conflicts; here we refuse.
    return null;
  }

  if (resource.isDirectory) {
    copyDir(resource.sourcePath, dest);
  } else {
    let content = fs.readFileSync(resource.sourcePath, "utf-8");
    if (resource.type === "agent") {
      content = convertResourceToPiAgent(resource, content);
    }
    ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, content);
  }

  const managedFiles: string[] = [];
  if (resource.isDirectory) {
    collectFiles(dest, managedFiles);
  } else {
    managedFiles.push(dest);
  }

  const now = new Date().toISOString();
  return {
    type: resource.type,
    name: resource.name,
    sourcePath: resource.sourcePath,
    destination: dest,
    scope,
    managedFiles,
    contentHash: hashFiles(managedFiles),
    upstreamHash: hashFiles(managedFiles),
    installedAt: now,
    lastSyncedAt: now,
  };
}

function collectFiles(dir: string, out: string[]) {
  for (const entry of fs.readdirSync(dir)) {
    const p = dir + "/" + entry;
    const stat = fs.statSync(p);
    if (stat.isDirectory()) collectFiles(p, out);
    else out.push(p);
  }
}

function hashFiles(files: string[]): string | undefined {
  const hash = crypto.createHash("sha256");
  for (const f of files.sort()) {
    if (fs.existsSync(f)) {
      hash.update(f);
      hash.update("\0");
      hash.update(fs.readFileSync(f));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

export function installPluginResources(
  scope: "global" | "project",
  resources: ResourceDescriptor[],
  opts: { nonInteractive?: boolean; projectRoot?: string } = {},
): { installed: InstalledResourceState[]; skipped: ResourceDescriptor[] } {
  const installed: InstalledResourceState[] = [];
  const skipped: ResourceDescriptor[] = [];

  for (const r of resources) {
    const state = installResource(scope, r, opts);
    if (state) installed.push(state);
    else skipped.push(r);
  }

  return { installed, skipped };
}

export function uninstallResource(state: InstalledResourceState): void {
  for (const f of state.managedFiles.sort().reverse()) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      // Ignore missing files
    }
  }
  // Prune empty directories. For directory resources (skills) the
  // destination itself is the directory; for file resources we prune the
  // containing directories. Walk up towards the scope root, but never
  // delete the root itself.
  const root = baseDirFor(state.scope, state.type);
  const isDir = fs.existsSync(state.destination) && fs.statSync(state.destination).isDirectory();
  let dir = isDir ? state.destination : path.dirname(state.destination);
  while (dir.startsWith(root) && dir !== root) {
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      else break;
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}