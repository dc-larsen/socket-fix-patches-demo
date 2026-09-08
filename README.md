# Socket Patches + Socket Fix: a GitHub Actions test project

A small, deliberately vulnerable Node app used to exercise two different ways of
clearing CVEs out of a dependency tree, and to show where each one earns its
keep.

| | Socket Patches | Socket Fix |
| --- | --- | --- |
| what changes | the tarball the lockfile resolves to | the dependency version |
| installed version | **unchanged** | upgraded |
| your code | untouched | may need to adapt to the new version |
| coverage | only where a patch has been published | wherever an upgrade path exists |
| review cost | a two-line lockfile diff per package | a version bump to test and ship |

The order matters, and it is the whole point of this repo. Patches leave the
installed version exactly where it is, so nothing downstream has to be
retested. Upgrades change the version and can change behaviour. So: **patch
everything that has a patch, then upgrade only what is left.**

On this repo's dependency tree, that split currently looks like:

- **22** advisories have a Socket patch available
- **62** advisories have an upgrade available via Socket Fix
- **20** of those overlap — a patch resolves them, so those upgrades never need
  to be reviewed at all
- **2** are patch-only, where Socket Fix found no upgrade path
- **42** are upgrade-only, with no patch published yet
- **23** neither tool can resolve automatically

The 20 overlapping advisories are the interesting number. Without patches, that
column includes `axios 0.21.1 → 0.33.0` and `express 4.17.1 → 4.22.0`. With
patches, those advisories close while `axios` stays on `0.21.1`.

> Run the workflow to regenerate these numbers. Patch coverage grows over time,
> so the split shifts.

## Workflows

### `socket-remediate.yml` — patch, prove, then report

The main one. It:

1. runs the app's smoke tests to establish a baseline
2. installs `socket-patch` and takes a read-only inventory of available patches
3. applies them in **hosted mode**, which rewrites only `resolved` and
   `integrity` in `package-lock.json`
4. reinstalls and **runs the same smoke tests again**
5. emits an **OpenVEX 0.2.0** attestation for the advisories it mitigated
6. verifies the patches actually landed, from the lockfile, from the bytes in
   `node_modules`, and from the attestation
7. asks Socket Fix what upgrades are *still* required (report only — no PRs)
8. opens one pull request with the patched lockfile and the full report as the
   PR body

**It needs no secrets.** Without a token, `socket-patch` uses the public patch
proxy, which serves free-tier patches — 13 of them on this tree, covering 11
packages. Add secrets to go further:

| secret | effect if absent |
| --- | --- |
| `SOCKET_API_TOKEN` | free-tier patches only (11 packages instead of 15) |
| `SOCKET_CLI_API_TOKEN` | the upgrade half of the report is omitted |

### `socket-fix-prs.yml` — upgrade pull requests

Runs Socket Fix in CI mode so it opens its own pull requests, one per fix. This
is the half that handles advisories with no patch available. Requires
`SOCKET_CLI_API_TOKEN`; also reads `SOCKET_FIX_PAT` if present.

Defaults to `--no-major-updates` and `--minimum-release-age 7d`. The release-age
floor means an upgrade has to have been public for a week before Socket Fix will
suggest it, which gives the ecosystem time to pull a malicious release before
you upgrade into it.

## Quick start

```bash
gh repo fork dc-larsen/socket-fix-patches-demo --clone
cd socket-fix-patches-demo
npm ci
npm run smoke        # 7/7 pass — the app works, vulnerable deps and all
```

Then run **Actions → Socket remediation → Run workflow**. With no secrets set
you will get patches applied, verified, attested, and a pull request opened.

To try it by hand:

```bash
curl -fsSL https://install.socket.dev/patch | sh

socket-patch scan --json                      # read-only: what's available
socket-patch scan --mode hosted --json --yes  # apply
npm ci                                        # install the patched tarballs
npm run smoke                                 # still 7/7
socket-patch vex --output vex.json            # OpenVEX attestation
npm run verify                                # confirm the patches landed
```

## What the patch diff looks like

```diff
     "node_modules/axios": {
       "version": "0.21.1",
-      "resolved": "https://registry.npmjs.org/axios/-/axios-0.21.1.tgz",
-      "integrity": "sha512-dKQiRHxGD9PPRIUNIWvZhPTPpl1rf/OxTYKsqKUDjBwYylTvV7SjSHJb9ratfyzM6wCdLCOYLzs73qpg5c4iGA==",
+      "resolved": "https://patch.socket.dev/patch/npm/axios/0.21.1/…/axios-0.21.1.tgz",
+      "integrity": "sha512-mYqSMPnS9SAimkd/Y1Eoz09ZntI1vF6ppiwQB/dVOy56ufAaJcM0hzVLCyxZFtTjjH7CLenP4cXo4xWuP+zI7Q==",
```

`"version"` does not move. Fifteen patched packages come to 24 changed lines in
the lockfile and nothing else. The files that npm then unpacks carry a header
naming the patch:

