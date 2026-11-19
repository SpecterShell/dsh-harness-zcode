# Memory

[简体中文](memory.zh-Hans.md)

The preset keeps durable project memory across sessions. It is on by default. This page covers how memory is stored, loaded and persisted, the defaults, and the limits.

## Storage

Memory lives under a workspace-relative root, `.zcode/memory` by default, configurable through `workspaceMemoryRoot`. Two files matter:

- `MEMORY.md` is the index. It is what gets injected into context.
- `FACTS.md` holds the durable facts the extraction writes, one Markdown bullet per fact. The index carries a pointer to it.

Extraction and injection resolve the same memory root from the sandbox policy's workspace root for the session, not from the current working directory. The root must be a non-blank, workspace-relative path, and the resolver enforces that the memory files stay inside the workspace root, including through symlink escapes. A session that changes its working directory keeps one memory root.

## Loading

On each request the preset reads `MEMORY.md` and injects it into context as a system reminder containing the recorded facts. The injected text is bounded by `memoryMaxBytes`, 32768 UTF-8 bytes by default. When the index exceeds the budget, the excess is cut and a truncation note is appended. If the index file does not exist, nothing is injected.

## Persistence

Extraction runs after an eligible interactive turn ends. It reads the recent conversation, asks the model for durable facts, merges them into `FACTS.md` without duplicating existing entries, and makes sure `MEMORY.md` points at the facts file. Writes go through the session's sandbox policy.

Extraction is skipped in three cases: when `headless` is on, when the turn already wrote memory directly, and when the turn failed. It does not run on every turn.

## Defaults

| Setting | Default | Effect |
| --- | --- | --- |
| `memoryEnabled` | On | Enables memory context. |
| `memoryExtractionEnabled` | On | Extracts durable memory from interactive sessions. |
| `memoryMaxBytes` | 32768 | Maximum UTF-8 byte budget for the injected index. |
| `workspaceMemoryRoot` | `.zcode/memory` | Workspace-relative root for memory files. |

`memoryExtractionEnabled` controls extraction independently of `memoryEnabled`. Sessions can still read existing memory with extraction turned off.

## Limitations

Upstream ZCode caps `MEMORY.md` at 200 lines and 25,000 characters. Its extraction subagent needs at least three words of eligible user prose and skips turns that already wrote memory. Its write tools are scoped to the memory directory. The preset uses the byte budget and turn rules described above. [Upstream index limits](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/core/src/memory/index-content.ts) · [Extraction rules](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/core/src/memory/extraction.ts)

- Memory is per workspace. Facts recorded in one workspace are not visible in another.
- The injected index is bounded. When it exceeds `memoryMaxBytes`, the excess is not injected.
- Extraction is not run on every turn. Turns without eligible user prose, failed turns, and turns that wrote memory directly are skipped.
- Local storage does not mean local inference. Extraction and the injected notes reach the configured model. Confidential project material requires an explicit approved model route.
- Sessions started in a subdirectory used to derive the memory root from the working directory, which could leave nested `.zcode/memory` directories under the workspace. The preset no longer creates these and does not discover, copy, move, merge or delete any that already exist. Migrating or consolidating them is a manual, operator-reviewed action.
