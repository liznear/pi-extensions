# Routing Example: Coder → Critic → Merger

Mission: "实现 feature X，代码要过 reviewer 审查后合并"

一个 task 的 pipeline：

```
coordinator ──"task 1: 做 X"──▶ coder-for-task-1
coder-for-task-1 ──"done, PR ready"──▶ critic-for-task-1
critic-for-task-1 ──LGTM──▶ merger-for-task-1 (或 coordinator)
critic-for-task-1 ──"改一下 Y"──▶ coder-for-task-1   ← 修订回路
```

三种路由模型下，这段流程分别怎么写：

---

## A. 纯声明式 channels

YAML 里把所有边写死，runner 负责投递，节点只管处理消息：

```yaml
channels:
  - from: coder
    to: critic
    scoped_to: task        # coder-for-task-1 → critic-for-task-1
    when: msg.type == "pr_ready"

  - from: critic
    to: coder
    scoped_to: task
    when: msg.type == "revision"    # 修订回路：打回原 coder

  - from: critic
    to: merger
    scoped_to: task
    when: msg.type == "lgtm"

  - from: coordinator
    to: coder
    when: msg.type == "task"        # 动态: coordinator 给 coder-1..N 派活
```

**优点**

- 整个系统的**拓扑一眼可见**：打开 YAML 就知道消息会流到哪。
- 天然可静态校验（"critic 发 lgtm 但没人接"在 load 时就能报错）。
- 节点 prompt 里不用教路由，节点更纯粹。

**缺点**

- **表达不了"看内容派活"**。比如 coordinator 拿到 5 个 task，想"含 Rust 的给 coder-rust，其余给 coder-ts" —— 声明式条件写不动这种业务判断（要么写成正则穷举，要么放弃）。
- 边的数量随流程复杂度膨胀，修订回路多的时候 YAML 比 prompt 还难读。

---

## B. 纯自主寻址

YAML 只定义 roles 和节点，没有 channels 段。每个 actor 像 intercom 的原生用法一样，自己决定回复谁：

```yaml
roles:
  coder:
    prompt: |
      你是 coder。收到 task 后实现并回复。
      完成后，把 PR 描述发给本 task 的 critic（名字是
      critic-for-<task-id>，你的 task-id 会随消息带给你）。
```

节点通过 intercom 的 `send`/`ask` 主动寻址发消息。

**优点**

- **任意复杂的派发逻辑零成本**：coordinator 想"看内容派活"就是 prompt 里一句话。
- 不需要发明 DSL 语法 —— 复用 intercom 原语，runner 更薄。
- 行为完全由 LLM 决定，涌现空间大。

**缺点**

- **拓扑不可见**：想知道"critic 会把 LGTM 发给谁"得读 prompt（还是自然语言，LLM 还可能不遵守）。
- **不可静态校验**：拼错地址 `critic-for-task-2`（实际是 task-1）只能运行时发现 —— 而且是在 5 分钟后跑挂才发现。
- 修订回路这种"结构上很重要"的行为退化为 prompt 约定，可靠性靠 LLM 心情。

---

## C. 混合（声明式为骨架 + 主动寻址逃生舱）

channels 定义主要骨架，同时给节点一个受控的主动发送能力：

```yaml
channels:
  - from: coder
    to: critic
    scoped_to: task        # 骨架: 打回/放行的修订回路是结构性的
  - from: critic
    to: merger
    scoped_to: task

roles:
  coordinator:
    prompt: |
      你负责任务分派。派发下一个 task 时，调用
      dispatch(role: "coder", taskId: N, payload: ...) 工具。
      # 逃生舱: 动态判断给谁、给几个、什么顺序，coordinator 自己决定
```

**优点**

- **结构归结构，智能归智能**：修订回路这种流程骨架在 YAML 里可见、可校验；coordinator 这种需要业务判断的节点拿到 `dispatch` 逃生舱。
- `dispatch` 是 runner 提供的**受控工具**（不是裸 send），可以记事件、限权限、可校验 —— 保留可观测性。
- 对 LLM 友好：prompt 说"完成 PR 后输出 `pr_ready`"比说"把消息发给 critic-for-task-1 这个地址"容易遵守得多（输出一个标记 vs 拼一个地址）。

**缺点**

- 两套机制并存，**心智模型最大**：用户要学"什么该写进 channels，什么该留给 dispatch"。
- 逃生舱可能被滥用 —— 图作者图省事全用 dispatch，YAML 沦为摆设（需要文档/ lint 引导）。
- runner 要实现 dispatch 工具语义 + channels 路由两种投递路径。

---

## 一句话对比

| | A 纯声明 | B 纯自主 | C 混合 |
|---|---|---|---|
| 拓扑可见性 | ★★★ | ★ | ★★（骨架可见） |
| 动态派发能力 | ✗ | ★★★ | ★★（够用） |
| 可静态校验 | ★★★ | ✗ | ★★ |
| 心智负担 | 低 | 低 | 中 |
| prompt 依赖度 | 低 | 高（路由都靠它） | 中 |

我仍然推荐 **C**：A 死在动态派发，B 死在可靠性 —— 而 graph 这个形态存在的意义就是"结构可声明"，C 是唯一两头都占的。
