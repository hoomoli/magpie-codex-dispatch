# magpie-codex-dispatch

当前发布版本：**0.0.9**。新任务后台执行、普通侧栏刷新、不置顶不跳转，完成后通过已有事件钩子唤醒 Claude。

桌面持有的空闲会话还可采用已本地验证的[原生归档中转流程](docs/native-archive-bridge.md)：插件创建准备会话，确认桌面接管后再派发清单，由该会话调用官方原生归档工具。无需共用后端、特殊启动或重启桌面。这是现有工具的编排方式，尚非自动归档回退或永久删除能力，完整发布验收仍未通过。

发布验收门禁仍为 **CLOSED**；所有者已明确接受未解决问题并授权发布；必需本地检查均已通过。详见 [0.0.9 发布记录](docs/verification.md)。

显示名称固定为 `magpie-codex-dispatch`，版本使用 Magpie 独立的版本徽标。本地目录安装不显示该徽标，可用 `codex_plugin_info` 核实运行版本；Git 安装还会显示由 Magpie 管理的提交标识。

要确认 Magpie 实际加载了哪个版本，让 Claude 调用 `codex_plugin_info`，或运行：

```sh
magpie tool magpie-codex-dispatch_codex_plugin_info --json
```

返回的 `pluginVersion` 和 `loadedAt`（模块加载时间）在加载时固定；仅修改磁盘文件，不会让旧宿主假报新版。所有成功的工具结果也包含当前宿主的 `pluginVersion`，重放回执亦如此，不改变原回执身份。更新后重载插件，再查询确认。此版本号用于本地代码；Git 标签和包发布属于独立的发布步骤。

[English](README.md) · [控制权规范](docs/ownership.md) · [验收记录](docs/verification.md)

**中文：** 通过 Magpie 新建指定项目的 Codex 会话、安全交接空闲会话，并在 Codex 桌面应用原生对话中实时执行任务。

**English:** A Magpie plugin for creating project-specific Codex conversations, handing off idle Companion sessions, and dispatching tasks with live execution in the native Codex desktop app.

```text
Claude / 其他 MCP 客户端
  → 已有 Magpie MCP 网关和插件宿主
    → 后台创建会话并取得执行权 → 自动执行
    → 普通侧栏刷新 → 桌面跟随进度 / 审批 / 停止 → 完成事件唤醒 Claude
```

新任务由独立后台进程调用桌面自带的 AppServer 执行，桌面通过跟随协议显示进度并转发审批和停止操作。Claude 无需轮询，也无需手动打开会话来启动任务。已有原生会话派发与明确请求的 Companion 交接仍沿用旧路径。

## 安装并接入 Claude

需要 macOS、正在运行的 Codex 桌面，以及支持社区插件工具的 Magpie：

```sh
magpie plugin add github:hoomoli/magpie-codex-dispatch
magpie library mcp agents magpie-codex-dispatch claude
```

本地开发安装：

```sh
git clone https://github.com/hoomoli/magpie-codex-dispatch.git
magpie plugin add ./magpie-codex-dispatch
magpie library mcp agents magpie-codex-dispatch claude
```

本地调试时，先停用原 Git 安装，再添加本仓库的绝对路径，确认加载成功后移除原 Git 条目，避免重复工具：

```sh
magpie plugin off 'github:hoomoli/magpie-codex-dispatch#main'
magpie plugin add /absolute/path/to/magpie-codex-dispatch
magpie tool magpie-codex-dispatch_codex_plugin_info --json
```

检查返回的 `moduleUrl` 指向本仓库，版本为 `0.0.8-local.1`。本地文件修改后仍须停用/启用插件以重载宿主，再查询 `loadedAt`；不以磁盘版本或界面缓存判断生效。原 Git 来源名称以本机安装记录为准。

