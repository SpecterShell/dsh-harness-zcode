# Configuration

[简体中文](configuration.zh-Hans.md)

Open `@spectershell/dsh-harness-zcode` on the DSH Plugins page to change these settings. ZCode sessions in the same profile pick up saved changes the next time they use the setting, so no restart is needed.

## Settings

| Field | Default | Effect |
| --- | --- | --- |
| `searchMode` | `bash` | `bash` hides Glob and Grep and searches through the shell, matching ZCode's embedded search branch. `tools` registers Glob and Grep as standalone tools. |
| `surfaceAllow` | Empty | Additional inherited tools to keep visible. Separate names with commas or spaces. |
| `headless` | Off | Runs without interactive presentation context. Turns memory extraction off without rewriting the stored field. |
| `memoryEnabled` | On | Enables ZCode memory context. |
| `memoryExtractionEnabled` | On | Extracts durable memory from interactive sessions. |
| `compactionEnabled` | On | Enables compaction context. |
| `microcompactionEnabled` | Off | Allows a host request to clear older tool results when the microcompaction threshold is met. |
| `compactionThreshold` | 0.9 | Context pressure ratio that triggers full compaction, 0.5 to 1. |
| `microcompactionThreshold` | 0.7 | Minimum fraction of the context window in use for a host microcompaction request, 0.25 to 1. |
| `memoryMaxBytes` | 32768 | Maximum UTF-8 byte budget for injected workspace memory, 1024 to 1048576. |
| `workspaceMemoryRoot` | `.zcode/memory` | Workspace-relative root for ZCode memory files. |
