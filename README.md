# magpie-codex-dispatch

[中文说明](README.zh-CN.md)

**English:** A Magpie plugin that dispatches tasks to the running Codex desktop app via local IPC, with execution visible in the native conversation.

**中文：** 通过本地 IPC 向正在运行的 Codex 桌面应用派发任务，并在原生会话中实时显示执行过程的 Magpie 插件。

```text
Claude (or another MCP client)
  -> Magpie's existing MCP gateway and plugin host
    -> the running Codex desktop app's local IPC
      -> an existing native conversation
```

No extra Codex app-server, separate dashboard, model API key, or model-routing change is required. The plugin runs inside Magpie's plugin host. Codex Desktop remains responsible for execution, permissions, approvals and live rendering. The caller obtains status through short polling calls.

## Status and requirements

Experimental **macOS-only** release. Requires an open local Codex desktop conversation and a Magpie version supporting community plugin tools. Creating a new desktop conversation from an external client is **not implemented**. Create/open the destination in the app first and use its thread UUID (for example, from a `codex://threads/<uuid>` link).

This uses **private desktop IPC**, not the public [Codex App Server API](https://learn.chatgpt.com/docs/app-server). Protocol changes can break compatibility. Verified against these local versions:

| Component | Version / evidence |
| --- | --- |
| ChatGPT/Codex Desktop | macOS 26.1027.61615; live owner discovery and status snapshot |
| Magpie | 0.1.2785; isolated plugin host loaded all four tools and read live desktop status |
| Magpie Bun | 1.4.4 |
| Node | 26.3.0; automated transport and failure-path tests |

The plugin's write operations have automated tests against a simulated desktop. A prior standalone probe established start/next-turn/interrupt viability, but that does **not** constitute an end-to-end test of this plugin. Claude -> installed Magpie MCP -> native desktop task execution and UI acceptance remain unverified for this release. No claim of Windows or Linux desktop support is made.

## Install

With Magpie installed and running:

```sh
magpie plugin add github:hoomoli/magpie-codex-dispatch
```

Or install a local checkout:

```sh
git clone https://github.com/hoomoli/magpie-codex-dispatch.git
magpie plugin add ./magpie-codex-dispatch
```

In Magpie, enable the community plugin and the built-in **Plugin tools** capability. Copy the MCP address from its Installed row. The combined endpoint is `/mcp/magpie/tools`; Magpie also offers a plugin-specific endpoint and a Library entry. Use the address shown by your instance, including its actual port.

To connect Claude Code directly, set `MAGPIE_TOOLS_URL` to the copied address, then run:

```sh
claude mcp add --transport http --scope user magpie-codex "$MAGPIE_TOOLS_URL"
```

Alternatively, enable this plugin's Library MCP entry for Claude through Magpie. Choose one connection method to avoid duplicate tools. Claude's model provider does not need to route through Magpie. A remote Magpie gateway may require its own authentication; this does not change Codex's authentication.

## Tools

Magpie adds a plugin prefix on the combined endpoint. The plugin-specific endpoint exposes the names below directly; inspect `tools/list` for the actual names.

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `codex_status` | `threadId`, optional `turnId` | Fresh snapshot, runtime/turn status and up to 16,000 characters of assistant output |
| `codex_dispatch` | `threadId`, `prompt`, `requestId` | Start the next turn in an idle thread; return acceptance and `turnId` |
| `codex_followup` | `threadId`, `turnId`, `prompt`, `requestId` | Steer an active turn; use dispatch after it finishes |
| `codex_stop` | `threadId`, `turnId`, `requestId` | Request interruption of that specific active turn |

Example dispatch arguments (replace the placeholder thread ID):

```json
{
  "threadId": "00000000-0000-4000-8000-000000000001",
  "requestId": "example-task-0001",
  "prompt": "Reply with exactly OK. Do not use tools or modify files."
}
```

1. Read `codex_status` to confirm the intended thread is open and idle.
2. Dispatch using a new request ID. Save the returned `turnId`.
3. Poll status with both `threadId` and `turnId`, typically every 2-5 seconds. `accepted: true` is not completion.
4. Handle `completed`, `interrupted`, `failed`, `inProgress` and `unknown` distinctly. Missing/evicted history stays unknown. Requests awaiting user input or approvals must be handled in the desktop app.

`codex_followup` checks the active turn before submitting, but the private steer protocol does not carry an atomic expected-turn guard. A concurrent UI turn change can race this check; avoid steering while another actor replaces the active turn. `codex_stop` sends the protocol's expected-turn guard. Always read status to confirm the resulting state.

## Failure and retry behavior

- Each IPC step times out after 8 seconds; a call fits within Magpie's 55-second tool budget under normal filesystem conditions. Caller cancellation closes IPC but does **not** automatically stop an accepted task.
- A mutation is never automatically retried. After submission, timeout, disconnect or an ambiguous response produces `OUTCOME_UNKNOWN`. Inspect the desktop/status before deciding what to do.
- Reuse the **same request ID and arguments** to retrieve an acknowledged receipt. Reusing an ID with different arguments fails. An in-flight/unknown receipt prevents resubmission, including after plugin restart.
- Successful preflight failure cleanup allows that ID to be retried because no mutation was sent. Only one command per thread is submitted at a time by one plugin instance; this is not a lock against other clients or the desktop UI.
- Receipt files retain operation IDs, a SHA-256 command fingerprint and acknowledgement metadata. They contain no prompt, conversation output, credentials or model settings. Receipts have no automatic expiry. Deleting them removes replay protection for those IDs.
- Status calls use a fresh snapshot and then disconnect. The plugin does not reconstruct a long-running patch stream; the desktop app renders its own live stream.

## Configuration and trust

Optional environment variables must be set for the **Magpie plugin host**, not just the calling Claude process:

| Variable | Default |
| --- | --- |
| `MAGPIE_CODEX_SOCKET` | `~/.codex/ipc/ipc.sock` |
| `MAGPIE_CODEX_STATE_DIR` | `~/.local/state/magpie-codex-dispatch` |

The socket must belong to the current user. The receipt directory must be owned by that user and have mode `0700`; receipt files use `0600`. The plugin does not read Codex credentials or rewrite its session files. It inherits the destination thread's settings and never answers approval requests automatically.

Anyone granted these tools can send work to local desktop threads and read their assistant output. Limit access through Magpie's MCP/Library configuration; do not expose this capability to untrusted clients. A prompt is limited to 64 KiB and IPC frames to 32 MiB. Unexpected stream versions fail before task submission.

## Development and verification

No runtime dependencies or build step are required. Node 22+ is used for development; Magpie supplies Bun at runtime.

```sh
npm run check
npm test
npm pack --dry-run
npm run probe -- <existing-thread-uuid>
```

The probe is read-only and prints metadata, not assistant output. Tests use temporary sockets and receipt directories, never your actual Codex sessions. They cover fragmented frames, owner routing, duplicates across restart, busy/changed turns, unsafe paths, timeout, disconnect, cancellation and version mismatch.

For installation acceptance, use a dedicated desktop conversation, send the harmless example through Claude's actual Magpie MCP connection, verify native UI output and status agree, then test a follow-up and interruption there. Do not use an active work conversation for acceptance testing.

Interface reference: [Magpie plugin tools, v0.1.2785](https://github.com/yetone/magpie/blob/v0.1.2785/docs/subsystems/plugin-tools.md). Related projects researched: [magpie-codex-bridge](https://github.com/lesnolie/magpie-codex-bridge) and [codex-web](https://github.com/i-am-BT/codex-web). This repository contains an independent implementation; it does not vendor their code or desktop application code.

## License

[MIT](LICENSE).
