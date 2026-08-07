# pi-extensions

Local collection of Pi extensions, extracted from `/etc/nix-all/home/modules/pi-extensions`.

This repo is also a **Pi package**, so you can install it directly via `pi install git:<repo>`.

## Included extensions

- `ask-question`
- `auto-title`
- `bash-timeout`
- `custom-agents`
- `custom-footer`
- `diff`
- `explain`
- `mini-task`
- `command-run`
- `otty-integration`
- `command-center`

## Install

### Option A: Install as a Pi package (recommended)

From GitHub:

```bash
pi install git:github.com/<owner>/pi-extensions
```

Or with a pinned tag/commit:

```bash
pi install git:github.com/<owner>/pi-extensions@v0.1.0
```

Project-local install (writes to `.pi/settings.json`):

```bash
pi install -l git:github.com/<owner>/pi-extensions
```

Then restart Pi, or run:

```text
/reload
```

### Option B: Local symlink install (for development)

Pi loads local extensions from:

- `~/.pi/agent/extensions/<extension-name>`

Create symlinks from this repo into that folder:

```bash
mkdir -p ~/.pi/agent/extensions

for ext in ask-question auto-title bash-timeout custom-agents custom-footer diff explain mini-task command-run otty-integration command-center; do
  ln -sfn "$PWD/$ext" "$HOME/.pi/agent/extensions/$ext"
done
```

Then restart Pi, or run `/reload`.

## Update extensions

If installed as a Pi package:

```bash
pi update --extensions
# or update only this package source
pi update git:github.com/<owner>/pi-extensions
```

If using symlink-based local development:

1. Commit changes:

```bash
git add .
git commit -m "Update pi extensions"
```

1. Pull latest where needed:

```bash
git pull
```

Then restart Pi or run `/reload`.

## Add a new extension

1. Create a new folder (example: `my-extension/`) with an `index.ts` entrypoint.
2. Link it into Pi:

```bash
ln -sfn "$PWD/my-extension" "$HOME/.pi/agent/extensions/my-extension"
```

1. Restart Pi or run `/reload`.

## Uninstall an extension

Remove only the Pi link (keeps source code in this repo):

```bash
rm ~/.pi/agent/extensions/<extension-name>
```

## Notes

- `custom-footer` and `custom-agents` have their own README files with extension-specific usage.
- `auto-title` automatically sets a session title after the first prompt (see its README for model configuration).
- `bash-timeout` enforces a default timeout (60s, configurable via `PI_BASH_TIMEOUT_SECONDS`) on `bash` calls that omit one.
- `otty-integration` reports pi agent state to the Otty terminal app (see its README for the `OTTY_KIND` caveat).
- `command-center` registers the `/cc` command (mission control for coordinated agent work) plus `/cc` syntax highlighting (its `extensions/cc-highlight.ts` is registered separately in the package manifest).
- If an extension does not appear, confirm the symlink exists:

```bash
ls -la ~/.pi/agent/extensions
```
