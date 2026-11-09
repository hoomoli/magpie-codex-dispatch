# Claude Desktop completion notifications

Version 0.0.3 supports Claude Desktop's local Code sessions opened normally from the Dock. It does not require the `claude-codex` launcher or custom Channels flags. Ordinary Claude web/chat sessions are not Code sessions and do not run these hooks.

## Install once

Use Node 22+ and a stable checkout/package path:

```sh
npm ci
node src/install-desktop.js
```

The installer merges three user-level hook groups into `~/.claude/settings.json` and a stdio `codex-notifications` MCP server into `~/.claude.json`. It preserves unrelated settings, servers, hooks and permissions; changed files receive private backups. It uses absolute executable/script paths, so launching from the Dock does not depend on terminal PATH. Load a new/resumed Desktop Code session after installation. Existing sessions may need their MCP connections reloaded to see the two review tools.

Keep using the existing Magpie `codex_dispatch`, `codex_create_task`, and `codex_followup` tools. No new return-channel parameter is required: native hook input supplies the actual Claude session UUID. The installer does not replace or update the Magpie package installed from GitHub. Query `codex_plugin_info` to distinguish its loaded version from this local notification component.

## Delivery

1. `PreToolUse` durably registers the request and session before dispatch. Binding failure blocks that dispatch instead of claiming notifications are available.
2. `PostToolUse` verifies the accepted request/thread/turn receipt, then waits for a terminal event from the existing Codex desktop stream. Task creation still may need the same request ID retried until accepted; an unaccepted receipt is never completion.
3. The hook runs with `asyncRewake: true`. Completion returns exit code 2 with a structured reminder, which Claude natively uses to wake the same idle session. There is no model status polling and no custom Channel handshake.
4. Claude reads the exact turn once, reviews changes/tests, then calls the `codex-notifications` server's `codex_review_complete` with sessionId, eventId, verdict and summary. This records review, not task success. Failed/interrupted tasks are never automatically resubmitted.
5. `SessionStart` recovers accepted tasks and unreviewed completion events. A review tool's post-hook rearms recovery for other pending tasks. `codex_notification_status` is diagnostic, not a polling loop.

## Boundaries and recovery

- Uses documented [native command hooks](https://code.claude.com/docs/en/hooks), including `asyncRewake` and exec-form arguments. Requires a current Claude Code runtime supporting these fields; managed hook policy and normal tool approvals still apply.
- The hook waits up to 23 hours (native timeout 24 hours). A timeout/disconnection reports unresolved state, never success. Resume the same session to recover. Closing Claude cannot wake a closed session; its detached worker retains accepted completion, delivered on resume.
- Delivery is at least once across restarts. Review acknowledgments are durable and idempotent; same-session concurrent hooks suppress duplicate wakeups. Session resume can replay unreviewed events. Claude must deduplicate by eventId.
- A follow-up requires the active `turnId`. Invalid follow-ups are rejected before reserving a notification binding. Older unaccepted bindings created without `turnId` allow that missing field to be supplied with the same request ID and otherwise identical arguments; accepted bindings and all other argument changes remain immutable. A binding error alone does not mean monitoring of previously accepted tasks has stopped. `codex_operation_status` covers creation/lifecycle operations, not dispatch/follow-up receipts; diagnose notifications with `codex_notification_status` and inspect the exact turn with `codex_status`.
- The worker keeps the existing private queue under `~/.local/state/magpie-codex-dispatch/channels/<session-uuid>/`. It stores IDs, statuses and review summaries, not task prompts or Claude messaging tokens. It reconnects the event stream after transport failure, without periodic successful-state polling.
- The notification server exposes only status/review tools; dispatch stays in Magpie. No model API key, inbound messaging setting or broader tool permission is installed.
- To uninstall, remove only the three hook entries referencing `desktop-hook.js` and the `codex-notifications` server. Keep saved state if recovery matters. Backups are full snapshots; do not restore them over later unrelated settings changes.

Local tests cover actual hook processes, detached worker, event delivery, duplicate suppression, recovery, MCP acknowledgment, configuration preservation and idempotent installation. They do not by themselves prove a Desktop session wakes: record that result separately in `verification.md`.
