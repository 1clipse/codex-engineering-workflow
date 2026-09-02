# Codex Engineering Workflow

一个以 JSON 为权威、可适配多个 Coding Agent 的完整工程交付工作流：从需求路由、澄清、规格、执行和评审，一直管理到证据闭环、权限确认与可恢复关闭。

它不是传统 Plan Mode 的替代品，而是将短期计划、长期计划树、具体工程流程和事务控制组合成一条可验证的交付链路。Codex 是原始宿主，但核心状态、门禁和 MCP 控制器不依赖 Codex。

## 工作流总览

下面是当前流程的交付概览，展示从需求路由到终态门禁、授权和恢复的完整路径。v3 将这个图背后的路线、状态机和门禁收敛到可校验 JSON，而不是长提示词。

[![Engineering Workflow 2.0 交付流程](assets/engineering-workflow-v2-flowchart.visual-check.1440x900.light.png)](assets/engineering-workflow-v2-flowchart.html)

点击流程图可打开可交互版本，支持浅色/深色主题、路径查看和导出。

## 核心能力

- 自动判断直接实现、常规交付、复杂决策、UI/UX 和纯计划维护路线。
- 读取并应用 Ask Matt 的 procedure manual，完成澄清、spec、tickets、goal、TDD 和 review 等阶段。
- 以 Plan Tree 作为唯一持久业务权威，保存范围、决策、阶段、证据与恢复点。
- 通过 Delivery Control MCP 管理事务、CAS revision、strict lease、崩溃恢复、受控状态块漂移检测和精确授权。
- 以结构化 evidence、terminal observation、Review disposition 和 terminal condition 作为完成门禁，阶段完成不等于交付完成。
- 对 commit、push、PR、merge、deploy、生产操作和外部通信采用精确、短期、单次授权。
- 通过 7 个高层入口隐藏普通流程中的 CAS、lease、journal、固定点和 evidence 事务细节。
- required phase 由统一策略控制：`spec` 只有在批准的 imported spec 下可跳过，`execute`/`review` 不可静默绕过；scope rework 会复用历史已完成阶段。
- 每次 scope revision 都创建新的 `delivery_generation` 和 fixed point；旧 spec、实现、Review 与 evidence 继续可审计，但不能关闭新一代交付。
- Review finding 按 ID 追加或更新，不能通过空列表清除；P0/P1 必须 `fixed` 且有 `reverified_by` 才能关闭。
- 授权同时保留外部动作 digest 与控制器 mutation digest，旧 SQLite schema 会自动迁移，事务备份保存在专用目录并限制保留数量。
- 外部动作把“已授权”和“已成功”分开验证：每次授权只允许一个结果，失败重试必须重新授权，并以本地回执 artifact/digest 证明结果。
- 路线策略、运行时枚举、JSON Schema、适配器能力和 workflow 引用由一个 canonical policy 生成，并由 drift check 阻止副本分叉。
- 每个 flow 固定 `policy_id`、版本和 digest；升级只能显式迁移，不能静默用新版规则重解释旧交付。
- 工作流规则不再由长篇 Skill 提示词承载：canonical JSON 定义路线、状态机、权限、证据、终态门禁和宿主能力；各 Agent 文件只负责加载 JSON、理解用户语义并连接控制器。
- `standard` 用于普通工程交付；声明了外部动作、多 Agent/多宿主、发布、生产或受监管风险时自动升级到 `strict`，不能静默降级。
- Codex 原生 Plan/Goal 和生命周期 Hook 都是可选会话辅助，不是关闭门禁，也不构成宿主级安全沙箱。

## 组件关系

