# Socket Fix + Socket Patches: upgrade what is easy, patch the rest

A small, deliberately vulnerable Node app and a GitHub Actions workflow that
clears its CVEs in two phases:

1. **Socket Fix** takes the easy upgrades: minor and patch bumps within the
   same major version. Low risk, and the dependency lands on a maintained
   release.
2. **Socket Patches** covers whatever is still vulnerable afterwards: advisories
   whose only fix is a major bump, advisories with no fixed release at all, and
   advisories that the freshly upgraded version still carries. The version stays
   put; the lockfile is repointed at a patched build of that same version.

Both phases run on one checkout, the app's smoke suite runs between them, and
the result is one pull request.

| | Phase 1: Socket Fix | Phase 2: Socket Patches |
| --- | --- | --- |
| what changes | the dependency version | the tarball the lockfile resolves to |
| installed version | bumped (minor/patch only) | **unchanged** |
| your code | may need to adapt | untouched |
| scope | wherever a same-major fix exists | wherever a patch has been published |
| review cost | a version bump to test | two lockfile lines per package |

## What happens on this tree

Measured with `socket` CLI 1.1.170 and `socket-patch` 4.0.0:

| | packages | advisories |
| --- | --- | --- |
| Phase 1 upgraded | **19** | **63** |
| Phase 2 patched | **5** | **6** |

The smoke suite passed 9/9 at all three checkpoints: before anything, after the upgrades, after the patches.

The five that reached phase 2 show the three reasons a patch is the only move:

| package | why phase 1 could not close it |
| --- | --- |
| `xmldom@0.6.0` | no upgrade path at all: the package was renamed, 0.6.0 is the last release under this name |
| `serialize-javascript@3.1.0` | fixed release is a major bump (6.x) |
| `tar@6.1.0` | fixed release is a major bump (7.x) |
| `ip@2.0.1` | phase 1 upgraded it 2.0.0 → 2.0.1, and 2.0.1 still carries GHSA-2p57-rm9w-gvfp |
| `qs@6.14.2` | phase 1 upgraded it 6.7.0 → 6.14.2, and 6.14.2 still carries GHSA-q8mj-m7cp-5q26 |

The last two are the case worth showing people. An upgrade is not a guarantee of
a clean version, and the patch closes the gap without another upgrade cycle.

> Run the workflow to regenerate these numbers. Patch coverage grows over time,
> so the split shifts.

## Workflows

### `socket-remediate.yml`

1. `npm ci`, then run the smoke suite to establish a baseline
2. **Phase 1**: `socket fix --all --no-major-updates --minimum-release-age 7d`,
   in local mode, so the upgrades land in the working tree
3. `npm ci` again and re-run the smoke suite. **A failure here fails the run.**
   An "easy" upgrade that breaks the app is not easy, and it should not reach a
   pull request.
4. **Phase 2**: `socket-patch scan --mode hosted` repoints anything still
   vulnerable at Socket's patch server
5. `npm ci` again, smoke suite again
6. `socket-patch vex` emits an **OpenVEX 0.2.0** attestation; `npm run verify`
   confirms the patches landed from the lockfile, the bytes in `node_modules`,
   and the attestation
7. One pull request with the version bumps, the lockfile repoints, and a report
   showing which tool closed what

Secrets are optional:

| secret | effect if absent |
| --- | --- |
| `SOCKET_CLI_API_TOKEN` | phase 1 is skipped; the run is patches-only |
| `SOCKET_API_TOKEN` | phase 2 uses the public patch proxy: free-tier patches only (4 of the 5 packages above) |

With no secrets at all this still runs, patches four packages, and opens a
pull request. Add both secrets to see the full two-phase result.

### `socket-fix-prs.yml`

The alternative for phase 1: Socket Fix in CI mode, opening one pull request
per upgrade instead of folding them into the combined PR. Same definition of
easy (`--no-major-updates`, `--minimum-release-age 7d`). Requires
`SOCKET_CLI_API_TOKEN`; uses `SOCKET_FIX_PAT` if present.

## Quick start

```bash
gh repo fork dc-larsen/socket-fix-patches-demo --clone
cd socket-fix-patches-demo
npm ci
npm run smoke        # 9/9 pass: the app works, vulnerable deps and all
```

