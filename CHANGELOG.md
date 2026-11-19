# Changelog

## 0.1.0 (2026-11-19)

First release of the ZCode presets for DeepSeek Harness.

- Four presets: ZCode mode, ZCode strict mode, ZCode PTC and ZCode Creator.
- Read, Write, Edit and Bash tools, with optional standalone Glob and Grep.
- Context assembly from stable and dynamic sections, with instruction file injection and re-read on session start and compaction.
- Compaction with a bounded restore of recently used files, and optional microcompaction off by default.
- Workspace memory under `.zcode/memory` with an injected `MEMORY.md` index, on by default and gated in headless mode.
