import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareRun, acceptanceServers } from '../scripts/acceptance.mjs';
import { evaluateGate, profiles, cleanupProblems } from '../scripts/acceptance-gate.mjs';
const identity = { commit: 'commit', sha256: 'source' };
const manifest = { runId: 'run', profile: 'connect', source: identity, expectedVersion: 'local', expectedModuleUrl: 'file:///local/src/version.js' };
const qaId = '01900000-0000-7000-8000-000000000001';
const ledger = { fixtures: [{ threadId: qaId }] };
test('acceptance preserves the configured dispatch alias and rejects duplicate or missing entries', () => {
  const dispatch = { type: 'http', url: 'http://127.0.0.1/example' }, notifications = { command: 'example' };
  const selected = acceptanceServers({ mcpServers: { 'magpie-codex-dispatch-plugin': dispatch, 'codex-notifications': notifications, unrelated: {} } });
  assert.deepEqual(Object.keys(selected), ['magpie-codex-dispatch-plugin', 'codex-notifications']);
  assert.equal(selected['magpie-codex-dispatch-plugin'], dispatch);
  assert.throws(() => acceptanceServers({ mcpServers: { ...selected, 'magpie-codex-dispatch': dispatch } }), /Multiple/);
  assert.throws(() => acceptanceServers({ mcpServers: { 'codex-notifications': notifications } }), /Configure/);
});
function report() { return { runId: 'run', profile: 'connect', loadedPlugin: { pluginVersion: 'local', moduleUrl: manifest.expectedModuleUrl, loadedAt: 'now' },
  cleanup: { status: 'PASS', policy: 'archive-retained-owner-v2', remainingThreadIds: [], items: [{ threadId: qaId, performedBy: 'claude-via-magpie', tool: 'codex_archive', route: 'background-owner', ownerVerified: true, requestId: 'cleanup-0001', serverAcknowledged: true, status: 'archived', verifiedState: { active: false, archived: true }, evidence: ['archive.json'] }] },
  cases: Object.fromEntries(profiles.connect.map(id => [id, { status: 'PASS', evidence: ['evidence.json'] }])) }; }
test('gate independently rejects false OPEN claims, missing cases and invalid evidence', async () => {
  const evaluate = (r, extra = {}) => evaluateGate(manifest, r, { identity, ledger, evidenceExists: async () => true, ...extra });
  assert.equal((await evaluate(report())).releaseGate, 'OPEN');
  assert.equal((await evaluate(report(), { requiredProfile: 'release' })).releaseGate, 'CLOSED');
  for (const status of ['FAIL', 'BLOCKED', 'NOT_RUN']) {
    const r = report(); r.releaseGate = 'OPEN'; r.cases.C05.status = status;
    assert.equal((await evaluate(r)).releaseGate, 'CLOSED');
  }
  const missing = report(); delete missing.cases.C01;
  assert.equal((await evaluate(missing)).releaseGate, 'CLOSED');
  assert.equal((await evaluate(report(), { evidenceExists: async () => false })).releaseGate, 'CLOSED');
  assert.equal((await evaluate(report(), { identity: { ...identity, sha256: 'edited' } })).releaseGate, 'CLOSED');
  const stale = report(); stale.loadedPlugin.moduleUrl = 'file:///git-cache/src/version.js';
  assert.equal((await evaluate(stale)).releaseGate, 'CLOSED');
  const wrong = report(); wrong.profile = 'release';
  assert.equal((await evaluate(wrong)).releaseGate, 'CLOSED');
});
test('prepare creates private, isolated current-session files without launching Claude or enabling full access', async t => {
  const base = await mkdtemp(join(tmpdir(), 'mcd-acceptance-')); t.after(() => rm(base, { recursive: true, force: true }));
  // No real credential source is needed in this test.
  const { writeFile } = await import('node:fs/promises');
  const config = join(base, 'config.json');
  await writeFile(config, JSON.stringify({ mcpServers: { 'magpie-codex-dispatch': { type: 'http', url: 'http://localhost:1' },
    'codex-notifications': { command: 'node', args: ['fixture'] }, unrelated: { command: 'do-not-load' } } }));
  const run = await prepareRun({ profile: 'release', outputDir: base, mcpConfig: config, currentSession: true });
  assert.equal(run.manifest.claudeSessionId, null);
  assert.equal(run.manifest.fullAccessAuthorizedForDedicatedFixtureOnly, false);
  assert.equal((await stat(join(run.directory, 'mcp-private.json'))).mode & 0o777, 0o600);
  const mcp = JSON.parse(await readFile(join(run.directory, 'mcp-private.json'), 'utf8'));
  assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ['codex-notifications', 'magpie-codex-dispatch']);
  const results = JSON.parse(await readFile(join(run.directory, 'results.json'), 'utf8'));
  assert.equal(results.releaseGate, 'CLOSED'); assert.equal(Object.keys(results.cases).length, 28);
  assert.ok(Object.values(results.cases).every(c => c.status === 'NOT_RUN'));
  const brief = await readFile(join(run.directory, 'brief.txt'), 'utf8');
  assert.match(brief, /CURRENT interactive Claude session/); assert.match(brief, /Full-access is NOT authorized/);
});

test('acceptance artifacts cannot be prepared inside the source checkout', async () => {
  const path = new URL('../.acceptance-artifacts-must-not-exist', import.meta.url);
  await assert.rejects(prepareRun({ profile: 'connect', outputDir: path.pathname, mcpConfig: '/unused' }), /outside the source checkout/);
});

test('cleanup is a mandatory gate: owner action, deletion, unknown or missing targets cannot pass', () => {
  assert.deepEqual(cleanupProblems(report(), ledger), []);
  for (const change of [
    r => { r.cleanup.policy = 'archive-unattached-v1'; },
    r => { delete r.cleanup.items[0].route; },
    r => { r.cleanup.items[0].ownerVerified = false; },
    r => { r.cleanup.items[0].status = 'waiting_writer_release'; },
    r => { r.cleanup.items[0].status = 'deleted'; },
    r => { r.cleanup.items[0].verifiedState.archived = false; },
    r => { r.cleanup.items = []; },
    r => { r.cleanup.remainingThreadIds = [qaId]; },
    r => { r.cleanup.items[0].performedBy = 'direct-file-deletion'; },
    r => { r.cleanup.items[0].threadId = 'unrelated-user-chat'; },
  ]) { const r = report(); change(r); assert.ok(cleanupProblems(r, ledger).length); }
});
test('manual desktop finish needs separate evidence and cannot replace a real plugin archive', async () => {
  const r = report(); const secondId = '01900000-0000-7000-8000-000000000002';
  const fixtures = { fixtures: [{ threadId: qaId }, { threadId: secondId }] };
  const manual = { threadId: secondId, performedBy: 'desktop-operator', tool: 'desktop-native-archive',
    status: 'archived', operatorConfirmed: true, ownerActionEvidence: 'owner-action.json',
    verifiedState: { active: false, archived: true }, evidence: ['operator-observation.json'] };
  r.cleanup.items.push(manual);
  assert.deepEqual(cleanupProblems(r, fixtures), []);
  const checked = await evaluateGate(manifest, r, { identity, ledger: fixtures, evidenceExists: async path => path !== 'owner-action.json' });
  assert.equal(checked.releaseGate, 'CLOSED');
  manual.operatorConfirmed = false; assert.ok(cleanupProblems(r, fixtures).length); manual.operatorConfirmed = true;
  r.cleanup.items = [{ ...manual, threadId: qaId }, manual];
  assert.ok(cleanupProblems(r, fixtures).some(s => s.includes('cannot replace')));
});
