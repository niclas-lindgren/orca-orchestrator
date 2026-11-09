# Installing into a repository

1. Add the package, pinned to a tag or commit so upgrades are deliberate:

   ```bash
   npm install --save-dev git+https://github.com/niclas-lindgren/orca-orchestrator.git#v0.1.3
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

Use the `git+https` URL: the `github:` shorthand makes npm fetch over SSH, which fails in environments without GitHub SSH access.

Requirements: Node >= 22.19 (built-in `node:sqlite`), `git`, `gh` (authenticated), and the Orca CLI.

## Upgrading

Bump the pinned version, run `install-skills`, and review the diff in one PR. Tool behaviour and the
skills change together, so the repository never runs skills that assume a tool it does not have.
