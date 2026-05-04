# Remap custom-agents shortcut to Alt+P

## Changes
- Update keyboard shortcut registration in `custom-agents/index.ts` from `alt+a` to `alt+p`.
- Update `custom-agents/README.md` to document Alt+P instead of Alt+A.

## Validation
- Reload pi and verify `Alt+P` cycles primary agents.
- Verify `/agent next` still works.