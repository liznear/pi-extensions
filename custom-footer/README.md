# custom-footer

A pi extension that installs a custom footer/status line pinned to the terminal footer layer.

## Why

This is a workaround when editor resizing/collapse behavior makes status-like lines look like they move with the input area.
By rendering via `ctx.ui.setFooter(...)`, the line is managed as the footer, not as an editor-adjacent widget.

## What it shows

- Session title (from `pi.setSessionName()` / `/name` / auto-title extension), shown on the right in the accent color when set
- Context usage bar with color-coded percentage of the context window
- Usage summary (`In 12.3K / Out 4.5K / Cache Hit 91%`, K/M formatted): cumulative input/output tokens and cache hit rate (`cacheRead / (input + cacheRead + cacheWrite)`) aggregated over assistant messages in the current branch
- Last run duration
- Aggregated extension status texts (`ctx.ui.setStatus(...)` entries)
- Current model id
- Current git branch (if available)

## Command

- `/custom-footer` or `/custom-footer on` → enable custom footer
- `/custom-footer off` → disable and restore pi default footer

## Install in this repo

This repo already auto-discovers extension directories under `home/modules/pi-extensions` via `home/modules/pi.nix`.
After syncing Home Manager, this extension is linked to:

- `~/.pi/agent/extensions/custom-footer`

Then restart pi (or run `/reload` in an existing session).

## Customize

Edit:

- `home/modules/pi-extensions/custom-footer/index.ts`

Main customization points:

- `left` segment: usage/cost formatting
- `statusText`: how extension statuses are merged
- `right` segment: model/branch display
