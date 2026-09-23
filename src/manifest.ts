/**
 * Marketplace manifest parsing with adapter-based format support.
 *
 * Supports Claude-style (`.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`)
 * and other marketplace formats via adapters.
 */

import fs from "node:fs";
import {
  MarketplaceManifest,
  MarketplacePluginManifest,
  PluginDescriptor,
  ResourceDescriptor,
} from "./types";

export interface ManifestAdapter {
  canHandle(marketplaceRoot: string): boolean;
  parseMarketplace(marketplaceRoot: string): MarketplaceManifest | null;
  parsePlugin(pluginPath: string): MarketplacePluginManifest | null;
}

export class ClaudeStyleManifestAdapter implements ManifestAdapter {
  canHandle(marketplaceRoot: string): boolean {
    const marketplaceFile = marketplaceRoot + "/.claude-plugin/marketplace.json";
    try {
      return fs.existsSync(marketplaceFile);
    } catch {
      return false;
    }
  }

  parseMarketplace(marketplaceRoot: string): MarketplaceManifest | null {
    const marketplaceFile = marketplaceRoot + "/.claude-plugin/marketplace.json";
    try {
      const data = JSON.parse(fs.readFileSync(marketplaceFile, "utf-8"));
      const plugins: MarketplacePluginManifest[] = [];

      for (const pluginInfo of data.plugins || []) {
        const pluginPath = marketplaceRoot + "/" + pluginInfo.source;
        const plugin = this.parsePlugin(pluginPath);
        if (plugin) {
          plugins.push(plugin);
        }
      }

      return {
        name: data.name || "Unknown Marketplace",
        description: data.description,
        plugins,
        raw: data,
      };
    } catch {
      return null;
    }
  }

    parsePlugin(pluginPath: string): MarketplacePluginManifest | null {
    const pluginFile = pluginPath + "/.claude-plugin/plugin.json";
    try {
      const data = JSON.parse(fs.readFileSync(pluginFile, "utf-8"));
      const id = data.name || pluginPath.split("/").pop() || "unknown";

      return {
        id,
        name: data.name || id,
        description: data.description,
        version: data.version,
        sourcePath: pluginPath,
        raw: data,
      };
    } catch {
      const id = pluginPath.split("/").pop() || "unknown";
      return {
        id,
        name: id,
        sourcePath: pluginPath,
      };
    }
  }
}

/**
 * Cursor-style manifest adapter (`.cursor/plugin.json`).
 */
export class CursorManifestAdapter implements ManifestAdapter {
  canHandle(marketplaceRoot: string): boolean {
    try {
      return fs.existsSync(marketplaceRoot + "/.cursor/plugin.json");
    } catch {
      return false;
    }
  }

  parseMarketplace(marketplaceRoot: string): MarketplaceManifest | null {
    // Cursor format may not have a top-level marketplace.json; return null
    // so the caller can fall through to plugin-level detection.
    return null;
  }

  parsePlugin(pluginPath: string): MarketplacePluginManifest | null {
    const pluginFile = pluginPath + "/.cursor/plugin.json";
    try {
      const data = JSON.parse(fs.readFileSync(pluginFile, "utf-8"));
      const id = data.name || pluginPath.split("/").pop() || "unknown";

      return {
        id,
        name: data.name || id,
        description: data.description,
        version: data.version,
        sourcePath: pluginPath,
        raw: data,
      };
    } catch {
      const id = pluginPath.split("/").pop() || "unknown";
      return {
        id,
        name: id,
        sourcePath: pluginPath,
      };
    }
  }
}

const DEFAULT_ADAPTERS: ManifestAdapter[] = [
  new ClaudeStyleManifestAdapter(),
  new CursorManifestAdapter(),
];

export function getManifestAdapters(): ManifestAdapter[] {
  return DEFAULT_ADAPTERS;
}

export function detectMarketplaceFormat(marketplaceRoot: string): ManifestAdapter | null {
  for (const adapter of getManifestAdapters()) {
    if (adapter.canHandle(marketplaceRoot)) {
      return adapter;
    }
  }
  return null;
}

export function parseMarketplace(marketplaceRoot: string): MarketplaceManifest | null {
  const adapter = detectMarketplaceFormat(marketplaceRoot);
  return adapter ? adapter.parseMarketplace(marketplaceRoot) : null;
}

export function parsePlugin(pluginPath: string): MarketplacePluginManifest | null {
  for (const adapter of getManifestAdapters()) {
    const manifest = adapter.parsePlugin(pluginPath);
    if (manifest) return manifest;
  }
  const id = pluginPath.split("/").pop() || "unknown";
  return { id, name: id, sourcePath: pluginPath };
}