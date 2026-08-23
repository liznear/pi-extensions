# Final grammar v1 (ticket 03 resolution artifact)

Supersedes [drafts/03-channels-grammar-v1.md](../drafts/03-channels-grammar-v1.md) (draft retains max_iterations/loop/on_exhausted — all cut during grilling).

## Worked example — review-pipeline

```yaml
# ~/.pi/graphs/review-pipeline.yaml
graph: review-pipeline
version: 1

roles:
  coordinator:                        # ordinary role name; NOT the graph-runner
    system_prompt_file: prompts/coordinator.md
    tools: [read, bash]               # role tools allowlist
    can_create_tasks: true            # gates create_task tool injection
    emits:
      - type: task_assigned
      - type: revision_exhausted
    receives: [merged, task_failed]

  coder:
    system_prompt: |
      你是实现者。收到 task_assigned 后实现，完成后 emit pr_ready；
      收到 revision 则修改后重新 emit pr_ready。
    emits:
      - type: pr_ready
        max_per_task: 3               # per-type quota — emit errors in-turn at quota
    receives: [task_assigned, revision]

  critic:
    system_prompt_file: prompts/critic.md
    emits:
      - type: revision
        max_per_task: 3
      - type: lgtm
    receives: [pr_ready]

  merger:
    system_prompt_file: prompts/merger.md
    emits:
      - type: merged
    receives: [lgtm]

nodes:
  - role: coordinator
    lifecycle: singleton              # eagerly spawned at graph start

  - roles: [coder, critic, merger]
    lifecycle: per_task               # registered (planned) on create_task;
                                      # physically spawned lazily on first routed message

channels:
  - id: assign
    from: coordinator
    to: coder
    when: msg.type == task_assigned
    scoped_to: task

  - id: review                        # to: string OR array (explicit multicast)
    from: coder
    to: critic
    when: msg.type == pr_ready
    scoped_to: task

  - id: revise
    from: critic
    to: coder
    when: msg.type == revision
    scoped_to: task

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

## Semantics settled during grilling

| Mechanism | Decision |
| --- | --- |
| Matching | One emit matches at most ONE channel (same `from` + overlapping `when` values across channels → load error R11); delivery goes to every `to` (string or array = explicit multicast) |
| Ambiguity | Forbidden statically (R11) — no implicit fan-out, no first-match ordering |
| Task factory | `create_task(payload)` tool — injected ONLY into `can_create_tasks: true` roles (R14); mints `task_id`, registers the pipeline's per_task nodes in `planned` state |
| Physical spawn | Lazy: first message routed to `<role, task_id>` spawns the session; R13 — only `scoped_to: task` channel targets may lazy-spawn; graph-scope messages route only to eagerly-spawned singletons |
| Loop protection | Per-type quota `max_per_task` on emits (count per `(role, type, task)`); at quota the emit tool errors in-turn ("已用完 N 次 revision，请 emit lgtm 或升级") guiding the LLM to converge INSIDE the loop; free-form pair-programming types simply omit the quota |
| Watchdog | None in v1 (human watches dashboard, `/graph steer` intervenes) |
| `loop:` field | Cut — back-edges are statically derived via topo sort (informational: cycles are legal) |
| Tool scoping | `emit` in every actor session; `create_task` only in `can_create_tasks` roles — both injected via `customTools` at spawn, physically absent from non-graph sessions; `/graph steer` only in the trigger session |
| Envelope boundary | (inherited from ticket 02) no address fields; `when` operands v1 = `msg.type` literal comparisons only |

## Validator rules (load-time, static)

| Rule | Check |
| --- | --- |
| R1 | every `emits` type is either consumed by some channel (`from` match) or declared `receives`-able somewhere — else orphan-type error (draft's `emits_final` folded into this cross-check) |
| R2 | channel `from`/`to` reference declared roles (every array element) |
| R3 | `when` operands: `msg.type` literal comparisons only |
| R4 | `when` values ⊆ `roles[from].emits` |
| R5 | every `receives` type has at least one channel that can deliver it (`to` match + `when` value match) |
| R6 | ~~loop on_exhausted required~~ obsolete (quotas replaced loop policies) |
| R7 | `scoped_to: task` channels: from/to roles within a compatible per_task pipeline; singleton↔per_task crossing only where spawn semantics allow (R13) |
| R8 | unique channel ids, role names, emits types per role |
| R9 | `when: msg.type == X` where no role emits X → orphan-type error |
| R10 | optional `payload_schema` is valid JSON Schema |
| R11 | no two channels share `from` + overlapping `when` value sets (ambiguity = error) |
| R12 | at least one `can_create_tasks: true` role exists when the graph has `per_task` nodes; its emits cover the trigger types routed into those pipelines |
| R13 | lazy spawn only for `scoped_to: task` targets; `scoped_to: graph` targets must be `singleton` nodes |
| R14 | `create_task` injection gated by `can_create_tasks` (default false) |

## Error UX

`<file>:<line>:<col> [<rule>] message` — YAML line/col precise, rule id, human text:

```
review-pipeline.yaml:14:7 [R4] channel 'review' forwards 'pr_ready' but role 'coder' does not declare it in emits
review-pipeline.yaml:31:3 [R11] channel 'review2' conflicts with 'review': same from 'coder', overlapping when-value 'pr_ready'
```
