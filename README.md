# magpie-codex-dispatch

[中文说明](README.zh-CN.md) · [Ownership contract / 控制权规范](docs/ownership.md)

**English:** A Magpie plugin for creating project-specific Codex conversations, handing off idle Companion sessions, and dispatching tasks with live execution in the native Codex desktop app.

**中文：** 通过 Magpie 新建指定项目的 Codex 会话、安全交接空闲会话，并在 Codex 桌面应用原生对话中实时执行任务。

```text
Claude / other MCP client
  -> existing Magpie MCP gateway and plugin host
    -> create empty thread -> temporary creator exits -> open native thread
    -> native desktop IPC: dispatch / follow-up / stop / status
```

Codex Desktop owns execution, permissions, approvals and live rendering. Claude's model does not need to route through Magpie. There is no separate dashboard or persistent Codex execution server added by this plugin. Creating a thread or reading the project catalog briefly starts the app's bundled public app-server, then closes it. That temporary client cannot execute turns. Existing native-thread dispatch uses the running desktop directly.

## Install and connect Claude

Requires macOS, a running Codex desktop app, and Magpie with community plugin tools enabled:

```sh
magpie plugin add github:hoomoli/magpie-codex-dispatch
magpie library mcp agents magpie-codex-dispatch claude
```

Local development:

```sh
git clone https://github.com/hoomoli/magpie-codex-dispatch.git
magpie plugin add ./magpie-codex-dispatch
magpie library mcp agents magpie-codex-dispatch claude
```

Magpie writes its plugin-specific HTTP MCP entry into Claude's configuration. Start a new Claude session to pick it up. Use the Library connection **or** a manually configured MCP entry, not both. The address and authentication depend on your Magpie instance; copy its Installed/Library address instead of assuming a port. No model-provider change is necessary.

Ask Claude, for example:

> Use the Magpie Codex tools to create a new task in project `my-project`. First list projects. Use one stable requestId and identical arguments for pending retries. After acceptance, poll status for the returned threadId and turnId. Task: …

For an old Companion session, first stop sending commands to that thread through the old openai-codex integration. Ask Claude to inspect ownership, hand off the idle session, and wait for `desktop_owned`. Subsequent commands use this plugin's follower tools; the desktop remains the writer.

## Tools

Plugin-specific MCP exposes these names. The combined endpoint prefixes them with `magpie-codex-dispatch_`; inspect `tools/list` for the actual names.

| Tool | Main arguments | Result |
| --- | --- | --- |
| `codex_projects` | none | Canonical project IDs, names and workspace roots |
| `codex_create_task` | `requestId`, `prompt`; project selection below | Create, attach and dispatch; can return a resumable pending phase |
| `codex_ownership` | `threadId` | Desktop ownership or external/unattached writer information |
| `codex_handoff` | `threadId`, `requestId`, optional `sourceEndpoint` | Release one idle Companion thread, wait for unload and attach desktop |
| `codex_recover_creation` | `requestId`, `threadId` | Verify source marker/project/cwd and bind an uncertain creation; does not dispatch |
| `codex_operation_status` | `requestId` | Read saved create/handoff progress without advancing it |
| `codex_status` | `threadId`, optional `turnId` | Fresh execution snapshot and up to 16,000 characters of assistant output |
| `codex_dispatch` | `threadId`, `prompt`, `requestId` | Start the next turn in an idle native thread |
| `codex_followup` | `threadId`, `turnId`, `prompt`, `requestId` | Steer an active turn |
| `codex_stop` | `threadId`, `turnId`, `requestId` | Request cancellation of the specified active turn |

### Create in a project

```json
{
  "requestId": "example-task-0001",
  "projectName": "my-project",
  "title": "Example task",
  "sandbox": "read-only",
  "prompt": "Reply exactly OK. Do not use tools or modify files."
}
```

Select an exact unique `projectName` or canonical `projectId` from `codex_projects`. Desktop UI project IDs can differ from backend IDs. One project root supplies the working directory; multiple roots require an explicit `cwd` inside a root. An explicit absolute `cwd` without a project creates a projectless thread. No implicit current-project default is used. Paths are resolved through filesystem aliases and checked before creation. This creates a **conversation**, not a new project.

Optional `title` is limited to 160 characters; its default is `Magpie task`, so empty threads are named before the creator exits. `sandbox` is `workspace-write` by default or `read-only`; approval policy is `on-request`. The creation response and native workspace are checked before dispatch. Follow-up turns inherit thread settings.

### Retry and completion