状态查询：无写入方时通过只读 AppServer 查询持久化历史，不恢复会话、不等待桌面所有者；返回 `source: persisted-history`、`historyOnly: true`、`runtimeStatus: notLoaded`。历史完成不代表实时运行状态；空历史或找不到指定轮次返回 `status: unknown`。指定旧轮次最多检查 200 轮，超过范围标记 `historyTruncated`。读取期间出现新写入方则改查桌面实时状态。`codex_ownership` 的无写入方结果只表示未挂载，不证明会话存在或已删除。

Magpie 会把此插件的 HTTP MCP 配置写入 Claude。新开 Claude 会话加载工具。Library 接入与手动配置 MCP 二选一，避免重复工具；地址、端口及认证以本机 Magpie 的 Installed/Library 页面为准。无需改变 Claude 模型配置。

可以对 Claude 说：

> 使用 Magpie Codex 工具，在 `my-project` 项目中新建任务。先查询项目；对待完成的派发保持相同 requestId 和参数重试。接受后使用返回的 threadId 和 turnId 查询完成情况。任务内容：……

如果是旧 openai-codex / Companion 会话，先停止通过旧集成向该会话提交，再检查所有权并交接，等到 `desktop_owned` 后使用本插件继续交互。

## 工具

插件专属 MCP 直接暴露下列名称；组合入口通常添加 `magpie-codex-dispatch_` 前缀，以 `tools/list` 为准。

| 工具 | 主要参数 | 作用 |
| --- | --- | --- |
| `codex_projects` | 无 | 列出真实项目 ID、名称和目录 |
| `codex_create_task` | `requestId`、`prompt`、项目或目录选择 | 新建、接管、派发，可返回等待状态 |
| `codex_ownership` | `threadId` | 检查桌面或外部写入方，不释放锁 |
| `codex_handoff` | `threadId`、`requestId`，可选 `sourceEndpoint` | 释放一个空闲 Companion 会话并等桌面接管 |
| `codex_recover_creation` | `requestId`、`threadId` | 校验唯一来源标记、项目和目录，恢复待确认创建；不派发 |
| `codex_operation_status` | `requestId` | 只读持久化进度，不推进流程 |
| `codex_set_permissions` | `threadId`、`requestId`、明确的 `permissionMode` | 修改并核验空闲会话的下一轮权限，不启动任务 |
| `codex_status` | `threadId`，可选 `turnId` | 获取实时状态及最多 16,000 字符的助手输出 |
| `codex_dispatch` | `threadId`、`prompt`、`requestId` | 在空闲原生会话开始下一轮 |
| `codex_followup` | 再加 `turnId` | 向进行中的轮次补充指令 |
| `codex_archive` | `threadId`、`requestId` | 归档目标并尝试归档派生子会话；区分运行中和等待所有者卸载 |
| `codex_stop` | `threadId`、`turnId`、`requestId` | 请求中断指定的进行中轮次 |

### 归档的支持范围

- `codex_archive` 支持由**核实过的原插件后台 owner**归档自己持有的空闲会话，也支持目标及已发现子会话均无写入方的持久化会话。归档请求通过插件私有通道送回原持有连接；持锁子会话仍拒绝。发现运行或待审批/输入状态返回 `THREAD_ACTIVE`。详见[后台持有与归档流程](docs/background-owned-thread-lifecycle.md)。
- 其他持锁情况返回 `completed: false`、`submitted: false`、`phase: owner_action_required`、`automaticRetry: false`，要求在所属桌面/客户端归档。停止自动重试；只有确认写入方自然释放后，才可用原归档 requestId 重试。不要求重启，不强抢锁。
- `completed: true` 与 `serverAcknowledged: true` 仅表示服务端确认；需独立核对活动/归档列表。子会话通知可能不完整，不承诺侧栏立即刷新；无法读取不等于清理成功。
- 归档预检失败仍保存阶段和安全错误信息；丢失变更回执保留 `outcome_unknown`，即使原 requestId 重试也不会再次发送，先查询 `codex_operation_status` 并核对实际状态。
- **永久删除工具 `codex_delete` 已移除**，不会暗中改成归档。旧删除回执仍可由 `codex_operation_status` 查询，标记 `retired: true`，不再提示重试。新的归档操作必须使用不同的 requestId；旧变更结果不明时先核实，不盲目另发。
- 最终核查中，原生工具管道以 `untrusted-code-signing-identity` 拒绝了 Magpie 的 Bun 客户端；follower IPC 也没有归档/释放请求。当前版本没有找到符合正常启动要求的独立入口。插件不会冒充官方调用方，也不再使用共用后端。详见[能力与最终核查记录](docs/app-server-capabilities.md)。

