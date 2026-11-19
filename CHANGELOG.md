# Changelog

## 0.2.0 (2026-11-19)

- `Bash` shows terminal output and an exit badge for failed commands. `Read` shows numbered lines. `Write` and `Edit` show the changes applied to disk. `Glob` and `Grep` show matching paths and search results.
- All four ZCode presets now allow an edit or overwrite after a complete read of the current file. An overwrite of an existing file still requires a current observation.
- New sessions save prompt snapshots in a format DSH can replay when the web client reloads. Sessions saved by 0.1.0 with the older snapshot event may still fail to open.

## 0.1.0 (2026-11-19)

First release of the ZCode presets for DeepSeek Harness.

- Four presets: ZCode mode, ZCode strict mode, ZCode PTC and ZCode Creator.
- Read, Write, Edit and Bash tools, with optional standalone Glob and Grep.
- Context assembly from stable and dynamic sections, with instruction file injection and re-read on session start and compaction.
- Compaction with a bounded restore of recently used files, and optional microcompaction off by default.
- Workspace memory under `.zcode/memory` with an injected `MEMORY.md` index, on by default and gated in headless mode.
