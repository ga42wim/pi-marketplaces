/**
 * pi-marketplaces extension entry point.
 *
 * Commands:
 *   /marketplaces [list]        List registered marketplaces
 *   /marketplaces show          Show installed plugins + resources
 *   /marketplaces add <url>     Register a marketplace (git URL or local path)
 *   /marketplaces install       Install plugins (interactive)
 *   /marketplaces uninstall     Remove installed plugins
 *   /marketplaces sync [url]    Pull upstream changes
 *   /marketplaces status        Sync + install summary
 *   /marketplaces config ...    Project-level enable/disable
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadGlobalConfig, loadProjectConfig, saveProjectConfig } from "./config";
import { addMarketplace, removeMarketplace, syncMarketplace, loadState, saveState } from "./sync";
import { discoverPlugins } from "./discover";
import { installPluginResources, uninstallResource, previewInstall } from "./install";
import { parseMarketplace } from "./manifest";
import { MultiSelect } from "./multiselect";
import {
  InstalledPluginState,
  MarketplaceRegistryEntry,
  PluginDescriptor,
  ResourceDescriptor,
  ResourceType,
} from "./types";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("marketplaces", {
    description: "Manage pi-marketplaces",
    handler: async (args, ctx) => {
      await handleMarketplacesCommand(pi, args, ctx);
    },
    getArgumentCompletions: (prefix: string) => {
      const subs = [
        "list",
        "plugins",
        "show",
        "add",
        "remove",
        "install",
        "uninstall",
        "sync",
        "status",
        "config",
        "help",
      ];
      const items = subs
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s }));
      return items.length ? items : null;
    },
  });

  // The marketplaces widget is transient output: it should stay on screen while
  // the user keeps working with /marketplaces, but disappear once they move on.
  // Extension commands skip this event, so a clear here fires for every *other*
  // input — i.e. exactly when the user has stopped interacting with the plugin.
  pi.on("input", async (_event, ctx) => {
    ctx.ui.setWidget("marketplaces", undefined);
    return { action: "continue" };
  });
}

/* ------------------------------------------------------------------ */
/* Select helpers — Pi's ctx.ui.select takes/returns plain strings.    */
/* ------------------------------------------------------------------ */

/**
 * Present a list of labelled choices and return the chosen value.
 * `choices` are `[value, label]` pairs; the label is shown to the user.
 */
async function pick(
  ctx: any,
  title: string,
  choices: Array<[string, string]>,
): Promise<string | undefined> {
  if (!choices.length) return undefined;
  const labels = choices.map(([, label]) => label);
  const chosen = await ctx.ui.select(title, labels);
  if (chosen === undefined) return undefined;
  const idx = labels.indexOf(chosen);
  return idx >= 0 ? choices[idx][0] : undefined;
}

/**
 * Multi-pick a set of values.
 *
 * In TUI mode this uses a checkbox component (space toggles, enter confirms).
 * In RPC / print modes `ctx.ui.custom` is unavailable, so we fall back to a
 * repeated single-select loop.
 */
async function pickMany(
  ctx: any,
  title: string,
  choices: Array<[string, string]>,
): Promise<string[]> {
  if (!choices.length) return [];

  if (ctx.mode === "tui") {
    const selected = await ctx.ui.custom<string[] | null>(
      (_tui: any, theme: any, _kb: any, done: (v: string[] | null) => void) => {
        const ms = new MultiSelect(
          title,
          choices.map(([value, label]) => ({ value, label })),
          theme,
        );
        ms.onDone = (values) => done(values);
        ms.onCancel = () => done(null);
        return {
          render: (width: number) => ms.render(width),
          handleInput: (data: string) => {
            ms.handleInput(data);
            _tui.requestRender();
          },
          invalidate: () => ms.invalidate(),
        };
      },
    );
    return selected ?? [];
  }

  // Fallback: repeated single selects, using a Done entry to finish.
  const chosen = new Set<string>();
  for (;;) {
    const remaining = choices.filter(([v]) => !chosen.has(v));
    const doneLabel = chosen.size
      ? `Done (selected: ${chosen.size})`
      : "Done (select nothing)";
    const labels = [
      ...remaining.map(([, label]) => (chosen.size ? `✓ ${label}` : label)),
      doneLabel,
    ];
    const labelToValue = new Map<string, string>();
    remaining.forEach(([v, label]) => labelToValue.set(chosen.size ? `✓ ${label}` : label, v));

    const answer = await ctx.ui.select(title, labels);
    if (answer === undefined) return [...chosen]; // cancelled → return what we have
    if (answer === doneLabel) return [...chosen];
    const value = labelToValue.get(answer);
    if (value === undefined) return [...chosen];
    chosen.add(value);
  }
}

/* ------------------------------------------------------------------ */
/* Command router                                                      */
/* ------------------------------------------------------------------ */

async function handleMarketplacesCommand(pi: ExtensionAPI, args: string, ctx: any) {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] || "list";
  const rest = parts.slice(1).join(" ");

  try {
    switch (sub) {
      case "add": await cmdAdd(pi, rest, ctx); break;
      case "remove":
      case "rm": await cmdRemove(pi, rest, ctx); break;
      case "list": await cmdList(pi, ctx); break;
      case "show":
      case "resources": await cmdShow(pi, ctx); break;
      case "install": await cmdInstall(pi, rest, ctx); break;
      case "uninstall":
      case "delete": await cmdUninstall(pi, rest, ctx); break;
      case "sync": await cmdSync(pi, rest, ctx); break;
      case "status": await cmdStatus(pi, rest, ctx); break;
      case "config": await cmdConfig(pi, rest, ctx); break;
      case "plugins": await cmdPlugins(pi, rest, ctx); break;
      case "help": cmdHelp(ctx, rest); break;
      default:
        ctx.ui.notify(`Unknown subcommand: ${sub}. Try /marketplaces help`, "error");
    }
  } catch (e: any) {
    ctx.ui.setStatus("marketplaces", undefined);
    ctx.ui.notify(`marketplaces error: ${e?.message ?? e}`, "error");
  }
}

