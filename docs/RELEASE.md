# Releasing Listener.AI

`.github/workflows/release.yml` publishes one version to three places from one
commit: the GitHub release (macOS x64 + arm64 and Windows builds with the
auto-update files), the `vX.Y.Z` tag, and the `listener-ai` npm package with
provenance. The run never creates commits. The version it releases is the one
`package.json` carries on `main` when the run starts.

## Cut a release

1. Bump the version on a fresh branch from `origin/main` and open an
   ordinary pull request:

   ```sh
   git fetch origin
   git switch -c bump-v2.18.0 origin/main
   npm version minor --no-git-tag-version   # or patch / major
   git add package.json
   git commit -S -m "Bump version to 2.18.0"
   gh pr create --title "Bump version to 2.18.0"
   ```

   Stage only `package.json` (the pnpm lockfile carries no root version), so
   the commit cannot pick up unrelated files. CI runs on the pull request like
   on any other change.

2. Merge it to `main`.

3. Start the release on `main`. There are no inputs:

   ```sh
   gh workflow run release.yml --ref main
   gh run watch
   ```

   The run releases the commit at the tip of `main` when it was created,
   including anything merged after the bump. Start it right after the merge if
   that matters.

## What the run guarantees

- `preflight` refuses any ref but `main`, reads the version from
  `package.json`, and passes only when the tag, the GitHub release and the npm
  version are all confirmed absent. A lookup error stops the run; it never
  assumes absence. "Tag already exists" means that version has been released
  or started before: inspect the tag, the release and npm for it (see
  Recovery) before deciding whether `main` needs a new bump.
- `build` runs macOS x64 and arm64 in one job (one `latest-mac.yml` for both
  architectures) and Windows in another, each checked out at the run's
  commit. The macOS signing and notarization configuration is unchanged.
- `tag` creates `vX.Y.Z` at that commit through the refs API after both
  builds succeed and before either channel publishes. A ref that already
  exists makes the call fail, so a tag can only ever point at the commit the
  run built.
- `release` and `npm-publish` run in parallel from the tag, re-check that the
  tag still resolves to the run's commit (`release`) and that `GITHUB_SHA`,
  `GITHUB_REF` and `package.json` agree (`npm-publish`), so npm provenance
  names the released commit on `refs/heads/main`. The npm trusted publisher is
  bound to the `release.yml` filename; keep it.
- One release runs at a time (`concurrency` on the workflow name). Tags are
  never deleted or moved, and an existing GitHub release is never updated by
  the workflow.

## Recovery

First find out exactly what exists for the version: `git ls-remote origin
refs/tags/vX.Y.Z`, `gh release view vX.Y.Z` (including its asset list), and
`npm view listener-ai@X.Y.Z version`.

**(a) Failed before `tag`, nothing published.** The tag, the release and the
npm version are all absent. Nothing to clean up: fix the cause and start a new
run with `gh workflow run release.yml --ref main`.

**(b) Tag created, one channel failed, that channel confirmed absent.** The
tag resolves to the run's commit, and the failed side shows nothing (no GitHub
release at all, or `npm view` reports the version missing). A new run is
refused because the tag exists, which is intended. Instead:

1. Open the run and confirm the `mac-build` and `win-build` artifacts are
   still listed and not expired (the run's Summary page, or
   `gh run view <run-id>` followed by `gh run download <run-id>`).
2. Use **Re-run failed jobs** on that same run. It keeps the same commit, ref
   and provenance, and only the failed job and its dependents run again.

Do not use this path if the artifacts are gone or the failed side is not
confirmed absent. This path has not yet been exercised on a real failure.

**(c) Anything else: stop and inspect.** This covers a `tag` job whose
outcome is unclear, a GitHub release that exists with some assets missing, an
npm publish whose acceptance is unknown, and any state where the tag does not
resolve to the run's commit. Do not re-run, do not start a new run, and do not
delete, move or recreate the tag or the release. Work out the exact remote
state first.

For a GitHub release with missing assets, complete it by hand from the same
run's artifacts, which were built from the released commit:

```sh
gh run download <run-id> --dir release-artifacts
gh release upload vX.Y.Z release-artifacts/mac-build/<missing-file> ...
```

Upload only the files that are missing. Do not pass `--clobber`, and do not
replace files that are already attached: an auto-update client may already
have read `latest-mac.yml` or `latest.yml`.

An npm version that was accepted cannot be republished or replaced; if the
job failed after the publish, the version is live and nothing is left to do
on npm.

## Migrating from the two-stage flow

The previous workflow created a `release/vX.Y.Z` branch, dispatched itself on
it and merged it back to `main` after publishing. The new workflow takes no
inputs and knows nothing about those branches. A leftover `release/vX.Y.Z`
branch may be deleted only when all of the following hold for that exact
version: its two-stage run finished successfully, the published tag `vX.Y.Z`
and the npm provenance source commit both equal the branch tip, and that
commit is already contained in `main`:

```sh
git ls-remote origin refs/heads/release/vX.Y.Z refs/tags/vX.Y.Z
git merge-base --is-ancestor <branch-tip> origin/main && echo on-main
git push origin --delete release/vX.Y.Z
```

Leave any branch that fails one of these checks, or whose origin is unknown,
in place and look into it first.
