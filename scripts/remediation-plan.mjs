// Joins the phase 1 result (Socket Fix) with the phase 2 result (Socket
// Patches) and prints a markdown report of which tool closed what.
//
//   node scripts/remediation-plan.mjs <socket-fix-applied.json> <socket-patch-applied.json>
//
// socket-fix-applied.json    output of: socket fix --all --output-file <path>
//                            shape: { type, fixes: { GHSA: [{ purl, fixedVersion }] }, failedToFix: [GHSA] }
// socket-patch-applied.json  output of: socket-patch scan --mode hosted --json
//                            shape: { packages: [{ purl, patches: [...] }], redirect: { redirected } }
//
// Either file may be missing when its phase was skipped; the report says so.
import { readFileSync, existsSync } from 'node:fs';

const [fixPath, patchPath] = process.argv.slice(2);
const read = (p) => (p && existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const fix = read(fixPath);
const patch = read(patchPath);

const nameOf = (purl) => purl.replace(/^pkg:npm\//, '').replace(/@[^@]*$/, '');
const versionOf = (purl) => purl.slice(purl.lastIndexOf('@') + 1);

// Numeric-ish version compare, enough to pick the highest target version when
// several advisories on one package resolve at different versions.
function cmpVersion(a, b) {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// --- phase 1: upgrades --------------------------------------------------------
const upgrades = new Map(); // name -> { name, from, to, advisories }
if (fix) {
  for (const [ghsa, ups] of Object.entries(fix.fixes || {})) {
    for (const u of ups) {
      const name = nameOf(u.purl);
      const cur = upgrades.get(name) || {
        name,
        from: versionOf(u.purl),
        to: u.fixedVersion,
        advisories: new Set(),
      };
      if (cmpVersion(u.fixedVersion, cur.to) > 0) cur.to = u.fixedVersion;
      cur.advisories.add(ghsa);
      upgrades.set(name, cur);
    }
  }
}
const upgradedAdvisories = new Set(fix ? Object.keys(fix.fixes || {}) : []);
const failedToFix = fix ? fix.failedToFix || [] : [];

// --- phase 2: patches -----------------------------------------------------------
const patched = []; // { name, version, tiers, advisories: [{ ghsa, severity, title }] }
if (patch) {
  for (const p of patch.packages || []) {
    const advisories = [];
    for (const q of p.patches || []) {
      for (const ghsa of q.ghsaIds || []) {
        advisories.push({ ghsa, severity: q.severity, title: q.title, tier: q.tier });
      }
    }
    patched.push({
      name: nameOf(p.purl),
      version: versionOf(p.purl),
      tiers: [...new Set((p.patches || []).map((q) => q.tier))].sort(),
      advisories,
    });
  }
}
const patchedAdvisories = new Set(patched.flatMap((p) => p.advisories.map((a) => a.ghsa)));
const leftover = failedToFix.filter((g) => !patchedAdvisories.has(g));

// --- report ---------------------------------------------------------------------
const out = [];
out.push('## Socket remediation: upgrade what is easy, patch the rest', '');
out.push('| phase | tool | packages | advisories | installed version |');
out.push('| --- | --- | --- | --- | --- |');
out.push(
  `| 1 | Socket Fix, minor and patch upgrades only | ${upgrades.size} | ${upgradedAdvisories.size} | changes |`
);
out.push(
  `| 2 | Socket Patches, hosted mode | ${patched.length} | ${patchedAdvisories.size} | unchanged |`
);
if (leftover.length) {
  out.push(`| – | neither | | ${leftover.length} | needs manual work |`);
}
out.push('');

if (!fix) {
  out.push(
    '> Phase 1 did not run: no `SOCKET_CLI_API_TOKEN` was available (or Socket Fix failed and was ' +
      'reverted), so this is a patches-only result. The packages below would otherwise be split ' +
      'between an upgrade and a patch.',
    ''
  );
}
if (patch && patch.canAccessPaidPatches === false) {
  out.push(
    '> Phase 2 ran against the public patch proxy, so only free-tier patches were applied. ' +
      'Set `SOCKET_API_TOKEN` for the full catalogue.',
    ''
  );
}

if (upgrades.size) {
  out.push(`### Phase 1: ${upgrades.size} packages upgraded`, '');
  out.push(
    'Each of these had a fixed release within the same major version, so the upgrade is the ' +
      'cheaper move: it closes the advisory and lands on a maintained release.',
    ''
  );
  out.push('| package | from | to | advisories closed |', '| --- | --- | --- | --- |');
  for (const u of [...upgrades.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    out.push(`| \`${u.name}\` | ${u.from} | ${u.to} | ${u.advisories.size} |`);
  }
  out.push('');
}

if (patched.length) {
  out.push(`### Phase 2: ${patched.length} packages patched in place`, '');
  out.push(
    'Still vulnerable after phase 1. Either the only fixed release is a major bump, there is no ' +
      'fixed release at all, or the version phase 1 upgraded to carries an advisory of its own. ' +
      'The version stays where it is; the lockfile now resolves it from Socket\'s patch server.',
    ''
  );
  out.push('| package | version | advisory | severity | tier |', '| --- | --- | --- | --- | --- |');
  for (const p of patched.sort((a, b) => a.name.localeCompare(b.name))) {
    for (const a of p.advisories) {
      out.push(`| \`${p.name}\` | ${p.version} | ${a.ghsa} | ${a.severity || '-'} | ${a.tier || '-'} |`);
    }
  }
  out.push('');
} else if (patch) {
  out.push('### Phase 2: nothing left to patch', '', 'Every advisory phase 1 could not upgrade away has no published patch either.', '');
}

if (leftover.length) {
  out.push(`### ${leftover.length} advisories neither tool resolved`, '');
  out.push('No minor or patch upgrade, and no published patch.', '');
  out.push('```', leftover.slice(0, 40).join('\n'));
  if (leftover.length > 40) out.push(`… ${leftover.length - 40} more`);
  out.push('```', '');
}

// Blank lines are load-bearing: GitHub markdown needs one before a table.
console.log(out.filter((l) => l !== undefined).join('\n'));