```js
// Socket Community Patch: https://socket.dev
// For more information see https://socket.dev/patch/bef9d52f-…
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
| `agent` | patch manifest plus blobs | the agent must run on every install | smallest footprint, most moving parts |

`hosted` is the default here because it needs no build-system changes and the
diff is reviewable. The trade is that installs reach Socket's patch server, so
it is not hermetic. `vendored` is the air-gap answer, at the cost of committing
the artifacts.

Modes are also spelled as booleans (`--redirect`, `--vendor`, `--apply`).
Prefer `--mode`.

## OpenVEX

After patching, a scanner looking at `axios@0.21.1` still sees a version string
with known CVEs against it. The attestation is how you tell it otherwise:

```json
{
  "vulnerability": { "name": "GHSA-jr5f-v2jv-69x6" },
  "products": [{
    "@id": "pkg:npm/socket-fix-patches-demo@1.0.0",
    "subcomponents": [{ "@id": "pkg:npm/axios@0.21.1" }]
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

Found while building and testing this repo, all verified against
`socket-patch 4.0.0` and `socket` CLI `1.1.170`:

- **`scan --json` on its own does not change anything.** It is read-only and
  lists an `updates` array. A `--mode` flag is what makes it apply. Easy to
  write a workflow that looks like it patches and silently does not.
- **The installer is `https://install.socket.dev/patch`.** The binary it
  installs is `socket-patch`, which is a different and newer tool than the
  `socket patch` subcommand bundled with the `socket` CLI — that bundled one
  has no `--mode`, no `vex`, and no `vendor`.
- **`socket-patch vex` needs `.socket/`.** Delete that directory and it fails
  with `Manifest not found`. If you gitignore it, the attestation can only ever
  be produced by the same run that applied the patches. That is why the
  workflow commits `.socket/vendor/redirect-state.json`.
- **VEX verification can under-report.** It re-hashes files on disk, and on this
  tree two of fifteen patched packages were omitted (`semver`, one `not_applied`;
  `ejs`, one `file_not_found`) even though both carry the correct Socket patch
  header for the expected patch UUID and both were installed from the patch
  server. So do not gate a build on `vex statements == patched packages`.
  `scripts/verify-patches.mjs` reports the gap and keeps going.
- **`vendor --revert` does not undo hosted mode.** It reports
  `Nothing vendored to revert` and leaves the lockfile redirected. To undo
  hosted patches, revert the commit.
- **Socket Fix installs its own analysis engine through the Socket-wrapped
  package manager**, so that install is itself policy-evaluated. If your org's
  policy action for `recentlyPublished` is `error`, Socket Fix dies before
  computing anything, because the engine publishes near-daily and is almost
  always inside the recency window. `SOCKET_CLI_ACCEPT_RISKS` does not override
  an `error` verdict. The fix is a package-scoped policy exception for
  `@coana-tech/cli`. The workflow marks that step `continue-on-error` so the
  patch half still lands.
- **`secrets` is not available in a step-level `if`.** Map the secret to a
  job-level `env` and test `env.NAME != ''`.
- **Pull requests opened with the default `GITHUB_TOKEN` do not trigger other
  workflows**, so your CI never runs on a Socket Fix PR. Use a PAT if you want
  the upgrade actually tested before merge.
- **`--autopilot` needs repo-level "Allow auto-merge" turned on**, or auto-merge
  is silently never armed.
- **GitHub disables scheduled workflows after ~60 days of repo inactivity.**
  Re-enable from the Actions tab.
- **pnpm 11 rejects a repointed lockfile** unless `trustLockfile: true` is set in
  `pnpm-workspace.yaml`. Hosted mode writes that automatically; opt out with
  `--no-trust-lockfile-config` and every install then needs
  `pnpm install --trust-lockfile`. This repo uses npm, so it does not apply here.

## Layout

```
.github/workflows/
  socket-remediate.yml    patch → verify → attest → report → PR
  socket-fix-prs.yml      Socket Fix in CI mode, opens upgrade PRs
scripts/
  verify-patches.mjs      confirms patches landed (lockfile + bytes + VEX)
  remediation-plan.mjs    joins the patch inventory with the upgrade plan
  fix-summary.mjs         renders a Socket Fix result as markdown
src/
  server.js               small Express app that actually calls its deps
  smoke.js                7 route checks, run before and after patching
```

`package.json` pins 15 direct dependencies to known-vulnerable versions, which
pull in vulnerable transitives (`qs@6.7.0`, `send@0.17.1`,
`serve-static@1.14.1`, `body-parser@1.19.0`) through `express@4.17.1`. The app
imports and calls all of them, so a scan sees real usage rather than an unused
dependency list.

## This app is intentionally vulnerable

Do not deploy it, and do not copy its `package.json` into anything real. It
exists to give the tooling something to fix. There is no exploit code here: the
proof that a patch worked is the attestation plus the patch header in the
installed bytes, and the proof that it did not break anything is the smoke
suite passing identically before and after.
