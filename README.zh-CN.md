# magpie-codex-dispatch

当前版本：**0.0.3**，新增事件驱动的 Claude 完成通知与检查回执，并包含跨进程派发锁、崩溃恢复、安全交接重试和运行版本查询。

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
    → 创建空会话 → 临时创建进程退出 → 打开原生会话
    → 桌面 IPC：派发 / 补充指令 / 停止 / 查询
```

执行、权限、审批和实时显示都由 Codex 桌面负责。Claude 的模型供应商不必改为 Magpie 路由；接入这里的 MCP 工具即可。不增加单独看板或常驻 Codex 执行服务。创建会话、读取项目目录时会短暂启动桌面附带的公开 app-server，随后退出；该临时客户端不能执行任务轮次。已有原生会话直接通过正在运行的桌面派发。

## 安装并接入 Claude

需要 macOS、正在运行的 Codex 桌面，以及支持社区插件工具的 Magpie：

```sh
magpie plugin add github:hoomoli/magpie-codex-dispatch#v0.0.3
magpie library mcp agents magpie-codex-dispatch claude
```

本地开发安装：

```sh
git clone https://github.com/hoomoli/magpie-codex-dispatch.git
magpie plugin add ./magpie-codex-dispatch
magpie library mcp agents magpie-codex-dispatch claude
```

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
| `codex_stop` | `threadId`、`turnId`、`requestId` | 请求中断指定的进行中轮次 |

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
| `inherit`（默认） | 保留原生会话当前选定的权限；已选择完全访问时继续继承 |
| `read-only` | 只读沙箱，`on-request` 审批 |
| `ask-for-approval` | 工作区可写沙箱，`on-request` 审批 |
| `full-access` | 文件系统和网络完全访问，`never` shell 审批；必须有用户明确授权 |

用户要求特定权限的新任务，Claude 应明确传递对应模式。其他会话的权限选择不代表授权所有新任务完全访问。旧参数 `sandbox: read-only/workspace-write` 映射到对应明确模式；与 `permissionMode` 冲突时拒绝。0.2.0 默认强制工作区可写并按需审批；0.2.1 改为继承。

桌面接管后，插件对空闲会话应用明确模式，重新读取快照核验，并将指定权限带入启动请求。更新未确认或权限不符时不发送任务。仅设置临时创建进程不够，因为桌面接管可能替换权限。补充指令和停止操作不会修改权限。

修正已有空闲会话时，调用 `codex_set_permissions`，传入 `threadId`、唯一 `requestId` 和明确授权的模式，不会启动任务。`codex_status.permissions` 表示已加载运行时当前或上一轮的权限，`nextTurnPermissions` 表示下一轮设置；它们不是任意历史 `turnId` 的权限查询。只改设置、尚未开始新轮次时，两者可能不同。回执是历史确认，当前设置应重新查询状态。

如果权限已更新，但后续检查失败，设置仍会保留；重试前先查状态。检查空闲和更新设置是两个私有 IPC 调用，应避免桌面与其他客户端同时提交或改权限。完全访问控制 shell 沙箱和审批，不代表取消所有连接器授权、macOS 权限弹窗或任务澄清。

### 等待、重试和完成

1. 每个逻辑操作固定一个请求 ID，8–128 位字母、数字、下划线或连字符。
2. 新建或交接返回等待阶段时，隔约 2–5 秒重复**相同工具、参数和请求 ID**。源端卸载实测可能需要约一分钟。
3. `phase: accepted` 后保存 `threadId` 和 `turnId`，使用两者查询 `codex_status`。已接受不等于已完成。
4. 分别处理进行中、完成、失败、中断、未知历史和待审批。审批在原生桌面处理。
5. 提交后丢回执会保留 `OUTCOME_UNKNOWN` / `dispatch_unknown`，不自动重发；先检查状态，不能换 ID 盲目再发一次。

状态文件保存哈希、ID、项目/目录和阶段，不保存提示词或对话输出。插件重启后，相同已接受请求仍返回原回执。创建请求丢回执时，会通过唯一来源标记进行有界的元数据查找；最多列出 1,000 条、读取 30 条缺失标记的候选记录。

**上游限制：** 刚创建的空会话可能不出现在列表，甚至尚未持久化。无法核实时保持 `creation_unknown`，不重复创建。若已掌握原会话 ID，可调用 `codex_recover_creation`；只有来源标记、项目和目录都匹配才绑定，然后重新调用原创建请求。如果原会话无法读取，恢复也会拒绝，不能把缺失当作失败后自动重建。

流程靠重试调用推进，没有后台重试守护进程。`codex_operation_status` 是历史进度，不能代替实时所有权或执行状态。请保留回执文件，删除会失去防重放保护。只有已核实的 Companion broker 明确在转发前拒绝时，才记录 `release_rejected`，允许按原请求重新检查源端并再次释放。超时、断连和含义不明的 RPC 错误仍保留释放意图，不自动重复取消订阅。

原生命令在读取桌面状态前取得会话级内核锁，一直持有到提交和保存回执完成；创建与交接进度另有请求级内核锁。所有插件实例必须共用同一状态目录。争用返回 `BUSY` / `OPERATION_BUSY`，不会后台排队。文件描述符关闭或进程退出（包括崩溃）后，由 macOS 释放锁。请保留 `.mutex` 文件；文件存在不代表锁被占用。绝不修改 Codex 写锁文件。

从旧目录锁版本升级时，先停止旧插件宿主，再加载新版本。已退出进程留下的 `.lock` 和 `.recovery` 目录保留供检查，不再阻塞流程；仍存活或记录不完整的旧持有方不会被绕过。这些锁只协调共用状态目录的插件调用，不能阻止桌面界面或绕过插件的其他客户端并发操作。

## 控制权边界

- 一个会话只有一个写入方。正常 Claude ↔ Codex 对话走桌面跟随接口，不需要每轮互相释放写锁。
- 旧会话交接支持当前用户的本地 Codex Companion broker。插件核实写入进程的父 broker、socket 和握手，检查目标空闲后只取消订阅该会话。运行中或未知写入方不会被强抢。
- 源端确认释放还不够，必须等待实际卸载，再取得原生所有者快照。不会删除 Codex 锁、杀共享 broker、关闭无关会话或自动中断运行中的任务。
- Claude 负责在交接前停止源端继续提交。上游没有“仅空闲时释放”的原子参数，违反协作约定仍可能发生竞争。插件不提供任意桌面到 CLI 的反向写入方迁移；双向交互都使用桌面原生所有者。
- 通过 `codex://threads/<id>` 打开会话，可能切换到前台；不使用辅助功能自动化。桌面若保留旧占用画面，可释放后切换会话再打开，或点“重试”。
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
