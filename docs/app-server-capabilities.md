# Verified Codex integration capabilities

Checked on 2026-11-05 against ChatGPT desktop `26.1027.61615`, bundled `codex-cli 0.166.0-alpha.5.1`, and this plugin's local development checkout. This is a compatibility record, not a guarantee about future versions. Read current schemas and repeat the probes after upgrades.

## Evidence sources

- [Official app-server protocol](https://learn.chatgpt.com/docs/app-server): public RPC and transport semantics.
- The installed CLI's `app-server --help`, `app-server generate-json-schema --experimental --out <private-directory>`, and isolated real-server probes below.
- Read-only inspection of the installed desktop's packaged request registry and local transport selection. No proprietary source is copied into this repository. Private inspection artifacts and actual fixture IDs remain outside Git.
- Plugin implementations: [RPC](../src/rpc.js), [desktop IPC](../src/desktop.js), [ownership inspection](../src/ownership.js), [lifecycle journal](../src/lifecycle.js), [stored status](../src/stored-status.js).

## Final native-archive audit and scope decision

The final audit on the installed build found **no independent Magpie archive entry satisfying ordinary desktop startup/restart without a shared backend**. This conclusion is bounded to the inspected version and tested paths, not a claim about every future desktop release.

| Check | Observed evidence |
| --- | --- |
| Fresh packaged follower request registry and version table | No archive, delete or unsubscribe/release request. Archive broadcasts are notifications, not owner commands. |
| Native app-tools pipe from Magpie's Bun 1.4.4 executable | A framed, read-only `tools/list` connected and was closed without a response. The matching desktop log recorded `untrusted-code-signing-identity`. |
| Recheck inside the actual Magpie plugin host | A temporary read-only diagnostic tool connected and received `EPIPE`; the matching desktop log recorded `dynamic_app_tools_peer_rejected reason=untrusted-process-ancestry`. The temporary tool was removed afterward. No mutation, caller impersonation or alternate trusted process was used. |
| Native tool-call schema and dispatch | Caller sources are Codex/ChatGPT with thread, turn and call context; no independently registered Magpie caller or standalone archive RPC was found. These internal identities must not be fabricated. |
| Official desktop tool catalog | `set_thread_archived` exists in its first-party caller surface. Its availability there does not grant a third-party caller access to the native pipe. |
| Independent app-server and reverse release | Existing real probes establish that archive is refused on another process's idle writer and external unsubscribe cannot release that connection. |

The private audit records include binary/source hashes, both exact read-only probe results and matching native peer-rejection logs. A desktop restart during the investigation changed its socket; the actual-host recheck rediscovered the current socket and confirmed the app artifact was unchanged. Neither refusal is inferred from an old socket or a timeout. No proprietary packaged source, private socket IDs or conversation content is committed here. The inspected app archive SHA-256 was `bb88615052255e79b5977885f9a0cc212c268589587c79d4d3b7c4b46e881a95`.

**Local scope from 0.0.8-local.4:** 13 public tools; retain `codex_archive` only for persisted roots whose complete discovered subtree has no writer. Held threads return `owner_action_required` without submission or timed retry advice. Active/awaiting-input threads remain refused. Permanent deletion is removed from both the tool catalog and mutation allowlist; old deletion receipts remain readable and retired. There is no automatic native fallback and no immediate-sidebar-refresh promise. Unsupported desktop-held cleanup must be performed in the owning desktop; record it separately from plugin integration evidence. The acceptance policy now requires genuine Claude-to-Magpie archival plus explicit verification of any manual finish, without rewriting historical reports.

## App-server RPC

**Original-owner implementation, 0.0.8-local.5:** newly created plugin workers retain ownership until explicit archive or idle handoff. `codex_archive` can route authenticated requests to the verified original background connection, with durable intent/ACK, serialized idle checks, descendant checks, post-ACK archive notifications and resource cleanup. This uses the plugin's own backend, not a backend shared with the desktop. Direct desktop-held archive remains unsupported; do not infer deletion support. See [retained-owner implementation and acceptance](background-owned-thread-lifecycle.md).

**Follow-up, 2026-11-06:** [desktop archival delegation](native-archive-bridge.md) was verified locally: Magpie dispatches an authorized manifest into a genuinely desktop-owned Codex chat, whose native turn invokes official `set_thread_archived`. An idle desktop-held test chat was archived successfully and independently checked. This does not grant Magpie direct native pipe access or expand direct `codex_archive` support. The linked procedure records the handoff receipt fix and acceptance limits.

| Method | Verified capability / boundary |
| --- | --- |
| `project/list`, `project/read` | Canonical project metadata. Desktop presentation IDs may differ; do not invent IDs from sidebar names. |
| `thread/start`, `thread/name/set` | Create/name persisted threads. Empty provisional threads may be readable by ID while absent from history lists. |
| `thread/read` | Read persisted history without resume/subscription. `status:notLoaded` is local to that backend and does not establish that another process has released its writer. |
| `thread/turns/list` | Paginate exact persisted turns without loading execution. Missing turns and stale in-progress history are not successful live execution. |
| `thread/list` | Page stored active and archived inventories separately; enumerate descendants with `ancestorThreadId` and all supported source kinds before cascading mutations. A listing alone is not proof that an empty thread does not exist. |
| `thread/loaded/list` | Loaded thread IDs in the connected backend. Use together with actual writer/socket PID checks, not as a global writer catalog. |
| `thread/resume`, `turn/start` | Load execution/start turns. Plugin read/status clients deliberately cannot use these methods. Background execution is separate from stored-history reading. |
| `thread/archive` | Archive persisted history; attempts to archive descendants. An independent server is rejected when another process holds an idle writer. Archive-first does not solve cross-process ownership. Descendant notifications can be incomplete. |
| `thread/delete` | Supported by the underlying server, but removed from this plugin's mutation allowlist and public tools. Earlier isolated same-backend experiments are historical evidence only. |
| `thread/unsubscribe` | Removes this connection's subscription. Calling it in a new server does not unsubscribe the desktop's connection or release another process's writer. Last-subscriber unload has a grace interval; an acknowledgment is not immediate writer release. |
| `thread/unarchive` | Restore archived persisted history. This is a mutation, not a cache-refresh trick for existing user chats. |

`thread not loaded: <id>` is classified as `THREAD_UNAVAILABLE`, not proof of deletion. An exact `already has an active writer` rejection is `THREAD_IN_USE`. Generic RPC errors must not be reclassified from vague message fragments. Unknown post-submission outcomes retain their request ID and must not be resent automatically.

## Desktop IPC and native deletion

### Official plugin surfaces checked locally

The installed Claude Code plugin `codex@openai-codex` version `1.0.6` identifies OpenAI as its author. Its command files and `scripts/codex-companion.mjs` expose setup, task/review, transfer, status/result and cancellation flows, but no archive or permanent-delete command. Its executable `.mjs` sources contain no `thread/archive` or `thread/delete` request. Cancellation stops a job; it does not delete the Codex chat. This finding applies to the installed version, not an unverified newer release.

The currently available official desktop `codex-app-tools` catalog exposes `set_thread_archived` and archived-chat listing, but no permanent chat-deletion tool. Deleting a sidebar section or automation is not chat deletion. Public app-server support for `thread/delete` and the desktop's native right-click action do not imply that either official plugin exports that capability.

The desktop's `~/.codex/ipc/ipc.sock` uses four-byte little-endian length-prefixed JSON. It is **not** an app-server control socket and does not accept app-server JSONL or WebSocket RPC.

| Surface | Verified behavior |
| --- | --- |
| `thread-owner-discovery` v1 | Finds a stream owner; no owner can time out. Skip discovery for writerless stored-status reads. |
| `thread-stream-state-changed` v11 | Live snapshots/Immer patches; revision gaps require a new snapshot. |
| Follower start/settings v2, steer v1, interrupt v4 | Owner-routed execution operations. Interrupt includes an expected turn guard. Settings acknowledgment still requires readback; the first real-Claude run found a background-owner readback defect. |
| Follower archive/delete/unsubscribe | **Not present** in the inspected request registry. Do not invent method names. |
| `thread-archived` v2 / `thread-unarchived` v1 | Catalog/cache notifications, not commands that persist archive/delete. Broadcast only after the corresponding actual mutation; do not forge an archive notification to evict an active owner. |
| Desktop right-click permanent delete | Sends `thread/delete` through its own backend and handles native deletion/catalog events. It can succeed while a separate plugin backend is refused. |
| Native app-tools pipe | Separate framed tool protocol with peer authorization and caller context. Not a public, unscoped lifecycle proxy for third-party clients. Do not impersonate a Codex/ChatGPT tool caller. |

### Reverse-handoff hypothesis

Claude is the MCP caller, not the writer. Older creation/handoff flows closed the temporary creator or unsubscribed through the verified Companion broker, then waited for the desktop to take ownership. Current background creation initially keeps execution in the plugin worker while the desktop follows its stream; opening the UI does not itself prove that the desktop has become the writer. Always inspect current ownership.

A desktop-to-plugin handoff would first require a supported release call on the desktop's own connection, followed by confirmed writer unload. No such desktop follower request was found in the inspected registry. The Companion broker's `thread/unsubscribe` release mechanism cannot be applied to a desktop-owned thread; a new app-server's unsubscribe only affects that new connection. Thus reverse handoff is not a verified workaround. Once the existing writer naturally unloads, the lifecycle client can archive/delete persisted history directly without first resuming or taking execution ownership.

Archiving through a plugin worker while it still owns a future task is a separate possible design; it does not recover ownership of existing desktop-held chats and has not been accepted as a fix. Do not turn this hypothesis into a capability claim.

## Rejected shared-backend experiment

The installed CLI supports WebSocket over Unix sockets. An isolated same-backend experiment succeeded: an extra client deleted an idle held thread and the original subscriber received a native deletion notification. This established a protocol capability, not a reliable desktop integration.

Read-only desktop inspection found a version-specific `CODEX_APP_SERVER_USE_LOCAL_DAEMON` startup switch. The experiment depended on selecting that mode before desktop startup. The plugin cannot guarantee that a later normal desktop restart uses the same backend. Process identity checks can prevent use of the wrong server, but cannot force the correct startup state. Requiring special launch scripts and coordinating app/plugin restarts does not meet the intended normal-launch workflow.

**Decision, 2026-11-05:** abandon this route. Shared-owner transport code, dependencies, setup launcher and dedicated tests were removed from the plugin. The privately saved experiment and its passing checks are historical evidence, not release acceptance. Do not reintroduce this route or ask the operator to change desktop startup merely to make deletion work.

Other verified details from the withdrawn experiment:

- The IPC stream socket and app-server control endpoint speak different protocols. A control endpoint uses an HTTP Upgrade handshake and WebSocket messages; a Companion broker uses raw JSONL.
- Long control endpoint paths can be symlinks to shorter Unix sockets. The experiment checked endpoint ownership and writer PID identity before any mutation.
- The installed CLI's `app-server proxy --sock` sent raw JSONL to the tested WebSocket-over-Unix listener, which rejected the handshake. A command's presence alone does not prove interoperability.
- Magpie Bun 1.4.4/macOS returned `EOPNOTSUPP` for `realpath(socket)`. Directory-only canonicalization plus bounded symlink resolution worked in the experiment.
- Native notification delivery to an isolated subscriber did not establish actual desktop sidebar refresh. That UI acceptance was never completed.

The unused daemon started solely for this experiment was stopped after confirming it had no loaded threads and was not the desktop's writer. No desktop process was restarted, no global startup environment was set, and the app bundle was not modified. Earlier plugin calls and evidence remain preserved privately.

## Reproducible supported-boundary checks

```sh
npm run check
npm test
node scripts/verify-lifecycle.mjs
```

The lifecycle probe uses a private temporary `CODEX_HOME`, creates no model turns and removes only its own fixtures/backend. It verifies that independent-server archive is refused on an idle held writer, that an external unsubscribe cannot release that writer, that the same archive request can proceed after normal owner shutdown, and that permanent deletion is blocked by the plugin.

Direct native desktop-held archival and immediate sidebar refresh remain excluded from the plugin API contract. The separately tested [desktop archival delegation](native-archive-bridge.md) uses an actual desktop model turn and its official tools. Do not continue probing unauthorized native peers or revive rejected takeover/shared-server paths. Existing unrelated acceptance failures remain open; this local delegation test alone does not open the release gate.

## Optional creation pinning (2026-11-09 local verification)

The currently installed bundled app-server exposes `threadSection/list` and `thread/section/move`. The desktop tool alias `pinned` maps to a server-owned section UUID; passing the alias directly to app-server is not the integration contract. The plugin verifies the known section is advertised, moves only the newly created thread, then reads back `thread.section.id` before starting execution. An isolated new, empty fixture was successfully moved, found in a section-filtered listing, then unpinned and archived. No model turn was started by this capability probe. This verifies persisted native section membership; actual desktop pixels and genuine Claude invocation remain separate acceptance checks.

`codex_create_task` opts in with `pin: true`; omitted/false preserves the previous default. The durable request fingerprint includes opt-in pinning, and accepted retries do not repeat it. Local agent rules may require explicit opt-in; the package does not impose that policy on other users.
