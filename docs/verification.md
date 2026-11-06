> Release numbering starts at **0.0.1**. Versions 0.2.x below are historical local development labels, not published releases. The initial release includes those verified changes; historical runtime observations retain their original version strings.

# Verification / 验收记录

## Version 0.0.8 (2026-11-06)

- Publication was explicitly authorized by the owner despite the release acceptance gate remaining **CLOSED**. The owner chose to proceed with 0.0.8 and accepted the unresolved findings from release run `release-nqBQg0`; this is a release exception, not a passing acceptance result. Historical version records and gate results remain unchanged.
- Known unresolved issues: M06's hook reports a generic integration-repair instruction when a reused requestId changes its prompt, rather than exposing `REQUEST_ID_CONFLICT`; M12's idle background-thread `set_permissions` can become permanently `OUTCOME_UNKNOWN`; preflight-rejected dispatch/followup notifications remain `awaiting_receipt`; post-archive sidebar refresh has not been manually confirmed for this release run.
- N02–N04 and M13 remain incomplete. M06 and M12 failed. Automated checks do not substitute for these live acceptance cases.
- Reported live passes in that run: background creation, dispatch, followup, stop and busy rejection; native idle-session wakeup; the original background owner remained retained more than 700 seconds after completion, then `codex_archive` succeeded with `route:background-owner` and the owning processes were released. This release task records those supplied observations without claiming a new live acceptance run or UI confirmation.
- Earlier publication attempt stopped before commit/tag/push: `npm run check` exited 0; `npm test` exited 1 (92 tests, 80 passed, 12 failed; Unix socket listeners were denied with `listen EPERM` in the execution sandbox). The remaining three required checks were not run, as requested on failure. No release was published.
- Final local release checks on 2026-11-06: `npm run check`, `npm test` (120 passed, zero failed/skipped), `git diff --check`, `node scripts/verify-lifecycle.mjs`, `node scripts/verify-retained-owner.mjs`, and `npm pack --dry-run` all passed. The real-server scripts used isolated temporary state without model turns or existing user chats. The earlier Unix socket sandbox failure did not recur. These results do not open the full acceptance gate.
- Release scope: retained background owners, authenticated original-owner archival and explicit idle handoff; stored-history status; lifecycle regression tests and maintained acceptance tooling. Permanent deletion and direct desktop-held archival remain unsupported. Private transcripts, fixture identities and evidence stay outside the release.

发布例外：所有者明确接受 `release-nqBQg0` 的未解决问题，选择照常发布 0.0.8；发布验收门禁仍为 **CLOSED**。M06 的 hook 将复用 requestId 修改 prompt 的冲突显示为集成修复提示，而非 `REQUEST_ID_CONFLICT`；M12 的空闲后台线程权限设置可永久停留 `OUTCOME_UNKNOWN`；预检拒绝的 dispatch/followup 通知仍为 `awaiting_receipt`；本轮归档后侧栏刷新未经人工确认。N02–N04、M13 未完成。该轮已实测后台创建、派发、followup、stop、忙碌拒绝及原生空闲唤醒；原后台 owner 在完成 700 秒以上仍保留，之后通过 `route:background-owner` 归档成功并释放进程。本次仅如实记录已提供的实测结果，不将本地检查或历史界面观察算作新的完整验收通过。

## Version 0.0.8-local.5 retained-owner lifecycle (2026-11-06, unpublished)

- Added private authenticated control routing to the original background owner; idle archive is serialized with follower mutations and durably journaled. ACK precedes genuine archive notifications and connection/socket/slot release.
- Replaced the completion shutdown timer with explicit archive/handoff retention and eight-owner admission per state root. Plugin reload reconnects to retained owners; crashes and desktop takeover are not automatically recovered.
- Added fault, concurrency, replay, pending-input, rejection, notification failure and admission checks, plus a real isolated-backend lifecycle verification script. Full Claude and native UI acceptance remain separate gates. No publication is authorized.
- Updated acceptance to `archive-retained-owner-v2`; historical deletion/writerless reports cannot substitute for a new actual Claude retained-owner archive.
- Installed-plugin checkpoint passed through actual Magpie calls: retained original background ownership beyond 60 seconds/across caller reload, owner-routed archive ACK, post-ACK notification, independent archived/history/resource checks, and user confirmation “已自动消失”. Both local API/UI fixtures are archived. This is Codex-through-Magpie evidence; fresh genuine Claude/full acceptance remains required. See [implementation and validation procedure](background-owned-thread-lifecycle.md).

## Version 0.0.8-local.4 native audit and scope reduction (2026-11-05, unpublished)

