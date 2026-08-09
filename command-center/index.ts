// Command Center — pi extension entry point.
//
// The pi-extensions repo convention is one folder per extension with an
// index.ts entry (auto-discovered as ~/.pi/agent/extensions/command-center).
// The extension itself lives in extensions/cc.ts and this file just re-exports
// it.
//
// command-center is not a standalone package: it is developed, linted,
// typechecked, and tested from the repo root via the root package.json scripts
// (e.g. `bun run verify`), and installed as part of the pi-extensions bundle
// via the root package.json `pi.extensions` manifest.
//
// NOTE: extensions/cc-highlight.ts is a second, independent extension (/cc
// syntax highlighting) and is registered separately in the package manifest.
export { default } from "./extensions/cc"
