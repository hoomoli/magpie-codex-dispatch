# Claude Desktop completion notifications

Version 0.0.3 supports Claude Desktop's local Code sessions opened normally from the Dock. It does not require the `claude-codex` launcher or custom Channels flags. Ordinary Claude web/chat sessions are not Code sessions and do not run these hooks.

## Install once

Use Node 22+ and a stable checkout/package path:

```sh
npm ci
node src/install-desktop.js
```

The installer merges three user-level hook groups into `~/.claude/settings.json` and a stdio `codex-notifications` MCP server into `~/.claude.json`. It preserves unrelated settings, servers, hooks and permissions; changed files receive private backups. It uses absolute executable/script paths, so launching from the Dock does not depend on terminal PATH. Load a new/resumed Desktop Code session after installation. Existing sessions may need their MCP connections reloaded to see the three notification/review tools.

Keep using the existing Magpie `codex_dispatch`, `codex_create_task`, and `codex_followup` tools. No new return-channel parameter is required: native hook input supplies the actual Claude session UUID. The installer does not replace or update the Magpie package installed from GitHub. Query `codex_plugin_info` to distinguish its loaded version from this local notification component.

## Delivery

1. `PreToolUse` durably registers the request and session before dispatch. Binding failure blocks that dispatch instead of claiming notifications are available.
2. `PostToolUse` verifies the accepted request/thread/turn receipt, then waits for a terminal event from the existing Codex desktop stream. Task creation still may need the same request ID retried until accepted; an unaccepted receipt is never completion.
3. The hook runs with `asyncRewake: true`. Completion returns exit code 2 with a structured reminder, which Claude natively uses to wake the same idle session. There is no model status polling and no custom Channel handshake.
4. Claude calls `codex_notification_result` with `sessionId` and `eventId` to retrieve the exact terminal turn and Codex validation report/logs, reviews changes, delegates additional tests/builds/checks to Codex unless explicitly authorized otherwise, then calls the `codex-notifications` server's `codex_review_complete` with sessionId, eventId, verdict and summary. This records review, not task success. Failed/interrupted tasks are never automatically resubmitted.
5. `SessionStart` recovers accepted tasks and unreviewed completion events. A review tool's post-hook rearms recovery for other pending tasks. `codex_notification_status` is diagnostic, not a polling loop.

## Boundaries and recovery

The monitor follows the execution owner as well as the shared desktop IPC connection. Losing that owner invalidates the subscription even if the router socket stays open. It reconnects to discover the current owner; after live connection failure it can recover the exact terminal turn from the background receipt, or from persisted history only while no writer is attached. Unknown, missing, and still-held history never becomes a completion event.

New hook watchers retry transport disconnection up to three times within the original watch deadline, preserving the task binding and event ID. Reconnection only rearms monitoring; it never repeats dispatch. A replay after reconnection can repeat a completion reminder, so deduplicate by event ID. Processes already running older code must be reloaded separately; replacing files does not update their in-memory subscriptions.

- Uses documented [native command hooks](https://code.claude.com/docs/en/hooks), including `asyncRewake` and exec-form arguments. Requires a current Claude Code runtime supporting these fields; managed hook policy and normal tool approvals still apply.
- The hook waits up to 23 hours (native timeout 24 hours). A timeout/disconnection reports unresolved state, never success. Resume the same session to recover. Closing Claude cannot wake a closed session; its detached worker retains accepted completion, delivered on resume.
- Delivery is at least once across restarts. Review acknowledgments are durable and idempotent; same-session concurrent hooks suppress duplicate wakeups. Session resume can replay unreviewed events. Claude must deduplicate by eventId.
- A follow-up requires the active `turnId`. Invalid follow-ups are rejected before reserving a notification binding. Older unaccepted bindings created without `turnId` allow that missing field to be supplied with the same request ID and otherwise identical arguments; accepted bindings and all other argument changes remain immutable. A binding error alone does not mean monitoring of previously accepted tasks has stopped. `codex_operation_status` covers creation/lifecycle operations, not dispatch/follow-up receipts; diagnose notifications with `codex_notification_status` and inspect the exact turn with `codex_status`.
- The worker keeps the existing private queue under `~/.local/state/magpie-codex-dispatch/channels/<session-uuid>/`. It stores IDs, statuses and review summaries, not task prompts or Claude messaging tokens. It reconnects the event stream after transport failure, without periodic successful-state polling.
- The notification server exposes only status/result/review tools; dispatch stays in Magpie. No model API key, inbound messaging setting or broader tool permission is installed.
- To uninstall, remove only the three hook entries referencing `desktop-hook.js` and the `codex-notifications` server. Keep saved state if recovery matters. Backups are full snapshots; do not restore them over later unrelated settings changes.

Local tests cover actual hook processes, detached worker, event delivery, duplicate suppression, recovery, MCP acknowledgment, configuration preservation and idempotent installation. They do not by themselves prove a Desktop session wakes: record that result separately in `verification.md`.

## Pending human attention

Updated notification workers also deliver pending approvals/input as `kind: "attention"` events; these are not completion or review events. Claude inspects `codex_status`, informs the user and links to the thread for native interaction, then calls `codex_notification_status` once to rearm the watcher. The installer includes that tool's post-hook. No approval, input response, permission change or redispatch is performed automatically. Existing notification workers need a safe reload before this feature is available; installing files does not hot-replace them. See [execution modes and attention](background-attention.md), including the limitation on unopened background chats' native sidebar runtime indicators.

## Enforced completion review

Completion comes from the execution state stream (or verified terminal history during recovery), not a model-written notification command. The plugin persists the event before delivery and owns session routing and replay. Task output is returned as data and cannot create a completion event or acknowledge a review.

Both native hooks and the optional Channel transport use the same worker-side review gate:

1. Receive a completion event, then call `codex_notification_result` with its `eventId` (also `sessionId` on the native notification server).
2. The worker selects the thread/turn from the saved event, reads it without starting execution, and verifies that the exact terminal status still matches. Attention events and another session's events are refused. An unavailable result remains unresolved; retry the read later without redispatching.
3. Review the returned report and actual changes. Call `codex_review_complete` with a factual verdict and summary. The worker refuses acknowledgments before result retrieval and refuses `passed` for failed, interrupted, or errored execution.

The queue persists only result-read metadata; output remains in Codex. Previously recorded reviews remain idempotent. Unreviewed events from an older queue require the new result-read step. Status exposes `capabilities.reviewRequiresResult` and each task's `resultRead` receipt. Safely reload old workers before using this protocol; installing files does not hot-replace a running worker.

This gate proves that the plugin retrieved the exact result before accepting a review. It does not prove that Claude understood the output, inspected every change, or validated the user's business goal. These remain review responsibilities. The installer preserves host permissions: exclusive delegation (preventing Claude from editing files or invoking Codex through other tools) requires a separate host-controlled permission policy. A caller-supplied permission mode is not independent evidence of user authorization.
