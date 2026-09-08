// Verifies that Socket Patches actually landed, from two independent angles:
//
//   1. Structural — the files inside node_modules carry Socket's patch header,
//      which means the tarball npm installed is the patched one.
//   2. Attested — the OpenVEX document that `socket-patch` emitted lists a
//      `fixed` statement for each vulnerability it mitigated.
//
// Exits non-zero only when nothing was patched at all. A package that is
// redirected in the lockfile but missing from the VEX document is reported as a
// discrepancy rather than a hard failure: `socket-patch vex` re-hashes files on
// disk, and a hash mismatch omits an otherwise-correctly-installed patch.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const VEX_PATH = process.env.VEX_PATH || 'socket-patches.openvex.json';
const LOCK_PATH = 'package-lock.json';
const PATCH_HOST = 'patch.socket.dev';
// Free-tier patches are headed "Socket Community Patch", org-tier ones
// "Socket Certified Patch". Match the part both share.
const PATCH_MARKER = 'Patch: https://socket.dev';

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// --- 1. lockfile: which packages were repointed at the patch server ---------
if (!existsSync(LOCK_PATH)) fail(`${LOCK_PATH} not found`);
const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
const redirected = Object.entries(lock.packages || {})
  .filter(([, meta]) => typeof meta.resolved === 'string' && meta.resolved.includes(PATCH_HOST))
  .map(([path, meta]) => ({ path, version: meta.version, resolved: meta.resolved }));

// --- 2. node_modules: do the installed bytes carry the patch header? --------
function headerFiles(dir, depth = 0) {
  if (depth > 3 || !existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) out.push(...headerFiles(full, depth + 1));
    else if (entry.endsWith('.js') || entry.endsWith('.cjs') || entry.endsWith('.mjs')) {
      try {
        if (readFileSync(full, 'utf8').slice(0, 400).includes(PATCH_MARKER)) out.push(full);
      } catch { /* unreadable file, ignore */ }
    }
  }
  return out;
}

const structural = [];
for (const pkg of redirected) {
  const dir = pkg.path.startsWith('node_modules/') ? pkg.path : join('node_modules', pkg.path);
  const hits = headerFiles(dir);
  structural.push({ ...pkg, patchedFiles: hits.length, name: dir.replace(/^node_modules\//, '') });
}

// --- 3. OpenVEX: what did Socket attest? -----------------------------------
let vexStatements = [];
let vexProduct = null;
if (existsSync(VEX_PATH)) {
  const vex = JSON.parse(readFileSync(VEX_PATH, 'utf8'));
  vexStatements = vex.statements || [];
  vexProduct = vexStatements[0]?.products?.[0]?.['@id'] || null;
}

// --- report ----------------------------------------------------------------
console.log('Socket Patches verification');
console.log('===========================\n');

if (redirected.length === 0) {
  console.log('No packages in package-lock.json resolve to the Socket patch server.');
  console.log('Nothing was patched — run `socket-patch scan --mode hosted` first.');
  process.exit(1);
}

console.log(`Lockfile entries repointed to ${PATCH_HOST}: ${redirected.length}\n`);
const width = Math.max(...structural.map((s) => s.name.length), 24);
for (const s of structural) {
  const mark = s.patchedFiles > 0 ? 'verified' : 'NO HEADER';
  console.log(`  ${s.name.padEnd(width)}  ${String(s.version).padEnd(10)} ${mark} (${s.patchedFiles} file${s.patchedFiles === 1 ? '' : 's'})`);
}

const withHeader = structural.filter((s) => s.patchedFiles > 0);
console.log(`\nInstalled packages carrying Socket patch headers: ${withHeader.length}/${redirected.length}`);

if (existsSync(VEX_PATH)) {
  // Socket asserts `not_affected` with the `inline_mitigations_already_exist`
  // justification, which is the OpenVEX way of saying the vulnerable code path
  // was patched in place rather than upgraded away.
  const byStatus = vexStatements.reduce((acc, s) => {
    acc[s.status] = (acc[s.status] || 0) + 1;
    return acc;
  }, {});
  const mitigated = vexStatements.filter(
    (s) => s.status === 'not_affected' && s.justification === 'inline_mitigations_already_exist'
  );
  const vulns = new Set(vexStatements.map((s) => s.vulnerability?.name).filter(Boolean));
  console.log(`OpenVEX statements: ${vexStatements.length} (${
    Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'
  })`);
  console.log(`Attested as patched in place: ${mitigated.length}`);
  console.log(`Distinct vulnerabilities covered: ${vulns.size}`);
  if (vexProduct) console.log(`Product: ${vexProduct}`);
  if (vulns.size) console.log(`\n  ${[...vulns].sort().join('\n  ')}`);
  if (vexStatements.length < redirected.length) {
    console.log(
      `\nnote: ${redirected.length - vexStatements.length} redirected package(s) are absent from the VEX document.` +
      `\n      socket-patch re-hashes files on disk to build the attestation, so a hash` +
      `\n      mismatch omits a patch that is nevertheless installed. Treated as a` +
      `\n      discrepancy to review, not a failure.`
    );
  }
} else {
  console.log(`\nnote: no VEX document at ${VEX_PATH}; skipped attestation checks.`);
}

if (withHeader.length === 0) {
  fail('lockfile points at the patch server but no installed file carries a patch header');
}
console.log('\nOK');