### 新建指定项目的会话

```json
{
  "requestId": "example-task-0001",
  "projectName": "my-project",
  "title": "Example task",
  "permissionMode": "read-only",
  "prompt": "Reply exactly OK. Do not use tools or modify files."
}
```

使用 `codex_projects` 返回的唯一 `projectName` 或真实 `projectId`。桌面界面的项目 ID 可能与后端不同，不能混用。项目只有一个根目录时自动选取；多个根目录必须提供位于其范围内的 `cwd`。只提供明确的绝对 `cwd`，则创建不归属项目的会话；不会默认塞进当前项目。目录会解析真实路径再检查归属。这里创建的是**会话，不是新项目**。

`title` 最多 160 字符，不填则用 `Magpie task`，确保空会话写入名称。创建结果和桌面目录经过核实后才派发。

### 权限模式

`codex_create_task` 和 `codex_dispatch` 支持 `permissionMode`：

| 模式 | 行为 |
| --- | --- |
| `inherit`（默认） | 已有会话保留当前设置；新建后台任务沿用后端默认值，不复制其他桌面会话的权限 |
| `read-only` | 只读沙箱，`on-request` 审批 |
| `ask-for-approval` | 工作区可写沙箱，`on-request` 审批 |
| `auto-review` | 工作区可写沙箱，`on-request` 审批由 Codex `auto_review` 审核；符合条件的请求可能获批或被拒绝 |
| `full-access` | 文件系统和网络完全访问，`never` shell 审批；必须有用户明确授权 |

用户要求特定权限的新任务，Claude 应明确传递对应模式。其他会话的权限选择不代表授权所有新任务完全访问。旧参数 `sandbox: read-only/workspace-write` 映射到对应明确模式；与 `permissionMode` 冲突时拒绝。0.2.0 默认强制工作区可写并按需审批；0.2.1 改为继承。

新任务在后台核验实际生效权限后执行；默认继承后端配置，不自动提升为完全访问。原生已有会话的权限变更仍通过其所有者应用并重新读取验证。

修正已有空闲会话时，调用 `codex_set_permissions`，传入 `threadId`、唯一 `requestId` 和明确授权的模式，不会启动任务。`codex_status.permissions` 表示已加载运行时当前或上一轮的权限，`nextTurnPermissions` 表示下一轮设置；它们不是任意历史 `turnId` 的权限查询。只改设置、尚未开始新轮次时，两者可能不同。回执是历史确认，当前设置应重新查询状态。

如果权限已更新，但后续检查失败，设置仍会保留；重试前先查状态。检查空闲和更新设置是两个私有 IPC 调用，应避免桌面与其他客户端同时提交或改权限。完全访问控制 shell 沙箱和审批，不代表取消所有连接器授权、macOS 权限弹窗或任务澄清。

### 等待、重试和完成

1. 每个逻辑操作固定一个请求 ID，8–128 位字母、数字、下划线或连字符。
2. 新建或交接返回等待阶段时，隔约 2–5 秒重复**相同工具、参数和请求 ID**。源端卸载实测可能需要约一分钟。
3. `phase: accepted` 后保存 `threadId` 和 `turnId`。安装完成钩子后等待事件自动唤醒，不轮询；`codex_status` 用于诊断或按需查询。已接受不等于已完成。
4. 分别处理进行中、完成、失败、中断、未知历史和待审批。审批在原生桌面处理。
5. 提交后丢回执会保留 `OUTCOME_UNKNOWN` / `dispatch_unknown`，不自动重发；先检查状态，不能换 ID 盲目再发一次。

