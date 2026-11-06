import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const profiles = {
  connect: [...Array.from({ length: 8 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`), 'Q01'],
  release: [...Array.from({ length: 3 }, (_, i) => `A0${i + 1}`),
    ...Array.from({ length: 17 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`),
    ...Array.from({ length: 4 }, (_, i) => `N0${i + 1}`), ...Array.from({ length: 3 }, (_, i) => `U0${i + 1}`), 'Q01'],
};
export async function sourceIdentity(root) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const hash = createHash('sha256');
  for (const name of [...new Set(files)].sort()) {
    const path = join(root, name);
    try { if ((await stat(path)).isFile()) hash.update(name).update('\0').update(await readFile(path)).update('\0'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; hash.update(name).update('\0missing\0'); }
  }
  return { commit, sha256: hash.digest('hex') };
}
export function cleanupProblems(report, ledger) {
  const problems = [];
  const cleanup = report.cleanup;
  if (!cleanup || cleanup.status !== 'PASS' || cleanup.policy !== 'archive-retained-owner-v2') return ['Q01: verified scoped archival cleanup is missing.'];
  if (!Array.isArray(ledger?.fixtures)) return ['Q01: fixture ledger is missing.'];
  const expected = new Set(ledger.fixtures.map(f => f.threadId).filter(Boolean));
  if (!expected.size) problems.push('Q01: no accepted QA fixture is registered.');
  const items = cleanup.items;
  if (!Array.isArray(items) || !Array.isArray(cleanup.remainingThreadIds)) return [...problems, 'Q01: incomplete cleanup inventory.'];
  if (cleanup.remainingThreadIds.length) problems.push('Q01: QA conversations still require archival.');
  const seen = new Set();
  let pluginArchives = 0, retainedArchives = 0;
  for (const item of items) {
    if (!expected.has(item.threadId) || seen.has(item.threadId)) problems.push('Q01: unknown or duplicate cleanup target.');
    seen.add(item.threadId);
    const plugin = item.performedBy === 'claude-via-magpie' && item.tool === 'codex_archive' && item.serverAcknowledged === true &&
      /^[A-Za-z0-9_-]{8,128}$/.test(item.requestId ?? '');
    const manual = item.performedBy === 'desktop-operator' && item.tool === 'desktop-native-archive' &&
      item.operatorConfirmed === true && typeof item.ownerActionEvidence === 'string' && item.ownerActionEvidence.length > 0;
    if (plugin) pluginArchives++;
    if (plugin && item.route === 'background-owner' && item.ownerVerified === true) retainedArchives++;
    if (!['archived', 'already_archived'].includes(item.status) || (!plugin && !manual) ||
      item.verifiedState?.active !== false || item.verifiedState?.archived !== true ||
      !Array.isArray(item.evidence) || !item.evidence.length) problems.push(`Q01: archival is not verified for ${item.threadId}.`);
  }
  if (!pluginArchives) problems.push('Q01: manual cleanup cannot replace a real Claude-through-Magpie archive.');
  if (!retainedArchives) problems.push('Q01: a verified original-background-owner archive through Claude/Magpie is required.');
  for (const id of expected) if (!seen.has(id)) problems.push(`Q01: fixture ${id} has no cleanup result.`);
  return problems;
}
export async function evaluateGate(manifest, report, { identity, evidenceExists, requiredProfile, ledger }) {
  const problems = [];
  const ids = profiles[manifest.profile];
  if (requiredProfile && manifest.profile !== requiredProfile) problems.push('This run does not satisfy the required profile.');
  if (!ids) return { releaseGate: 'CLOSED', problems: ['Unknown acceptance profile.'] };
  if (identity.commit !== manifest.source.commit || identity.sha256 !== manifest.source.sha256) problems.push('Source snapshot changed; rerun acceptance.');
  if (report.runId !== manifest.runId || report.profile !== manifest.profile) problems.push('Report identity/profile mismatch.');
  const loaded = report.loadedPlugin;
  if (!loaded || loaded.pluginVersion !== manifest.expectedVersion || !loaded.loadedAt || loaded.moduleUrl !== manifest.expectedModuleUrl) problems.push('Actual loaded plugin identity is missing or mismatched.');
  for (const id of ids) {
    const item = report.cases?.[id];
    if (item?.status !== 'PASS') { problems.push(`${id}: ${item?.status ?? 'MISSING'}`); continue; }
    if (!Array.isArray(item.evidence) || !item.evidence.length) { problems.push(`${id}: missing evidence`); continue; }
    for (const path of item.evidence) if (typeof path !== 'string' || !await evidenceExists(path)) problems.push(`${id}: unavailable evidence file`);
  }
  problems.push(...cleanupProblems(report, ledger));
  for (const item of Array.isArray(report.cleanup?.items) ? report.cleanup.items : []) {
    const paths = [...(Array.isArray(item.evidence) ? item.evidence : []), ...(item.ownerActionEvidence ? [item.ownerActionEvidence] : [])];
    for (const path of paths) if (typeof path !== 'string' || !await evidenceExists(path)) problems.push('Q01: unavailable archival evidence file.');
  }
  return { releaseGate: problems.length ? 'CLOSED' : 'OPEN', profile: manifest.profile,
    scope: manifest.profile === 'connect' ? 'Basic create/read/notification connection only; not release acceptance.' : 'Complete documented release matrix.', problems };
}
export async function checkRun(directory, { requiredProfile } = {}) {
  const run = await realpath(directory);
  const manifest = JSON.parse(await readFile(join(run, 'manifest.json'), 'utf8'));
  const report = JSON.parse(await readFile(join(run, 'results.json'), 'utf8'));
  const ledger = JSON.parse(await readFile(join(run, 'ledger.json'), 'utf8'));
  if (!profiles[manifest.profile] || typeof manifest.sourceRoot !== 'string' || !manifest.source?.sha256 || !manifest.source?.commit) {
    throw Error('Unsupported run manifest. Prepare a new run with the maintained acceptance launcher; historical audit reports cannot open this gate.');
  }
  const identity = await sourceIdentity(manifest.sourceRoot);
  const result = await evaluateGate(manifest, report, { identity, requiredProfile, ledger, evidenceExists: async name => {
    try {
      const path = await realpath(resolve(run, name)), rel = relative(run, path);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
      const info = await stat(path); return info.isFile() && info.size > 0;
    } catch { return false; }
  } });
  await writeFile(join(run, 'gate.json'), JSON.stringify({ ...result, checkedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  return result;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const index = args.indexOf('--require-profile');
    const requiredProfile = index < 0 ? undefined : args[index + 1];
    if (index >= 0) {
      if (!profiles[requiredProfile]) throw Error('Invalid required profile.');
      args.splice(index, 2);
    }
    if (args.length !== 1) throw Error('Usage: npm run acceptance:check -- /absolute/run-directory [--require-profile release]');
    const result = await checkRun(args[0], { requiredProfile }); console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.releaseGate === 'OPEN' ? 0 : 1;
  } catch (error) { console.error(`Acceptance gate CLOSED: ${error.message}`); process.exitCode = 1; }
}
