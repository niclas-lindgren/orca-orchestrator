# Installing into a repository

1. Add the repository CLI dependency, pinned to an immutable commit archive so CI and
   non-Pi harnesses get the exact reviewed implementation:

   ```bash
   npm install --save-dev https://github.com/niclas-lindgren/orca-orchestrator/archive/<commit>.tar.gz
   ```

2. Add the two entry points the skills call, to `package.json`:

   ```json
   { "scripts": { "auto": "orca-orchestrator auto", "orca": "orca-orchestrator orca" } }
   ```

3. Create the configuration and edit it (see [configuration](configuration.md)):

   ```bash
   npx orca-orchestrator init
   ```

4. Copy the skills where your agent harness discovers them, and commit them:

   ```bash
   npx orca-orchestrator install-skills            # default: .agents/skills
   npx orca-orchestrator check-skills              # exit 1 if a copy is missing or differs
   ```

   Run `check-skills` in the repository's CI, so a stale or hand-edited copy fails the build
   instead of silently diverging.

5. Add `.local/` (or your `stateDir`) to `.gitignore`. The lease database is local state; if it is
   tracked, reverting a file in the checkout erases every lease.

6. For Pi, also install the package project-locally. Tracking `main` keeps Pi's extension and
   skills current when `pi update` runs; use a commit instead when immutable Pi loading is required:

   ```bash
   pi install --local git:github.com/niclas-lindgren/orca-orchestrator@main
   ```

   Pi loads the `orca_status` tool, `/orca-status` command and package skills. This supplements,
   rather than replaces, the repository CLI dependency above: Pi-managed package binaries are not
   available to CI, npm scripts, or other harnesses.

Avoid npm's `github:` shorthand for the repository dependency: its lockfile can resolve through SSH,
which fails in environments without GitHub SSH access.

Requirements: Node >= 22.19 (built-in `node:sqlite`), `git`, `gh` (authenticated), and the Orca CLI.

## Upgrading

Bump the immutable repository dependency, run `install-skills`, and review the diff in one PR. Tool
behaviour and committed skill copies change together, so the repository never runs skills that assume
a tool it does not have. Run `pi update --extensions` to advance a Pi package that tracks `main`.