操作回执保存哈希、ID、项目/目录和阶段。后台执行器另存私有终态输出摘要用于迟到通知恢复；私有输入文件读取后删除。以下创建恢复规则针对旧版原生创建流程。插件重启后，相同已接受请求仍返回原回执。创建请求丢回执时，会通过唯一来源标记进行有界的元数据查找；最多列出 1,000 条、读取 30 条缺失标记的候选记录。

**上游限制：** 刚创建的空会话可能不出现在列表，甚至尚未持久化。无法核实时保持 `creation_unknown`，不重复创建。若已掌握原会话 ID，可调用 `codex_recover_creation`；只有来源标记、项目和目录都匹配才绑定，然后重新调用原创建请求。如果原会话无法读取，恢复也会拒绝，不能把缺失当作失败后自动重建。

流程靠重试调用推进，没有后台重试守护进程。`codex_operation_status` 是历史进度，不能代替实时所有权或执行状态。请保留回执文件，删除会失去防重放保护。只有已核实的 Companion broker 明确在转发前拒绝时，才记录 `release_rejected`，允许按原请求重新检查源端并再次释放。超时、断连和含义不明的 RPC 错误仍保留释放意图，不自动重复取消订阅。

原生命令在读取桌面状态前取得会话级内核锁，一直持有到提交和保存回执完成；创建与交接进度另有请求级内核锁。所有插件实例必须共用同一状态目录。争用返回 `BUSY` / `OPERATION_BUSY`，不会后台排队。文件描述符关闭或进程退出（包括崩溃）后，由 macOS 释放锁。请保留 `.mutex` 文件；文件存在不代表锁被占用。绝不修改 Codex 写锁文件。

从旧目录锁版本升级时，先停止旧插件宿主，再加载新版本。已退出进程留下的 `.lock` 和 `.recovery` 目录保留供检查，不再阻塞流程；仍存活或记录不完整的旧持有方不会被绕过。这些锁只协调共用状态目录的插件调用，不能阻止桌面界面或绕过插件的其他客户端并发操作。


## 控制权边界

- 一个会话只有一个写入方。正常 Claude ↔ Codex 对话走桌面跟随接口，不需要每轮互相释放写锁。
- 旧会话交接支持当前用户的本地 Codex Companion broker。插件核实写入进程的父 broker、socket 和握手，检查目标空闲后只取消订阅该会话。运行中或未知写入方不会被强抢。
- 源端确认释放还不够，必须等待实际卸载，再取得原生所有者快照。不会删除 Codex 锁、杀共享 broker、关闭无关会话或自动中断运行中的任务。
- Claude 负责在交接前停止源端继续提交。上游没有“仅空闲时释放”的原子参数，违反协作约定仍可能发生竞争。插件不提供任意桌面到 CLI 的反向写入方迁移；双向交互都使用桌面原生所有者。
- 新建任务不调用打开链接、不置顶、不切换当前页面。明确请求的旧 Companion 交接仍可能打开目标会话。
- 补充指令发送前检查轮次，但私有 steer 协议没有原子轮次保护，应避免与界面切换轮次并发。停止接口有 `expectedTurnId` 保护，仍需查询最终状态。
- 调用方取消等待不会自动中断已接受任务。每次工具调用有 45 秒期限，通信及临时进程清理均有超时边界。

完整规范见 [ownership.md](docs/ownership.md)。

## 兼容性与配置

