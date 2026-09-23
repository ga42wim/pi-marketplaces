/**
 * Core data model for pi-marketplaces.
 *
 * The marketplace is the source of truth. This module defines the normalized
 * representation that all marketplace-format adapters produce.
 */

export type ResourceType =
  | "agent"
  | "skill"
  | "rule"
  | "reference"
  | "other";

export type InstallationScope = "global" | "project";

export interface MarketplaceManifest {
  /** Human-readable marketplace display name. */
  name: string;
  /** Optional description of the marketplace. */
  description?: string;
  /** Plugins declared by the marketplace manifest. */
  plugins: MarketplacePluginManifest[];
  /** Raw manifest payload, kept for adapter-specific metadata. */
  raw?: Record<string, unknown>;
}

export interface MarketplacePluginManifest {
  /** Stable plugin identifier. Falls back to directory name. */
  id: string;
  /** Display name. Falls back to id. */
  name: string;
  /** Plugin description. */
  description?: string;
  /** Relative path from the marketplace repository root. */
  sourcePath: string;
  /** Optional version string. */
  version?: string;
  /** Raw plugin manifest payload. */
  raw?: Record<string, unknown>;
}

export interface ResourceDescriptor {
  /** Normalized resource type. */
  type: ResourceType;
  /** Stable resource identity (usually a file stem or directory name). */
  name: string;
  /** Relative path inside the marketplace repository. */
  sourcePath: string;
  /** Whether this resource is a single file or a directory tree. */
  isDirectory: boolean;
  /** Display name for the browser. */
  displayName: string;
  /** Optional description parsed from frontmatter/manifest. */
  description?: string;
  /** Frontmatter metadata for Markdown-based resources. */
  metadata?: Record<string, unknown>;
  /** Raw source payload (e.g. frontmatter) for lossless round-tripping. */
  rawMetadata?: Record<string, unknown>;
  /** Source plugin id. */
  sourcePlugin: string;
}

export interface PluginDescriptor {
  id: string;
  name: string;
  description?: string;
  version?: string;
  sourcePath: string;
  agents: ResourceDescriptor[];
  skills: ResourceDescriptor[];
  rules: ResourceDescriptor[];
  references: ResourceDescriptor[];
  other: ResourceDescriptor[];
  metadata: Record<string, unknown>;
}

export interface MarketplaceDescriptor {
  id: string;
  name: string;
  description?: string;
  source: string;
  ref?: string;
  resolvedCommit?: string;
  plugins: PluginDescriptor[];
}

export interface MarketplaceRegistryEntry {
  /** User-facing marketplace name. */
  name: string;
  /** Git repository URL. */
  url: string;
  /** Branch, tag, or ref (optional). */
  ref?: string;
  /** Resolved commit SHA after last fetch. */
  resolvedCommit?: string;
  /** Local clone path managed by pi-marketplaces. */
  clonePath: string;
  /** ISO timestamp of registration. */
  registeredAt: string;
  /** ISO timestamp of last successful sync. */
  lastSyncedAt?: string;
  /** Installed plugins for this marketplace. */
  installedPlugins: InstalledPluginState[];
}

export interface InstalledPluginState {
  pluginId: string;
  scope: InstallationScope;
  /** Resource types selected at install time. */
  resourceTypes: ResourceType[];
  /** ISO timestamp of installation. */
  installedAt: string;
  /** Resources tracked at install/sync time. */
  resources: InstalledResourceState[];
}

export interface InstalledResourceState {
  type: ResourceType;
  name: string;
  sourcePath: string;
  destination: string;
  scope: InstallationScope;
  /** All files managed by this resource (file or directory tree). */
  managedFiles: string[];
  /** Hash of the installed content at last sync. */
  contentHash?: string;
  /** Hash of the upstream content at last sync. */
  upstreamHash?: string;
  installedAt: string;
  lastSyncedAt?: string;
  /** Whether the resource was locally modified after installation. */
  locallyModified?: boolean;
}

export interface ProjectConfig {
  /** Disable whole plugins for this project. */
  plugins?: {
    disable?: string[];
    enable?: string[];
  };
  /** Disable individual skills. */
  skills?: {
    disable?: string[];
    enable?: string[];
  };
  /** Disable individual agents. */
  agents?: {
    disable?: string[];
    enable?: string[];
  };
  /** Explicit project-local overrides keyed by resource identity. */
  overrides?: Record<string, string>;
}

export interface SyncOptions {
  /** Overwrite locally modified managed resources without prompting. */
  overwriteLocalChanges?: boolean;
  /** Remove resources deleted upstream (default true). */
  removeDeleted?: boolean;
  /** Non-interactive: skip prompts and report conflicts instead. */
  nonInteractive?: boolean;
}

export interface SyncResult {
  updated: string[];
  added: string[];
  removed: string[];
  conflicts: string[];
  unchanged: string[];
}

export interface InstallOptions {
  scope: InstallationScope;
  resourceTypes: ResourceType[];
  /** Non-interactive: fail on conflicts instead of prompting. */
  nonInteractive?: boolean;
  /** Project root for project-scoped installs. */
  projectRoot?: string;
}

export interface InstallPreview {
  marketplace: string;
  plugin: string;
  scope: InstallationScope;
  resources: ResourceDescriptor[];
  conflicts: InstallConflict[];
}

export interface InstallConflict {
  resource: ResourceDescriptor;
  destination: string;
  reason: "unmanaged" | "collision" | "modified";
  message: string;
}

export interface EffectiveResource {
  type: ResourceType;
  name: string;
  destination: string;
  scope: InstallationScope;
  marketplace: string;
  plugin: string;
  /** Whether this resource is currently disabled by project config. */
  disabled: boolean;
}
