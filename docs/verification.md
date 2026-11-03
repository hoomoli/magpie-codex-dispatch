> Release numbering starts at **0.0.1**. Versions 0.2.x below are historical local development labels, not published releases. The initial release includes those verified changes; historical runtime observations retain their original version strings.

# Verification / 验收记录

Verification history on **2026-11-03**, through local version **0.2.2**. Original 0.2.1 acceptance is retained below. No credentials, private conversations, machine paths or raw runtime logs are published here.

## Version 0.2.2 (local, unpublished) / 0.2.2（本地，未发布）

Verified locally on **2026-11-03**, after the 0.2.1 permission changes. Syntax checks and **52/52 tests** pass under Node and Magpie Bun 1.4.4, including the version-reporting regression. After reload, installed `codex_plugin_info` returned `pluginVersion: "0.2.2"` with a module load timestamp; an existing operation-status result also carried `pluginVersion: "0.2.2"`. The package has not been released.

- Independent dispatcher instances and separate processes cannot submit concurrently to the same thread. A contender returns `BUSY`, releases its unsubmitted receipt, and reads a fresh busy snapshot on retry.
- A real child process holds the operation lock after the `lockf` helper exits. After `SIGKILL`, a new caller acquires the same inode without deleting locks or running directory recovery. Dead legacy `.lock` plus `.recovery` state no longer blocks; live or incomplete legacy ownership remains refused.
- A verified broker rejection after persisted release intent allows one new attempt. Timeout, disconnect, cancellation and ambiguous RPC errors never resubmit an uncertain unsubscribe.
- These regression tests use temporary state and socket fixtures. They do not seize existing desktop or Companion conversations.
- A separate isolated check used the real bundled app-server, a local model stub and a simulated desktop snapshot adapter: two simultaneous dispatchers produced one `turn/start`, one acceptance and one `BUSY`; retry returned `THREAD_NOT_IDLE`. No live desktop session or external model was used.
- Installed-host reload: toggling this plugin off/on replaced the Bun host. A lock held by a separate process caused the installed tool to return `BUSY` without dispatching. After releasing it, actual Claude Code called the configured Magpie MCP endpoint using the same request ID; dispatch succeeded and an identical retry returned the same thread/turn with `replayed: true`.
- The native desktop completed that marker task in about 85 seconds with exactly `MAGPIE_RELOAD_OK`. Claude's bounded five status checks ended while the turn was still running; subsequent desktop and installed-plugin reads confirmed `completed`, no error and the exact output. No permissions were changed and the task used no tools or project files. This is execution/state acceptance, not a new visual or per-token rendering audit. Crash recovery and rejected-release cases remain isolated tests.

本次在 0.2.1 权限改动之上完成本地修复，Node 与 Magpie Bun 均通过 **51 项测试**。新增验证包含真实子进程的互斥与强制退出恢复、旧恢复目录残留，以及释放被明确拒绝和结果未知时的不同重试行为。另用隔离的真实 bundled app-server、本地模型桩和模拟桌面快照适配器复测并发：两个调用只产生一次启动，另一个返回 `BUSY`，重试后为 `THREAD_NOT_IDLE`。

随后已重载安装态 Magpie 插件，确认 Bun 宿主换代。独立进程持锁时，安装态工具返回 `BUSY`；释放锁后，真实 Claude 经已配置的 MCP 成功派发，并以相同请求 ID 获得同一轮的重放回执。桌面约 85 秒后输出 `MAGPIE_RELOAD_OK`。Claude 的五次有界查询先结束，之后通过桌面和安装态插件确认最终完成、无错误、输出匹配。任务没有调用工具、操作项目文件或修改权限。本次完成运行与状态验收，未重新进行视觉或逐字渲染验收；崩溃恢复与释放拒绝仍采用隔离测试。以下保留原发布版本的验收记录。

## Environment

| Component | Verified version |
| --- | --- |
| ChatGPT / Codex desktop, macOS | 26.1027.61615 |
| Desktop bundled Codex CLI | 0.166.0-alpha.5.1 |
| Magpie | 0.1.2785 |
| Magpie Bun | 1.4.4 |
| Node | 26.3.0 |
| Claude openai-codex Companion plugin | 1.0.6 |

## English