这是 **macOS 实验性集成**，同时使用公开 [Codex App Server API](https://learn.chatgpt.com/docs/app-server) 和**私有桌面 IPC**。桌面升级可能导致不兼容；不支持的流协议版本在派发前拒绝。不宣称 Windows/Linux 桌面支持。

以下环境变量设置在 **Magpie 插件宿主**，仅在 Claude 中设置无效：

| 变量 | 默认值 |
| --- | --- |
| `MAGPIE_CODEX_SOCKET` | `~/.codex/ipc/ipc.sock` |
| `MAGPIE_CODEX_STATE_DIR` | `~/.local/state/magpie-codex-dispatch` |
| `MAGPIE_CODEX_BINARY` | 桌面自带 Codex CLI；覆盖值必须是绝对可执行路径 |
| `CODEX_HOME` | 公开客户端和写入方检查默认用 `~/.codex`；非标准桌面目录还需设置 socket |

socket 必须属于当前用户。状态目录权限为 `0700`、文件为 `0600`。插件不直接读取凭证、不改写 Codex 会话存储；桌面自带 app-server 使用现有登录配置。获得 MCP 权限即可派发本地任务和读取助手输出，应通过 Magpie 限定可信客户端。提示词上限 64 KiB，协议帧上限 32 MiB，错误信息不输出内部原始载荷。

## Claude 接通测试与发布验收

新接入的 Claude Code 在本仓库运行：

```sh
npm run acceptance:connect -- --prepare --current-session
```

然后让当前 Claude 读取命令输出目录中的 `brief.txt` 并执行。发布前使用 `acceptance:release` 准备完整验收，并通过 `acceptance:release:check` 独立校验。接通通过只证明基本创建、查询、通知链路，不能代替完整发布验收。任何失败、阻塞、缺失证据或源码变化都不能放行发布。

完整入口和步骤见 [验收说明](docs/acceptance/README.md) 与 [完整测试矩阵](docs/acceptance/claude-release-gate.md)。

## 开发与验证

无需构建。运行依赖已固定在 package-lock.json：MCP SDK 用于 Claude Channel，Immer 用于桌面状态增量。本地目录安装先运行 npm ci；Channel 使用 Node 22+，Magpie 工具使用自带 Bun。文件锁依赖 macOS 系统自带的 `/usr/bin/lockf` 及其继承文件描述符能力；工具不可用时会在提交前报错。

```sh
npm run check
npm test
npm pack --dry-run
npm run probe -- <thread-uuid>
```

只读 probe 不打印对话正文。自动测试使用临时 socket 和状态目录，覆盖路由、忙碌状态、取消、协议异常、丢回执、项目检查及防重复。真实链路及兼容性边界见 [验收记录](docs/verification.md)。

接口参考：[Magpie plugin tools v0.1.2785](https://github.com/yetone/magpie/blob/v0.1.2785/docs/subsystems/plugin-tools.md)。独立实现，不包含桌面应用私有源码。[MIT 许可](LICENSE)。

## 自动回传 Claude 检查

从 Dock 打开的 Claude Desktop Code：在本仓库运行一次 `node src/install-desktop.js`，加载新会话或恢复会话后，继续通过现有 Magpie 工具派发。原生异步 Hook 自动绑定当前会话，在 Codex 完成后唤醒 Claude 检查，无需模型轮询、专门启动命令或 Channel 参数。详见[桌面配置与恢复](docs/desktop-notifications.md)。终端使用的 [Channel 启动器](docs/channels.md) 仍作为可选方案保留。

## 后台执行生命周期

为刷新普通侧栏，插件仅对自己刚创建、尚未执行的空会话做一次真实归档与恢复，后台恢复并启动任务后转发该恢复事件。不会归档已有任务，不会强抢写锁。

桌面断线时后台任务继续，连接按退避重试，不重新派发。任务完成后保存私有终态摘要，继续保留原 owner，直到明确调用 `codex_archive` 或空闲交接 `codex_handoff`。每个状态目录最多保留 8 个后台 owner，超限时在新建会话前拒绝。归档收到真实 ACK 后才通知桌面并释放连接、控制 socket 和容量。插件重载不终止这些独立后台；后台崩溃后不会自动重建或抢回 owner，仍可按准确会话和轮次读取已保存结果。旧 Claude Pre/PostToolUse 与 asyncRewake 回传链路继续使用，不需要换启动入口。

后台进程异常退出不会自动重跑。未知审批请求明确报错，不自动批准。旧版未完成的创建请求不能自动迁移，以免重复执行。私有桌面协议受应用版本影响；本版完整快照超过 32 MiB 时不能继续实时推送，不会因此重复派发任务。
