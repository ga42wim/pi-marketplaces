# AGENTS.md

Guidance for AI agents (and humans) working **on this repository**.

This is a Pi extension. It is a *distribution/sync layer* for agent resources —
not an agent runtime. Keep that boundary intact.

## What this project is

`pi-marketplaces` lets users register Git-based marketplaces, discover the
plugins they contain, and install their resources (agents, skills, rules,
references) into Pi's standard discovery directories.

**Hard rules:**

1. **The marketplace is the source of truth.** Never implement agent execution,
   prompt composition, or model logic here. This project only moves files.
2. **No repository may be privileged.** Do not hard-code any URL, owner, or
   plugin name (no hard-coded usernames, no vendor-specific shortcuts in
   production paths). Fixtures used for testing must be treated as ordinary data.
3. **No vendor lock-in.** Marketplace/plugin formats are parsed through adapters
   (`src/manifest.ts`). Adding a format must not require touching the installer.
4. **Install into real Pi paths**, discovered rather than invented:
   - global: `~/.pi/agent/{agents,skills,rules,references}`
   - project: `.pi/{agents,skills,rules,references}`
   Respect `PI_CODING_AGENT_DIR` (see `src/paths.ts`).
5. **Never destroy user data.** Only delete files the installer created and still
   tracks (`InstalledResourceState.managedFiles`). Never overwrite an existing
   destination without surfacing a conflict.
6. **No build step.** Code runs through jiti. Do not introduce a bundler or
   compiled output; `package.json` `main` points at `src/index.ts`.

## Layout

| File | Responsibility |
|---|---|
| `src/index.ts` | Extension entry; registers `/marketplaces` and all subcommands |
| `src/types.ts` | Normalized model shared by every module |
| `src/paths.ts` | Global/project path resolution |
| `src/config.ts` | Registry + project config persistence |
| `src/manifest.ts` | Format adapters → common model |
| `src/discover.ts` | Plugin/resource enumeration from a clone |
| `src/cursor.ts` | Cursor-style Markdown → Pi agent format |
| `src/install.ts` | Install/uninstall + managed-file tracking |
| `src/sync.ts` | Git sync + registry state |
| `src/filter.ts` | Project enable/disable calculation |
| `src/multiselect.ts` | Checkbox multi-select TUI component |

## Pi extension API notes (learned the hard way)

These are easy to get wrong; the codebase already had bugs from each of them.

- `ctx.ui.select(title, options)` takes **`string[]`** and returns a **string**.
  It does **not** accept `{label, value}` objects.
- `ctx.ui.confirm(title, message)` returns a boolean. There is **no**
  `multiSelect()` method — multi-select is `ctx.ui.custom()` with a component
  (see `src/multiselect.ts`).
- `ctx.ui.notify(message, type)` — `type` is `"info" | "warning" | "error"`.
  `"success"` and `"warn"` are invalid.
- `setStatus(key, text | undefined)` — **always clear** a status you set
  (`undefined`), on success *and* failure, or the footer hangs forever.
- `ctx.ui.custom()` returns `undefined` in RPC/JSON/print modes. Guard
  TUI-only UI with `ctx.mode === "tui"` and provide a fallback so
  non-interactive `install`/`add` still work.
- Prefer `ctx.hasUI` to decide whether to show a guided flow at all.

## Conventions

- ESM only; `import` (no `require`), `node:` prefixes for built-ins.
- Keep registry state in one place: `GLOBAL_STATE_FILE`
  (`~/.pi/agent/marketplaces-state.json`). Do not add a second registry file —
  a split brain between two config files was a real bug.
- Paths built from a plugin's `sourcePath` may already be absolute; check before
  joining (`src/discover.ts`).
- User-facing output: use `setWidget` for anything the user should be able to
  read at leisure; `notify` toasts are transient and easy to miss.
- **Widgets must be cleared.** `setWidget` output persists until overwritten or
  set to `undefined`. Register an `input`-event handler to clear it once the
  user moves on (extension commands skip the `input` event, so the clear fires
  for every *other* input — see `src/index.ts`).

## Verifying changes

Load the extension directly — no build needed:

```bash
pi -e ./src/index.ts -p "hi"
```

> **Never test against the real `~/.pi/agent`.** It holds the user's live
> marketplaces and installed skills/agents. Point tests at an isolated config
> dir instead:
>
> ```bash
> export PI_CODING_AGENT_DIR=/tmp/pi-test-agent
> pi -e ./src/index.ts
> ```
>
> `PI_CODING_AGENT_DIR` overrides the config dir, so the registry
> (`marketplaces-state.json`), clones, and install targets all stay inside the
> sandbox. Wiping a scratch dir is fine; wiping `~/.pi/agent` destroys the
> user's setup.

Exercise the command flow. In RPC mode you can drive dialogs by responding to
`extension_ui_request` messages:

```bash
pi --mode rpc -e ./src/index.ts
# send: {"type":"prompt","message":"/marketplaces help"}
```

A good end-to-end check:

```bash
/marketplaces add /path/to/fixture --no-install   # discovery + summary
/marketplaces add /path/to/fixture                # guided install
/marketplaces show                                # installed resources
/marketplaces uninstall <plugin>                  # files and empty dirs removed
/marketplaces remove <url> --purge                # registry + clone cleaned
```

Confirm installs land in `~/.pi/agent/{agents,skills}` and that
`pi --mode rpc` `get_commands` shows new `skill:*` entries.
