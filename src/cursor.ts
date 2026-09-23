import fs from "node:fs";
/**
 * Cursor agent adapter.
 *
 * Converts Cursor-style Markdown agents (with YAML frontmatter) to Pi agent
 * definitions. Preserves unknown frontmatter fields and the Markdown body.
 */

import { ResourceDescriptor, extractFrontmatter } from "./discover";

export interface CursorAgentDefinition {
  name: string;
  role?: string;
  description?: string;
  body: string;
  frontmatter: Record<string, unknown>;
  rawFrontmatter: Record<string, unknown>;
  sourcePath: string;
}

/** Parse a Cursor-style agent Markdown file. */
export function parseCursorAgent(filePath: string): CursorAgentDefinition | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const fm = extractFrontmatter(content);
    const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "");
    return {
      name: fm.name || filePath.split("/").pop()?.replace(/\.md$/, "") || "unknown",
      role: fm.raw.role as string | undefined,
      description: fm.description || fm.raw.description as string | undefined,
      body: body.trim(),
      frontmatter: fm.metadata,
      rawFrontmatter: fm.raw,
      sourcePath: filePath,
    };
  } catch {
    return null;
  }
}

/** Convert a Cursor agent to a Pi-compatible agent Markdown string. */
export function convertCursorToPiAgent(cursor: CursorAgentDefinition): string {
  const lines: string[] = [];

  // Preserve known Pi-compatible frontmatter
  const piFrontmatter: Record<string, string> = {};
  if (cursor.name) piFrontmatter.name = cursor.name;
  if (cursor.role) piFrontmatter.role = cursor.role;
  if (cursor.description) piFrontmatter.description = cursor.description;

  // Include preserved unknown fields as comments so they're not lost
  const unknownFields: string[] = [];
  for (const [k, v] of Object.entries(cursor.rawFrontmatter)) {
    if (!["name", "role", "description"].includes(k)) {
      unknownFields.push(`# ${k}: ${JSON.stringify(v)}`);
    }
  }

  if (Object.keys(piFrontmatter).length > 0) {
    lines.push("---");
    for (const [k, v] of Object.entries(piFrontmatter)) {
      lines.push(`${k}: ${v}`);
    }
    if (unknownFields.length > 0) {
      lines.push("# preserved-unknown-fields:");
      lines.push(...unknownFields);
    }
    lines.push("---");
    lines.push("");
  }

  lines.push(cursor.body);
  return lines.join("\n");
}

/** Convert a ResourceDescriptor (from discovery) to a Pi agent file. */
export function convertResourceToPiAgent(
  resource: ResourceDescriptor,
  content: string,
): string {
  // If it already has frontmatter, preserve it and ensure required fields exist
  const fm = extractFrontmatter(content);
  const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "");

  const piFrontmatter: Record<string, string> = {
    name: fm.name || resource.name,
    description: fm.description || resource.description || "",
  };

  if (fm.raw.role) piFrontmatter.role = fm.raw.role as string;

  // Preserve unknown fields as comments
  const unknownFields: string[] = [];
  for (const [k, v] of Object.entries(fm.raw)) {
    if (!["name", "role", "description"].includes(k)) {
      unknownFields.push(`# ${k}: ${JSON.stringify(v)}`);
    }
  }
  for (const [k, v] of Object.entries(resource.rawMetadata || {})) {
    if (!["name", "role", "description"].includes(k) && !fm.raw[k]) {
      unknownFields.push(`# ${k}: ${JSON.stringify(v)}`);
    }
  }

  const lines: string[] = [];
  if (Object.keys(piFrontmatter).length > 0 || unknownFields.length > 0) {
    lines.push("---");
    for (const [k, v] of Object.entries(piFrontmatter)) {
      lines.push(`${k}: ${v}`);
    }
    if (unknownFields.length > 0) {
      lines.push("# preserved-unknown-fields:");
      lines.push(...unknownFields);
    }
    lines.push("---");
    lines.push("");
  }
  lines.push(body.trim());
  return lines.join("\n");
}