Then **Actions → Socket remediation → Run workflow**.

By hand:

```bash
# phase 1
npm install -g socket
socket fix --all --no-major-updates --minimum-release-age 7d
npm ci && npm run smoke

# phase 2
curl -fsSL https://install.socket.dev/patch | sh
socket-patch scan --json                       # read-only: what is still open
socket-patch scan --mode hosted --json --yes   # apply
npm ci && npm run smoke
socket-patch vex --output vex.json             # OpenVEX attestation
npm run verify
```

## What the two diffs look like

Phase 1 is ordinary version bumps in `package.json` (and the matching lockfile
changes):

```diff
-    "express": "4.17.1",
+    "express": "4.22.0",
-    "minimist": "1.2.5",
+    "minimist": "1.2.6",
```

Phase 2 never touches a `"version"` field. Two lines per package in the
lockfile:

```diff
     "node_modules/xmldom": {
       "version": "0.6.0",
-      "resolved": "https://registry.npmjs.org/xmldom/-/xmldom-0.6.0.tgz",
-      "integrity": "sha512-…",
+      "resolved": "https://patch.socket.dev/patch/npm/xmldom/0.6.0/…/xmldom-0.6.0.tgz",
+      "integrity": "sha512-…",
```

The files npm then unpacks carry a header naming the patch:

```js
// Socket Community Patch: https://socket.dev
// For more information see https://socket.dev/patch/<uuid>
```

Free-tier patches say `Socket Community Patch`; org-tier ones say
`Socket Certified Patch`. `scripts/verify-patches.mjs` greps for the part they
share as a cheap, offline check that the patched tarball is the one installed.

## Patch modes

`socket-patch scan --mode <mode>`:

| mode | what lands in the repo | install needs | use when |
| --- | --- | --- | --- |
| `hosted` | two lockfile lines per package | reachable `patch.socket.dev` | default; smallest diff, no build changes |
| `vendored` | the patched artifacts, under `.socket/vendor/` | nothing | air-gapped or hermetic builds |
| `agent` | patch manifest plus blobs | the agent on every install | smallest footprint, most moving parts |

`hosted` is the default here because it needs no build-system changes and the
diff is reviewable. The trade is that installs reach Socket's patch server, so
it is not hermetic. `vendored` is the air-gap answer, at the cost of committing
the artifacts.

## OpenVEX

After phase 2 a scanner looking at `xmldom@0.6.0` still sees a version string
with known CVEs against it. The attestation is how you tell it otherwise:

```json
{
  "vulnerability": { "name": "GHSA-crh6-fp67-6883" },
  "products": [{
    "@id": "pkg:npm/socket-fix-patches-demo@1.0.0",
    "subcomponents": [{ "@id": "pkg:npm/xmldom@0.6.0" }]
  }],
  "status": "not_affected",
  "justification": "inline_mitigations_already_exist"
}
```

`not_affected` with `inline_mitigations_already_exist` is the OpenVEX way of
saying the vulnerable code path is gone even though the version looks
unchanged. Any VEX-aware tool can consume it. The workflow attaches the
document to the run and commits it alongside the lockfile.

## Things worth knowing before you copy this

Found while building and testing this repo:

- **Socket Fix only opens its own pull requests when all four of `CI`,
  `SOCKET_CLI_GITHUB_TOKEN`, `SOCKET_CLI_GIT_USER_NAME` and
  `SOCKET_CLI_GIT_USER_EMAIL` are set.** Actions sets `CI` for you. Leave the
  other three off the step and it edits the working tree instead, which is how
  the combined workflow gets both phases into one PR. It prints "CI mode
  detected, but pull request creation is disabled"; that is expected. Pass
  `--all` in local mode.
- **`--no-major-updates` treats `0.x` minors as non-major.** It proposed
  `axios 0.21.1 → 0.33.0` here. If "easy" has to mean "no breaking changes",
  0.x packages need a closer look.
- **`socket-patch scan --json` on its own changes nothing.** It is read-only.
  A `--mode` flag is what applies. Easy to write a workflow that looks like it
  patches and silently does not.
- **The installer is `https://install.socket.dev/patch`.** The binary it
  installs, `socket-patch`, is a different and newer tool than the
  `socket patch` subcommand bundled with the `socket` CLI, which has no
  `--mode`, no `vex`, and no `vendor`.
