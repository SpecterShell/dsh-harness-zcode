# @spectershell/dsh-harness-zcode

[![CI](https://github.com/SpecterShell/dsh-harness-zcode/actions/workflows/ci.yml/badge.svg)](https://github.com/SpecterShell/dsh-harness-zcode/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@spectershell/dsh-harness-zcode)](https://www.npmjs.com/package/@spectershell/dsh-harness-zcode)

[English](README.md)

本包为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供四种 ZCode 预设，共用文件工具、提示词和上下文管理机制。[GitHub 仓库](https://github.com/SpecterShell/dsh-harness-zcode)

## 安装

```sh
dsh plugin --profile web add @spectershell/dsh-harness-zcode
```

该命令从 [npm](https://www.npmjs.com/package/@spectershell/dsh-harness-zcode) 安装已发布的包。重启 DSH 后，新建会话时可选择四种 ZCode 预设。本包要求 DSH 0.2.2-rc.3 或更高的 0.2 版本，以及 Node.js 24.9 或更高版本。

## 功能

### 预设

| 预设 | 说明 |
| --- | --- |
| **ZCode mode** (`zcode`) | 可同时使用 ZCode 工具和当前 DSH 配置中的工具。<ul><li>隐藏功能重叠的宿主工具 `read`、`write`、`edit`、`glob`、`grep`、`bash` 和 `pwsh`。</li><li>其余工具照常可用，包括之后安装的插件提供的工具。</li><li>可用 `skill` 加载技能，也可使用子 agent、消息和工作流委派任务。</li></ul> |
| **ZCode strict mode** (`zcode-strict`) | 工具范围限于 ZCode 工具、技能加载和任务委派。<ul><li>提供 `Read`、`Write`、`Edit` 和 `Bash`。选用独立搜索工具后，还可使用 `Glob` 和 `Grep`。</li><li>提供 `skill`，并支持通过子 agent、消息和工作流委派任务。</li><li>隐藏配置中其他插件提供的无关工具。</li></ul> |
| **ZCode PTC** (`zcode-ptc`) | 模型每次调用工具时编写一个程序。<ul><li>模型只直接调用 `run_code`。</li><li>程序内可使用当前启用的 ZCode 工具，例如在一次调用中读取多个文件。</li><li>程序也可通过 `subagent`、`subagent_fork` 和 `workflow` 委派任务。</li></ul> |
| **ZCode Creator** (`zcode-creator`) | 在严格模式的基础上提供开发 DSH 插件所需的工具。<ul><li>可用 `cordis_inspect_list` 和 `cordis_inspect_query` 查询运行中的接口。</li><li>除 ZCode 工具外，还可使用 `skill` 加载技能或通过委派工具分配任务。</li><li>宿主提供配置上下文时，可使用 `plugin_manager` 和 `plugin_market`。</li></ul> |

用户级和项目级 `AGENTS.md` 均适用于这四种预设。

### 工具

默认通过 `Bash` 搜索。将 `searchMode` 设为 `tools` 即可启用 `Glob` 和 `Grep`。点击工具名可查看参数和输入输出示例。

| 工具 | 用途 |
| --- | --- |
| [`Read`](docs/tools.zh-Hans.md#read) | 读取文件并显示行号。可用 `offset` 和 `limit` 指定行范围。 |
| [`Write`](docs/tools.zh-Hans.md#write) | 新建文件或覆盖全部内容。覆盖已有文件前须先读取该文件。 |
| [`Edit`](docs/tools.zh-Hans.md#edit) | 替换文件中匹配的文本。默认要求匹配位置唯一，设置 `replace_all` 可替换全部匹配项。 |
| [`Bash`](docs/tools.zh-Hans.md#bash) | 执行 shell 命令。下次调用从上一次命令结束时的工作目录开始。 |
| [`Glob`](docs/tools.zh-Hans.md#glob) | 按 glob 模式查找路径匹配的文件。 |
| [`Grep`](docs/tools.zh-Hans.md#grep) | 用正则表达式搜索文件内容，可用 glob 模式限定文件范围。 |

### 技能

ZCode mode、严格模式和 Creator 均提供 DSH 的 `skill` 工具。agent 可按需加载当前配置中可用的技能说明。

### 角色设定

- [角色提示词](src/context/index.ts#L46)：遵守当前权限，在用户拒绝工具调用后调整做法。
- [行为提示词](src/context/index.ts#L61)：遵循项目代码风格，并说明哪些检查失败或被跳过。

### 指令文件

个人指令放在 `~/.zcode/AGENTS.md`，项目指令放在 `AGENTS.md`。预设先读取个人指令，再从当前工作目录向上查找最近的项目指令文件，最远查到项目根目录。[指令文件查找逻辑](src/context/instructions.ts)

### 压缩

上下文用量达到默认阈值（窗口的 90%）后，预设会总结对话历史，并重新读取最近使用且仍有读取权限的文件，最多五个。也可用 `/compact` 提前生成摘要。微压缩默认关闭，启用后可为单次模型请求缩短较早的工具结果，保留最近五条符合条件的结果。[压缩指南和会话时间线](docs/compression.zh-Hans.md)

### 工作区记忆

记忆默认开启。预设从工作区根目录下的 `.zcode/memory/MEMORY.md` 读取索引。符合条件的交互轮次结束后，预设可将项目事实写入同目录下的 `FACTS.md`，供后续会话查阅。[工作区记忆指南](docs/memory.zh-Hans.md)

## 设置

在插件页面打开本包可调整搜索、记忆和压缩设置，保存后立即生效，无需重启。各字段说明见 [配置说明](docs/configuration.zh-Hans.md)。

## 文档

- [配置](docs/configuration.zh-Hans.md)
- [工具](docs/tools.zh-Hans.md)
- [压缩](docs/compression.zh-Hans.md)
- [工作区记忆](docs/memory.zh-Hans.md)
- [基准测试](docs/benchmark.zh-Hans.md)

## 开发

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

## 许可证

[Apache License 2.0](LICENSE)。归属说明见 [NOTICE](NOTICE)（英文）。
