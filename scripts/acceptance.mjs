import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, lstat, copyFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { profiles, sourceIdentity } from './acceptance-gate.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const help = `Usage: npm run acceptance:connect -- [--prepare] [--output-dir PATH] [--mcp-config FILE]
       npm run acceptance:release -- [--prepare] [--allow-full-access] [--output-dir PATH]
       node scripts/acceptance.mjs --resume /absolute/run-directory
       npm run acceptance:check -- /absolute/run-directory

Starts an INTERACTIVE Claude acceptance session using only the configured Magpie and notification MCP servers.
--prepare creates a private run and brief without launching Claude.
--current-session prepares a brief for the Claude session you are already in; no nested Claude process. No global configuration changes or publication.
--allow-full-access explicitly authorizes that mode ONLY for harmless marker operations in dedicated QA threads.
A connect pass covers basic integration only; a release requires the complete matrix and real UI/notification evidence.`;
function parse(args) {
  const options = { profile: 'connect', prepare: false, allowFullAccess: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') return { help: true };
    if (arg === '--prepare') options.prepare = true;
    else if (arg === '--current-session') { options.currentSession = true; options.prepare = true; }
    else if (arg === '--allow-full-access') options.allowFullAccess = true;
    else if (['--profile', '--output-dir', '--mcp-config', '--resume'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`Missing value for ${arg}`);
      options[{ '--profile': 'profile', '--output-dir': 'outputDir', '--mcp-config': 'mcpConfig', '--resume': 'resume' }[arg]] = args[++i];
    } else throw Error(`Unknown argument: ${arg}`);
  }
  if (!profiles[options.profile]) throw Error('Profile must be connect or release.');
  return options;
}
export function acceptanceServers(config) {
  const names = ['magpie-codex-dispatch', 'magpie-codex-dispatch-plugin'].filter(n => config.mcpServers?.[n]);
  if (names.length > 1) throw Error('Multiple Magpie dispatch MCP entries are configured. Keep exactly one to avoid ambiguous acceptance.');
  if (names.length !== 1 || !config.mcpServers?.['codex-notifications']) throw Error('Configure one magpie-codex-dispatch (or magpie-codex-dispatch-plugin) and codex-notifications MCP server first; see docs/acceptance/README.md.');
  return Object.fromEntries([names[0], 'codex-notifications'].map(n => [n, config.mcpServers[n]]));
}
export async function prepareRun(options) {
  const base = resolve(options.outputDir ?? join(homedir(), '.local/state/magpie-codex-dispatch/acceptance'));
  // Keep mutable run evidence outside the source tree used for the source hash.
  if (base === root || base.startsWith(root + '/')) throw Error('Acceptance output must be outside the source checkout.');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const info = await lstat(base);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077) throw Error('Output directory must be private (0700), owned by you, and not a symlink.');
  const config = JSON.parse(await readFile(options.mcpConfig ?? join(homedir(), '.claude.json'), 'utf8'));
  const servers = acceptanceServers(config);
  const directory = await mkdtemp(join(base, `${options.profile}-`));
  await mkdir(join(directory, 'evidence'), { mode: 0o700 });
  await mkdir(join(directory, 'logs'), { mode: 0o700 });
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = { runId: randomUUID(), profile: options.profile, createdAt: new Date().toISOString(),
    sourceRoot: root, source: await sourceIdentity(root), expectedVersion: metadata.version,
    expectedModuleUrl: pathToFileURL(join(root, 'src/version.js')).href, claudeSessionId: options.currentSession ? null : randomUUID(),
    fullAccessAuthorizedForDedicatedFixtureOnly: Boolean(options.allowFullAccess) };
  const brief = `Read ${join(root, 'docs/acceptance/README.md')} and ${join(root, 'docs/acceptance/claude-release-gate.md')} in full.