| Check | Observed result |
| --- | --- |
| Syntax and automated tests | `npm run check`; 41/41 tests passed under Node and Magpie's Bun |
| Installed Magpie host | Local checkout installed; 11 plugin tools loaded; plugin-specific HTTP MCP enabled for Claude through Library |
| Actual Claude → Magpie → native desktop | Claude Code connected to the installed gateway, selected a project, created a thread, retried pending attachment, dispatched, and observed `inProgress` then `completed`; exact harmless marker matched |
| Idempotency | Claude repeated the accepted create request; `replayed: true`, same thread ID and turn ID |
| Project targeting | Two existing projects tested; backend project ID and canonical workspace path matched. macOS path casing/aliases were resolved |
| Temporary creator | Exited before native dispatch; no task turn was sent to that creator |
| Existing blocked conversation | Idle source Companion unsubscribed; writer released after about 62 seconds; native owner snapshot confirmed |
| Plugin's automatic handoff | Dedicated real Companion broker/thread handed off through plugin logic; pending release remained visible; native ownership confirmed in about 70 seconds, before test broker cleanup |
| Fault-injected lost creation reply | Unknown state never issued a second create. A named/persisted thread was recovered using its known ID plus verified source marker, then dispatched on that same thread; exact marker completed |
| Unpersisted empty-thread boundary | An immediate lost creation reply before naming left an unreadable/unlisted thread. Recovery refused; no duplicate was created. This upstream ambiguity remains explicit |
| Installed Magpie active-thread controls | Busy dispatch rejected with `THREAD_NOT_IDLE`; follow-up accepted; stop accepted for the expected turn; final state `interrupted` |
| Native live stream | During the final control check: 2 snapshots, 5 patches, 0 revision gaps |
| Permission propagation (0.2.1) | Installed Magpie create dispatched a harmless marker task after native takeover; completion and actual runtime danger-full-access/never permissions confirmed |
| Permission correction (0.2.1) | Installed settings-only tool corrected an existing idle thread; next-turn Full Access verified without starting a task |

The follow-up test initially exposed a missing `restoreMessage.context` field. The transport was corrected, its regression assertion added, and the installed Magpie control check passed afterward.

Actual desktop ownership, execution output and stream updates were verified. This is not a screenshot/layout audit or a claim of compatibility with other desktop versions. Automated fixtures alone are not the basis for the end-to-end claims. Runtime acceptance used harmless dedicated tasks; business repositories were not edited by the test instructions.

The implementation intentionally does not promise automatic resolution of every unknown outcome. The public creation API has no request idempotency key, and empty-thread persistence/listing has gaps. Conservatively retaining uncertainty prevents duplicate work. The recovery tool requires a matching original thread; it cannot manufacture proof that a missing thread never existed.

GitHub Actions is not configured; the listed checks were run locally. The package dry run includes source and bilingual documentation, with no runtime dependencies.

## 中文

此次已完成真实的 **Claude Code → 当前运行的 Magpie HTTP MCP → Codex 桌面原生会话** 验收，不是仅用模拟接口替代。Claude 选定项目、新建会话、按原请求重试等待、读取到进行中和完成状态，并核对了预期输出。重复已接受请求返回同一会话和轮次。

两个现有项目均核对了真实项目 ID 与目录归属。截图中的旧占用会话已释放并由桌面接管；另外使用独立真实 Companion 会话验证了插件自动交接，约 70 秒完成。源端仍持有写入方时明确返回等待，没有通过删除 Codex 锁或杀共享 broker 强抢。

故障注入确认了防重复和恢复边界：已命名且持久化的原会话可经来源标记校验后恢复，继续在原会话完成任务；还未持久化的空会话如果丢回执，则保留“结果待确认”，不自动另建。上游接口没有创建幂等键，不能把这种不确定性包装成成功。

最终安装态验收中，忙碌会话拒绝第二个任务，补充指令成功，中断指定轮次成功，最终为 `interrupted`；原生流观察到 2 个快照、5 个增量，无版本序列缺口。补充指令实测暴露的恢复上下文缺失已修复并增加回归断言。

41 项自动测试在 Node 和 Magpie Bun 下全部通过。双语文档与源码包含在打包预检中。GitHub Actions 未配置，检查在本地执行。已核实桌面所有权、执行结果与实时流，但未进行截图视觉验收，也不宣称其他桌面版本兼容。

0.2.1 权限修补补充验收：通过已安装 Magpie 插件新建独立验证会话，桌面接管后指定完全访问；任务完成且实际运行权限为 `danger-full-access + never`。已有空闲会话可单独修正下一轮权限，不启动业务任务。默认继承、指定权限的回读核验、忙碌竞争、权限更新丢回执、模式冲突和旧请求兼容均有回归覆盖。这些检查不代表所有连接器或系统授权弹窗都会消失。

## Event-driven completion verification (2026-11-03)

Version 0.0.3 passed syntax checks and all 72 Node tests, including isolated socket integration, durable review, crash recovery, duplicate suppression and configuration preservation.

A live marker-only test in Claude Desktop 4.4212.0 Code, opened normally from the Dock, dispatched through the existing Magpie tools. Claude ended its first response with `DOCK_WAITING`. Native completion then woke the same idle session; Claude read the exact turn once, recorded a passed review, and displayed `DOCK_REVIEW_OK`. No user message or model polling occurred between acceptance and review. The Codex turn returned `DOCK_CODEX_OK` without tool calls or file changes.

The optional terminal Channel route was separately validated with Claude Code 2.1.309. Isolated integration tests cover offline completion and worker crash recovery. These checks do not establish real implementation review quality, physical reboot recovery, managed organization compatibility, or compatibility with every desktop version. Closed sessions recover on resume.
