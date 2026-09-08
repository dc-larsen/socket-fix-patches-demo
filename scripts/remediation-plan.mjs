// Joins the Socket Patches inventory with the Socket Fix plan and prints a
// markdown report showing which tool owns which vulnerability.
//
//   node scripts/remediation-plan.mjs <patch-scan.json> [fix-plan.json]
//
// patch-scan.json  output of: socket-patch scan --json
// fix-plan.json    output of: socket fix --no-apply-fixes --output-file <path>
//
// The split matters because the two tools have different costs. A patch keeps
// the installed version identical, so nothing downstream has to be retested. An
// upgrade changes the version and can change behaviour. Where both can resolve
// the same advisory, the patch is the cheaper move.
import { readFileSync, existsSync } from 'node:fs';

const [patchPath, fixPath] = process.argv.slice(2);
if (!patchPath) {
  console.error('usage: node scripts/remediation-plan.mjs <patch-scan.json> [fix-plan.json]');
  process.exit(2);
}

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

// --- patches ---------------------------------------------------------------
const scan = read(patchPath);
const patchByGhsa = new Map();
for (const pkg of scan.packages || []) {
  for (const patch of pkg.patches || []) {
    for (const ghsa of patch.ghsaIds || []) {
      patchByGhsa.set(ghsa, {
        purl: pkg.purl,
        tier: patch.tier,
        severity: patch.severity,
        title: patch.title,
      });
    }
  }
}

// --- fix -------------------------------------------------------------------
let fixByGhsa = new Map();
let failedToFix = [];
if (fixPath && existsSync(fixPath)) {
  const fix = read(fixPath);
  fixByGhsa = new Map(Object.entries(fix.fixes || {}));
  failedToFix = fix.failedToFix || [];
}

const patchGhsas = new Set(patchByGhsa.keys());
const fixGhsas = new Set(fixByGhsa.keys());
const both = [...patchGhsas].filter((g) => fixGhsas.has(g)).sort();
const patchOnly = [...patchGhsas].filter((g) => !fixGhsas.has(g)).sort();
const fixOnly = [...fixGhsas].filter((g) => !patchGhsas.has(g)).sort();

const pkgName = (purl) => purl.replace(/^pkg:npm\//, '').replace(/@[^@]*$/, '');
const upgradeFor = (ghsa) =>
  (fixByGhsa.get(ghsa) || [])
    .map((u) => `${pkgName(u.purl)} → ${u.fixedVersion}`)
    .join(', ');

const lines = [];
lines.push('## Socket remediation plan', '');
lines.push('| route | advisories | what happens to the installed version |');
lines.push('| --- | --- | --- |');
lines.push(`| Patch (no upgrade needed) | ${both.length + patchOnly.length} | unchanged |`);
lines.push(`| Upgrade only (no patch available) | ${fixOnly.length} | version changes |`);
lines.push(`| Neither tool can auto-resolve | ${failedToFix.length} | needs manual work |`);
lines.push('');

lines.push(
  `**${scan.packagesWithPatches || 0} package(s)** have Socket patches available ` +
  `(${scan.totalPatches || 0} patches: ${scan.freePatches || 0} free, ${scan.paidPatches || 0} org-tier).`
);
if (scan.canAccessPaidPatches === false) {
  lines.push('');
  lines.push(
    '> Running against the public patch proxy, so only free-tier patches are listed. ' +
    'Set a `SOCKET_API_TOKEN` to include your organization\'s full patch catalogue.'
  );
}
lines.push('');

if (both.length) {
  lines.push(
    `### ${both.length} advisories where a patch replaces an upgrade`, '',
    'Socket Fix proposed a version bump for each of these, and a patch resolves the same',
    'advisory without changing the installed version. Applying patches first means these',
    'upgrades never have to be reviewed, tested, or shipped.', '',
    '| advisory | package | severity | upgrade avoided |',
    '| --- | --- | --- | --- |'
  );
  for (const g of both) {
    const p = patchByGhsa.get(g);
    lines.push(`| ${g} | \`${pkgName(p.purl)}\` | ${p.severity || '-'} | ${upgradeFor(g) || '-'} |`);
  }
  lines.push('');
}

if (patchOnly.length) {
  lines.push(
    `### ${patchOnly.length} advisories only a patch resolves`, '',
    'Socket Fix found no upgrade path for these.', '',
    '| advisory | package | severity | title |', '| --- | --- | --- | --- |'
  );
  for (const g of patchOnly) {
    const p = patchByGhsa.get(g);
    lines.push(`| ${g} | \`${pkgName(p.purl)}\` | ${p.severity || '-'} | ${(p.title || '').slice(0, 80)} |`);
  }
  lines.push('');
}

if (fixOnly.length) {
  lines.push(
    `### ${fixOnly.length} advisories that require an upgrade`, '',
    'No patch exists for these yet, so Socket Fix owns them.', '',
    '| advisory | upgrade |', '| --- | --- |'
  );
  for (const g of fixOnly.slice(0, 40)) lines.push(`| ${g} | ${upgradeFor(g) || '-'} |`);
  if (fixOnly.length > 40) lines.push(`| … | ${fixOnly.length - 40} more |`);
  lines.push('');
}

if (failedToFix.length) {
  lines.push(
    `### ${failedToFix.length} advisories neither tool resolved automatically`, '',
    'No patch, and no upgrade that Socket Fix could apply safely.', '',
    '```',
    failedToFix.slice(0, 30).join('\n'),
    failedToFix.length > 30 ? `… ${failedToFix.length - 30} more` : '',
    '```',
    ''
  );
}

console.log(lines.filter((l) => l !== undefined).join('\n'));
