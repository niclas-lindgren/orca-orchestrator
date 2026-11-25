# Working on orca-orchestrator

This repository is the shared Pi package and Claude plugin, not a consumer project's private skill copy. Read `README.md` for the native Orca versus guard ownership boundary. Preserve the existing authority, lease, fresh-review and exact-head safeguards.

## Version and changelog policy (required)

Before final review of any user-facing package change, update the release metadata in the **same PR/change**. This includes extensions, bundled guard code, skills and their references, installation behavior, and consumer-facing documentation. Skill-only or docs-only delivery changes still count: Git consumers can fetch them without a version bump, but Pi's package changelog notification depends on an increased `package.json` version.

1. Compare against the latest fetched default branch and released tags. Choose an unused version newer than the default-branch version. For routine compatible fixes and skill/docs updates, increment the patch (for example, `0.4.3` to `0.4.4`). Use a minor for substantial additive features and obtain human direction for breaking changes. Honor an explicitly requested release version.
2. Keep `package.json`, the top-level `package-lock.json` version, and `package-lock.json`'s `packages[""].version` identical. `npm version patch --no-git-tag-version` can update these for a patch when the tree is ready; inspect its diff.
3. Add a dated version heading in `CHANGELOG.md` matching the package version (for example, `## 0.4.4 - YYYY-MM-DD`). Put the changes shipping in that version there, including pending `Unreleased` entries that are part of the release. Do not leave shipped changes only under `Unreleased`.
4. Bump **once per PR/release**, not once per repair commit. If the same PR already contains an appropriate unreleased bump relative to its base, update its existing changelog entry. If another release lands first, reconcile the version before final review.
5. Run `npm run check` after the metadata is committed in a clean checkout: the replay tests require a clean evaluator checkout. Confirm package/lockfile/changelog consistency and report the final version and exact tested head.
6. Include version/changelog edits **before** independent exact-head review. Later metadata edits change the head and invalidate prior review receipts, just like code edits.

Purely internal tests or development-tool changes with no shipped behavior/documentation change may omit a bump; state why in the handoff. Do not omit a required bump merely because the consumer tracks Git `main`.

## Distribution and release authority

- Branch-tracking Git installs receive merged changes through `pi update --extensions` (or a targeted `pi update <source>`). Consumers restart Pi afterward. Tags/commits remain pinned until the consumer selects a new ref.
- A version bump is not a publication: it does not create a Git tag, GitHub release or npm release. Create/push release tags or publish to npm only with explicit user authorization; never move an existing tag. Do not claim a release was published merely because files were updated or merged.
- Never update consumer settings or installed package copies as a substitute for changing this canonical package.
- `orca-improve` remains draft-only; release metadata does not authorize it to approve or merge its own work.
