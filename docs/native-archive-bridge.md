# Delegate archival to a desktop-owned Codex chat

## Local verification: 2026-11-06

The existing plugin dispatched an authorized manifest to a **desktop-owned** Codex chat. Its next turn received the official `codex-app-tools` tool `set_thread_archived` and successfully archived another idle, desktop-held test chat. This is model-mediated delegation through the owning desktop, not direct Magpie access to its native tools pipe.

No shared app-server, special startup, desktop restart, peer impersonation, lock removal or forced owner release was used. Magpie's local plugin was reloaded for a handoff receipt fix. Codex performed this test through the actual installed Magpie tools; it does not replace outstanding real-Claude acceptance.

## Procedure using existing tools

1. Collect exact user-authorized IDs and expected titles. Exclude the current user chat and runner. Track active, unknown, already archived and eligible targets separately; missing history is not successful cleanup.
2. Call `codex_create_task` with a fixed unique request ID, explicit workspace and a bootstrap prompt that only acknowledges readiness. Do not archive in this background turn. The public create tool requires a nonempty prompt and starts execution; it has no empty-create-only mode.
3. Wait for bootstrap completion. In `0.0.8-local.5`, ownership is retained until explicit archive/handoff; it does not expire after 60 seconds. If the intended targets are retained plugin-owned chats, prefer direct `codex_archive` through their original owners instead of this bridge. Never force release active/pending work.
4. For a bridge that needs official desktop tools, call `codex_handoff` with its own fixed request ID. It explicitly requests idle source release. Follow pending receipts and independently confirm `codex_ownership.owner === "desktop"`. Visibility or a follower connection alone is insufficient. Reuse identical IDs/arguments for uncertain retries. No desktop restart is needed.
5. Call `codex_dispatch` in the desktop-owned runner with the explicit manifest. Require discovery of the official `set_thread_archived`, validation of target identity and idle state, and invocation with `archived:true` only for approved targets. If unavailable, stop; do not recursively call Magpie or access native sockets.
6. Save actual per-target tool results. Independently verify absent active inventory, present archived inventory, and readable history. Dispatch acceptance or assistant claims alone are insufficient. After a lost reply inspect results/state before redispatching any unresolved subset.
7. Save evidence, then archive the idle runner through a separate authorized native desktop caller, recording this cleanup separately. Do not assume self-archival during execution is supported.

A first preparation message may contain the manifest, but must defer mutations until actual desktop ownership and a subsequent native turn. The verified `0.0.8-local.4` sequence used bootstrap first, normal source exit, then manifest dispatch. The `0.0.8-local.5` explicit idle release path has separate automated coverage and still needs its own full Claude acceptance.

## Observed evidence

| Stage | Result |
| --- | --- |
| Initial plugin-created runner | `owner:background`; native archive tool unavailable |
| Initial handoff before fix | Incorrect `desktop_owned` receipt while actual owner remained background |
| Fixed handoff while background-held | `waiting_writer_release`, `owner:background`; no forced release |
| Normal worker exit followed by existing handoff/open flow | Independently confirmed `owner:desktop` |
| Next desktop-owned turn | Official `mcp__codex_app__set_thread_archived` available |
| Direct plugin archive of held fixture | `owner_action_required`, `submitted:false` |
| Manifest dispatched through Magpie | Actual native archive tool call completed successfully |
| Independent final inventories | Both fixture and runner: active=false, archived=true, history readable |

Runner: `MAGPIE-QA-NATIVE-ARCHIVE-BRIDGE` (`<private-fixture-id>`). Target: `MAGPIE-QA-NATIVE-ARCHIVE-TARGET` (`<private-fixture-id>`). Native mutation turn `<private-fixture-id>` records `codex_app.set_thread_archived` with that target and `archived:true`. Both test chats were archived afterward; permanent deletion was not attempted. Private receipts and postchecks are retained outside the checkout in the dated `magpie-native-archive-bridge` audit directory.

## Boundaries

- Direct `codex_archive` remains limited to writerless persisted subtrees; plugin info's `desktopHeldArchive:false` describes that direct API.
- This is a locally verified orchestration recipe, not a new atomic batch API or automatic native fallback. Discover tools in each runner's actual native turn.
- Ownership and tool availability are separate gates. The fix prevents background followers from being labeled desktop owners and revalidates historical `desktop_owned` receipts.
- The one-target idle test does not establish multi-target partial-failure recovery, active-thread archival, descendant behavior, or immediate sidebar refresh. Sidebar pixels were not manually observed.
- The inspected official desktop model tools offer archival, not permanent deletion.
- Release remains closed pending fresh full acceptance, including genuine Claude-to-Magpie execution and cleanup.