- **`socket-patch vex` needs `.socket/`.** Delete that directory and it fails
  with `Manifest not found`. If you gitignore it, the attestation can only be
  produced by the run that applied the patches. That is why the workflow
  commits `.socket/vendor/redirect-state.json`.
- **VEX verification can under-report.** It re-hashes files on disk, and on an
  earlier version of this tree it omitted two correctly installed patches
  (`semver`, `ejs`) whose files carried the right Socket header. Do not gate a
  build on `vex statements == patched packages`; `scripts/verify-patches.mjs`
  reports the gap and keeps going.
- **`vendor --revert` does not undo hosted mode.** It reports
  `Nothing vendored to revert` and leaves the lockfile redirected. To undo
  hosted patches, revert the commit.
- **Socket Fix installs its analysis engine through the Socket-wrapped
  package manager**, so that install is itself policy-evaluated. If your org's
  policy action for `recentlyPublished` is `error`, phase 1 dies before
  computing anything, because the engine publishes near-daily. The workflow
  marks phase 1 `continue-on-error`, reverts any partial edit, and carries on
  with patches. The lasting fix is a package-scoped policy exception for
  `@coana-tech/cli`.
- **The repo has to let Actions open pull requests.** Settings → Actions → General →
  "Allow GitHub Actions to create and approve pull requests" must be on, with
  workflow permissions at read and write. It is off by default on a new repo and
  some organizations disable it by policy; without it the last step fails with
  "GitHub Actions is not permitted to create or approve pull requests".
  `peter-evans/create-pull-request` is the only third-party action here, so
  allow-list it if your organization restricts marketplace actions.
- **Token scopes.** `SOCKET_CLI_API_TOKEN` needs `full-scans:create` and
  `packages:list` (from `socket fix --help`). Creating the `recentlyPublished`
  exception through the triage API needs `triage:alerts-update`.
- **Runners need egress to `patch.socket.dev`** in hosted mode, because
  `npm ci` fetches the patched tarballs from there. If CI egress is locked down,
  use `--mode vendored` and commit the artifacts instead.
- **`secrets` is not available in a step-level `if`.** Map the secret to a
  job-level `env` and test `env.NAME != ''`.
- **Pull requests opened with the default `GITHUB_TOKEN` do not trigger other
  workflows**, so your CI never runs on a Socket Fix PR. Use a PAT in
  `socket-fix-prs.yml` if you want the upgrade tested before merge.
- **`--autopilot` needs repo-level "Allow auto-merge" turned on**, or auto-merge
  is silently never armed.
- **GitHub disables scheduled workflows after ~60 days of repo inactivity.**
  Re-enable from the Actions tab.
- **pnpm 11 rejects a repointed lockfile** unless `trustLockfile: true` is set in
  `pnpm-workspace.yaml`. Hosted mode writes that automatically; opt out with
  `--no-trust-lockfile-config`. This repo uses npm, so it does not apply here.

## Layout

```
.github/workflows/
  socket-remediate.yml    fix (minor/patch) → smoke → patch the rest → smoke → attest → PR
  socket-fix-prs.yml      Socket Fix in CI mode, one PR per upgrade
scripts/
  verify-patches.mjs      confirms patches landed (lockfile + bytes + VEX)
  remediation-plan.mjs    joins the phase 1 and phase 2 results into a report
  fix-summary.mjs         renders a Socket Fix result as markdown
src/
  server.js               small Express app that actually calls its deps
  smoke.js                9 route checks, run at every checkpoint
```

`package.json` pins 17 direct dependencies to known-vulnerable versions, which
pull in vulnerable transitives (`qs@6.7.0`, `send@0.17.1`,
`serve-static@1.14.1`, `body-parser@1.19.0`) through `express@4.17.1`. The app
imports and calls all of them, so a scan sees real usage rather than an unused
dependency list.

## This app is intentionally vulnerable

Do not deploy it, and do not copy its `package.json` into anything real. It
exists to give the tooling something to fix. There is no exploit code here: the
proof that a patch worked is the attestation plus the patch header in the
installed bytes, and the proof that nothing broke is the smoke suite passing
identically at every checkpoint.