You are the acceptance reviewer, not the implementer. Execute ONLY the ${options.profile} profile. Run directory: ${directory}.
${manifest.claudeSessionId ? `This run uses INTERACTIVE session ${manifest.claudeSessionId}.` : 'Run this in your CURRENT interactive Claude session. Use the real session UUID from native completion reminders; do not invent one.'} Use the actual MCP tools; no print-mode wakeup substitutes.
Expected version ${metadata.version}, module ${manifest.expectedModuleUrl}. Write actual identity to results.json.loadedPlugin.
${options.allowFullAccess ? 'The operator explicitly authorized full-access ONLY in dedicated QA threads for harmless marker operations inside this run directory.' : 'Full-access is NOT authorized. If the selected profile requires it, mark that case BLOCKED and request operator authorization; never silently elevate.'}
Read manifest.json/results.json/ledger.json. Update every required case with PASS/FAIL/BLOCKED/NOT_RUN and evidence file paths relative to this run directory. Save exact relevant tool calls/results to private evidence files. Save human observations verbatim. Never infer UI visibility or native notification wakeups from metadata.
Run-only reports/fixtures are authorized. Do not modify product code, Git state, global settings, credentials, business files or existing user chats. No commits, pushes or publication. Test-only projectless cwd equals this run directory and is explicitly authorized; project marker cases use an existing canonical project and no file changes. Never precreate worktrees. Never use the old Companion integration except a dedicated ledger-owned handoff fixture in the release profile. At most 3 QA turns concurrently and 12 QA root threads cumulatively. At most 8 background owners can be retained; archive completed fixtures after their observations/evidence, or explicitly hand them off, before reaching that limit. Register requests BEFORE dispatch; save exact thread/turn IDs. Mutations may only target this run's ledger-owned fixtures. Do not replace unknown requests with new IDs.
After acceptance end the response and wait for an actual event; do not poll successful states. Read the WHOLE native hook message including system-reminder and JSON identifiers, not just its Stop hook feedback summary. A delivered event that the model failed to act on is not an automatic-review pass. After a real reminder review the exact result and acknowledge its event, then continue independent cases. Use normal approvals; never bypass them. If a required observation is unavailable, record BLOCKED and continue. Record every failure without patching source or weakening requirements.
After evidence is saved, execute required Q01 with cleanup.policy=archive-retained-owner-v2. YOU (Claude) must demonstrate at least one actual Magpie codex_archive on a ledger-owned retained-background QA fixture after independently verifying the original background writer beyond 60 seconds of completion; permanent deletion is no longer offered. Archive every supported QA fixture, including registered auxiliary fixtures/descendants. A verified retained plugin background writer is supported via the original owning connection; require route=background-owner, ownerVerified=true and evidence of ownership plus the archive ACK. For desktop/unknown writers, owner_action_required is an unsupported boundary, NOT completion: stop retrying and request manual archival in the owning desktop. Do not use native internal pipes, impersonate callers, share backends, restart apps, remove locks or delete raw files. Archive receipts use fixed request IDs and serverAcknowledged=true. At least one plugin cleanup item must additionally have route=background-owner and ownerVerified=true, with actual owner and control-path evidence among its files. Every cleanup item needs threadId, status=archived/already_archived, verifiedState={active:false,archived:true}, performedBy, tool and real relative evidence paths. Plugin items use performedBy=claude-via-magpie, tool=codex_archive and requestId. Manual desktop items use performedBy=desktop-operator, tool=desktop-native-archive, operatorConfirmed=true and ownerActionEvidence pointing to the actual plugin boundary receipt. Independently verify inventories; manual cleanup is reported separately and cannot replace the required Claude-to-Magpie success. Preserve histories/reports and all request receipts. If ANY fixture remains active, unknown, or intentionally retained, keep cleanup.status and Q01 BLOCKED and list remainingThreadIds. Do not rewrite historical deletion acceptance reports to this new policy.
Finish report.md/results.json, list remaining fixtures, then run node ${join(root, 'scripts/acceptance-gate.mjs')} ${directory}. A nonzero exit keeps the gate CLOSED. A connect OPEN does not authorize release or prove all optional capabilities. End with the gate result and evidence paths.`;
  const files = {
    'manifest.json': manifest,
    'mcp-private.json': { mcpServers: servers },
    'settings-private.json': { enabledPlugins: { 'codex@openai-codex': false } },
    'results.json': { runId: manifest.runId, profile: manifest.profile, releaseGate: 'CLOSED', loadedPlugin: null,
      cases: Object.fromEntries(profiles[options.profile].map(id => [id, { status: 'NOT_RUN', evidence: [], notes: '' }])),
      cleanup: { policy: 'archive-retained-owner-v2', status: 'NOT_RUN', items: [], remainingThreadIds: [] } },
    'ledger.json': { runId: manifest.runId, fixtures: [], notifications: [] },
  };
  for (const [name, data] of Object.entries(files)) await writeFile(join(directory, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(directory, 'brief.txt'), brief + '\n', { mode: 0o600 });
  return { directory, manifest };
}
async function findTranscript(sessionId) {
  const projects = join(homedir(), '.claude/projects');
  try {
    for (const entry of await readdir(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try { const path = join(projects, entry.name, `${sessionId}.jsonl`); await lstat(path); return path; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } catch { /* The native transcript may not exist yet. */ }
  return null;
}
export async function main(args = process.argv.slice(2)) {
  const options = parse(args);
  if (options.help) { console.log(help); return; }
  let directory, manifest;
  if (options.resume) {
    directory = resolve(options.resume); manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    const identity = await sourceIdentity(root);
    if (identity.commit !== manifest.source.commit || identity.sha256 !== manifest.source.sha256) throw Error('Source changed since this run. Start a new acceptance run.');
  } else ({ directory, manifest } = await prepareRun(options));
  console.log(`Acceptance run: ${directory}\nProfile: ${manifest.profile}\nClaude session: ${manifest.claudeSessionId ?? 'current interactive session'}\nGate starts CLOSED. Do not publish from this session.`);
  if (options.prepare) { console.log(manifest.claudeSessionId ? `Start: node scripts/acceptance.mjs --resume ${directory}` : `Read and execute in your current Claude session: ${join(directory, 'brief.txt')}`); return; }
  if (!manifest.claudeSessionId) throw Error('This run belongs to an existing Claude session; read its brief there instead of starting a nested process.');
  const brief = await readFile(join(directory, 'brief.txt'), 'utf8');
  const invocation = JSON.parse(await readFile(join(directory, 'mcp-private.json'), 'utf8'));
  const toolPatterns = Object.keys(acceptanceServers(invocation)).map(name => `mcp__${name}__*`);
  const cli = [await findTranscript(manifest.claudeSessionId) ? '--resume' : '--session-id', manifest.claudeSessionId,
    '--strict-mcp-config', '--mcp-config', join(directory, 'mcp-private.json'), '--settings', join(directory, 'settings-private.json'),
    '--add-dir', root, '--permission-mode', 'default', '--allowedTools', ['Read','Write','Edit','Glob','Grep','Bash',...toolPatterns].join(','), '--', brief];
  const child = spawn('claude', cli, { cwd: directory, stdio: 'inherit' });
  await new Promise((done, fail) => { child.once('error', fail); child.once('exit', code => { process.exitCode = code ?? 1; done(); }); });
  const transcript = await findTranscript(manifest.claudeSessionId);
  if (transcript) await copyFile(transcript, join(directory, 'transcript.jsonl'));
  else console.error('Native transcript unavailable; preserve the QA session for diagnosis.');
  console.log(`Check gate: npm run acceptance:check -- ${directory}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
