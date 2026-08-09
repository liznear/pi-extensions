# command-center

Pi extension that registers the `/cc` command (mission control for coordinated
agent work) plus `/cc` syntax highlighting (`extensions/cc-highlight.ts`).

`command-center` is **not a standalone package** — it has no `package.json`,
`tsconfig.json`, or `biome.json` of its own. It is developed, linted,
typechecked, and tested from the repository root as part of the `pi-extensions`
bundle:

- Install dependencies:

  ```bash
  bun install
  ```

  (run at the repository root; root `package.json` `devDependencies` cover
  `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, etc.)

- Lint / format / typecheck / test:

  ```bash
  bun run verify
  ```

  (runs `biome check .`, `tsc --noEmit`, and `bun test` from the root, covering
  this extension's sources and `core/__tests__`.)

- Install: `command-center` is registered in the root `package.json`
  `pi.extensions` manifest, so it is installed as part of the pi-extensions
  bundle (`pi install git:github.com/<owner>/pi-extensions`).