1. Save one request ID per logical operation. IDs contain 8–128 letters, digits, underscores or hyphens.
2. For pending create/handoff phases, wait roughly 2–5 seconds and repeat the **same tool, arguments and requestId**. A tool response can arrive before desktop attachment or source unload finishes. Source unload was observed to take about a minute.
3. On `phase: accepted`, save `threadId` and `turnId`. Poll `codex_status` with both. Acceptance is not completion.
4. Handle `inProgress`, `completed`, `failed`, `interrupted`, unknown history and approval requests separately. Handle approvals in the native app.
5. A lost mutation acknowledgement is `OUTCOME_UNKNOWN` / `dispatch_unknown`. It is never automatically resubmitted. Inspect status; do not invent a new ID to retry uncertain work.

Durable state keeps fingerprints, IDs, project/workspace metadata and progress, not prompts or conversation output. Repeated acknowledged commands return the original receipt, including after restart. Creation lost before saving its thread ID is reconciled using a unique source marker and a bounded metadata scan; if unresolved it stays `creation_unknown` rather than creating a duplicate. The scan examines at most 1,000 list entries and reads at most 30 candidates with omitted markers. Absence is not treated as proof of failure. Empty threads may be omitted from listings or may not yet be persisted upstream. If the original ID is known, `codex_recover_creation` verifies its unique source marker, cwd and project before binding it; then retry the original create arguments. An unreadable thread cannot be recovered or silently recreated.

Progress is advanced by retry calls; there is no background retry worker. `codex_operation_status` is a saved checkpoint, not a live ownership or completion assertion. Do not delete receipt files: doing so removes replay protection. Plugin operation locks can recover a dead process; incomplete lock records are reported for inspection. Codex's writer-lock files are never modified.

## Ownership and limitations

- A thread has one writer. Normal Claude ↔ Codex interaction uses the desktop's follower interface and does **not** transfer the writer back and forth.
- Handoff supports the local, current-user **Codex Companion broker** protocol. The plugin verifies the writer's parent broker/socket and its handshake, reads the target's idle status, then sends `thread/unsubscribe` for that thread only. Unknown or active writers are refused.
- Source acknowledgement alone is insufficient: the plugin waits for writer release and a native owner snapshot. It never deletes Codex locks, kills a shared broker, closes unrelated threads or interrupts active work automatically.
- The source must quiesce submissions before handoff. The source API has no atomic “unsubscribe only if idle” guard; a client that ignores this contract can race the check. Arbitrary desktop-to-CLI writer transfer is not provided. Both callers should keep using the native owner via this plugin.
- Desktop takeover uses the supported `codex://threads/<id>` deep link and can bring the app/thread to the foreground. It uses no accessibility automation. If the app retains a stale busy screen, switch away and reopen the thread, or use its Retry action after release.
- Follow-up checks the active turn, but the private steer protocol has no atomic expected-turn guard. Avoid concurrent UI turn replacement. Stop does send `expectedTurnId`; confirm the final state with status.
- Caller cancellation stops waiting; it does not automatically cancel an already accepted task. Each tool call has a 45-second deadline, with bounded IPC/RPC timeouts and subprocess cleanup.

This is an **experimental macOS integration using private desktop IPC** alongside the public [Codex App Server API](https://learn.chatgpt.com/docs/app-server). Desktop updates can break it. Unsupported stream versions fail before dispatch. Windows/Linux desktop support is not claimed.

## Configuration and trust

Set optional environment variables on the **Magpie plugin host**, not only Claude:

| Variable | Default |
| --- | --- |
| `MAGPIE_CODEX_SOCKET` | `~/.codex/ipc/ipc.sock` |
| `MAGPIE_CODEX_STATE_DIR` | `~/.local/state/magpie-codex-dispatch` |
| `MAGPIE_CODEX_BINARY` | Installed desktop's bundled Codex CLI; absolute executable path required |
| `CODEX_HOME` | `~/.codex` for the public client and writer inspection; also set the socket override for a nonstandard desktop home |

Sockets must belong to the current user. State directory permissions are `0700`, files `0600`. The plugin never reads credentials directly or edits Codex session storage; the bundled app-server uses the user's existing Codex setup. MCP access grants local task execution and assistant-output reads: limit it to trusted clients through Magpie. Prompts are limited to 64 KiB and protocol frames to 32 MiB. Raw internal errors and conversation payloads are not included in error messages.

## Verification and development

No runtime dependencies or build step. Node 22+ for development; Magpie supplies Bun.

```sh
npm run check
npm test
npm pack --dry-run
npm run probe -- <thread-uuid>
```

The probe reads metadata only. Automated tests use temporary sockets/state and cover routing, busy/changed turns, cancellation, protocol errors, lost replies, creation recovery, project validation and duplicate prevention. See [verification record](docs/verification.md) for actual local acceptance and remaining compatibility limits.

Interface reference: [Magpie plugin tools, v0.1.2785](https://github.com/yetone/magpie/blob/v0.1.2785/docs/subsystems/plugin-tools.md). This independent implementation does not vendor proprietary desktop code.

[MIT license](LICENSE).
