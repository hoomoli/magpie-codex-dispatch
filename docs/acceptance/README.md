# Acceptance entry points

Current regression work is tracked in [known acceptance findings](known-findings.md).

Use these procedures when onboarding a new Claude installation and before publishing. The product must be locally installed in Magpie; verify it with `codex_plugin_info`, not a cached plugin-page badge. Requires macOS, Codex desktop, Magpie, Node 22+, and an authenticated interactive Claude Code installation. Set up the dedicated `magpie-codex-dispatch` and `codex-notifications` MCP entries using the main README and desktop notification guide first.

The launcher also accepts the existing dispatch entry name `magpie-codex-dispatch-plugin`, preserving that name and its actual tool prefix in invocation-only configuration. Exactly one dispatch entry must be configured; duplicate aliases are rejected. No global entry is renamed.

## A new Claude session: basic connection

Ask the current Claude Code session to run this in the checkout:

```sh
npm run acceptance:connect -- --prepare --current-session
```

It prints a private run directory and `brief.txt`. Tell Claude to read that brief and this document, then execute it in the SAME interactive session. It must use the real session/event IDs from native completion reminders, not invent them. No nested Claude process is needed. An ordinary Claude chat without Code/hooks cannot pass notification acceptance. Read the entire native hook message, including its `<system-reminder>` and JSON event identifiers; the outer “Stop hook feedback” summary alone is not the completion payload. If the model overlooks a delivered event and needs correction, record that failure instead of claiming fully automatic review.

Alternatively, from a normal terminal, start a new interactive Claude dedicated to acceptance:

```sh
npm run acceptance:connect
```

The launcher uses your existing sign-in, selects only the two relevant MCP servers for this invocation, and disables the old Companion plugin for this invocation. It does not rewrite global MCP/provider/permission configuration, change model/provider, or bypass approvals. Claude itself may save normal session and folder-trust metadata. The normal folder-trust/permission dialogs may appear. Grant only the test scope you intend. Config copies and transcripts are private; do not commit them.

The connection profile is deliberately narrower than full release validation:

| Case | Required actual observation |
| --- | --- |
| C01 | `codex_plugin_info` matches expected local version/module path; save its actual response as evidence and `results.json.loadedPlugin`. |
| C02 | Exactly one loaded installation and all 13 plugin tools available in the actual MCP catalog. |
| C03 | `codex_projects` returns usable canonical project metadata; no implicit project creation or selection. |
| C04 | Register a new QA request in the ledger, create one read-only, projectless, marker-only task with cwd equal to the run directory, and save accepted thread/turn IDs. The test-only cwd is explicitly authorized. |
| C05 | End Claude's response after acceptance, receive a real native completion reminder without polling, read the exact terminal result once, verify the marker, acknowledge the real event, then confirm reviewed state once. A print-mode run cannot pass. |
| C06 | After C08 archival and confirmed writer release, read status: persisted history, notLoaded, exact marker/turn. Query a nonexistent turn: unknown, never success. Retained owners do not expire automatically; do not wait for a completion timer or restart apps. Bounded diagnostics are allowed. |
| C07 | Replay the identical create request: same thread/turn, no duplicate. Change prompt with that ID: a clear REQUEST_ID_CONFLICT rejection, not an integration-repair instruction. |
| C08 | Confirm the original background owner is still retained more than 60 seconds after completion, then archive through actual Magpie codex_archive. Require route:background-owner, serverAcknowledged:true and independently verified writer release/archived inventory. Desktop/unknown owners require owner_action_required; active/pending owners are refused. Reuse the archive ID to verify durable replay. Permanent deletion must be absent. Execute this before the stored-history portion of C06. |

An OPEN connection gate means basic create/read/notification integration works for the tested source and installation. It does **not** prove all permission modes, handoff, steering, stopping, channels, recovery, or desktop visuals, and is not release authorization.

## Complete release profile

```sh
npm run acceptance:release -- --prepare --current-session
```

Then have the current Claude read/execute the generated brief and [the complete release matrix](claude-release-gate.md). From a terminal, omit `--prepare --current-session` to launch an independent interactive Claude.

`full-access` is excluded unless explicitly authorized for dedicated marker-only QA threads:

```sh
npm run acceptance:release -- --prepare --current-session --allow-full-access
```

That flag does not grant general unrestricted work. Without authorization, the full-access case is BLOCKED and the release gate remains CLOSED. UI observations and real Claude Desktop/Channel flows require their actual surfaces. Ask the operator for exact observations when necessary; never replace them with mock evidence or tool metadata. Test only ledger-owned QA conversations and preserve unrelated work.

