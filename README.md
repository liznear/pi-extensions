# pi-extensions

Local collection of Pi extensions, extracted from `/etc/nix-all/home/modules/pi-extensions`.

## Included extensions

- `ask-question`
- `custom-footer`
- `diff`
- `plan-mode`
- `review`
- `todo`
- `tool-rendering`

## Install (from this repo)

Pi loads extensions from:

- `~/.pi/agent/extensions/<extension-name>`

Create symlinks from this repo into that folder:

```bash
mkdir -p ~/.pi/agent/extensions

for ext in ask-question custom-footer diff plan-mode review todo tool-rendering; do
  ln -sfn "$PWD/$ext" "$HOME/.pi/agent/extensions/$ext"
done
```

Then restart Pi, or run:

```text
/reload
```

## Update extensions

After making changes in this repo:

1. Commit changes:

```bash
git add .
git commit -m "Update pi extensions"
```

2. If this repo is pushed to a remote, pull latest on any machine where you use Pi:

```bash
git pull
```

Because the extensions are symlinked, Pi will pick up the updated files after restart or `/reload`.

## Add a new extension

1. Create a new folder (example: `my-extension/`) with an `index.ts` entrypoint.
2. Link it into Pi:

```bash
ln -sfn "$PWD/my-extension" "$HOME/.pi/agent/extensions/my-extension"
```

3. Restart Pi or run `/reload`.

## Uninstall an extension

Remove only the Pi link (keeps source code in this repo):

```bash
rm ~/.pi/agent/extensions/<extension-name>
```

## Notes

- `custom-footer` and `plan-mode` have their own README files with extension-specific usage.
- If an extension does not appear, confirm the symlink exists:

```bash
ls -la ~/.pi/agent/extensions
```
