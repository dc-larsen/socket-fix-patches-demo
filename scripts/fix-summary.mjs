// Renders a markdown summary of a `socket fix` result file.
//
//   node scripts/fix-summary.mjs socket-fix-applied.json
//
// The result file has the shape:
//   { type, fixes: { "<GHSA>": [{ purl, fixedVersion }] }, failedToFix: ["<GHSA>"] }
import { readFileSync, existsSync } from 'node:fs';

const path = process.argv[2];
if (!path || !existsSync(path)) {
  console.log('## Socket Fix\n\nNo result file was produced; see the run log.');
  process.exit(0);
}

const data = JSON.parse(readFileSync(path, 'utf8'));
const fixes = data.fixes || {};
const failed = data.failedToFix || [];

// One advisory can be resolved by upgrading several packages, and one upgrade
// can resolve several advisories, so collapse to a unique upgrade set.
const upgrades = new Map();
for (const ups of Object.values(fixes)) {
  for (const u of ups) {
    const name = String(u.purl).replace(/^pkg:npm\//, '').replace(/@[^@]*$/, '');
    const key = `${name}@${u.fixedVersion}`;
    if (!upgrades.has(key)) upgrades.set(key, { name, to: u.fixedVersion, advisories: new Set() });
  }
}
for (const [ghsa, ups] of Object.entries(fixes)) {
  for (const u of ups) {
    const name = String(u.purl).replace(/^pkg:npm\//, '').replace(/@[^@]*$/, '');
    upgrades.get(`${name}@${u.fixedVersion}`).advisories.add(ghsa);
  }
}

const out = [];
out.push('## Socket Fix', '');
out.push(`- result type: \`${data.type || 'unknown'}\``);
out.push(`- advisories with an available upgrade: **${Object.keys(fixes).length}**`);
out.push(`- distinct upgrades: **${upgrades.size}**`);
out.push(`- advisories Socket Fix could not resolve: **${failed.length}**`);
out.push('');

if (upgrades.size) {
  out.push('### Upgrades', '', '| package | to | advisories resolved |', '| --- | --- | --- |');
  for (const u of [...upgrades.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    out.push(`| \`${u.name}\` | ${u.to} | ${u.advisories.size} |`);
  }
  out.push('');
}

if (failed.length) {
  out.push(
    `### ${failed.length} advisories with no safe upgrade`, '',
    'These need a patch, a manual upgrade, or a documented risk acceptance.', '',
    '```', failed.slice(0, 40).join('\n'),
    failed.length > 40 ? `… ${failed.length - 40} more` : '', '```', ''
  );
}

// Blank lines are load-bearing here: GitHub markdown needs one before a table
// or the table renders as literal pipes.
console.log(out.filter((l) => l !== undefined).join('\n'));
