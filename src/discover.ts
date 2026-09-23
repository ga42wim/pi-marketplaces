import fs from "node:fs";
/**
 * Plugin and resource discovery from a marketplace repository clone.
 *
 * Looks for standard directories inside each plugin:
 * - agents/ → agent definitions (Markdown)
 * - skills/ → skills (SKILL.md files in subdirectories)
 * - rules/ → rules (.mdc files or .md)
 * - references/ → reference docs (.md)
 */

import { PluginDescriptor, ResourceDescriptor, ResourceType } from "./types";
import { parsePlugin, parseMarketplace } from "./manifest";

const RESOURCE_DIRS: Record<ResourceType, string[]> = {
  agent: ["agents"],
  skill: ["skills"],
  rule: ["rules"],
  reference: ["references"],
  other: [],
};

function exists(fs: any, path: string): boolean {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listFiles(fs: any, dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Detect agent Markdown files inside a directory. */
function detectAgents(fs: any, pluginDir: string): ResourceDescriptor[] {
  const agentsDir = pluginDir + "/agents";
  if (!exists(fs, agentsDir)) return [];

  const out: ResourceDescriptor[] = [];
  for (const f of listFiles(fs, agentsDir)) {
    if (!f.endsWith(".md")) continue;
    const src = agentsDir + "/" + f;
    const stem = f.replace(/\.md$/, "");
    const content = readSafe(fs, src);
    const meta = extractFrontmatter(content);
    out.push({
      type: "agent",
      name: meta.name || stem,
      sourcePath: src,
      isDirectory: false,
      displayName: meta.name || stem,
      description: meta.description,
      metadata: meta.metadata,
      rawMetadata: meta.raw,
      sourcePlugin: "",
    });
  }
  return out;
}

/** Detect skills in skills/<name>/SKILL.md tree structure. */
function detectSkills(fs: any, pluginDir: string): ResourceDescriptor[] {
  const skillsDir = pluginDir + "/skills";
  if (!exists(fs, skillsDir)) return [];

  const out: ResourceDescriptor[] = [];
  for (const entry of listFiles(fs, skillsDir)) {
    const skillPath = skillsDir + "/" + entry;
    const skillFile = skillPath + "/SKILL.md";
    if (!exists(fs, skillPath)) continue;

    let name = entry;
    let description: string | undefined;
    let metadata: Record<string, unknown> | undefined;
    let rawMetadata: Record<string, unknown> | undefined;

    if (exists(fs, skillFile)) {
      const content = readSafe(fs, skillFile);
      const meta = extractFrontmatter(content);
      name = meta.name || entry;
      description = meta.description;
      metadata = meta.metadata;
      rawMetadata = meta.raw;
    }

    out.push({
      type: "skill",
      name,
      sourcePath: skillPath,
      isDirectory: true,
      displayName: name,
      description,
      metadata,
      rawMetadata,
      sourcePlugin: "",
    });
  }
  return out;
}

/** Detect rules (files with .mdc or .md extension). */
function detectRules(fs: any, pluginDir: string): ResourceDescriptor[] {
  const rulesDir = pluginDir + "/rules";
  if (!exists(fs, rulesDir)) return [];

  const out: ResourceDescriptor[] = [];
  for (const f of listFiles(fs, rulesDir)) {
    if (!f.endsWith(".mdc") && !f.endsWith(".md")) continue;
    const src = rulesDir + "/" + f;
    const name = f.replace(/\.(mdc|md)$/, "");
    out.push({
      type: "rule",
      name,
      sourcePath: src,
      isDirectory: false,
      displayName: name,
      sourcePlugin: "",
    });
  }
  return out;
}

/** Detect references (Markdown files). */
function detectReferences(fs: any, pluginDir: string): ResourceDescriptor[] {
  const refDir = pluginDir + "/references";
  if (!exists(fs, refDir)) return [];

  const out: ResourceDescriptor[] = [];
  for (const f of listFiles(fs, refDir)) {
    if (!f.endsWith(".md")) continue;
    const src = refDir + "/" + f;
    const name = f.replace(/\.md$/, "");
    out.push({
      type: "reference",
      name,
      sourcePath: src,
      isDirectory: false,
      displayName: name,
      sourcePlugin: "",
    });
  }
  return out;
}

/** Very small YAML frontmatter extractor for Markdown resources. */
function extractFrontmatter(
  content: string,
): { name?: string; description?: string; metadata?: Record<string, unknown>; raw: Record<string, unknown> } {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!m) return { raw: {} };

  const raw: Record<string, unknown> = {};
  const nameMatch = m[1].match(/^name:\s*(.+)$/m);
  const descMatch = m[1].match(/^description:\s*(.+)$/m);
  const roleMatch = m[1].match(/^role:\s*(.+)$/m);

  if (nameMatch) raw.name = nameMatch[1].trim();
  if (descMatch) raw.description = descMatch[1].trim();
  if (roleMatch) raw.role = roleMatch[1].trim();

  // Remaining lines become a metadata bag for unsupported keys.
  const metadata: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\S+):\s*(.+)$/);
    if (kv) {
      const key = kv[1];
      const val = kv[2].trim();
      if (key !== "name" && key !== "description" && key !== "role") {
        metadata[key] = val;
      }
    }
  }

  return {
    name: raw.name as string | undefined,
    description: raw.description as string | undefined,
    metadata,
    raw,
  };
}

function readSafe(fs: any, path: string): string {
  try {
    return fs.readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/** Build a PluginDescriptor from a parsed marketplace plugin manifest. */
export function discoverPlugin(
  marketplaceRoot: string,
  pluginManifest: any,
): PluginDescriptor {
  // `sourcePath` may already be absolute (adapters resolve it against the
  // marketplace root); only join when it is relative.
  const raw = pluginManifest.sourcePath || pluginManifest.source || pluginManifest.id;
  const pluginDir = isAbsolute(raw) ? raw : joinPosix(marketplaceRoot, raw);
  const plugin = parsePlugin(pluginDir);

  const agents = detectAgents(fs, pluginDir);
  const skills = detectSkills(fs, pluginDir);
  const rules = detectRules(fs, pluginDir);
  const references = detectReferences(fs, pluginDir);

  return {
    id: plugin.id,
    name: plugin.name,
    description: plugin.description,
    version: plugin.version,
    sourcePath: pluginDir,
    agents,
    skills,
    rules,
    references,
    other: [],
    metadata: plugin.raw || {},
  };
}

function isAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

/** Join and normalize POSIX-ish paths without pulling in node:path. */
function joinPosix(base: string, rel: string): string {
  const parts = (base.replace(/\/+$/, "") + "/" + rel).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" && out.length) continue;
    if (part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return (base.startsWith("/") ? "/" : "") + out.filter(Boolean).join("/");
}

/** Discover all plugins in a marketplace clone. */
export function discoverPlugins(marketplace: any): PluginDescriptor[] {
  const root = marketplace.clonePath || marketplace.source;
  const market = parseMarketplace(root);
  if (!market) return [];

  const plugins: PluginDescriptor[] = [];
  for (const p of market.plugins || []) {
    try {
      plugins.push(discoverPlugin(root, p));
    } catch (err) {
      // Log and continue — partial discovery is fine.
      console.warn("Failed to discover plugin", p.id, err);
    }
  }
  return plugins;
}

export { extractFrontmatter };