# pi-marketplaces

A general-purpose **marketplace / package manager for reusable AI-agent resources** —
agents, skills, rules, and references — for the [Pi coding agent](https://github.com/earendil-works/pi).

Register a Git-based marketplace, discover the plugins it offers, and install
their resources into Pi's standard discovery directories. No format lock-in: a
small adapter layer normalizes different marketplace layouts (Claude-style,
Cursor-style, …) into one internal model.

```
/marketplaces add https://github.com/user/marketplace.git
/marketplaces plugins
/marketplaces install
/marketplaces show
```

## Why

Agent resources (sub-agent definitions, skills, rules, reference docs) are
increasingly shared across repositories — but there is no common way to
distribute them. `pi-marketplaces` is the distribution and sync layer:

- The **marketplace is the source of truth** — this project never implements its
  own agent runtime.
- Resources materialize into **Pi's standard discovery paths**, so Pi (and
  extensions like `pi-subagents`) pick them up natively.
- **Adapter-based parsing** means any marketplace format can be supported
  without hard-coding a specific vendor.

## Install

Requires Pi (with TypeScript extension support) and Node.js.

```bash
# from a local checkout
pi install /path/to/pi-marketplaces

# or from git (once published)
pi install git:github.com/<owner>/pi-marketplaces
```

Then reload Pi (`/reload`) so the extension and any installed skills are picked up.

## Commands

Everything lives under `/marketplaces`:

| Command | Description |
|---|---|
| `/marketplaces` | List registered marketplaces (default) |
| `/marketplaces plugins [filter]` | List plugins available in registered marketplaces |
| `/marketplaces show` | Show installed plugins and their resources |
| `/marketplaces add <url\|path>` | Register a marketplace (git URL or local path) |
| `/marketplaces remove [url]` | Unregister a marketplace |
| `/marketplaces install [args]` | Install plugins |
| `/marketplaces uninstall [plugin...]` | Remove installed plugins |
| `/marketplaces sync [url]` | Fetch upstream changes |
| `/marketplaces status` | Sync + install summary |
| `/marketplaces config <cmd>` | Project-level enable/disable |
| `/marketplaces help [topic]` | Help — topics: `install`, `uninstall`, `config`, `scopes` |

### Registering a marketplace

```
/marketplaces add https://github.com/user/repo.git
/marketplaces add git@github.com:user/repo.git
/marketplaces add /path/to/local/marketplace
```

After cloning, `add` **discovers everything and guides you through installing**:

```
Marketplace: acme-agent-toolbox
Plugins: 3   Resources: 6 agents, 22 skills, 22 rules, 6 references

What's inside:
  • workflows — 6 agents, 14 skills, 14 rules, 6 references
      Multi-step workflow and delivery skills …
  • productivity — 4 skills, 4 rules
      Daily workflow skills: planning, notes, triage …
  • tooling — 4 skills, 4 rules
      Language- and platform-specific skills …
```

It then offers to install now (which plugins → which scope → which resource
types), or you can defer with `/marketplaces install`.

Flags:

```bash
/marketplaces add <url> --no-install   # register only, don't prompt
/marketplaces add <url> --yes          # install with defaults, no prompt
```

### Installing plugins

Interactive:

```
/marketplaces install
```

A checkbox multi-select is used for picking plugins and resource types:

- **space** toggle · **enter** confirm · **↑/↓** move · **a** all · **esc** cancel

Non-interactive shorthand:

```bash
/marketplaces install productivity               # global, all resource types
/marketplaces install tooling --types skills     # only skills
/marketplaces install workflows productivity --project
/marketplaces install tooling --marketplace acme-agent-toolbox
```

### Uninstalling and removing

```bash
/marketplaces uninstall                       # pick interactively
/marketplaces uninstall tooling               # by plugin name
/marketplaces uninstall workflows productivity  # several at once
/marketplaces uninstall tooling --scope project
/marketplaces uninstall --all                 # remove everything installed

/marketplaces remove                          # pick a marketplace interactively
/marketplaces remove acme-agent-toolbox      # by name or URL
/marketplaces remove <url> --purge            # also uninstall its plugins
/marketplaces remove <url> --keep-clone       # keep the local git clone
```

Only files the installer created **and still tracks** are deleted. Files you
edited by hand, or unmanaged files, are left untouched. Empty skill directories
are pruned automatically.

### Project config

Global installs make a plugin available in **every** project. An optional
project file, `.pi-marketplaces.json`, narrows that per project:

```bash
/marketplaces config show
/marketplaces config disable-plugin
/marketplaces config enable-plugin
/marketplaces config disable-skill
/marketplaces config disable-agent
```

```json
{
  "plugins": { "disable": ["tooling"] },
  "skills":  { "disable": ["standup"] },
  "agents":  { "disable": ["qa"] }
}
```

