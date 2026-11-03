# Ownership contract / 控制权规范

## English

A **writer** owns the Codex runtime session; an MCP caller merely requests work. Do not equate permission to send a message with ownership of the writer lock.

New tasks: resolve an explicit project/workspace → durably record creation intent → create an empty thread → persist its ID → close the temporary creator → verify source release → open the native thread → confirm a native owner snapshot → dispatch once. The temporary creator has no turn-execution methods.

Old Companion tasks: stop source-side submissions → require the target to be idle → durably record release intent → unsubscribe that thread through its verified source broker → wait for unload → open the native thread → confirm the native owner. A release RPC response is not proof that the writer lock is free. Waiting is reported, not hidden.

Once native ownership is established, Claude, other MCP clients and the desktop UI interact through the same native owner. Do not resume this thread in the old Companion backend. Completing one turn does not mean the writer must be destroyed; the app needs it for the next turn. The plugin disconnects its follower subscriptions after each call.

The plugin owns release mechanics and verification. The calling Claude workflow owns the cooperation contract: stop direct source submissions before handoff, do not concurrently resume or mutate the source, preserve request IDs, and treat pending/unknown outcomes distinctly. The upstream idle check and unsubscribe are separate RPCs; no atomic idle-only release exists in the verified API.

Never delete Codex writer-lock files, kill a shared broker, release unrelated sessions or force an active handoff. Unknown source types require their own supported release mechanism. No arbitrary reverse desktop-to-CLI writer takeover is implemented; use the desktop follower path for both conversational directions.

Persisted phases:

| Phase | Meaning / caller action |
| --- | --- |
| `preparing` | Resolve project and prepare intent; retry identical request |
| `creating` / `creation_unknown` | Creation submitted; reconcile metadata, never create again on uncertainty |
| `thread_created` | ID retained; temporary creator must exit |
| `release_requested` / `waiting_source_release` | Release may be pending; wait and retry same ID |
| `waiting_writer_release` | Writer still exists; no forced takeover |
| `waiting_desktop` | Native owner not confirmed; repeat same request |
| `desktop_owned` | Handoff confirmed at that point; use live ownership for later checks |
| `dispatching` / `dispatch_unknown` | Do not submit a new operation to compensate for uncertainty |
| `waiting_dispatch` | Preflight failed; inspect state, then retry same request |
| `accepted` | Original turn receipt retained; poll execution status |
| `project_mismatch` | Stop; inspect project association before any task |

## 中文

**写入方**持有 Codex 运行时会话；MCP 调用方只是请求执行任务。能发消息不等于需要获取写锁。

新任务流程：明确项目或目录 → 持久化创建意图 → 新建空会话 → 保存 ID → 退出临时创建进程 → 确认源端释放 → 打开原生会话 → 确认桌面所有者快照 → 派发一次。临时创建客户端不具备执行轮次的方法。

旧 Companion 会话：先停止源端继续提交 → 确认目标空闲 → 保存释放意图 → 通过核实过的源 broker 取消订阅这一个会话 → 等待卸载 → 打开原生会话 → 确认桌面接管。释放接口返回成功，不代表写锁已立即释放；等待状态必须明确返回。

桌面接管后，Claude、其他 MCP 客户端和桌面输入框都通过同一个原生所有者交互。不要再从旧 Companion 后端恢复该会话。一次任务完成不需要销毁桌面写入方，后续消息仍由它处理；插件每次调用结束会断开自己的跟随订阅。

**插件负责执行释放和核实接管；Claude 调用规范负责配合**：交接前停止源端提交，不并发恢复源会话，保留请求 ID，区分等待、失败与结果未确认。已验证的上游 API 将“检查空闲”和“取消订阅”分成两个调用，没有原子的“仅空闲时释放”参数，因此调用方必须遵守约定。

禁止删除 Codex 写锁文件、杀死共享 broker、释放无关会话或强抢正在运行的任务。未知源端需使用其自身支持的释放机制。插件未实现任意桌面到 CLI 的反向写入方迁移；双向对话均通过桌面跟随接口完成。

上述阶段分别覆盖准备、创建待确认、已建会话、等待源端释放、等待桌面、已接管、派发待确认和已接受。`accepted` 不表示执行完成；`desktop_owned` 是交接时的确认，后续实时状态应查询 `codex_ownership`。任何待确认操作都不能通过换一个请求 ID 来盲目重试。
