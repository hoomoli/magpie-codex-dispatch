# Execution ownership and human attention

New task creation accepts `executionMode`:

| Mode | Ownership and presentation |
| --- | --- |
| `background` (default) | Runs in the plugin worker without navigation. Desktop history can show `notLoaded` even while the actual owner is active or waiting. Opening the thread subscribes to the live stream. Native sidebar runtime indicators for unopened background threads are not synchronized. |
| `desktop` | Opens the chat, verifies actual native ownership, then dispatches. The native owner handles activity and approval presentation. Creation can return a pending phase while desktop attachment is still unavailable. |

Both modes accept optional `pin: true`. Preserve the original arguments and request ID on retries. A durable route reservation prevents a request from creating a second thread by switching execution modes. This option applies to new tasks; it does not migrate or interrupt an existing running thread.

## Pending approval and input

`codex_status` now includes `activity` (`running`, `waiting_on_approval`, `waiting_on_input`, or the reported runtime type) and `attentionRequests` for the exact selected turn. Pending command approvals include the command, reason and working directory for diagnosis. Persisted history remains explicitly `historyOnly`; it is not a source of live approval state.

The notification worker observes the existing event stream. Supported command/file/permission approvals, user-input requests, and MCP elicitations generate separate `kind: "attention"` events. Events are bound to an exact thread, turn, method and request ID. The durable queue stores identifiers/status only, not commands, reasons or task prompts. Identical snapshots do not repeat a notice. Resolution removes a pending attention event; terminal completion clears attention and still requires its own review.

Native hooks wake the bound Claude session for attention as well as completion. Claude inspects the exact turn, tells the user what is blocked and links to the thread for native interaction. It must not automatically approve, answer, change permissions or redispatch. Attention events are not accepted by `codex_review_complete`. After reporting attention, call `codex_notification_status` once; its post-hook rearms the outstanding watcher without replaying the same event. Resuming the Claude session can replay still-pending requests. Delivery is at least once: deduplicate by event ID and check current state before acting.

The optional Channel transport keeps its persistent subscription and distinguishes attention from completion through notification metadata. `codex_notification_status` reports `awaiting_attention` and the worker's `capabilities.attentionNotifications` flag. Merely installing files does not upgrade an already-running notification worker.

## Compatibility and validation

The inspected desktop stream handler rejects snapshots for threads it is not following. There is no verified plugin IPC command for setting an unopened thread's native catalog runtime state or raising a native global approval dialog. Broadcasting snapshots to every client does not solve this. Desktop execution is the available ownership path for native presentation; background mode uses the Claude attention channel rather than claiming native sidebar synchronization.

Tests cover exact-turn filtering, request lifecycle/deduplication, queue restart and privacy, continued completion delivery, native hook rearming, and execution-mode replay protection. A real hook process plus detached notification worker is exercised against a simulated desktop stream without polling or any approval/permission/execution mutation. Actual native sidebar pixels, approval dialog presentation, and live Claude wakeup require desktop acceptance; these automated checks do not establish that acceptance.

Install using the existing desktop hook installer, then reload the plugin/new Claude session. Do not kill task workers or disconnect other live notification clients to force an upgrade. Existing attention events in an old notification worker remain unsupported until that worker is safely reloaded.

## Historical render compatibility

Outgoing snapshots normalize subagent items in both live turns and paginated history, including reconnect and the last snapshots before handoff. Normalization preserves already hydrated receiver-thread metadata, fills missing render collections from wire receiver IDs, and does not mutate transcripts or the source snapshot. Malformed receiver IDs stop publication rather than sending a snapshot known to crash the desktop.

The 2026-11-10 affected native-owned conversation retained 12 incompatible historical items among 16 subagent records. Actual Sentry breadcrumbs at 09:47:48 and 09:57:33 (Asia/Shanghai) pointed to the installed desktop's `receiverThreads.map` access. Normalizing the captured state makes all 16 accesses pass. This is a data/stack reproduction, not a claim that the existing native cache has been repaired.

A plugin update only protects snapshots emitted by upgraded owners. It cannot rewrite a snapshot already adopted by the native desktop, and upgrading files does not replace loaded execution workers. Existing polluted native history needs a supported native reload from persisted history; if only an app restart is available, wait until active work is safely complete. Do not edit session JSONL/SQLite, impersonate the native IPC owner, or terminate active workers to force recovery.
