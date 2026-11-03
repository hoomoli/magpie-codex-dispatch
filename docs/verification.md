# Verification / 验收记录

Local acceptance on **2026-11-03**, release **0.2.0**. No credentials, private conversations, machine paths or raw runtime logs are published here.

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
| Syntax and automated tests | `npm run check`; 31/31 tests passed under Node and Magpie's Bun |
| Installed Magpie host | Local checkout installed; 10 plugin tools loaded; plugin-specific HTTP MCP enabled for Claude through Library |
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

The follow-up test initially exposed a missing `restoreMessage.context` field. The transport was corrected, its regression assertion added, and the installed Magpie control check passed afterward.

Actual desktop ownership, execution output and stream updates were verified. This is not a screenshot/layout audit or a claim of compatibility with other desktop versions. Automated fixtures alone are not the basis for the end-to-end claims. Runtime acceptance used harmless dedicated tasks; business repositories were not edited by the test instructions.

The implementation intentionally does not promise automatic resolution of every unknown outcome. The public creation API has no request idempotency key, and empty-thread persistence/listing has gaps. Conservatively retaining uncertainty prevents duplicate work. The recovery tool requires a matching original thread; it cannot manufacture proof that a missing thread never existed.

GitHub Actions is not configured; the listed checks were run locally. The package dry run includes source and bilingual documentation, with no runtime dependencies.

## 中文

此次已完成真实的 **Claude Code → 当前运行的 Magpie HTTP MCP → Codex 桌面原生会话** 验收，不是仅用模拟接口替代。Claude 选定项目、新建会话、按原请求重试等待、读取到进行中和完成状态，并核对了预期输出。重复已接受请求返回同一会话和轮次。

两个现有项目均核对了真实项目 ID 与目录归属。截图中的旧占用会话已释放并由桌面接管；另外使用独立真实 Companion 会话验证了插件自动交接，约 70 秒完成。源端仍持有写入方时明确返回等待，没有通过删除 Codex 锁或杀共享 broker 强抢。

故障注入确认了防重复和恢复边界：已命名且持久化的原会话可经来源标记校验后恢复，继续在原会话完成任务；还未持久化的空会话如果丢回执，则保留“结果待确认”，不自动另建。上游接口没有创建幂等键，不能把这种不确定性包装成成功。

最终安装态验收中，忙碌会话拒绝第二个任务，补充指令成功，中断指定轮次成功，最终为 `interrupted`；原生流观察到 2 个快照、5 个增量，无版本序列缺口。补充指令实测暴露的恢复上下文缺失已修复并增加回归断言。

31 项自动测试在 Node 和 Magpie Bun 下全部通过。双语文档与源码包含在打包预检中。GitHub Actions 未配置，检查在本地执行。已核实桌面所有权、执行结果与实时流，但未进行截图视觉验收，也不宣称其他桌面版本兼容。
