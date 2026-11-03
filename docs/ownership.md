# Ownership contract / 控制权规范

## English

A **writer** owns the Codex runtime session; an MCP caller merely requests work. Do not equate permission to send a message with ownership of the writer lock.

New tasks: resolve an explicit project/workspace → durably record creation intent → create an empty thread → persist its ID → close the temporary creator → verify source release → open the native thread → confirm a native owner snapshot → apply and verify requested permissions → dispatch once. The temporary creator has no turn-execution methods.

Old Companion tasks: stop source-side submissions → require the target to be idle → durably record release intent → unsubscribe that thread through its verified source broker → wait for unload → open the native thread → confirm the native owner. A release RPC response is not proof that the writer lock is free. Waiting is reported, not hidden.

Once native ownership is established, Claude, other MCP clients and the desktop UI interact through the same native owner. Do not resume this thread in the old Companion backend. Completing one turn does not mean the writer must be destroyed; the app needs it for the next turn. The plugin disconnects its follower subscriptions after each call.

The plugin owns release mechanics and verification. The calling Claude workflow owns the cooperation contract: stop direct source submissions before handoff, do not concurrently resume or mutate the source, preserve request IDs, and treat pending/unknown outcomes distinctly. The upstream idle check and unsubscribe are separate RPCs; no atomic idle-only release exists in the verified API.

Only the verified Companion broker's exact pre-forwarding busy rejection clears the release intent. The same request can then re-identify the source, recheck idle state and retry unsubscribe. Transport failures and other RPC errors keep the intent because they do not prove non-delivery.

Plugin native commands share a per-thread macOS kernel lock; flow checkpoints share a per-request lock. The lock is retained by the plugin's open file descriptor, not by a helper process or a recovery-directory record. Never unlink `.mutex` files while hosts are running. Upgrades must stop old directory-lock hosts first; dead legacy recovery directories no longer block the new lock, while live or incomplete legacy owners remain refused. The desktop UI and non-plugin clients do not participate in these locks.

Never delete Codex writer-lock files, kill a shared broker, release unrelated sessions or force an active handoff. Unknown source types require their own supported release mechanism. No arbitrary reverse desktop-to-CLI writer takeover is implemented; use the desktop follower path for both conversational directions.

Permission selection is independent of writer ownership. The caller supplies explicit user-authorized modes; the plugin applies and verifies them after native takeover. Default inheritance never silently promotes a task to Full Access. See the README permission contract.

Persisted phases:

| Phase | Meaning / caller action |
| --- | --- |
| `preparing` | Resolve project and prepare intent; retry identical request |
| `creating` / `creation_unknown` | Creation submitted; reconcile metadata, never create again on uncertainty |
| `thread_created` | ID retained; temporary creator must exit |
| `release_rejected` | Broker proved it did not forward release; retry the same ID to recheck and release |
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

新任务流程：明确项目或目录 → 持久化创建意图 → 新建空会话 → 保存 ID → 退出临时创建进程 → 确认源端释放 → 打开原生会话 → 确认桌面所有者快照 → 应用并核验指定权限 → 派发一次。临时创建客户端不具备执行轮次的方法。

旧 Companion 会话：先停止源端继续提交 → 确认目标空闲 → 保存释放意图 → 通过核实过的源 broker 取消订阅这一个会话 → 等待卸载 → 打开原生会话 → 确认桌面接管。释放接口返回成功，不代表写锁已立即释放；等待状态必须明确返回。

桌面接管后，Claude、其他 MCP 客户端和桌面输入框都通过同一个原生所有者交互。不要再从旧 Companion 后端恢复该会话。一次任务完成不需要销毁桌面写入方，后续消息仍由它处理；插件每次调用结束会断开自己的跟随订阅。

**插件负责执行释放和核实接管；Claude 调用规范负责配合**：交接前停止源端提交，不并发恢复源会话，保留请求 ID，区分等待、失败与结果未确认。已验证的上游 API 将“检查空闲”和“取消订阅”分成两个调用，没有原子的“仅空闲时释放”参数，因此调用方必须遵守约定。

只有核实过的 Companion broker 返回明确的转发前忙碌拒绝，才清除释放意图并记录 `release_rejected`。原请求重试会重新识别源端、检查空闲，再取消订阅。传输失败和其他 RPC 错误不能证明请求未执行，继续保留意图。

插件原生命令共享会话级 macOS 内核锁，流程进度共享请求级锁。锁由插件持有的文件描述符维持，不依赖辅助进程或恢复目录；宿主运行期间不得删除 `.mutex` 文件。升级前须停止旧目录锁版本的宿主；死亡进程的旧恢复目录不再阻塞，活跃或记录不完整的旧持有方仍会被拒绝。桌面界面及绕过插件的客户端不参与这些锁。

禁止删除 Codex 写锁文件、杀死共享 broker、释放无关会话或强抢正在运行的任务。未知源端需使用其自身支持的释放机制。插件未实现任意桌面到 CLI 的反向写入方迁移；双向对话均通过桌面跟随接口完成。

上述阶段分别覆盖准备、创建待确认、已建会话、等待源端释放、等待桌面、已接管、派发待确认和已接受。`accepted` 不表示执行完成；`desktop_owned` 是交接时的确认，后续实时状态应查询 `codex_ownership`。任何待确认操作都不能通过换一个请求 ID 来盲目重试。

权限选择与写入方归属分别处理：调用方传递用户明确授权的模式，插件在桌面接管后负责应用和核验；默认继承，不自动将任务提升为完全访问。详见 README 权限规范。
