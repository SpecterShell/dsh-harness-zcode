# @spectershell/dsh-harness-zcode

[![CI](https://github.com/SpecterShell/dsh-harness-zcode/actions/workflows/ci.yml/badge.svg)](https://github.com/SpecterShell/dsh-harness-zcode/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@spectershell/dsh-harness-zcode)](https://www.npmjs.com/package/@spectershell/dsh-harness-zcode)

[简体中文](README.zh-Hans.md)

This bundle provides four ZCode presets for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). They share file tools, prompts and context management. [GitHub repository](https://github.com/SpecterShell/dsh-harness-zcode)

## Installation

```sh
dsh plugin --profile web add @spectershell/dsh-harness-zcode
```

The command installs the published package from [npm](https://www.npmjs.com/package/@spectershell/dsh-harness-zcode). After restarting DSH, the four ZCode presets are available when a session is started. The package requires DSH 0.2.2-rc.3 or a later 0.2 release and Node.js 24.9 or newer.

## Features

### Presets

| Preset | Description |
| --- | --- |
| **ZCode mode** (`zcode`) | Combines ZCode tools with tools from the active DSH profile. <ul><li>Hides the overlapping host tools `read`, `write`, `edit`, `glob`, `grep`, `bash` and `pwsh`.</li><li>Other profile tools remain available, including tools from plugins installed later.</li><li>Includes the `skill` loader, subagents, messaging and workflows.</li></ul> |
| **ZCode strict mode** (`zcode-strict`) | Limits the model to the ZCode tool set, skills and delegation. <ul><li>Provides `Read`, `Write`, `Edit` and `Bash`. Selecting tool search adds `Glob` and `Grep`.</li><li>Includes `skill` and the tools for subagents, messaging and workflows.</li><li>Hides unrelated tools contributed by profile plugins.</li></ul> |
| **ZCode PTC** (`zcode-ptc`) | The model writes one program per tool call. <ul><li>`run_code` is the only tool the model calls directly.</li><li>Within a program it can use the configured ZCode tools, for example to read several files in one call.</li><li>Programs can also delegate work through `subagent`, `subagent_fork` and `workflow`.</li></ul> |
| **ZCode Creator** (`zcode-creator`) | Extends strict mode with tools for developing DSH plugins. <ul><li>`cordis_inspect_list` and `cordis_inspect_query` expose the live runtime APIs.</li><li>The `skill` loader and delegation tools are available alongside the ZCode tools.</li><li>`plugin_manager` and `plugin_market` are available when the host supplies a profile context.</li></ul> |

User and project `AGENTS.md` files apply to all four presets.

### Tools

By default the agent searches through `Bash`. Set `searchMode` to `tools` to expose `Glob` and `Grep`. Each tool below links to its inputs and example outputs.

| Tool | What it does |
| --- | --- |
| [`Read`](docs/tools.md#read) | Reads a file with line numbers. Use `offset` and `limit` to read a range. |
| [`Write`](docs/tools.md#write) | Creates a file or replaces its contents. An existing file must be read before overwriting it. |
| [`Edit`](docs/tools.md#edit) | Replaces matching text in a file. The match must be unique unless `replace_all` is set. |
| [`Bash`](docs/tools.md#bash) | Runs a shell command. Later calls start in the working directory left by the previous call. |
| [`Glob`](docs/tools.md#glob) | Finds files whose paths match a glob pattern. |
| [`Grep`](docs/tools.md#grep) | Searches file contents with a regular expression. An optional glob limits the files searched. |

### Skills

ZCode mode, strict mode and Creator include the DSH `skill` tool. The agent can use it to load instructions for a skill available in the current profile.

### Persona

- [Persona prompt](src/context/index.ts#L46): Respects the selected permissions and adjusts when the user declines a tool call.
- [Working instructions](src/context/index.ts#L61): Cover project code style and how to report failed or skipped checks.

### Instructions

Put personal instructions in `~/.zcode/AGENTS.md` and project instructions in `AGENTS.md`. The preset loads the user file first, then searches upward from the working directory for the nearest project file within the project root. [Instruction discovery](src/context/instructions.ts)

### Compaction

At the default threshold of 90% of the context window, the preset summarizes conversation history and rereads up to five recent files that the agent still has permission to read. Use `/compact` to request a summary earlier. Optional microcompaction shortens older tool results for one model request and keeps the five newest eligible results intact. [Compaction guide and timeline](docs/compression.md)

### Workspace memory

Memory is enabled by default. The preset loads the index at `.zcode/memory/MEMORY.md` under the workspace root. After eligible interactive turns, it can save project facts in `FACTS.md` beside the index for later sessions. [Workspace memory guide](docs/memory.md)

## Settings

Open the bundle on the Plugins page to change search, memory and compaction settings. Saved values apply without a restart. [Configuration](docs/configuration.md)

## Documentation

- [Configuration](docs/configuration.md)
- [Tools](docs/tools.md)
- [Compression](docs/compression.md)
- [Workspace memory](docs/memory.md)
- [Benchmark](docs/benchmark.md)

## Development

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
