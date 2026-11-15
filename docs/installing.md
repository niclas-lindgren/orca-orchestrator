# Installing into a repository

Orca's skill content is owned by **this repository**. Consumers must not copy, vendor, or edit `orca-flow` or `orca-fleet` inside the application repository.

## Repository CLI for CI and non-Pi harnesses

Install the CLI as an independent, reproducible dependency:

```bash
npm install --save-dev 'https://github.com/niclas-lindgren/orca-orchestrator/archive/<reviewed-commit>.tar.gz'
```

Add script entrypoints in `package.json`:

```json
{ "scripts": { "auto": "orca-orchestrator auto", "orca": "orca-orchestrator orca" } }
```

Create `orca.config.json` using `npx orca-orchestrator init` and adapt the gate, review project, worker instructions, and protected domains; see [configuration](configuration.md). Ignore `.local/` (or your configured `stateDir`) in Git.

**The npm CLI dependency and Pi's package cache are separate installations.** An npm `package-lock.json` freezes the CLI resolution for reproducible verification. `pi update --extensions` does **not** update that lockfile or `node_modules`. Update and review the npm lockfile whenever the shared CLI changes; verify that skills and installed CLI are compatible before operating a delivery flow. Never silently treat a Pi update as a CLI update.

## Pi.dev: native package discovery, no copied skills

From the consumer repository:

```bash
pi install --local git:github.com/niclas-lindgren/orca-orchestrator
pi update --extensions
```

Project settings should contain:

```json
{ "packages": ["git:github.com/niclas-lindgren/orca-orchestrator"] }
```

The **unpinned** Git source follows its default branch when `pi update --extensions` runs. Explicit `@commit` and `@tag` refs stay pinned. Pi loads `skills/` and `extensions/orca.ts` directly from its managed package. A new Pi session or `/reload` picks up installed changes. Check `pi list` to confirm the loaded package.

Updating Pi alone doesn't update npm's CLI. For safety, do not run new skill procedures that require commands unsupported by the CLI version in `node_modules`; upgrade the npm dependency first.

## Claude Code: shared plugin, no copied skills

This repository is also a Claude Code plugin marketplace. Register its GitHub source and install the `orca-orchestrator` plugin; or declare these project settings in `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "orca-orchestrator-marketplace": {
      "source": { "source": "github", "repo": "niclas-lindgren/orca-orchestrator" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": { "orca-orchestrator@orca-orchestrator-marketplace": true }
}
```

Claude loads `skills/orca-flow` and `skills/orca-fleet` from the installed plugin. In Claude Code, they appear under `/orca-orchestrator:orca-flow` and `/orca-orchestrator:orca-fleet`. Plugin availability requires repository trust and successful marketplace/plugin installation; inspect `claude plugin list` if discovery fails. Plugin auto-updates follow Claude Code's own marketplace refresh policy and do not update the npm CLI.

## Legacy installer

`install-skills` and `check-skills` remain available for older consumers, but **do not use them in new consumers**. They copy skill files, producing a second maintained copy and potentially stale procedures. Prefer native Pi packages and Claude plugins.

## Updating safely

1. Review upstream Orca changes, especially command contracts, authority checks, lease handling and review gating.
2. Run `pi update --extensions` to refresh Pi's unpinned Git package. Update Claude plugins via Claude's plugin manager if needed.
3. Update the npm CLI dependency and its lockfile in a reviewed application PR when new commands or behavior are required.
4. Run the application's canonical gate and inspect the available skill and CLI commands before dispatching workers.

Requirements: Node >= 22.19, `git`, authenticated `gh`, and the Orca CLI.
