# Ticket 03: What is the YAML grammar for channels, and what can be statically validated?

Status: open
Type: grilling
Parent map: [Actor-Graph map](../map.md)

## Question

Finalize the **channels DSL grammar** and the validator's guarantees:

1. Full grammar for the `channels` section: `from`/`to` role references, `when` conditions over envelope fields (`msg.type`), `scoped_to: task`, and `max_iterations` (pin ③) with its overflow policy (who is notified when a revision loop exhausts — coordinator? human?).
2. The `roles` section's `emits` declaration (pin ②): syntax, and the static checks it unlocks (unmatched emits, channels referencing undeclared types, unreceivable message types — list every validator rule precisely).
3. The `nodes` section: `singleton` vs `per_task` lifecycle declarations, and how a per-task pipeline is expressed (roles composed per task instance).
4. Versioning/validation UX: what does a load-time error look like for the graph author? Line-precise YAML errors vs. structural messages.
5. A complete worked example in the final grammar — the coder→critic→merger graph with revision loop and max_iterations — as the grammar's acceptance test.

## Context

- Depends on the envelope shape (Ticket 02); conditions operate on envelope fields.
- The example produced here is input to the acceptance ticket (Ticket 06).
- Constraints already locked: pure declarative routing, no dispatch/escape hatch in v1 (see map Notes).
