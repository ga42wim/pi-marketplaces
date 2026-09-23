/**
 * Filtering layer for project-level resource enable/disable configuration.
 *
 * Calculates the effective resource set based on global installation + project
 * config + Pi's native precedence.
 */

import { InstalledResourceState, ProjectConfig, EffectiveResource } from "./types";
import { destinationFor } from "./install";

/** Core filter: whether a resource is disabled by project config. */
export function isDisabledByConfig(
  resource: InstalledResourceState,
  pluginId: string,
  projectConfig?: ProjectConfig,
): boolean {
  const cfg = projectConfig ?? {};
  if (cfg.plugins?.disable?.includes(pluginId)) return true;
  if (resource.type === "skill" && cfg.skills?.disable?.includes(resource.name)) return true;
  if (resource.type === "agent" && cfg.agents?.disable?.includes(resource.name)) return true;
  return false;
}

/** Calculate effective resources for a project. */
export function calculateEffectiveResources(
  globalResources: InstalledResourceState[],
  projectConfig?: ProjectConfig,
): EffectiveResource[] {
  const cfg = projectConfig ?? {};
  return globalResources
    .filter(r => !isDisabledByConfig(r, r.sourcePath.split("/").pop() || r.name, cfg))
    .map(r => ({
      type: r.type,
      name: r.name,
      destination: destinationFor(r.scope, r.type, r.name),
      scope: r.scope,
      marketplace: r.sourcePlugin || "unknown",
      plugin: r.sourcePath.split("/").pop() || "unknown",
      disabled: isDisabledByConfig(r, r.sourcePath.split("/").pop() || r.name, cfg),
    }));
}

export function hasPluginEnabled(
  pluginId: string,
  projectConfig?: ProjectConfig,
): boolean {
  if (!projectConfig?.plugins?.disable) return true;
  return !projectConfig.plugins.disable.includes(pluginId);
}