// Command Center — pi extension entry point.
//
// The pi-extensions repo convention is one folder per extension with an
// index.ts entry (auto-discovered as ~/.pi/agent/extensions/command-center).
// The extension itself lives in extensions/cc.ts and is kept in sync with the
// command-center-manual repo; this file just re-exports it.
//
// NOTE: extensions/cc-highlight.ts is a second, independent extension (/cc
// syntax highlighting) and is registered separately in the package manifest.
export { default } from "./extensions/cc"