- **No file** → all globally-installed resources are available.
- **No file, project install** → resources installed into `.pi/` override globals.
- The file is meant to be committed so a team shares the same setup. Marketplace
  data itself lives outside the repo, in `~/.pi/agent/`.

> **Current limitation:** disable lists are recorded and editable, but Pi's
> native loaders do not yet consult `.pi-marketplaces.json` automatically. To
> truly scope a resource to a project today, install it at **project scope**
> (`.pi/agents`, `.pi/skills`), which overrides globals natively. Enforcement
> wiring is planned.

## Security and trust

Installing from a marketplace is **installing content you did not write** — the
same trust model as npm packages or editor extensions.

- Installing **never executes code** from a marketplace — it only copies files.
- But it copies **agents and skills into Pi's auto-discovery directories**
  (`~/.pi/agent/agents`, `~/.pi/agent/skills`), which Pi loads into your agent's
  context. A malicious skill or agent is an instruction-injection vector: it can
  tell the assistant to run commands, read files, or ignore its safety rules.
- **Only add marketplaces and install plugins from sources you trust.** Treat a
  shared marketplace link exactly like a shared install script.
- Uninstall only removes files the installer created and still tracks; it never
  deletes files you authored or edited.

Commands are run through `execFile` with argument arrays rather than a shell, so
marketplace URLs and refs cannot inject shell commands.

> **Sync is partial:** `sync` fetches upstream changes and detects them, but
> resource-level reconciliation (updating changed files, removing content deleted
> upstream) is not fully implemented yet. Re-installing a plugin merges new
> resources; it does not yet rewrite locally-modified ones.

## Where resources land

Pi's standard discovery paths:

| Scope | Agents | Skills | Rules | References |
|---|---|---|---|---|
| Global | `~/.pi/agent/agents/<name>.md` | `~/.pi/agent/skills/<name>/SKILL.md` | `~/.pi/agent/rules/` | `~/.pi/agent/references/` |
| Project | `.pi/agents/<name>.md` | `.pi/skills/<name>/SKILL.md` | `.pi/rules/` | `.pi/references/` |

Precedence (highest first): `.pi/agents` → `.agents/agents` → `~/.pi/agent/agents`.

Notes:

- **Skills** are discovered natively by Pi. After installing, run `/reload`.
- **Global agents** require the [`pi-subagents`](https://github.com/tintinweb/pi-subagents)
  extension to be active — that extension reads `~/.pi/agent/agents/`.

## Supported marketplace formats

Parsing goes through adapters that normalize into a common internal model.

| Adapter | Detects | Manifest |
|---|---|---|
| Claude-style | `.claude-plugin/marketplace.json` | `.claude-plugin/plugin.json` |
| Cursor-style | `.cursor/plugin.json` | `.cursor/plugin.json` |

Resource directories inside a plugin:

```
plugin/
  agents/*.md            # agent definitions (YAML frontmatter)
  skills/<name>/SKILL.md # skills (YAML frontmatter)
  rules/*.mdc | *.md     # rules
  references/*.md        # reference docs
```

Adding a new format means implementing `ManifestAdapter` (`src/manifest.ts`) and
registering it in `DEFAULT_ADAPTERS` — nothing else changes.

## Architecture

```
src/
  index.ts        # extension entry point; registers /marketplaces + all commands
  types.ts        # normalized data model (Marketplace, Plugin, Resource, …)
  paths.ts        # resolves Pi's global/project discovery paths
  config.ts       # global registry + project config persistence
  manifest.ts     # format adapters (Claude, Cursor) → common model
  discover.ts     # enumerate plugins and their resources from a clone
  cursor.ts       # Cursor-style agent Markdown → Pi agent format
  install.ts      # install/uninstall resources; managed-file tracking
  sync.ts         # git fetch/reset; registry + sync state
  filter.ts       # project-level enable/disable calculation
  multiselect.ts  # checkbox multi-select TUI component
```

Design rules:

- **No repository is privileged.** The marketplace is data, not code; no URL is
  treated as built-in.
- **Non-destructive.** Installation never overwrites an existing destination
  without reporting it; uninstall only removes tracked files.
- **Idempotent-ish sync.** Re-running install merges into existing plugin state
  instead of duplicating it.

## Development

```bash
npm install
pi -e ./src/index.ts -p "hi"   # load the extension directly to check it starts
```

Extensions load via [jiti](https://github.com/unjs/jiti), so there is no build
step — TypeScript runs directly.

Testing against a marketplace fixture:

```bash
pi -e ./src/index.ts
/marketplaces add /path/to/some/marketplace --no-install
/marketplaces add /path/to/some/marketplace
```

## License

MIT — see [LICENSE](LICENSE).