function cmdHelp(ctx: any, topic?: string) {
  const t = (topic || "").trim();

  if (t === "install") {
    ctx.ui.setWidget("marketplaces", [
      "HOW TO INSTALL PLUGINS FROM A MARKETPLACE",
      "",
      "1. Register a marketplace (once):",
      "     /marketplaces add <git-url-or-local-path>",
      "   Examples:",
      "     /marketplaces add https://github.com/user/repo.git",
      "     /marketplaces add git@github.com:user/repo.git",
      "     /marketplaces add /path/to/local/marketplace",
      "",
      "   After cloning, add shows what was discovered and offers to install",
      "   plugins right away (pick plugins → scope → resource types).",
      "   Flags:",
      "     --no-install / --source-only   just register, don't prompt to install",
      "     --yes / -y                     install with defaults, no prompt",
      "",
      "2. Browse what it offers:",
      "     /marketplaces plugins            # all plugins in all marketplaces",
      "     /marketplaces plugins dev        # filter by name",
      "",
      "3. Install a plugin:",
      "     /marketplaces install",
      "   You will be asked, step by step:",
      "     a) which marketplace",
      "     b) which plugins (pick several, then Done)",
      "     c) scope: Global (all projects) or Current project only",
      "     d) resource types: Agents / Skills / Rules / References",
      "",
      "   Non-interactive shorthand:",
      "     /marketplaces install <plugin> [<plugin> ...]        (global, all types)",
      "     /marketplaces install <plugin> --project             (project scope)",
      "     /marketplaces install <plugin> --types agents,skills",
      "",
      "Where resources land (Pi standard discovery paths):",
      "  global  agents:  ~/.pi/agent/agents/<name>.md",
      "  global  skills:  ~/.pi/agent/skills/<name>/SKILL.md",
      "  global  rules:   ~/.pi/agent/rules/<file>",
      "  project agents:  .pi/agents/<name>.md",
      "  project skills:  .pi/skills/<name>/SKILL.md",
      "",
      "Note: global agents require the pi-subagents extension to be active.",
      "Skills are discovered natively by Pi. After installing, /reload if needed.",
    ]);
    ctx.ui.notify("Help: installing plugins", "info");
    return;
  }

  if (t === "uninstall" || t === "remove") {
    ctx.ui.setWidget("marketplaces", [
      "HOW TO UNINSTALL",
      "",
      "UNINSTALL A PLUGIN (removes its installed resources):",
      "  /marketplaces uninstall                     pick interactively",
      "  /marketplaces uninstall my-plugin           by plugin name",
      "  /marketplaces uninstall plugin-a plugin-b   several at once",
      "  /marketplaces uninstall my-plugin --scope project",
      "  /marketplaces uninstall --marketplace acme-toolbox",
      "  /marketplaces uninstall --all               remove EVERYTHING installed",
      "",
      "  Only files that the installer created and still tracks are deleted.",
      "  Files you edited by hand, or unmanaged files, are left untouched.",
      "  Empty skill directories are pruned automatically.",
      "",
      "REMOVE A MARKETPLACE (unregister the source):",
      "  /marketplaces remove                        pick interactively",
      "  /marketplaces remove acme-toolbox          by name or URL",
      "  /marketplaces remove <url> --purge          also uninstall its plugins",
      "  /marketplaces remove <url> --keep-clone     keep the local git clone",
      "",
      "  By default, removing a marketplace deletes its local clone but",
      "  LEAVES already-installed resources in place (use --purge to also",
      "  remove them, or uninstall them first).",
      "",
      "After uninstalling skills/agents, run /reload to refresh Pi's list.",
    ]);
    ctx.ui.notify("Help: uninstall / remove", "info");
    return;
  }

  if (t === "config") {
    ctx.ui.setWidget("marketplaces", [
      "HOW TO USE THE PROJECT CONFIG (.pi-marketplaces.json)",
      "",
      "Installing globally makes a plugin available in EVERY project.",
      "The optional project config narrows that down per project:",
      "it DISABLES or ENABLES specific plugins / skills / agents.",
      "",
      "Management commands (they edit ./.pi-marketplaces.json):",
      "  /marketplaces config show            show the current file",
      "  /marketplaces config disable-plugin  turn plugins off in THIS project",
      "  /marketplaces config enable-plugin   turn them back on",
      "  /marketplaces config disable-skill   turn individual skills off",
      "  /marketplaces config disable-agent   turn individual agents off",
      "",
      "What the file looks like:",
      "  {",
      '    "plugins": { "disable": ["some-plugin"] },',,
      '    "skills":  { "disable": ["standup"] },',
      '    "agents":  { "disable": ["qa"] }',
      "  }",
      "",
      "Semantics:",
      "  • no file            → ALL globally-installed resources are available",
      "  • disable list       → those named resources are hidden in this project",
      "  • project install    → resources installed into .pi/ override globals",
      "   (.pi/agents/x.md overrides ~/.pi/agent/agents/x.md for this project)",
      "",
      "The file is meant to be committed so a team shares the same setup.",
      "Other marketplace data lives OUTSIDE the repo, in ~/.pi/agent/.",
      "",
      "IMPORTANT: disabling is currently recorded in the config, but Pi's",
      "native loaders do not yet consult it automatically. To truly hide a",
      "skill/agent in a project today, install that plugin at project scope",
      "instead, or remove it globally. Enforcement wiring is on the roadmap.",
    ]);
    ctx.ui.notify("Help: project config", "info");
    return;
  }

  if (t === "scopes") {
    ctx.ui.setWidget("marketplaces", [
      "GLOBAL vs PROJECT SCOPE",
      "",
      "GLOBAL  (default)",
      "  Stored once under ~/.pi/agent/. Available in every project.",
      "  Managed centrally; sync updates them everywhere.",
      "",
      "PROJECT",
      "  Stored inside the repo under .pi/ and committed with it.",
      "  Only active for that project and overrides global resources of",
      "  the same name. Use it when a project needs a pinned/variant setup.",
      "",
      "Precedence (highest first):",
      "  1. .pi/agents/<name>.md   (project, local)",
      "  2. .agents/agents/<name>.md (shared cross-tool workspace)",
      "  3. ~/.pi/agent/agents/<name>.md (global)",
      "",
      "Sync never overwrites files you edited locally, and never touches",
      "resources it does not own (unmanaged files are left alone).",
    ]);
    ctx.ui.notify("Help: scopes", "info");
    return;
  }

  // Default: overview
  ctx.ui.setWidget("marketplaces", [
    "pi-marketplaces — marketplace / package manager for agent resources",
    "",
    "USAGE",
    "  /marketplaces [command] [args]",
    "",
    "COMMANDS",
    "  list                     List registered marketplaces (default)",
    "  plugins [filter]         List plugins available in registered marketplaces",
    "  show                     Show installed plugins and their resources",
    "  add <url> [--no-install] Register a marketplace (guides you through install)",
    "  remove [url]             Unregister a marketplace",
    "  install [args]           Install plugins (interactive, or with args)",
    "  uninstall [plugin...]    Remove installed plugins (or --all)",
    "  sync [url]               Fetch upstream changes",
    "  status                   Sync + install summary",
    "  remove [url]             Unregister a marketplace (--purge to uninstall too)",
    "  config <cmd>             Project-level enable/disable (.pi-marketplaces.json)",
    "  help [topic]             Help; topics: install, uninstall, config, scopes",
    "",
    "QUICK START",
    "  /marketplaces add https://github.com/user/repo.git",
    "  /marketplaces plugins",
    "  /marketplaces install",
    "  /marketplaces show",
    "",
    "More:  /marketplaces help install | help uninstall | help config | help scopes",
  ]);
  ctx.ui.notify("pi-marketplaces help — try /marketplaces help install", "info");
}