| 组件 | 职责 |
| --- | --- |
| `engineering-workflow` | 薄入口；理解需求、选择 JSON 路线并协调交付 |
| [Ask Matt](https://github.com/tt-a1i/matt-skills-with-to-goal) | 提供具体工程 procedure manuals |
| [Plan Tree](https://github.com/SeemSeam/plan-tree) | 持久计划、范围、决策、状态、问题与证据的权威来源 |
| `delivery-control` | 本地策略执行、事务、恢复、证据、授权和指标控制 |
| Product Design | 可选；处理 UI/UX 设计与设计 QA |

## Agent 兼容性

| Agent | 支持级别 | 方式 |
| --- | --- | --- |
| Codex | 原生 | Skill、Plugin 与 MCP；原生 Plan/Goal 只作会话辅助 |
| Claude Code | 原生 MCP | `.mcp.json` 片段与薄 Skill 入口 |
| OpenCode | 原生 MCP | `opencode.json` 片段与 Command 入口 |
| Pi | 本地 Bridge | Pi Skill + TypeScript stdio MCP bridge |
| DSH / DeepSeek Harness | 原生 MCP | `cordis.yml` 片段 |
| ZCode | 需探测 | 先检测 MCP/ACP/Plugin 能力；未确认前仅使用共享 Plan Tree 与 JSON |

详细安装和能力边界见 [adapters/README.md](adapters/README.md)。不会为未确认的宿主伪造 native Plan、MCP 或插件支持。

## 要求

- Codex、Claude Code、OpenCode、Pi、DSH，或其他支持本地 stdio MCP 的 Agent
- [Ask Matt](https://github.com/tt-a1i/matt-skills-with-to-goal)
- [Plan Tree](https://github.com/SeemSeam/plan-tree) `>= 0.4.0`
- Node.js 24（用于构建和运行 `delivery-control`）
- PowerShell 5 或 7（用于 workflow 验证脚本）
- Product Design（可选，只有 UI/UX 路线需要）

## 安装

### 1. 安装依赖 Skills

请先按各自仓库的说明安装 Ask Matt 与 Plan Tree。本仓库不复制或重新分发这两个项目。

### 2. 安装 Codex 适配器

将 `skills/engineering-workflow` 复制到 Codex 的个人 Skills 目录：

```powershell
Copy-Item -Recurse -Force .\skills\engineering-workflow "$env:USERPROFILE\.codex\skills\engineering-workflow"
```

### 3. 构建 Delivery Control

```powershell
Set-Location .\plugins\delivery-control
npm ci
npm run check
Set-Location ..\..
codex plugin marketplace add 1clipse/codex-engineering-workflow
codex plugin add delivery-control@codex-engineering-workflow
```

不同 Codex CLI 版本的插件命令可能略有差异，请以当前 Codex 插件文档和 `codex plugin --help` 为准。安装或升级插件后，新建一个 Codex 任务以加载新的 Skill 和 MCP 工具。

### 4. 安装其他 Agent 适配器

先构建完成 `delivery-control`，再生成一个不覆盖现有配置的本地片段：

```powershell
./adapters/install-adapter.ps1 -Host claude-code
./adapters/install-adapter.ps1 -Host opencode
./adapters/install-adapter.ps1 -Host dsh
```

审阅生成片段后再合并到各 Agent 的宿主配置。Pi 使用 `adapters/pi/` 的本地 bridge；ZCode 先运行 `./adapters/zcode/probe-zcode.ps1`，只有确认官方支持的协议后才配置。

## 使用

日常功能、复杂 Bug、研究、架构或跨会话交付：

```text
$engineering-workflow 实现用户权限管理，并完成测试和评审
```

也可以直接用自然语言提出非简单工程任务，满足 Skill 触发条件时由 Codex 自动路由。

在 Claude Code、OpenCode、Pi 或 DSH 中，使用其对应的 `adapters/` 入口；入口会读取同一份 `plugins/delivery-control/schemas/workflow-policy.json`，再通过 MCP 调用同一组控制工具。

仅维护计划树时直接调用：

```text
$plan-tree 更新当前路线图和未决问题
```

需要审计、恢复、漂移诊断或检查终态门禁时：

```text
$delivery-control 审计当前 flow，检查漂移和未满足的验收项
```

普通交付只使用这 7 个高层 MCP 工具：

```text
start_or_resume_flow       # 初始化或恢复
route_flow                 # 选择控制器内置路线模板及 delivery mode
checkpoint_flow            # 推进阶段、变更范围、显式迁移策略或解决已恢复的漂移
record_evidence            # 记录交付证据或 Review disposition
authorize_external_action  # 请求、确认、消费并登记一个精确的外部动作
audit_or_recover_flow      # 审计一致性或恢复 journal
close_or_cancel_flow       # 通过全部门禁后关闭，或保留取消后的恢复点
```

## 为什么采用 JSON 协议，而不是长提示词

提示词仍然需要存在，但只承担模型擅长的部分：理解自然语言、判断任务路线、指出真正需要用户决定的产品问题。它不再保存状态机、权限规则或完成定义。

| 层 | 真相来源 | 能解决的问题 |
| --- | --- | --- |
| 语义层 | 薄 Skill / Agent 指令 | 需求理解、路线判断、澄清问题 |
| 协议层 | `workflow-policy.json` | 枚举、允许的迁移、严格模式、证据字段、门禁 |
| 执行层 | Delivery Control | CAS、journal、lease、证据 digest、单次授权、恢复 |
| 业务层 | Plan Tree | 范围、决策、用户意图、开放问题和证据索引 |

JSON 本身不是安全边界；它必须由控制器校验，才会在模型上下文变长、换 Agent 或发生崩溃时仍然保持同一份规则。普通 Plan Tree 说明文字可以自由编辑，只有控制器管理的状态块参与一致性校验。

## 与 Codex 原生 Plan / Goal 的区别

| 对比项 | Codex 原生 Plan / Goal | Engineering Workflow v3 |
| --- | --- | --- |
| 生命周期 | 当前会话或长任务的执行辅助 | 跨会话、跨 Agent 的可恢复交付协议 |
| 表达方式 | 由当前 Agent 生成的计划步骤 | 版本化 JSON + Plan Tree + 事务控制器 |
| 权威性 | 宿主运行时视图 | JSON 管规则，Plan Tree 管业务语义 |
| 完成标准 | 当前任务/目标的宿主状态 | 每个验收项都有有效证据、授权和可观察终态 |
| 宿主依赖 | Codex 专有 | Codex、Claude Code、OpenCode、Pi、DSH 等可共享 |
| 失败恢复 | 依赖宿主会话能力 | journal、revision、受控块 digest 和 Plan Tree 重建 |

所以两者是互补关系：在 Codex 中仍然可以用 `/plan` 或 `/goal` 让当前会话更易执行；工作流只把它们投影为可选运行时视图，绝不把“Plan 已完成”当成“交付已完成”。

## 验证

仓库内可独立运行的测试：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\engineering-workflow\scripts\test-state.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\engineering-workflow\scripts\test-upgrades.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\engineering-workflow\scripts\test-validate.ps1

Set-Location .\plugins\delivery-control
npm ci
npm run check
```

完整集成验证还会动态检查已安装的 28 个 Ask Matt Skills、Plan Tree、Product Design、全局 `AGENTS.md` 和 Delivery Control。安装全部依赖后，通过 `validate.ps1` 的 `SkillsRoot`、`AgentsFile`、`ProductDesignRoot` 和 `DeliveryPluginRoot` 参数传入实际路径；`test-validate.ps1` 提供同名的 `Source*` 参数用于故障注入测试。

## 数据与安全

`delivery-control` 通过本地 stdio MCP 运行，不监听网络端口。运行状态默认保存在 `~/.codex/state/delivery-control/delivery-control.sqlite`，不会包含在本仓库或插件升级包中。

Plan Tree 投影产生的恢复备份位于目标目录下的 `.delivery-control-backups/`，默认最多保留最近 5 份；SQLite schema 会在插件启动时执行受控迁移，不需要删除现有状态库。

控制器不会替用户执行 commit、push、PR、merge、deploy、生产变更或外部消息；它只记录并验证这些动作是否持有匹配的授权。外部动作的授权必须同时匹配 action、target、environment 和精确 request digest。它是交付协议控制层，不是任何 Agent 宿主级安全沙箱。

## 特别鸣谢 / Special Thanks

- [@tt-a1i](https://github.com/tt-a1i) 的 [matt-skills-with-to-goal](https://github.com/tt-a1i/matt-skills-with-to-goal)，为本工作流提供 Ask Matt 路由与工程 procedure manuals。
- [@mattpocock](https://github.com/mattpocock) 的 [mattpocock/skills](https://github.com/mattpocock/skills)，是 Ask Matt 项目标注的上游灵感与基础。
- [@SeemSeam](https://github.com/SeemSeam) 的 [plan-tree](https://github.com/SeemSeam/plan-tree)，为跨会话长期计划、决策、状态和证据管理提供基础。

这些上游项目彼此独立，也不隶属于本集成项目。请遵循各自仓库的许可证、使用条款和版本说明。

更完整的致谢与边界说明见 [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md)。

## License

本仓库目前未附加开源许可证。公开可见不等于授予复制、修改或再分发权；上游依赖继续适用各自的许可证或权利声明。
