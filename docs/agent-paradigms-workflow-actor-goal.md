# AI Agent 编排范式对比与架构学习指南：Workflow vs Actor vs Goal

> 本文系统梳理了 AI Coding Agent（特别是 Pi 生态及主流开源社区）中三种核心任务协作与执行范式：**Workflow（工作流/DAG）**、**Actor（响应式角色网）** 与 **Goal（目标导向自驱循环）**。

---

## 目录

1. [概览与全景对比](#1-概览与全景对比)
2. [范式一：Workflow（工作流 / DAG 管道）](#2-范式一workflow工作流--dag-管道)
3. [范式二：Actor（消息驱动 / 响应式角色图）](#3-范式二actor消息驱动--响应式角色图)
4. [范式三：Goal（目标导向 / 自治循环）](#4-范式三goal目标导向--自治循环)
5. [横向技术对比与选型指南](#5-横向技术对比与选型指南)
6. [组合实战：三者如何协同工作](#6-组合实战三者如何协同工作)
7. [开源项目与插件 GitHub 仓库汇总](#7-开源项目与插件-github-仓库汇总)

---

## 1. 概览与全景对比

在以 Pi 为代表的终端 Coding Agent 体系中，原生环境通常是“单轮对话、单进程、单工作区”的。为了解决复杂长链路工程问题，社区与开源框架演化出了三种不同的抽象层级：

```text
                    ┌──────────────────────────────────────────┐
                    │               Goal 范式                  │
                    │  "达成目标 X，不达目的不罢休（自动循环）" │
                    └─────────────────────┬────────────────────┘
                                          │ 可以内嵌
                    ┌─────────────────────▼────────────────────┐
                    │             Workflow 范式                │
                    │   "先做 A，再做 B，然后并行 C1/C2，最后汇聚"  │
                    └─────────────────────┬────────────────────┘
                                          │ 可以作为底层实体
                    ┌─────────────────────▼────────────────────┐
                    │              Actor 范式                  │
                    │ "我是 Coder，收到 Review 意见就改，改完发回"│
                    └──────────────────────────────────────────┘
```

| 维度 | Workflow (工作流 / DAG) | Actor (角色消息网) | Goal (目标自治循环) |
| :--- | :--- | :--- | :--- |
| **核心隐喻** | 工厂流水线 (Pipeline) | 团队办公室协作 (Mailbox/Channel) | 任务看板与对赌协议 (Checklist & Loop) |
| **控制流** | 确定性有向无环图 (DAG) 或阶段式推进 | 事件/消息驱动的自治反应流 (Message-driven) | 目标收敛判定循环 (Evaluator Loop) |
| **拓扑关系** | 单向、分叉、汇聚 | 网状、双向博弈、动态握手 | 单点闭环（或单 Agent 树状递推） |
| **状态载体** | 节点间上下文传递 (Step Output) | 独立 Actor Session 内存 + 共享 Blackboard | Session 自定义持久化条目 (Custom Entries) |
| **防死循环机制** | DAG 深度上限、重试次数限制 | **Emit Quotas (通道发射配额)** | **Turn / Token 预算限制、停机判定** |
| **开源对标** | Temporal, LangGraph (DAG 模式), CrewAI | AutoGen 0.4+, Ray, Erlang/Akka 模式 | OpenAI Codex `/goal`, AutoGPT, Devin 循环 |
| **Pi 生态插件** | `pi-agents-flow`, `@osolmaz/pi-workflows` | `@actor-graph`, `command-center` | `pi-goal`, `pi-goals`, `pi-goal-x` |

---

## 2. 范式一：Workflow（工作流 / DAG 管道）

### 2.1 核心概念

Workflow 范式将复杂工程任务拆解为若干个有序的**步骤（Steps）**或**阶段（Phases）**。数据在节点之间按照有向图流动，前置节点的输出作为后置节点的输入。

### 2.2 核心架构模型

- **Supervisor-Worker 模式**：一个主控 Agent（Supervisor）负责制定工作流图，将子任务分发给临时的 Worker Agent，收集结果并统一判定门禁（Quality Gate）。
- **Git Worktree 隔离**：各个并行任务在独立的 Git 工作树中运行，最后在合并节点通过自动化或人工介入进行 Rebase/Merge。

```text
                    [ 需求输入 ]
                         │
                         ▼
                  [ Supervisor 规划 ]
                         │
           ┌─────────────┴─────────────┐
           ▼                           ▼
    [ Worker 1: 后端开发 ]       [ Worker 2: 前端开发 ]  (并行 Git Worktrees)
           │                           │
           └─────────────┬─────────────┘
                         ▼
                  [ 质检 / 集成测试 ]
                         │
                         ▼
                     [ 交付结果 ]
```

### 2.3 Pi 生态典型实现

1. **`pi-agents-flow`**
   - Supervisor 主管模式，将根 Pi Agent 变为调度器。
   - 具备持久化 Workflow Graph 与结构化质检门禁（Quality Gate）。
2. **`@osolmaz/pi-workflows`**
   - 专为 Pi 打造的轻量级工作流引擎，提供 TUI 终端实时查看器。
3. **`pi-dynamic-workflows-oc-style`**
   - 支持多达上百个 Subagent 的并行 Fan-out 扇出，具备模型智能路由和上下文隔离治理。

### 2.4 适用场景与局限

- **适用**：阶段划分明确、产物交接清晰的任务（如：`调研 -> 制定 RFC -> 拆分模块并行写代码 -> Code Review -> 整合测试`）。
- **局限**：难以表达复杂的动态博弈与即时双向反馈（如写代码的人与审查员来回多轮激烈讨论）。

---

## 3. 范式二：Actor（消息驱动 / 响应式角色图）

### 3.1 核心概念

借鉴经典分布式系统的 **Actor 模型**（如 Erlang/Akka/Orleans）。每个 Agent 是一个拥有**独立生命周期、独立邮箱/通道和独立工作空间**的实体（Actor）。
Actor 之间不直接共享全局状态，而是通过**带有类型约定的消息信封（Typed Message Envelopes）**相互通信。

### 3.2 核心架构模型（以 `@actor-graph` 为例）

- **声明式通道路由（Channels）**：YAML 中定义哪些 Actor 监听什么类型的消息，产出什么类型的消息。
- **配额防环（Emit Quotas）**：允许双向循环（如 `coder` $\leftrightarrow$ `critic`），但对每类消息设置最大发射次数，达到上限则强制熔断或升级。
- **Blackboard（黑板模式）**：所有事件流（`events.jsonl`）的派生投影视图，作为只读事实来源。
- **触发端作为 Observer**：用户发起会话仅作为只读的 TUI 监控界面，不参与 Actor 内部计算。

```yaml
# @actor-graph 示例架构片段
channels:
  - from: coordinator
    to: coder
    type: task_assignment
  - from: coder
    to: critic
    type: code_review_request
    quota: 5 # 循环保护：最多审查 5 轮
  - from: critic
    to: coder
    type: review_feedback
  - from: critic
    to: coordinator
    type: task_completed
```

```text
                     ┌────────────────┐
                     │  Coordinator   │
                     └───────┬────────┘
                             │ task_assignment
                             ▼
  ┌───────────────┐  code_review_request   ┌───────────────┐
  │     Coder     ├───────────────────────►│    Critic     │
  │ (Actor / CWD) │◄───────────────────────┤ (Actor / CWD) │
  └───────────────┘    review_feedback     └───────┬───────┘
                                                   │ task_completed
                                                   ▼
                                            [ Blackboard / Done ]
```

### 3.3 开源社区与 Pi 生态代表

1. **`@actor-graph`（Pi 生态）**：
   - 进程内通过 SDK Services 启动持久化子 Session。
   - 基于 `pi-intercom` 拓展通道做跨进程事件镜像。
   - 支持 `/graph steer`（人工中途干预）与 `/graph resume`（断点重放恢复）。
2. **`AutoGen 0.4+` (`autogen-core`)（开源社区）**：
   - 彻底拥抱 Actor 架构，基于 Topic 和 AgentID 进行异步 RPC 消息派发。
3. **`LangGraph`（开源社区）**：
   - 基于 StateGraph 与 Channels 驱动的多角色状态机，同样强调循环步数控制与 Checkpointing。

### 3.4 适用场景与局限

- **适用**：多角色协同、角色间博弈/结对编程（Pair Programming）、红蓝对抗测试、以及高度自治的长程任务。
- **局限**：概念抽象高，定义 Typed Channel 和消息 Schema 相比线性工作流有一定学习和编写成本。

---

## 4. 范式三：Goal（目标导向 / 自治循环）

### 4.1 核心概念

默认情况下，Coding Agent 跑完一次推理（1 Turn）后就会等待用户输入。Goal 范式的核心是：**赋予 Agent 一个长程目标，Agent 自动检测是否达标，未达标则自动继续（Auto-continue），直到目标完成或预算耗尽。**

### 4.2 三种主流实现形态

```text
                       [ /goal 设定目标 ]
                              │
                              ▼
                      ┌─► [ Agent 执行 1 轮 ]
                      │       │
                      │       ▼
                      │  [ 判定目标状态 ]
                      │       ├─► 达标 (goal_complete) ──► [ 结束并输出报告 ]
                      │       ├─► 阻塞 (goal_blocked)  ──► [ 暂停请求人工介入 ]
                      │       ├─► 超出预算 (Budget Limit)─► [ 熔断报警 ]
                      └───────┴── 未达标 ────────────────► (自动注入提示词并循环)
```

#### ① 自动推进循环（Auto-Continue Loop）

- **代表**：`pi-goal`、`@xbear/pi-goal`、`@pinet/agent-goal`
- **机制**：劫持 `agent_end` 事件。若 Agent 尚未调用 `goal_complete`，插件自动构造继续提示词注入会话，驱使 Agent 进行下一轮思考和行动。

#### ② 持久化与分支感知（Session-Aware Persistence）

- **代表**：`pi-goals`、`pi-codex-goal`、`pi-agent-goal`
- **机制**：参考 OpenAI Codex CLI 的 `/goal` 规范。将 Goal 数据存入会话 Custom Entries，这样在用户执行 `/tree`、`/fork`、会话恢复或上下文压缩（Context Compaction）时，目标与进度状态完全不丢失。

#### ③ 结构化与独立审查（Structured & Plan-first）

- **代表**：`pi-goal-x`、`@pandi-coding-agent/plan`
- **机制**：
  - **Plan 优先**：先锁死代码编辑工具，专心输出规划，经人工 Approve 后才进入 Goal 执行。
  - **独立评审员（Auditor）**：每一轮不只由执行者自己宣称完成，而是由一个轻量级的判定器（Auditor）验证测试是否通过。

### 4.3 适用场景与局限

- **适用**：单会话下的复杂开发任务（如“修复所有的单元测试失败”、“为当前模块补全文档并增加覆盖率至 80%”）。
- **局限**：通常作用于单一 Agent / 线性会话，缺乏多角色独立隔离与多工作区分叉能力。

---

## 5. 横向技术对比与选型指南

### 5.1 决策树（如何选择？）

```text
你有多个明确的不同角色（如 Coder、Reviewer、Tester）需要互相协作吗？
 ├── 否（单 Agent） ──► 你需要让 Agent 自己持续执行直到目标达成吗？
 │                       ├── 是 ──► 【选 Goal 模式】 (如 pi-goal / pi-goals)
 │                       └── 否 ──► 原生单轮交互 / Prompt Templates
 │
 └── 是（多 Agent） ──► 任务流向是线性的分步流水线，还是双向/网状的博弈交互？
                         ├── 确定性分步流水线 ──► 【选 Workflow 模式】 (如 pi-agents-flow)
                         └── 双向博弈 / 响应式消息网 ──► 【选 Actor 模式】 (如 @actor-graph)
```

### 5.2 综合特性对照矩阵

| 特性维度 | Workflow 方案 | Actor 方案 (`@actor-graph`) | Goal 方案 (`pi-goal`) |
| :--- | :--- | :--- | :--- |
| **上手复杂度** | 中等（配置 Step 节点） | 较高（需理解 Channel / Quota / Actor） | 极低（直接 `/goal <内容>`） |
| **执行透明度** | 高（清晰的节点进度） | 极高（细粒度事件流与 Blackboard） | 中（终端持续滚动输出） |
| **隔离级别** | 进程级 / Worktree 级 | 进程级 Session + 独立 Git Worktree | 单会话 / 上下文注入 |
| **灵活性** | 适合标准研发流程 | 适合高度复杂的定制系统 | 适合单兵作战长程任务 |

---

## 6. 组合实战：三者如何协同工作

在最前沿的 Agent 架构中，这三者绝不是互斥的，而是可以**层层嵌套**的强大组合体：

```text
┌────────────────────────────────────────────────────────────────────────┐
│ 1. 外层 Goal：交付 "用户认证模块升级"                                    │
│    目标判据：所有集成测试通过，且安全扫描 0 漏洞                         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 拆解并触发
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 2. 中层 Workflow：标准开发生命周期                                      │
│    [ Phase 1: 架构设计 ] ──► [ Phase 2: 双角色实现 ] ──► [ Phase 3: 发布 ]│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 在 Phase 2 中实例化
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 3. 内部 Actor Graph：结对开发网络                                      │
│    [ Coder Actor ] ◄───(Channel: Review & Feedback)───► [ Critic Actor ]│
│    通过 Emit Quota 控制 3 轮内完成收敛并回传产物                       │
└────────────────────────────────────────────────────────────────────────┘
```

- **Goal** 负责**外层承诺与交付结果保障**（什么时候算真正做完）；
- **Workflow** 负责**宏观阶段把控与分工推进**（先做什么、后做什么）；
- **Actor Graph** 负责**局部复杂子节点的多角色深度协作与质量打磨**（专家角色的双向博弈）。

---

## 7. 开源项目与插件 GitHub 仓库汇总

### 7.1 Workflow 类别

| 项目 | 说明 | GitHub 链接 |
| :--- | :--- | :--- |
| **`pi-agents-flow`** | Supervisor 模式的 Durable Workflow Graph | [GalaxyXieyu/pi-agents-flow](https://github.com/GalaxyXieyu/pi-agents-flow) |
| **`pi-workflows`** | 基于 TS Graph 的 Workflow 引擎与终端 Viewer | [osolmaz/pi-workflows](https://github.com/osolmaz/pi-workflows) |
| **`pi-dynamic-workflows`** | 百级子 Agent 扇出与 Git Worktree 隔离编排 | [gtnotacoder/pi-dynamic-workflows](https://github.com/gtnotacoder/pi-dynamic-workflows) |
| **`agents-workflow`** | 特性并行开发多 Agent 编排系统 | [l3wi/agents-workflow](https://github.com/l3wi/agents-workflow) |
| **`pi (subagent example)`** | Pi 官方子 Agent 多进程隔离实现范例 | [earendil-works/pi subagent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent) |

### 7.2 Actor 类别

| 项目 / 框架 | 说明 | GitHub / 来源 |
| :--- | :--- | :--- |
| **`@actor-graph`** | 本仓库实现的声明式 Channel 路由与配额防环 Actor 引擎 | 本地路径 `actor-graph/` |
| **`pi-fabric`** | 支持 Actor、Mesh、Swarm 和递归架构的可编程 Agent 运行时 | [monotykamary/pi-fabric](https://github.com/monotykamary/pi-fabric) |
| **`@llblab/pi-actors`** | Pi 的本地 Actor 内核与持久化执行注册表 | [npm:@llblab/pi-actors](https://pi.dev/packages/@llblab/pi-actors) |
| **`pi-swarm` (`@gjczone/pi-swarm`)** | 支持 Mailbox 邮箱机制与协作 Team 的 Swarm 插件 | [npm:@gjczone/pi-swarm](https://www.npmjs.com/package/@gjczone/pi-swarm) |
| **`pi-intercom` / `agent-intercom-pi`** | Pi 跨 Session 消息对讲通信底座（Actor Mailbox 底座） | [pi-intercom](https://www.npmjs.com/package/pi-intercom) / [dataforxyz/agent-intercom-pi](https://github.com/dataforxyz/agent-intercom-pi) |
| **`AutoGen 0.4+` (`autogen-core`)** | 微软开源的基于 Actor 模型的通用多 Agent 框架 | [microsoft/autogen](https://github.com/microsoft/autogen) |
| **`LangGraph`** | 基于状态机图与 State Channels 的编排引擎 | [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) |
| **`OpenHands`** | 基于 Append-only EventStream 与沙箱的 Coding Agent | [All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands) |
| **`LlamaIndex Workflows`** | 事件驱动的异步事件流工作流框架 | [run-llama/llama_index](https://github.com/run-llama/llama_index) |

### 7.3 Goal 类别

| 项目 / 插件 | 说明 | GitHub 链接 |
| :--- | :--- | :--- |
| **`pi-goal` (`@narumitw/pi-goal`)** | 经典的 Auto-continue 目标闭环插件 | [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions) |
| **`pi-goal` (`@xbear/pi-goal`)** | 支持交互式与 CLI 打印模式的 `/goal` 增强版 | [xbeark/pi-goal](https://github.com/xbeark/pi-goal) |
| **`pi-goals`** | Codex 风格、跨 `/tree` 分支感知与预算监控的持久化 Goal | [giuseppecrj/pi-goals](https://github.com/giuseppecrj/pi-goals) / [transcendr/pi-goals](https://github.com/transcendr/pi-goals) |
| **`pi-codex-goal`** | 纯 Session 自定义条目存储的 Codex `/goal` 实现 | [fitchmultz/pi-codex-goal](https://github.com/fitchmultz/pi-codex-goal) |
| **`pi-agent-goal`** | 具备分支对齐、阶段审查与导入的 Goal 插件 | [KristjanPikhof/Pi-Agent-Goal](https://github.com/KristjanPikhof/Pi-Agent-Goal) |
| **`pi-goal-x`** | 支持 Sisyphus 巡检目标与独立 Auditor 评审的 Goal 方案 | [tmonk/pi-goal-x](https://github.com/tmonk/pi-goal-x) |
