# Draft: channels grammar v1 (ticket 03 grilling artifact)

Worked example below is the proposal to react to — coder→critic→merger with
revision loop, termination policy, and all inherited pins from ticket 02.

```yaml
# ~/.pi/graphs/review-pipeline.yaml
graph: review-pipeline
version: 1

roles:
  coordinator:
    system_prompt_file: prompts/coordinator.md   # or inline `system_prompt: |`
    tools: [read, bash]                          # tools allowlist for this role
    emits: [mission_start, task_assigned]         # everything this role may emit
    receives: [revision_exhausted]                # what may reach it (optional but validated)

  coder:
    system_prompt: |
      你是实现者。收到 task_assigned 后实现，完成后 emit pr_ready；
      收到 revision 请求则修改后重新 emit pr_ready。
    emits: [pr_ready]
    receives: [task_assigned, revision]
    disable_graph_context: false                  # default false = inject type-level view

  critic:
    system_prompt_file: prompts/critic.md
    emits: [revision, lgtm]
    receives: [pr_ready]

  merger:
    system_prompt_file: prompts/merger.md
    emits: [merged]
    receives: [lgtm]

nodes:
  - role: coordinator
    lifecycle: singleton          # one instance, alive for whole graph run

  - roles: [coder, critic, merger] # per-task pipeline: fresh instances per task
    lifecycle: per_task           # coder-for-task-1, critic-for-task-1, ...

channels:
  - id: assign                    # stable id → routing stamps / dashboard
    from: coordinator
    to: coder
    when: msg.type == task_assigned
    scoped_to: task

  - id: review
    from: coder
    to: critic
    when: msg.type == pr_ready
    scoped_to: task

  - id: revise                    # loop edge (backward): iteration counter lives here
    from: critic
    to: coder
    when: msg.type == revision
    scoped_to: task
    max_iterations: 3
    on_exhausted: emit_to         # termination policy (see enum below)
    exhausted_target: coordinator # paired with emit_to / notify

  - id: approve
    from: critic
    to: merger
    when: msg.type == lgtm
    scoped_to: task

  - id: done
    from: merger
    to: coordinator
    when: msg.type == merged
    scoped_to: task
```

## Termination policy enum (`on_exhausted`)

| 值 | 行为 |
| --- | --- |
| `fail` | graph run 标记失败，task 终止（默认） |
| `emit_to` | 拒投递时由 runner 合成一条 `revision_exhausted` 消息发给 `exhausted_target` |
| `notify` | 事件流里发 human 通知事件，graph 继续（人可 /graph steer） |

## Validator rules (load-time, static)

R1 every `roles.X.emits` type: at least one channel consumes it (`from` match) or role opts out via `emits_final: true`（终态类型，如 merged 可以没人接）
R2 every channel `from`/`to`: references a declared role
R3 every channel `when` operand: `msg.type` only, literal comparison
R4 every `when` value: ⊆ `roles[from].emits`（channel 声称转发的类型必须在 from 角色的 emits 里）
R5 every `roles.X.receives`: at least one channel can deliver it（to=X 且 when 值匹配）
R6 loop edges（max_iterations > 1）: `on_exhausted` 必填
R7 `scoped_to: task` channels: from/to 角色必须同属一个 per_task pipeline（不能 singleton→per_task 跨界混 scope）
R8 duplicate channel `id` / duplicate role name / duplicate emits type within role → 报错
R9 `when: msg.type == X` 但没有任何角色 emits X → 报错（孤儿类型）
R10 payload schema（若声明 `payload_schema`）必须是合法 JSON Schema

## Error UX

`yaml` + `line/col` + rule id + 人话消息，例：
`review-pipeline.yaml:14:7 [R4] channel 'review' forwards 'pr_ready' but role 'coder' does not declare it in emits`
