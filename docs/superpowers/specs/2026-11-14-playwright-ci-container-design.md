# Playwright CI Container Design

## Goal

Keep browser tests current without coupling them to the Linux release behind
GitHub's `ubuntu-latest` runner. A runner image update must not break browser
installation merely because the repository's Playwright version predates that
Linux release.

## Scope

Only E2E jobs are isolated. Lint and production builds continue to run directly
on `ubuntu-latest`.

## Design

The installed `@playwright/test` package is the single source of truth for the
Playwright version:

1. The E2E job checks out the repository, sets up Node, and runs `npm ci`.
2. A repository script reads the exact installed version from
   `@playwright/test/package.json`.
3. The script runs the requested command inside the matching official image:
   `mcr.microsoft.com/playwright:v<version>-noble`.
4. The repository is mounted into the container, which runs the standard or
   unreachable-worker Playwright configuration.

The workflows no longer run `playwright install --with-deps`. Browser binaries
and native libraries come from the official image rather than the GitHub host.
The host may therefore move to a newer Ubuntu release without changing the
browser environment.

Both `.github/workflows/pr.yml` and `.github/workflows/ci.yml` call the same
repository script so their setup cannot drift.

## Dependency Updates

Add weekly Dependabot updates for `@playwright/test`. Updating it updates the
lock file through the ordinary dependency PR. Because the container tag is
derived at runtime from the installed package, there is no second Playwright
version to update manually.

The image uses Playwright's `noble` image family. This is independent of the
GitHub host release. A future Playwright release that no longer publishes that
family will fail with a missing-image error in its dependency PR, before it can
reach the default branch. Changing image families is therefore an explicit,
rare compatibility migration rather than an implicit runner surprise.

## Failure Handling

- Missing or invalid installed Playwright version: fail before starting tests
  with a clear error.
- Missing matching official image: fail while pulling the image; do not fall
  back to `latest` or a mismatched browser version.
- Browser test failure: preserve Playwright's exit status and existing
  `test-results` artifact upload.
- Container or registry outage: fail the required E2E check rather than bypass
  browser tests.

## Testing

- Unit-test or smoke-test the helper's version-to-image resolution.
- Run the standard `tests/scrobblify.spec.ts` suite through the helper.
- Run `playwright.unreachable-worker.config.ts` through the same helper.
- Keep lint and build checks unchanged.
- Validate the workflow YAML and confirm the failing Ubuntu 26.04 dependency
  installation step has been removed.

## Non-goals

- Containerizing lint or build jobs.
- Automatically merging dependency updates.
- Floating to an unmatched `latest` Playwright image.
- Pinning GitHub Actions to a specific Ubuntu runner release.
