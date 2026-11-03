# magpie-codex-dispatch

[English](README.md)

**中文：** 通过本地 IPC 向正在运行的 Codex 桌面应用派发任务，并在原生会话中实时显示执行过程的 Magpie 插件。

**English:** A Magpie plugin that dispatches tasks to the running Codex desktop app via local IPC, with execution visible in the native conversation.

```text
Claude 或其他 MCP 客户端
  → Magpie 已有的 MCP 网关与插件宿主
    → 正在运行的 Codex 桌面应用本地 IPC
      → 已有的原生会话
```

插件运行在 Magpie 插件宿主中，不启动额外的 Codex app-server，不需要单独看板、模型 API Key，也无需修改 Claude 的模型路由。Codex 桌面应用负责执行、权限、审批及实时展示，调用方通过短请求查询状态。

## 当前支持范围

这是实验性的 **macOS 首版**。目标会话必须已在本机 Codex 桌面应用中打开。**尚不支持从外部自动新建桌面会话**：请先在应用中创建或打开目标会话，再使用其 UUID，例如 `codex://threads/<uuid>` 链接中的 ID。

本插件依赖**桌面应用内部 IPC**，不是公开的 [Codex App Server API](https://learn.chatgpt.com/docs/app-server)，应用升级后可能需要适配。当前核实范围：

| 组件 | 版本及验证 |
| --- | --- |
| ChatGPT/Codex Desktop | macOS 26.1027.61615；真实会话归属发现与状态读取 |
| Magpie | 0.1.2785；隔离插件宿主成功加载四个工具，并读取真实桌面状态 |
| Magpie Bun | 1.4.4 |
| Node | 26.3.0；模拟 IPC 与失败路径自动测试 |

插件写操作已通过模拟桌面测试。此前独立探测脚本验证过派发、下一轮追加和中断，但**不能将其视为本插件的端到端验收**。本版本尚未完成“Claude → 正式安装的 Magpie MCP → 原生桌面任务执行及界面展示”的完整验收。不宣称支持 Windows 或 Linux 桌面。

## 安装与接入

在已安装并运行 Magpie 的环境中执行：

```sh
magpie plugin add github:hoomoli/magpie-codex-dispatch
```

也可以安装本地仓库：

```sh
git clone https://github.com/hoomoli/magpie-codex-dispatch.git
magpie plugin add ./magpie-codex-dispatch
```

在 Magpie 中启用本插件以及内置的 **Plugin tools**。从插件的 Installed 行复制 MCP 地址。所有插件的公共入口为 `/mcp/magpie/tools`；Magpie 也提供单插件入口与 Library 条目。请使用自己实例显示的实际地址和端口。

将复制的地址赋给 `MAGPIE_TOOLS_URL` 后，Claude Code 可以直接添加：

```sh
claude mcp add --transport http --scope user magpie-codex "$MAGPIE_TOOLS_URL"
```

或者在 Magpie Library 中将本插件的 MCP 条目启用给 Claude。两种方式选一种，避免工具重复。**无需先把 Claude 的模型请求改走 Magpie。** 远程 Magpie 网关可能要求自己的鉴权；这与 Codex 的登录无关。

## 四个工具

公共 MCP 入口会给工具名增加插件前缀，单插件入口使用下列名字。请以实际 `tools/list` 返回为准。

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `codex_status` | `threadId`，可选 `turnId` | 读取最新快照、执行状态和最多 16,000 字符的助手输出 |
| `codex_dispatch` | `threadId`、`prompt`、`requestId` | 在空闲的已有会话中开始下一轮，返回接收结果与 `turnId` |
| `codex_followup` | `threadId`、`turnId`、`prompt`、`requestId` | 向执行中的轮次追加指令；已结束时使用 dispatch |
| `codex_stop` | `threadId`、`turnId`、`requestId` | 请求中断指定的执行中轮次 |

调用示例，需替换占位会话 ID：

```json
{
  "threadId": "00000000-0000-4000-8000-000000000001",
  "requestId": "example-task-0001",
  "prompt": "Reply with exactly OK. Do not use tools or modify files."
}
```

1. 先查询状态，确认目标会话正确、已打开且空闲。
2. 用新的 `requestId` 派发任务，保存返回的 `turnId`。
3. 带上会话和轮次 ID 查询状态，建议间隔 2–5 秒。`accepted: true` 只代表接收，不代表执行完成。
4. 分别处理 `completed`、`interrupted`、`failed`、`inProgress` 和 `unknown`。历史未加载或已移出缓存时保持未知；审批和等待用户输入仍在桌面应用内处理。

`codex_followup` 会先检查活动轮次，但内部 steer 接口没有原子的目标轮次保护。如果桌面用户同时切换了执行轮次，仍可能发生竞争，使用时应避免其他调用方同时替换当前轮次。`codex_stop` 则发送协议支持的 `expectedTurnId` 保护参数。两者都应再查状态确认结果。

## 超时与重复请求

- 每步 IPC 超时为 8 秒，正常文件系统条件下，整个调用控制在 Magpie 的 55 秒工具预算内。取消工具调用会关闭 IPC，**不会自动停止已经接收的任务**。
- 写操作发送后不自动重试。超时、断线或不明确的响应会返回 `OUTCOME_UNKNOWN`；请先查看桌面或查询状态。
- 重试时使用**相同 requestId 和相同参数**。已确认的请求返回保存的回执；正在处理或结果未知的请求不再次发送，插件重启后也一样。相同 ID 配不同参数会报错。
- 发送前检查失败且成功清理回执后，可以重用该 ID。一个插件实例同时只向同一会话提交一个命令，但不能阻止其他客户端或桌面用户并发操作。
- 本地回执只存操作 ID、SHA-256 参数指纹和接收元数据，不保存任务文本、会话输出、凭证或模型配置。回执不会自动过期，删除它们会失去对应请求的重复保护。
- 每次状态查询都读取新快照后断开；插件不重建长期增量流，实时展示由桌面应用自身负责。

## 配置与访问范围

可选环境变量应配置给 **Magpie 插件宿主**，仅配置给 Claude 进程不会生效：

| 变量 | 默认值 |
| --- | --- |
| `MAGPIE_CODEX_SOCKET` | `~/.codex/ipc/ipc.sock` |
| `MAGPIE_CODEX_STATE_DIR` | `~/.local/state/magpie-codex-dispatch` |

Socket 必须属于当前用户。回执目录必须属于当前用户且权限为 `0700`，文件权限为 `0600`。插件不读取 Codex 凭证、不修改会话文件，继承目标会话的执行设置，不自动代答审批。

获得这些工具权限的调用方可以向本地桌面会话派发任务，并读取助手输出。请通过 Magpie 的 MCP/Library 设置限定调用方，不向不可信客户端开放。任务文本最多 64 KiB，IPC 帧最多 32 MiB；不支持的状态协议版本会在派发前报错。

## 开发和验证

没有运行时依赖，无需构建。开发使用 Node 22+，运行时由 Magpie 提供 Bun。

```sh
npm run check
npm test
npm pack --dry-run
npm run probe -- <existing-thread-uuid>
```

只读探测脚本只输出元数据，不打印助手内容。自动测试使用临时 socket 和回执目录，不接触真实会话；覆盖分片帧、归属路由、重启后重复请求保护、忙碌或变化的轮次、不安全路径、超时、断线、取消和协议版本不匹配。

安装验收应使用专门的测试会话，通过 Claude 实际连接的 Magpie MCP 发送上述无副作用示例，核对原生界面和查询结果，再在该测试会话中验证追加及中断，不使用正在工作的会话。

接口依据：[Magpie 插件工具说明 v0.1.2785](https://github.com/yetone/magpie/blob/v0.1.2785/docs/subsystems/plugin-tools.md)。调研参考项目：[magpie-codex-bridge](https://github.com/lesnolie/magpie-codex-bridge)、[codex-web](https://github.com/i-am-BT/codex-web)。本仓库为独立实现，没有包含这些项目或桌面应用的代码副本。

## 许可证

[MIT](LICENSE)。