async function cmdPlugins(pi: ExtensionAPI, args: string, ctx: any) {
  const entries = loadGlobalConfig();
  if (!entries.length) {
    ctx.ui.notify("No marketplaces registered. Use /marketplaces add <url>", "info");
    return;
  }

  const filter = args.trim().toLowerCase();
  const lines: string[] = ["Available plugins:", ""];
  let total = 0;

  for (const e of entries) {
    const manifest = parseMarketplace(e.clonePath);
    const plugins = manifest?.plugins ?? [];
    const matching = filter
      ? plugins.filter(
          (p) =>
            p.id.toLowerCase().includes(filter) ||
            p.name.toLowerCase().includes(filter),
        )
      : plugins;
    if (!matching.length) continue;

    const installedHere = new Set(e.installedPlugins.map((ip) => ip.pluginId));
    lines.push(`${e.name}:`);
    for (const p of matching) {
      total++;
      const mark = installedHere.has(p.id) ? " [installed]" : "";
      lines.push(`  ${p.id}${mark}`);
      if (p.description) lines.push(`      ${p.description}`);
    }
    lines.push("");
  }

  if (!total) {
    ctx.ui.notify(filter ? `No plugins match "${filter}"` : "No plugins found", "warning");
    return;
  }

  lines.push("Install with:  /marketplaces install   (or: /marketplaces install <plugin>)");
  ctx.ui.setWidget("marketplaces", lines);
  ctx.ui.notify(`${total} plugin(s) available`, "info");
}

/* ------------------------------------------------------------------ */
/* add                                                                 */
/* ------------------------------------------------------------------ */

async function cmdAdd(pi: ExtensionAPI, args: string, ctx: any) {
  const argv = args.trim().split(/\s+/).filter(Boolean);
  const yes = argv.includes("--yes") || argv.includes("-y");
  const noInstall = argv.includes("--no-install") || argv.includes("--source-only");
  const url = argv.find((a) => !a.startsWith("--"));

  if (!url) {
    if (!ctx.hasUI) {
      ctx.ui.notify("Usage: /marketplaces add <url|path> [--yes] [--no-install]", "error");
      return;
    }
    const input = await ctx.ui.input("Add Marketplace", "Git URL or local path:");
    if (!input) return;
    await doAdd(input, ctx, { yes, noInstall });
    return;
  }
  await doAdd(url, ctx, { yes, noInstall });
}

