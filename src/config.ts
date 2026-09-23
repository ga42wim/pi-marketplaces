/**
 * Configuration layer.
 *
 * The global marketplace registry lives at a single canonical file
 * (`GLOBAL_STATE_FILE`, i.e. ~/.pi/agent/marketplaces-state.json) so that the
 * add / list / install / sync / status commands all read and write the same
 * data. Project-level config lives at .pi-marketplaces.json (optional).
 */

import fs from "node:fs";
import path from "node:path";
import { MarketplaceRegistryEntry, ProjectConfig } from "./types";
import { GLOBAL_STATE_FILE } from "./paths";

// Kept for backwards compatibility with earlier imports.
export const GLOBAL_CONFIG_DIR = path.dirname(GLOBAL_STATE_FILE);
export const GLOBAL_CONFIG_FILE = GLOBAL_STATE_FILE;

export const PROJECT_CONFIG_FILE = ".pi-marketplaces.json";

export function loadGlobalConfig(): MarketplaceRegistryEntry[] {
  try {
    const data = JSON.parse(fs.readFileSync(GLOBAL_STATE_FILE, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function saveGlobalConfig(entries: MarketplaceRegistryEntry[]) {
  const dir = path.dirname(GLOBAL_STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(GLOBAL_STATE_FILE, JSON.stringify(entries, null, 2));
}

export function loadProjectConfig(cwd: string): ProjectConfig {
  try {
    const data = fs.readFileSync(path.join(cwd, PROJECT_CONFIG_FILE), "utf-8");
    return JSON.parse(data) as ProjectConfig;
  } catch {
    return {};
  }
}

export function saveProjectConfig(cwd: string, cfg: ProjectConfig) {
  fs.writeFileSync(path.join(cwd, PROJECT_CONFIG_FILE), JSON.stringify(cfg, null, 2));
}
