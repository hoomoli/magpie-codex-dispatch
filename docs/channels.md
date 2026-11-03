> For Claude Desktop Code opened from the Dock, use [native hook notifications](desktop-notifications.md). This page describes the optional terminal launcher.

# Event-driven Claude review

The local `claude-codex` launcher starts an interactive Claude Code session with a dedicated stdio MCP channel. Its dispatch tools reuse the same implementation as the Magpie plugin, automatically binding every dispatched task to the exact Claude session UUID. The ordinary Magpie HTTP tools remain available, but tasks dispatched through those tools are not automatically registered with this channel.

## Start and resume

```sh
npm ci
node src/claude-channel.js
# Later, use the exact UUID printed by the launcher:
node src/claude-channel.js --resume <session-uuid>
```

Installed npm packages also expose `claude-codex` and `codex-completion-channel` executables. The launcher provides the MCP configuration for this invocation; it does not overwrite Claude's global configuration or change tool permissions. Use the channel's own `codex_dispatch` / `codex_create_task` tools. A successful dispatch response includes `completionChannel`. An accepted task is not necessarily successful or reviewed.

Claude Code Channels are in research preview. The launcher explicitly requests the custom development channel; Claude displays its development-channel confirmation. Organization policy and authentication requirements still apply. Do not use `-p`: the development-channel flag is ignored in noninteractive mode. See [Anthropic's channel reference](https://code.claude.com/docs/en/channels-reference).

## Execution and delivery

1. Before submission the worker durably records the request fingerprint and its session binding. Prompts are not persisted in the notification queue.
2. Existing dispatch journals protect against duplicate task submission. The worker records the accepted thread/turn IDs, then subscribes to the native desktop state stream. A task that already finished is detected in the initial snapshot.
3. Ordered Immer patches update the snapshot. A revision gap, disconnect, or unknown protocol causes reconnection with backoff, never a successful completion. A healthy connection does not poll task status. The worker does not acquire the Codex thread writer or start another app-server.
4. A terminal state (`completed`, `failed`, `interrupted`) creates a durable event for that exact thread and turn. Intermediate output and unrelated turns do not trigger review. The event carries identifiers and status, not instructions copied from task output.
5. The stdio server pushes `notifications/claude/channel` into the originating Claude session. Claude reads the final result once, checks relevant changes/tests, and calls `codex_review_complete` with an explicit verdict and summary.

`codex_channel_status` reports `awaiting_receipt`, `watching`, `awaiting_review`, or `reviewed`. It is diagnostic, not a polling requirement. Creation/handoff can still return pending until native ownership is ready; retry the same creation request ID as directed. A missing/unknown receipt never causes automatic resubmission.

## Recovery and limits

- Each route has one detached worker and one live Channel subscriber. Native hook and review RPC clients may also attach. Another Channel subscriber cannot take over an active route. Separate launcher sessions receive separate UUIDs.
- Closing Claude leaves the worker listening for accepted tasks. Completion remains on disk while Claude is offline. Resuming the same UUID reconnects and replays unacknowledged events. A newly created Claude session does not receive another session's queue.
- Delivery is **at least once**, with a stable event ID. Reconnect before acknowledgement can repeat an event. Claude must deduplicate by event ID; the review acknowledgement is idempotent and conflicting acknowledgements are rejected. Exactly-once model execution is not claimed.
- If the worker crashes, restarting the channel recovers accepted receipts from the existing dispatch journal and reconnects. It does not install a login service: after a machine reboot or worker crash, restart/resume the launcher to recover. If the desktop cannot supply the target turn's history, the state stays unresolved.
- Disconnected workers with no accepted unfinished tasks exit after 60 seconds. Completed events remain durable. At most 128 unreviewed request records and 4096 total records are accepted per route. Diagnostic status returns the newest 50 records and totals. State is local/private (0700 directories, 0600 files); the local socket has no public network listener.
- Saved state lives in `~/.local/state/magpie-codex-dispatch/channels/<session-uuid>/`. `queue.json` includes review summaries, which may contain project details. `worker.json` records the worker PID and version. Preserve this directory to recover pending reviews.
- Desktop streaming uses the existing private IPC integration, not a documented desktop API. Compatibility is checked against the current stream revision. No task completion is inferred from a timeout or missing history.

## Validation

`npm test` includes real stdio MCP client/server and detached-worker tests with a simulated desktop socket: dispatch receipt binding, offline completion, ordered patches, no status polling, reconnect replay, acknowledgement persistence, and replay-safe dispatch. Unit tests cover terminal states, wrong turns, revision gaps, unsafe patches, state persistence and conflicting review receipts.

These tests do not prove that an authenticated interactive Claude installation permits custom channels or automatically performs a real review. That requires a live interactive run with the development channel enabled and a native desktop-owned test thread.