/** One-line resource tally for a plugin, e.g. "6 agents, 14 skills, 14 rules". */
function tallyPlugin(p: PluginDescriptor): string {
  const parts: string[] = [];
  if (p.agents.length) parts.push(`${p.agents.length} agent${p.agents.length === 1 ? "" : "s"}`);
  if (p.skills.length) parts.push(`${p.skills.length} skill${p.skills.length === 1 ? "" : "s"}`);
  if (p.rules.length) parts.push(`${p.rules.length} rule${p.rules.length === 1 ? "" : "s"}`);
  if (p.references.length) parts.push(`${p.references.length} reference${p.references.length === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : "no resources";
}

/** Render a discovery summary as widget lines. */
function summaryLines(
  marketplaceName: string,
  plugins: PluginDescriptor[],
  opts: { installedIds?: Set<string>; hint?: string } = {},
): string[] {
  const totals = { agent: 0, skill: 0, rule: 0, reference: 0 };
  for (const p of plugins) {
    totals.agent += p.agents.length;
    totals.skill += p.skills.length;
    totals.rule += p.rules.length;
    totals.reference += p.references.length;
  }

  const lines: string[] = [
    `Marketplace: ${marketplaceName}`,
    `Plugins: ${plugins.length}   Resources: ${totals.agent} agents, ${totals.skill} skills, ` +
      `${totals.rule} rules, ${totals.reference} references`,
    "",
    "What's inside:",
  ];
  for (const p of plugins) {
    const mark = opts.installedIds?.has(p.id) ? " [installed]" : "";
    lines.push(`  • ${p.id}${mark} — ${tallyPlugin(p)}`);
    if (p.description) lines.push(`      ${p.description}`);
  }
  if (opts.hint) {
    lines.push("", opts.hint);
  }
  return lines;
}

async function doAdd(
  url: string,
  ctx: any,
  opts: { yes?: boolean; noInstall?: boolean } = {},
) {
  const entries = loadGlobalConfig();
  if (entries.some((e) => e.url === url || e.clonePath === url)) {
    ctx.ui.notify("Marketplace already registered", "warning");
    return;
  }

  ctx.ui.setStatus("marketplaces", "Fetching marketplace...");
  let entry;
  try {
    entry = addMarketplace(url);
  } catch (e: any) {
    ctx.ui.setStatus("marketplaces", undefined);
    ctx.ui.notify(`Failed to add marketplace: ${e.message}`, "error");
    return;
  }
  ctx.ui.setStatus("marketplaces", undefined);
  ctx.ui.notify(`Added marketplace: ${entry.name}`, "info");

  // Discover plugins and their resources up front so we can guide the user.
  const manifest = parseMarketplace(entry.clonePath);
  const discovered = discoverPlugins({ ...entry, clonePath: entry.clonePath });

  if (!discovered.length) {
    ctx.ui.setWidget("marketplaces", [
      `Marketplace: ${manifest?.name ?? entry.name}`,
      "No plugins were discovered.",
      "",
      "The repository may not follow a supported layout yet",
      "(.claude-plugin/marketplace.json or .cursor/plugin.json plus",
      "agents/, skills/, rules/, references/ directories).",
    ]);
    ctx.ui.notify(
      `Added ${entry.name}, but no plugins/resources were discovered. See /marketplaces help install.`,
      "warning",
    );
    return;
  }

  const mpName = manifest?.name ?? entry.name;
  const totalResources = discovered.reduce(
    (n, p) => n + p.agents.length + p.skills.length + p.rules.length + p.references.length,
    0,
  );
  ctx.ui.notify(
    `Discovered ${discovered.length} plugin(s) with ${totalResources} resource(s): ${discovered
      .map((p) => p.id)
      .join(", ")}`,
    "info",
  );

  // Source-only: stop here.
  if (opts.noInstall || !ctx.hasUI) {
    ctx.ui.setWidget(
      "marketplaces",
      summaryLines(mpName, discovered, {
        hint: opts.noInstall
          ? "Install later with:  /marketplaces install"
          : "Run /marketplaces install to add plugins.",
      }),
    );
    return;
  }

  // ---- Guided install ----
  const wants = opts.yes
    ? true
    : await ctx.ui.confirm("Install now?", `Install plugins from ${mpName} now?`);

  if (!wants) {
    ctx.ui.setWidget(
      "marketplaces",
      summaryLines(mpName, discovered, {
        hint: "Install any time with:  /marketplaces install",
      }),
    );
    ctx.ui.notify("Marketplace added. Install later with /marketplaces install", "info");
    return;
  }

  const pluginIds = await pickMany(
    ctx,
    "Which plugins? (choose Done when finished)",
    discovered.map((p) => [p.id, `${p.id} — ${tallyPlugin(p)}`] as [string, string]),
  );
  if (!pluginIds.length) {
    ctx.ui.setWidget(
      "marketplaces",
      summaryLines(mpName, discovered, { hint: "Nothing installed." }),
    );
    return;
  }

  const scope = await pick(ctx, "Install where?", [
    ["global", "Global — available in all projects"],
    ["project", "This project only — .pi/ (committed with the repo)"],
  ]);
  if (!scope) return;

  const resourceTypes = await pickMany(
    ctx,
    "Which resource types? (choose Done when finished)",
    RESOURCE_TYPE_CHOICES,
  );
  if (!resourceTypes.length) return;

  const { installedCount, skippedCount } = await performInstall(
    ctx,
    entry,
    discovered,
    pluginIds,
    scope as "global" | "project",
    resourceTypes,
  );

  ctx.ui.notify(
    `Installed ${installedCount} resource(s) (${skippedCount} skipped).`,
    "info",
  );

  const installedIds = new Set(
    loadGlobalConfig().find((e) => e.url === entry.url)?.installedPlugins.map((ip) => ip.pluginId),
  );
  ctx.ui.setWidget(
    "marketplaces",
    summaryLines(mpName, discovered, {
      installedIds,
      hint:
        installedCount > 0
          ? "Run /reload so Pi picks up new skills/agents, then /marketplaces show."
          : "Nothing new installed (all destinations already existed).",
    }),
  );
}

/* ------------------------------------------------------------------ */
/* remove                                                              */
/* ------------------------------------------------------------------ */

async function cmdRemove(pi: ExtensionAPI, args: string, ctx: any) {
  const entries = loadGlobalConfig();
  if (!entries.length) {
    ctx.ui.notify("No marketplaces registered", "info");
    return;
  }

  // Shorthand: /marketplaces remove <url|name> [--purge] [--keep-clone]
  const argv = args.trim().split(/\s+/).filter(Boolean);
  const purge = argv.includes("--purge");
  const keepClone = argv.includes("--keep-clone");
  const nameArg = argv.find((a) => !a.startsWith("--"));

  let entry;
  if (nameArg) {
    entry = entries.find(
      (e) => e.url === nameArg || e.name === nameArg || e.clonePath === nameArg || e.name.includes(nameArg),
    );
    if (!entry) {
      ctx.ui.notify(`No registered marketplace matches "${nameArg}"`, "error");
      return;
    }
  } else {
    const url = await pick(
      ctx,
      "Remove Marketplace",
      entries.map((e) => [e.url, `${e.name} — ${e.url}`] as [string, string]),
    );
    if (!url) return;
    entry = entries.find((e) => e.url === url);
  }
  if (!entry) return;

  const installedCount = entry.installedPlugins.length;
  const resourceCount = entry.installedPlugins.reduce((n, ip) => n + ip.resources.length, 0);

  let action: "source" | "uninstall" | "cancel";
  if (purge) {
    action = "uninstall";
  } else if (nameArg && !installedCount) {
    // Nothing to uninstall — just remove.
    action = "source";
  } else if (nameArg) {
    // Shorthand: default to removing everything, but confirm once.
    const confirm = await ctx.ui.confirm(
      "Remove marketplace?",
      `${entry.name} has ${installedCount} installed plugin(s) (${resourceCount} resource(s)).\nUninstall those resources and remove the marketplace?`,
    );
    action = confirm ? "uninstall" : "cancel";
  } else if (installedCount) {
    const chosen = await pick(ctx, "Marketplace has installed resources", [
      ["source", "Remove source only (keep installed resources)"],
      ["uninstall", "Uninstall managed resources too"],
      ["cancel", "Cancel"],
    ]);
    if (!chosen || chosen === "cancel") return;
    action = chosen as "source" | "uninstall";
  } else {
    action = "source";
  }

  if (action === "uninstall") {
    let removed = 0;
    for (const ip of entry.installedPlugins) {
      for (const res of ip.resources) {
        uninstallResource(res);
        removed++;
      }
    }
    ctx.ui.notify(`Removed ${removed} managed resource file(s)`, "info");
  }

  removeMarketplace(entry.url, { deleteClone: !keepClone });
  ctx.ui.notify(
    `Marketplace removed: ${entry.name}${keepClone ? " (clone kept)" : " (clone deleted)"}`,
    "info",
  );
}

/* ------------------------------------------------------------------ */
/* list / show                                                         */
/* ------------------------------------------------------------------ */

async function cmdList(pi: ExtensionAPI, ctx: any) {
  const entries = loadGlobalConfig();
  if (!entries.length) {
    ctx.ui.setWidget("marketplaces", [
      "No marketplaces registered.",
      "Add one with:  /marketplaces add <git-url-or-local-path>",
      "Then run:      /marketplaces install",
    ]);
    ctx.ui.notify("No marketplaces registered. Use /marketplaces add <url>", "info");
    return;
  }

  const lines: string[] = ["Registered marketplaces:", ""];
  for (const e of entries) {
    const status = e.lastSyncedAt ? `synced ${e.lastSyncedAt}` : "never synced";
    lines.push(`• ${e.name}`);
    lines.push(`    url:     ${e.url}`);
    lines.push(`    commit:  ${e.resolvedCommit || "unknown"}`);
    lines.push(`    status:  ${status}`);
    lines.push(
      `    plugins: ${
        e.installedPlugins.length
          ? e.installedPlugins.map((ip) => `${ip.pluginId}(${ip.scope})`).join(", ")
          : "none installed"
      }`,
    );
    lines.push("");
  }
  lines.push("Use /marketplaces show to list installed plugins and resources.");
  ctx.ui.setWidget("marketplaces", lines);
  ctx.ui.notify(`${entries.length} marketplace(s) registered`, "info");
}

function resourceSummary(p: InstalledPluginState): string[] {
  const byType: Record<string, string[]> = {};
  for (const r of p.resources) (byType[r.type] ||= []).push(r.name);
  const lines: string[] = [];
  for (const [type, names] of Object.entries(byType)) {
    lines.push(`    ${type}s: ${names.join(", ")}`);
  }
  if (!p.resources.length) lines.push("    (no resources recorded)");
  return lines;
}

async function cmdShow(pi: ExtensionAPI, ctx: any) {
  const entries = loadGlobalConfig();
  const installed = entries.flatMap((e) =>
    e.installedPlugins.map((ip) => ({ marketplace: e.name, plugin: ip })),
  );

  const lines: string[] = ["Installed plugins & resources:", ""];
  if (!installed.length) {
    lines.push("Nothing installed yet.");
    lines.push("Run /marketplaces install to install a plugin from a registered marketplace.");
    ctx.ui.setWidget("marketplaces", lines);
    ctx.ui.notify("No plugins installed", "info");
    return;
  }

  for (const item of installed) {
    lines.push(`• ${item.marketplace} / ${item.plugin.pluginId}  [${item.plugin.scope}]`);
    lines.push(...resourceSummary(item.plugin));
    lines.push("");
  }
  lines.push("Global resources: ~/.pi/agent/agents/, ~/.pi/agent/skills/");
  lines.push("Project resources: .pi/agents/, .pi/skills/");
  ctx.ui.setWidget("marketplaces", lines);
  ctx.ui.notify(`${installed.length} plugin(s) installed`, "info");
}

/* ------------------------------------------------------------------ */
/* install                                                             */
/* ------------------------------------------------------------------ */

const RESOURCE_TYPE_CHOICES: Array<[ResourceType, string]> = [
  ["agent", "Agents"],
  ["skill", "Skills"],
  ["rule", "Rules"],
  ["reference", "References"],
];

async function cmdInstall(pi: ExtensionAPI, args: string, ctx: any) {
  const entries = loadGlobalConfig();
  if (!entries.length) {
    ctx.ui.notify("No marketplaces registered. Add one first.", "error");
    return;
  }

  // Parse optional non-interactive arguments:
  //   /marketplaces install <plugin> [<plugin> ...] [--project] [--types agents,skills] [--marketplace <name>]
  const argv = args.trim().split(/\s+/).filter(Boolean);
  let scopeFlag: "global" | "project" | undefined;
  let typesFlag: ResourceType[] | undefined;
  let mpFlag: string | undefined;
  const pluginArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project" || a === "-p") scopeFlag = "project";
    else if (a === "--global" || a === "-g") scopeFlag = "global";
    else if (a === "--types" || a === "-t") {
      const raw = (argv[++i] || "").toLowerCase();
      typesFlag = raw
        .split(",")
        .map((s) => s.trim().replace(/s$/, ""))
        .filter((s): s is ResourceType =>
          ["agent", "skill", "rule", "reference"].includes(s),
        );
    } else if (a === "--marketplace" || a === "-m") {
      mpFlag = argv[++i];
    } else if (!a.startsWith("--")) {
      pluginArgs.push(a);
    }
  }

  let mpEntry;
  if (mpFlag) {
    mpEntry = entries.find(
      (e) =>
        e.name === mpFlag ||
        e.url === mpFlag ||
        e.clonePath === mpFlag ||
        e.name.includes(mpFlag!),
    );
    if (!mpEntry) {
      ctx.ui.notify(`No registered marketplace matches "${mpFlag}"`, "error");
      return;
    }
  } else if (entries.length === 1) {
    mpEntry = entries[0];
  } else if (pluginArgs.length) {
    // Pick the marketplace that actually contains the requested plugins.
    mpEntry =
      entries.find((e) =>
        (parseMarketplace(e.clonePath)?.plugins ?? []).some((p) =>
          pluginArgs.includes(p.id) || pluginArgs.includes(p.name),
        ),
      ) ?? entries[0];
  } else {
    const url = await pick(
      ctx,
      "Select marketplace",
      entries.map((e) => [e.url, e.name] as [string, string]),
    );
    if (!url) return;
    mpEntry = entries.find((e) => e.url === url);
  }
  if (!mpEntry) return;
  const url = mpEntry.url;

  const marketplace = parseMarketplace(mpEntry.clonePath);
  if (!marketplace?.plugins?.length) {
    ctx.ui.notify("No plugins found in marketplace", "warning");
    return;
  }

  let pluginIds: string[];
  if (pluginArgs.length) {
    const known = new Map<string, string>();
    for (const p of marketplace.plugins) {
      known.set(p.id, p.id);
      known.set(p.name, p.id);
    }
    const unknown = pluginArgs.filter((p) => !known.has(p));
    if (unknown.length) {
      ctx.ui.notify(
        `Unknown plugin(s): ${unknown.join(", ")}. Known: ${marketplace.plugins.map((p) => p.id).join(", ")}`,
        "error",
      );
      return;
    }
    pluginIds = pluginArgs.map((p) => known.get(p)!);
  } else {
    pluginIds = await pickMany(
      ctx,
      "Select plugins to install (choose Done when finished)",
      marketplace.plugins.map((p) => [p.id, p.name] as [string, string]),
    );
    if (!pluginIds.length) return;
  }

  let scope: string;
  if (scopeFlag) {
    scope = scopeFlag;
  } else {
    const chosen = await pick(ctx, "Installation scope", [
      ["global", "Global (all projects)"],
      ["project", "Current project only"],
    ]);
    if (!chosen) return;
    scope = chosen;
  }

  let resourceTypes: ResourceType[];
  if (typesFlag?.length) {
    resourceTypes = typesFlag;
  } else if (pluginArgs.length) {
    resourceTypes = RESOURCE_TYPE_CHOICES.map(([v]) => v);
  } else {
    resourceTypes = await pickMany(
      ctx,
      "Select resource types (choose Done when finished)",
      RESOURCE_TYPE_CHOICES,
    );
    if (!resourceTypes.length) return;
  }

  const discovered = discoverPlugins({ ...mpEntry, clonePath: mpEntry.clonePath });

  const { installedCount, skippedCount } = await performInstall(
    ctx,
    mpEntry,
    discovered,
    pluginIds,
    scope as "global" | "project",
    resourceTypes,
  );

  ctx.ui.notify(
    `Installed ${installedCount} resource(s) (${skippedCount} skipped). Run /marketplaces show to inspect.`,
    "info",
  );
  await cmdShow(pi, ctx);
}

/**
 * Install a set of plugins (already discovered) at the given scope.
 * Shared by /marketplaces install and the guided post-add flow.
 */
async function performInstall(
  ctx: any,
  mpEntry: MarketplaceRegistryEntry,
  discovered: PluginDescriptor[],
  pluginIds: string[],
  scope: "global" | "project",
  resourceTypes: ResourceType[],
): Promise<{ installedCount: number; skippedCount: number }> {
  let totalInstalled = 0;
  let totalSkipped = 0;

  for (const pluginId of pluginIds) {
    const pluginDesc = discovered.find((p) => p.id === pluginId);
    if (!pluginDesc) {
      ctx.ui.notify(`Plugin not found in discovery: ${pluginId}`, "warning");
      continue;
    }

    const resources: ResourceDescriptor[] = [];
    if (resourceTypes.includes("agent")) resources.push(...pluginDesc.agents);
    if (resourceTypes.includes("skill")) resources.push(...pluginDesc.skills);
    if (resourceTypes.includes("rule")) resources.push(...pluginDesc.rules);
    if (resourceTypes.includes("reference")) resources.push(...pluginDesc.references);

    if (!resources.length) continue;

    const preview = previewInstall(scope, resources);
    if (preview.conflicts.length) {
      const shown = preview.conflicts.slice(0, 15).map((c) => `  - ${c.destination}`).join("\n");
      const more = preview.conflicts.length > 15 ? `\n  …and ${preview.conflicts.length - 15} more` : "";
      const confirm = await ctx.ui.confirm(
        "Conflicts detected",
        `${preview.conflicts.length} destination(s) already exist and will be skipped:\n${shown}${more}\n\nContinue installing the rest?`,
      );
      if (!confirm) continue;
    }

    const { installed, skipped } = installPluginResources(scope, resources, {
      projectRoot: ctx.cwd,
    });
    totalInstalled += installed.length;
    totalSkipped += skipped.length;

    const state = loadState();
    const entry = state.find((e) => e.url === mpEntry.url);
    if (entry) {
      const pluginState: InstalledPluginState = {
        pluginId,
        scope,
        resourceTypes: resourceTypes as ResourceType[],
        installedAt: new Date().toISOString(),
        resources: installed,
      };
      // Merge with an existing entry for the same plugin + scope instead of
      // appending a duplicate.
      const existingIdx = entry.installedPlugins.findIndex(
        (ip) => ip.pluginId === pluginId && ip.scope === scope,
      );
      if (existingIdx >= 0) {
        const existing = entry.installedPlugins[existingIdx];
        const mergedResources = [
          ...existing.resources.filter(
            (r) => !installed.some((n) => n.type === r.type && n.name === r.name),
          ),
          ...installed,
        ];
        const mergedTypes = Array.from(
          new Set([...(existing.resourceTypes || []), ...(resourceTypes as ResourceType[])]),
        );
        entry.installedPlugins[existingIdx] = {
          ...existing,
          resourceTypes: mergedTypes,
          resources: mergedResources,
          installedAt: pluginState.installedAt,
        };
      } else {
        entry.installedPlugins.push(pluginState);
      }
      saveState(state);
    }
  }

  return { installedCount: totalInstalled, skippedCount: totalSkipped };
}

/* ------------------------------------------------------------------ */
/* uninstall                                                           */
/* ------------------------------------------------------------------ */

async function cmdUninstall(pi: ExtensionAPI, args: string, ctx: any) {
  const entries = loadState();
  const installed = entries.flatMap((e) =>
    e.installedPlugins.map((ip) => ({ url: e.url, marketplace: e.name, plugin: ip })),
  );
  if (!installed.length) {
    ctx.ui.notify("No installed plugins", "info");
    return;
  }

  // Shorthand: /marketplaces uninstall <plugin> [--marketplace <name>] [--scope global|project] [--all]
  const argv = args.trim().split(/\s+/).filter(Boolean);
  let mpFlag: string | undefined;
  let scopeFlag: string | undefined;
  let all = false;
  const pluginArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") all = true;
    else if (a === "--marketplace" || a === "-m") mpFlag = argv[++i];
    else if (a === "--scope" || a === "-s") scopeFlag = argv[++i];
    else if (!a.startsWith("--")) pluginArgs.push(a);
  }

  let targets = installed;
  if (mpFlag) targets = targets.filter((t) => t.marketplace === mpFlag || t.url === mpFlag);
  if (scopeFlag) targets = targets.filter((t) => t.plugin.scope === scopeFlag);
  if (pluginArgs.length) {
    targets = targets.filter((t) => pluginArgs.includes(t.plugin.pluginId));
    const missing = pluginArgs.filter((p) => !targets.some((t) => t.plugin.pluginId === p));
    if (missing.length && !all) {
      ctx.ui.notify(`Not installed: ${missing.join(", ")}`, "warning");
    }
    if (!targets.length) return;
  } else if (!all) {
    // Interactive pick.
    const key = await pick(
      ctx,
      "Uninstall plugin (pick one)",
      targets.map((i) => [
        `${i.url}::${i.plugin.pluginId}::${i.plugin.scope}`,
        `${i.marketplace} / ${i.plugin.pluginId} (${i.plugin.scope})`,
      ] as [string, string]),
    );
    if (!key) return;
    targets = targets.filter(
      (i) => `${i.url}::${i.plugin.pluginId}::${i.plugin.scope}` === key,
    );
  }

  if (!targets.length) return;

  const totalResources = targets.reduce((n, t) => n + t.plugin.resources.length, 0);
  if (targets.length > 1 || all) {
    const names = targets.map((t) => `${t.marketplace}/${t.plugin.pluginId}(${t.plugin.scope})`);
    const confirm = await ctx.ui.confirm(
      "Uninstall plugins?",
      `Remove ${targets.length} plugin(s) and ${totalResources} managed resource(s)?\n${names.join(", ")}`,
    );
    if (!confirm) return;
  } else {
    const t = targets[0];
    const confirm = await ctx.ui.confirm(
      "Uninstall?",
      `Remove ${t.plugin.resources.length} managed resource(s) from ${t.marketplace}/${t.plugin.pluginId}?`,
    );
    if (!confirm) return;
  }

  let removedResources = 0;
  for (const t of targets) {
    for (const res of t.plugin.resources) {
      uninstallResource(res);
      removedResources++;
    }
  }

  // Update state: drop the exact plugin+scope entries we removed.
  const fresh = loadState();
  for (const t of targets) {
    const entry = fresh.find((e) => e.url === t.url);
    if (!entry) continue;
    entry.installedPlugins = entry.installedPlugins.filter(
      (ip) => !(ip.pluginId === t.plugin.pluginId && ip.scope === t.plugin.scope),
    );
  }
  saveState(fresh);

  ctx.ui.notify(
    `Uninstalled ${targets.length} plugin(s), removed ${removedResources} resource file(s).`,
    "info",
  );
}

/* ------------------------------------------------------------------ */
/* sync                                                                */
/* ------------------------------------------------------------------ */

async function cmdSync(pi: ExtensionAPI, args: string, ctx: any) {
  const entries = loadState();
  if (!entries.length) {
    ctx.ui.notify("No marketplaces registered", "info");
    return;
  }

  let urls: string[];
  const arg = args.trim();
  if (arg) {
    urls = [arg];
  } else {
    urls = await pickMany(
      ctx,
      "Select marketplaces to sync (choose Done to start)",
      entries.map((e) => [e.url, e.name] as [string, string]),
    );
  }
  if (!urls.length) return;

  for (const url of urls) {
    const entry = entries.find((e) => e.url === url);
    if (!entry) continue;

    ctx.ui.setStatus("marketplaces", `Syncing ${entry.name}...`);
    try {
      const result = syncMarketplace(entry, { nonInteractive: true });
      ctx.ui.setStatus("marketplaces", undefined);
      const summary = [
        `added ${result.added.length}`,
        `updated ${result.updated.length}`,
        `removed ${result.removed.length}`,
        `conflicts ${result.conflicts.length}`,
        `unchanged ${result.unchanged.length}`,
      ].join(", ");
      ctx.ui.notify(`Synced ${entry.name}: ${summary}`, result.conflicts.length ? "warning" : "info");
    } catch (e: any) {
      ctx.ui.setStatus("marketplaces", undefined);
      ctx.ui.notify(`Sync failed for ${entry.name}: ${e.message}`, "error");
    }
  }
}

/* ------------------------------------------------------------------ */
/* status / config                                                     */
/* ------------------------------------------------------------------ */

async function cmdStatus(pi: ExtensionAPI, args: string, ctx: any) {
  const entries = loadState();
  if (!entries.length) {
    ctx.ui.setWidget("marketplaces", ["No marketplaces registered."]);
    ctx.ui.notify("No marketplaces", "info");
    return;
  }

  const lines: string[] = ["Marketplace status:", ""];
  for (const e of entries) {
    const pluginCount = e.installedPlugins.length;
    const resourceCount = e.installedPlugins.reduce((n, ip) => n + ip.resources.length, 0);
    lines.push(`• ${e.name}`);
    lines.push(`    plugins:   ${pluginCount}`);
    lines.push(`    resources: ${resourceCount}`);
    lines.push(`    synced:    ${e.lastSyncedAt || "never"}`);
    lines.push("");
  }
  ctx.ui.setWidget("marketplaces", lines);
  ctx.ui.notify(`${entries.length} marketplace(s)`, "info");
}

async function cmdConfig(pi: ExtensionAPI, args: string, ctx: any) {
  const projectConfig = loadProjectConfig(ctx.cwd);
  const parts = args.trim().split(/\s+/);
  const action = parts[0] || "show";

  if (action === "show") {
    ctx.ui.setWidget("marketplaces", [
      `Project config (${ctx.cwd}/.pi-marketplaces.json):`,
      "",
      JSON.stringify(projectConfig, null, 2),
      "",
      "Subcommands: disable-plugin, enable-plugin, disable-skill, disable-agent",
    ]);
    ctx.ui.notify("Project config shown", "info");
    return;
  }

  const allPlugins = loadState().flatMap((e) =>
    e.installedPlugins.map((ip) => [ip.pluginId, `${ip.pluginId} (${ip.scope})`] as [string, string]),
  );

  if (action === "disable-plugin") {
    const toDisable = await pickMany(ctx, "Disable plugins (choose Done when finished)", allPlugins);
    if (toDisable.length) {
      projectConfig.plugins = projectConfig.plugins || {};
      projectConfig.plugins.disable = Array.from(
        new Set([...(projectConfig.plugins.disable || []), ...toDisable]),
      );
      saveProjectConfig(ctx.cwd, projectConfig);
      ctx.ui.notify("Updated project config", "info");
    }
    return;
  }

  if (action === "enable-plugin") {
    const disabled = projectConfig.plugins?.disable ?? [];
    if (!disabled.length) {
      ctx.ui.notify("No plugins disabled in this project", "info");
      return;
    }
    const toEnable = await pickMany(
      ctx,
      "Enable plugins (choose Done when finished)",
      disabled.map((p) => [p, p] as [string, string]),
    );
    if (toEnable.length) {
      projectConfig.plugins = projectConfig.plugins || {};
      projectConfig.plugins.disable = disabled.filter((p) => !toEnable.includes(p));
      saveProjectConfig(ctx.cwd, projectConfig);
      ctx.ui.notify("Updated project config", "info");
    }
    return;
  }

  if (action === "disable-skill" || action === "disable-agent") {
    const kind = action === "disable-skill" ? "skills" : "agents";
    const names = Array.from(
      new Set(
        loadState().flatMap((e) =>
          e.installedPlugins.flatMap((ip) =>
            ip.resources.filter((r) => r.type === (action === "disable-skill" ? "skill" : "agent")).map((r) => r.name),
          ),
        ),
      ),
    );
    if (!names.length) {
      ctx.ui.notify(`No installed ${kind} to disable`, "info");
      return;
    }
    const toDisable = await pickMany(
      ctx,
      `Disable ${kind} (choose Done when finished)`,
      names.map((n) => [n, n] as [string, string]),
    );
    if (toDisable.length) {
      const bucket = (projectConfig as any)[kind] = (projectConfig as any)[kind] || {};
      bucket.disable = Array.from(new Set([...(bucket.disable || []), ...toDisable]));
      saveProjectConfig(ctx.cwd, projectConfig);
      ctx.ui.notify("Updated project config", "info");
    }
    return;
  }

  ctx.ui.notify(
    "Unknown config command. Try: show, disable-plugin, enable-plugin, disable-skill, disable-agent",
    "error",
  );
}
