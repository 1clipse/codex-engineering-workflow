# Codex Engineering Workflow

一个面向 Codex 的完整工程交付工作流：从需求路由、澄清、规格、执行和评审，一直管理到证据闭环、权限确认与可恢复关闭。

它不是传统 Plan Mode 的替代品，而是将短期计划、长期计划树、具体工程流程和事务控制组合成一条可验证的交付链路。

![Engineering Workflow](assets/engineering-workflow-flowchart.png)

## 核心能力

- 自动判断直接实现、常规交付、复杂决策、UI/UX 和纯计划维护路线。
- 读取并应用 Ask Matt 的 procedure manual，完成澄清、spec、tickets、goal、TDD 和 review 等阶段。
- 以 Plan Tree 作为唯一持久业务权威，保存范围、决策、阶段、证据与恢复点。
- 通过 Delivery Control MCP 管理事务、CAS revision、lease、崩溃恢复、漂移检测和 native Plan 同步。
- 以结构化 evidence 和 terminal condition 作为完成门禁，阶段完成不等于交付完成。
- 对 commit、push、PR、merge、deploy、生产操作和外部通信采用精确、短期、单次授权。

## 组件关系

| 组件 | 职责 |
| --- | --- |
| `engineering-workflow` | 唯一日常入口；自动路由并推进完整交付流程 |
| [Ask Matt](https://github.com/tt-a1i/matt-skills-with-to-goal) | 提供具体工程 procedure manuals |
| [Plan Tree](https://github.com/SeemSeam/plan-tree) | 持久计划、范围、决策、状态、问题与证据的权威来源 |
| `delivery-control` | 本地事务、锁、恢复、证据、授权、指标和同步控制 |
| Product Design | 可选；处理 UI/UX 设计与设计 QA |

## 要求

- Codex Desktop 或支持 Skills 与本地 MCP 插件的 Codex 环境
- [Ask Matt](https://github.com/tt-a1i/matt-skills-with-to-goal)
- [Plan Tree](https://github.com/SeemSeam/plan-tree) `>= 0.4.0`
- Node.js 24（用于构建和运行 `delivery-control`）
- PowerShell 5 或 7（用于 workflow 验证脚本）
- Product Design（可选，只有 UI/UX 路线需要）

## 安装

### 1. 安装依赖 Skills

请先按各自仓库的说明安装 Ask Matt 与 Plan Tree。本仓库不复制或重新分发这两个项目。

### 2. 安装 Engineering Workflow

将 `skills/engineering-workflow` 复制到 Codex 的个人 Skills 目录：

```powershell
Copy-Item -Recurse -Force .\skills\engineering-workflow "$env:USERPROFILE\.codex\skills\engineering-workflow"
```

### 3. 构建并安装 Delivery Control

```powershell
Set-Location .\plugins\delivery-control
npm ci
npm run check
Set-Location ..\..
codex plugin marketplace add 1clipse/codex-engineering-workflow
codex plugin add delivery-control@codex-engineering-workflow
```

不同 Codex CLI 版本的插件命令可能略有差异，请以当前 Codex 插件文档和 `codex plugin --help` 为准。安装或升级插件后，新建一个 Codex 任务以加载新的 Skill 和 MCP 工具。

## 使用

日常功能、复杂 Bug、研究、架构或跨会话交付：

```text
$engineering-workflow 实现用户权限管理，并完成测试和评审
```

也可以直接用自然语言提出非简单工程任务，满足 Skill 触发条件时由 Codex 自动路由。

仅维护计划树时直接调用：

```text
$plan-tree 更新当前路线图和未决问题
```

需要审计、恢复、漂移诊断或检查终态门禁时：

```text
$delivery-control 审计当前 flow，检查漂移和未满足的验收项
```

## 验证

仓库内可独立运行的测试：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\engineering-workflow\scripts\test-state.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\engineering-workflow\scripts\test-upgrades.ps1

Set-Location .\plugins\delivery-control
npm ci
npm run check
```

完整集成验证还会动态检查已安装的 28 个 Ask Matt Skills、Plan Tree、Product Design、全局 `AGENTS.md` 和 Delivery Control。安装全部依赖后，通过 `validate.ps1` 的 `SkillsRoot`、`AgentsFile`、`ProductDesignRoot` 和 `DeliveryPluginRoot` 参数传入实际路径；`test-validate.ps1` 提供同名的 `Source*` 参数用于故障注入测试。

## 数据与安全

`delivery-control` 通过本地 stdio MCP 运行，不监听网络端口。运行状态默认保存在 `~/.codex/state/delivery-control/delivery-control.sqlite`，不会包含在本仓库或插件升级包中。

控制器不会替用户执行 commit、push、PR、merge、deploy、生产变更或外部消息；它只记录并验证这些动作是否持有匹配的授权。它是交付协议控制层，不是 Codex 宿主级安全沙箱。

## 特别鸣谢 / Special Thanks

- [@tt-a1i](https://github.com/tt-a1i) 的 [matt-skills-with-to-goal](https://github.com/tt-a1i/matt-skills-with-to-goal)，为本工作流提供 Ask Matt 路由与工程 procedure manuals。
- [@mattpocock](https://github.com/mattpocock) 的 [mattpocock/skills](https://github.com/mattpocock/skills)，是 Ask Matt 项目标注的上游灵感与基础。
- [@SeemSeam](https://github.com/SeemSeam) 的 [plan-tree](https://github.com/SeemSeam/plan-tree)，为跨会话长期计划、决策、状态和证据管理提供基础。

这些上游项目彼此独立，也不隶属于本集成项目。请遵循各自仓库的许可证、使用条款和版本说明。

更完整的致谢与边界说明见 [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md)。

## License

本仓库目前未附加开源许可证。公开可见不等于授予复制、修改或再分发权；上游依赖继续适用各自的许可证或权利声明。