## Required archival cleanup (Q01, both profiles)

The current supported scope is **archival through the retained original plugin background owner, or archival of unattached persisted subtrees**. Permanent deletion and direct archival of desktop-held threads remain unsupported. After preserving evidence, Claude must demonstrate at least one actual Magpie `codex_archive` success on a ledger-owned retained-background fixture, confirming ownership more than 60 seconds after completion. An operator-only cleanup cannot substitute for that integration test. Include native Desktop/Channel fixtures and verified descendants in the same ledger; never target existing user chats, the operator's current chat, or unknown descendants.

Use a fixed archive request ID per operation, distinct from any old deletion ID. Preserve actual successful archive receipts, including replays for already-archived fixtures. Inspect both active and archived inventories: a cleaned fixture must be absent from active and present in archived. An unreadable/missing thread, owner_action_required, waiting, unknown outcome, or an archive acknowledgment without independent verification is not cleanup success. No permanent deletion, forged archive broadcasts, raw storage/lock edits, shared-server setup or application restart is part of this procedure.

When Magpie reports owner_action_required, stop automatic retries. Ask the operator to archive in the owning desktop/client, preserve the plugin boundary receipt and actual operator confirmation, then independently verify archived state. This is **manual finish outside plugin scope**, never Claude-through-Magpie success. If any fixture remains active, unknown or intentionally retained for diagnosis, Q01 stays BLOCKED and the gate CLOSED. Reports, transcripts and notification evidence are preserved.

Set `results.json.cleanup.policy` to `archive-retained-owner-v2`, with `status`, `items` and `remainingThreadIds`. Every item has `threadId`, `status: "archived"` or `"already_archived"`, `verifiedState: {"active": false, "archived": true}`, and real relative `evidence` file paths. Plugin items additionally have `performedBy: "claude-via-magpie"`, `tool: "codex_archive"`, fixed `requestId`, and `serverAcknowledged: true`. Manual items instead have `performedBy: "desktop-operator"`, `tool: "desktop-native-archive"`, `operatorConfirmed: true`, and `ownerActionEvidence` pointing to the actual plugin boundary receipt. At least one valid plugin archive through the retained original background owner is mandatory: include route: "background-owner" and ownerVerified: true, and save evidence of actual writer identity beyond 60 seconds, the routed request and ACK. Other unsupported desktop-held fixtures still need separate manual finish. Never substitute native desktop-model archival for the retained-owner case.

This is a revised capability contract. Keep historical deletion-based runs unchanged; prepare a new run on the current source snapshot. Do not relabel earlier failures as passing.

## Evidence and checking

By default runs live outside the repository under `~/.local/state/magpie-codex-dispatch/acceptance/`. Override the private parent directory using `--output-dir /absolute/private/directory`. Use `--mcp-config /absolute/config.json` to read a different MCP configuration; it must contain both dedicated entries. `--prepare` without `--current-session` prepares a standalone CLI run and prints its start command.

Each run contains `manifest.json` (source commit + dirty-tree hash), `brief.txt`, `results.json`, `ledger.json`, evidence/log directories, and private invocation-only MCP/settings copies. Standalone CLI runs export only their own transcript on exit. Current-session executions should export relevant, sanitized tool receipts to evidence files; do not copy unrelated session history. Do not share the private MCP config or credential headers.

For each case write one of PASS, FAIL, BLOCKED, NOT_RUN; PASS requires nonempty evidence files within the run directory. Use file paths relative to that directory. Preserve exact fixture/request/thread/turn/event IDs and raw observed vs expected results. Fill `loadedPlugin` with the actual `codex_plugin_info` result. Finish a readable `report.md` and machine-readable `results.json`.

```sh
npm run acceptance:check -- /absolute/run-directory
```

Before publication, require the release profile explicitly so a basic connection run cannot accidentally satisfy a release check:

```sh
npm run acceptance:release:check -- /absolute/release-run-directory
```

The independent checker writes `gate.json`, exits nonzero for any missing/failed/blocked case, missing evidence, plugin identity mismatch, or changed source snapshot. It computes the result itself rather than trusting a claimed `releaseGate: OPEN` in Claude's report. A connect gate never substitutes for a release gate. The checker does not publish anything and cannot authenticate a fabricated human claim: the reviewer still must inspect the evidence.

Standalone CLI resume (same snapshot):

```sh
node scripts/acceptance.mjs --resume /absolute/run-directory
```

For a current-session run, resume the original Claude session and re-read its brief instead. After source changes, start a new run; do not rewrite an old manifest to hide the change. Keep failed runs as regression evidence. No release is permitted until a complete release-profile check is OPEN and the user separately authorizes publication.