- Final independent native-pipe probe used Magpie's Bun 1.4.4 executable and only `tools/list`; the matching desktop log recorded `untrusted-code-signing-identity`. A second read-only probe inside the actual Magpie plugin host received `EPIPE`, with a matching `untrusted-process-ancestry` rejection on the current desktop socket. The temporary diagnostic tool was removed. Fresh packaged follower/schema inspection found no independently callable archive or release request. No mutation, impersonation or authorization bypass was attempted.
- Reduced the public catalog to 13 tools: only unattached persisted-thread archival remains. Held roots/descendants return `owner_action_required` without submission or timed retry advice. Permanent deletion is removed from the catalog and RPC mutation allowlist; historical deletion receipts remain readable but retired.
- Updated the acceptance contract to `archive-unattached-v1`. At least one actual Claude-to-Magpie archive remains mandatory. Manual native archive of unsupported held fixtures is explicitly separate, needs operator/boundary evidence and cannot replace integration success. Any active/unknown residual fixture still blocks cleanup.
- A subsequent installed-plugin check found four previously authorized residual QA chats naturally writerless. Codex called the actual Magpie `codex_archive` tool for all four; each returned server acknowledgment. Independent active/archived listings confirmed all four archived, history stayed readable, and a same-ID replay returned the historical receipt. This is live Codex-through-Magpie evidence, not a fresh Claude run or a desktop-held archive test. Sidebar appearance was not observed.
- Earlier failed release runs remain unchanged. This scope decision does not resolve the open permission, hook-conflict or native-notification findings and does not authorize a release.

## Version 0.0.8-local.3 withdrawal (2026-11-05, unpublished)

- Removed the shared-owner control transport, dependency, dedicated tests and startup helper from the local plugin. It cannot guarantee shared ownership across ordinary desktop restarts and is not an accepted solution.
- Retained earlier stored-history status fixes, loaded-plugin identity, maintained acceptance framework, and the real independent-server boundary probe.
- The unused experiment-only daemon was stopped after checking that it had no loaded threads and differed from the desktop writer. No desktop restart or global startup-environment change was performed.
- Local `0.0.8-local.2` did pass isolated same-backend deletion/native-notification checks, but real desktop-held deletion/sidebar acceptance was never completed. Preserve that as historical protocol evidence only; it does not open any release gate.
- Maintain verified app-server/IPC capabilities and rejected approaches in [the capability record](app-server-capabilities.md).

## Version 0.0.8-local.1 unloaded status (2026-11-05, unpublished)

- Reproduced desktop owner-discovery timeout for persisted `notLoaded` threads with no writer, while initialization and loaded-thread snapshots responded normally. Unloaded status now bypasses owner discovery and reads persisted history without resume or mutations.
- Isolated real AppServer check created/named an empty persisted thread, exited its writer, and read status successfully: `historyOnly: true`, `runtimeStatus: notLoaded`, `status: unknown`, no turns. Existing user threads were not modified.
- Regression coverage includes exact-turn pagination, missing/empty history, stale in-progress history, output bounds, bounded history traversal, writer attachment during reads, and propagation of unavailable history without substituting stale completion results.

## Version 0.0.7 lifecycle diagnostics (2026-11-05)

- An isolated test with two real bundled Codex 0.166.0 AppServers confirms that an idle writer still prevents a second server from archiving/deleting its thread (`-32600`, active-writer rejection). Desktop follower IPC inspected in the installed version exposes no lifecycle mutation command. Immediate mutation of a desktop-loaded idle thread is **not implemented**.
- `node scripts/verify-lifecycle.mjs` passes in a temporary isolated `CODEX_HOME`: actual writer detection returns a waiting receipt; after the owning server exits, the same request ID archives the thread; deletion succeeds; active/archived listings exclude it; a subsequent read classifies as `THREAD_UNAVAILABLE`. Only the owner snapshot transport is substituted in this test. No model turn or existing user conversation is used, and this is not a real desktop sidebar refresh acceptance.
- Regression coverage distinguishes idle/unconfirmed writers, active roots/descendants, pending approvals, durable preflight failure diagnostics, progression after unload, and safe RPC method/code classification without raw error payloads. Submitted unknown outcomes retain their no-resend behavior.

## Version 0.0.6 lifecycle tools (2026-11-05, local)

- The bundled Codex 0.166.0 experimental JSON schema includes `thread/archive` and `thread/delete`. The [official AppServer documentation](https://learn.chatgpt.com/docs/app-server) confirms descendant cascading and permanent deletion semantics.
- In a temporary isolated `CODEX_HOME`, created and named a persisted empty thread without starting a model turn, then invoked the actual plugin lifecycle executor to archive it and delete the archived thread. Both real AppServer calls acknowledged success. The thread was absent from both active and archived listings afterward. No user thread was modified.
- Unit coverage includes persisted receipts, replay after restart, request conflicts, writer refusal on root/descendants, and lost-reply suppression. Desktop sidebar refresh, installed Magpie reload, and real Claude invocation remain unverified for these new tools.

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
