# 工具

[English](tools.md)

预设挂载 Read、Write、Edit 和 Bash，以及 `searchMode` 为 `tools` 时的 Glob 和 Grep。默认 `searchMode: "bash"` 时，Glob 和 Grep 被隐藏，搜索经由 Bash 完成，对应 ZCode 的内嵌搜索分支。

输出取自执行器实际返回给模型的文本。示例中的工作区路径统一为 `/tmp/workspace`。

## Read

从本地文件系统读取文件。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `file_path` | string | 是 | 要读取文件的绝对路径。 |
| `offset` | number | 否 | 起始读取的 0 基行偏移。 |
| `limit` | number | 否 | 读取的行数。 |

默认最多读取 2000 行，拒绝超过 256 KiB 的文件。结果使用从 1 开始的 `cat -n` 风格行号。

### 示例

#### 偏移与行数

`offset` 为 1 且 `limit` 为 1 时，`Read` 只返回第 2 行 `beta`。偏移量从零开始。

文件内容 (`demo/hello.txt`)

```text
alpha
beta
gamma
```

输入

```json
{
  "file_path": "/tmp/workspace/demo/hello.txt",
  "offset": 1,
  "limit": 1
}
```

输出

```text
2	beta
```

#### 文件缺失

读取不存在的文件会返回 `File not found` 错误，并显示请求的路径。

输入

```json
{
  "file_path": "/tmp/workspace/demo/absent.txt"
}
```

输出

```text
Error: File not found: /tmp/workspace/demo/absent.txt
```

### 特殊情况

- 以换行结尾的文件当前会多渲染一个带行号的空行，空文件渲染为 `1	`。
- 以 UTF-8 BOM 开头的文件读取时不含 BOM：BOM 不会到达模型。

### 权限与沙箱

| | DSH 原生 | 上游 ZCode | 本预设 |
| --- | --- | --- | --- |
| 沙箱执行 | 会话访问模式，升级经批准提示 | 权限服务含 allow、ask、deny 行为、plan 模式策略和预批准规则 | 工具消费会话沙箱策略，自身不暴露升级参数 |
| 缺少执行提供方 | 不适用 | 不适用 | 缺少执行提供方时，工具行保持未注册，工具不会开放 |

### 文件读取跟踪

| | DSH 原生 | 上游 ZCode | 本预设 |
| --- | --- | --- | --- |
| 用于压缩恢复的逐文件触碰状态 | 未声明为预设行为 | 每个文件一条记录。Read、Write、Edit 会覆盖记录。仅在没有记录时，Bash 和 recall 才补一条 | 经 `ZCodeFileTouches` 按规范化路径和工具记录一条。只有 Read、Write、Edit 可用于恢复 |

### 文件编码

以下字节对照使用的上游和宿主版本见[证据范围](#证据范围)。

| 情况 | 上游 ZCode | DSH | 本预设 | 结论 |
| --- | --- | --- | --- | --- |
| 读取含 UTF-8 BOM 的文件 | `readTextFile` 把 BOM 作为前导字符返回（`efbbbf616c706861`） | `readText` 剥离它（`616c706861`） | 渲染无 BOM 的编号行（`1\talpha`） | 适配器读取层面的结果已证实。本预设的 Read 使用 DSH 的 `readText`，BOM 会在到达模型前被剥离 |
| 读取 UTF-16LE 文件 | 解码文本并记录编码 | 作为二进制文件拒绝 | 作为二进制文件拒绝 | 本预设无法观察该文件，也就不能执行受保护的 Edit 或 Write |

## Write

把文件写入本地文件系统，已存在时覆盖。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `file_path` | string | 是 | 要写入文件的绝对路径。 |
| `content` | string | 是 | 写入文件的内容。 |

### 示例

#### 创建

向新路径写入内容会创建 `created.txt`，文件包含 `content` 中的两行文本。

输入

```json
{
  "file_path": "/tmp/workspace/demo/created.txt",
  "content": "first\nsecond\n"
}
```

输出

```text
File created successfully at: /tmp/workspace/demo/created.txt (file state is current in your context — no need to Read it back)
```

#### 覆盖已存在文件

完整读取文件后，`Write` 会用新内容覆盖整个文件。本例将第二行改为 `SECOND`。

文件内容 (`demo/created.txt`)

```text
first
second
```

输入

```json
{
  "file_path": "/tmp/workspace/demo/created.txt",
  "content": "first\nSECOND\n"
}
```

输出

```text
The file /tmp/workspace/demo/created.txt has been updated successfully. (file state is current in your context — no need to Read it back)
```

### 文件编码

以下字节对照使用的上游和宿主版本见[证据范围](#证据范围)。

| 情况 | 上游 ZCode | DSH | 本预设 | 结论 |
| --- | --- | --- | --- | --- |
| Write 覆盖上的 UTF-8 BOM | 丢失（模型的字符串无 BOM，两个写入器都不合成） | 丢失 | 丢失 | 一致。三者的 Write 都不保留 BOM。上游仅在 Edit 时保留 BOM |
| 新文件上的 UTF-8 BOM | 无 BOM | 无 BOM | 无 BOM | 一致 |
| 已有 UTF-16LE 文件 | 检测 UTF-16LE，以不含 BOM 的 UTF-16LE 写入新文本 | 获得写入授权后，`writeText` 会写 UTF-8 | Read 将文件作为二进制拒绝，受保护的 Write 随后拒绝覆盖，原始字节保持不变 | 本预设在宿主转换之前关闭失败 |
| 在 CRLF 文件上写入 LF 负载 | 把文件的 CRLF 风格应用于负载（`6f6e650d0a...`） | 以 LF 写入负载（`6f6e650a...`） | 与 DSH 相同 | 上游在覆盖时应用文件原有风格。DSH 直接写入 LF 负载 |

- 覆盖已有文件需要先 Read。创建新文件不需要。
- 沙箱拒绝 Edit 或 Write 后，文件的 BOM 和 CRLF 字节保持不变。

## Edit

在文件中执行精确的字符串替换。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `file_path` | string | 是 | 要修改文件的绝对路径。 |
| `old_string` | string | 是 | 要替换的文本。 |
| `new_string` | string | 是 | 替换后的文本。 |
| `replace_all` | boolean | 否 | 替换所有出现的位置，默认为 false。 |

`old_string` 必须非空且不同于 `new_string`。默认操作要求精确且唯一的匹配。`replace_all` 为 true 时替换所有精确匹配。只有先完整 Read，才能编辑已有文件。部分、截断或超长的 Read 不授权编辑。

### 示例

#### 唯一替换

完整读取文件后，`Edit` 会将唯一匹配的 `beta` 替换为 `BETA`。

文件内容 (`demo/hello.txt`)

```text
alpha
beta
gamma
```

输入

```json
{
  "file_path": "/tmp/workspace/demo/hello.txt",
  "old_string": "beta",
  "new_string": "BETA"
}
```

输出

```text
The file /tmp/workspace/demo/hello.txt has been updated successfully.
```

#### 全部替换

读取文件后，设置 `replace_all: true` 可一次将两处 `same` 都替换为 `twice`。

文件内容 (`demo/repeat.txt`)

```text
same
same
```

输入

```json
{
  "file_path": "/tmp/workspace/demo/repeat.txt",
  "old_string": "same",
  "new_string": "twice",
  "replace_all": true
}
```

输出

```text
The file /tmp/workspace/demo/repeat.txt has been updated. All occurrences were successfully replaced.
```

#### 歧义匹配被拒绝

`same` 匹配两处且省略 `replace_all` 时，`Edit` 会报告匹配不唯一，两行内容均保持原样。

文件内容 (`demo/ambiguous.txt`)

```text
same
same
```

输入

```json
{
  "file_path": "/tmp/workspace/demo/ambiguous.txt",
  "old_string": "same",
  "new_string": "once"
}
```

输出

```text
Error: old_string matched 2 times in "/tmp/workspace/demo/ambiguous.txt"; provide a more specific old_string or set replace_all to true
```

#### 未经预先读取的编辑被拒绝

编辑本次会话尚未读取的文件会返回错误，提示先用 `Read` 读取文件。

文件内容 (`demo/unread.txt`)

```text
body
```

输入

```json
{
  "file_path": "/tmp/workspace/demo/unread.txt",
  "old_string": "body",
  "new_string": "other"
}
```

输出

```text
Error: edit requires reading "/tmp/workspace/demo/unread.txt" first
```

#### 外部改动后过期被拒绝

文件在上一次 `Read` 后发生变化，`Edit` 会拒绝修改。本例中，agent 读到 `before` 后，另一个进程追加了 `external`。

文件内容 (`demo/stale.txt`)

```text
before
external
```

输入

```json
{
  "file_path": "/tmp/workspace/demo/stale.txt",
  "old_string": "before",
  "new_string": "after"
}
```

输出

```text
Error: cannot edit "/tmp/workspace/demo/stale.txt": file changed since it was read
```

### 文件编码

以下字节对照使用的上游和宿主版本见[证据范围](#证据范围)。

| 情况 | 上游 ZCode | DSH | 本预设 | 结论 |
| --- | --- | --- | --- | --- |
| 统一 LF、统一 CRLF、混合 EOL、`old_string` 或 `new_string` 含 CRLF、`replace_all`、无尾随换行 | 重新应用检测到的风格 | 相同 | 相同 | 逐字节一致 |
| EOL 检测范围 | 在整个文件内统计 CRLF 与 LF（`tool/handlers/edit.ts:648-662`） | 仅采样前 4096 字节（`dsh-fs-local` `readForEdit`） | 继承 DSH 的采样 | 当首 4096 字节与整个文件占多数的风格相反时产生分歧 |
| Edit 上的 UTF-8 BOM | 保留 BOM（`efbbbf` 保留） | 丢弃 BOM | 丢弃 BOM | `dsh-fs-local` 中的字节级数据丢失，位于本预设之下 |
| UTF-16LE | 读取、编辑并重写，BOM 保持完整 | 作为二进制文件拒绝 | 作为二进制文件拒绝 | 不支持对 UTF-16LE 文件执行 Edit |

- 编辑已有文件前需要完整 Read。没有观察记录时，编辑以 `FS_NOT_OBSERVED` 关闭失败。部分、截断或超长的 Read 不授权修改。
- 外部改动之后的 Edit 作为过期被拒绝，且不做任何改动。
- 沙箱拒绝 Edit 或 Write 后，文件的 BOM 和 CRLF 字节保持不变。

### 证据范围

上游字节结果来自 `zai-org/ZCode` 的 `fec975905a2abd4c07e35c40d51fa097a2258ec9` 提交。对照按处理器顺序调用真实的 `NodeFileSystemAdapter` 读写方法、编辑匹配器和规范化器，没有运行完整的上游 `editHandler`，因此不覆盖它的读取门控、权限服务、批准流程和跟踪。DSH 结果使用 0.2.2-rc.3 中真实的 `dsh-fs-local` 服务。本预设的授权和修改行为由 `test/tools/editing.test.ts` 与 `test/tools/editing-entry.test.ts` 覆盖，测试经过注册工具行、随包提供的观察策略和原生执行器。

适配器对照在 Node.js 24.22.2 和一套本地文件系统上运行，不覆盖网络文件系统、超大文件和 ApplyPatch。EOL 检测、BOM 移除和 UTF-16 二进制处理都来自本预设委托的 `dsh-fs-local`。

## Bash

执行 Bash 命令。会话工作目录跨调用保留。每次调用使用新的 shell，不继承上一次调用的变量和函数。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `command` | string | 是 | 要执行的命令。 |
| `timeout` | number | 否 | 可选超时时间（毫秒），1 到 600000，默认 120000。 |
| `description` | string | 否 | 对该命令作用的清晰简洁描述。 |

工作目录通过命令退出时打印的标记进行跟踪，并在下一次调用时重新应用。`searchMode: "bash"` 时，前导脚本定义 `find()` 和 `grep()` 两个 shell 函数，且 `grep()` 在安装了 `rg` 时优先使用它。stdout 输出上限为 30000 字节。输出报告 stdout、stderr、`completed`、`failed`、`cancelled` 或 `spawn_error` 之一的状态、退出码或信号、命令是否被中断，以及任一流是否被截断。

### 示例

#### 简单命令

该命令输出 `hello`，退出码为 0。

输入

```json
{
  "command": "printf \"hello\\n\""
}
```

输出

```text
hello

[exit code: 0]
```

#### 工作目录跨调用保留

`cd demo` 成功后，在下一次 `Bash` 调用中执行 `pwd` 会输出 `/tmp/workspace/demo`。

输入

```json
{
  "command": "cd demo && pwd"
}
```

输出

```text
/tmp/workspace/demo

[exit code: 0]
```

紧随其后的第二次调用：

```json
{
  "command": "pwd"
}
```

输出

```text
/tmp/workspace/demo

[exit code: 0]
```

#### 搜索前导

在 Bash 搜索模式下，`grep` 输出匹配行，`find` 列出 `demo` 下的 TypeScript 文件路径。

文件内容 (`demo/nested/find-me.ts`)

```text
export const needle = 1
```

文件内容 (`demo/nested/other.ts`)

```text
nothing here
```

输入

```json
{
  "command": "grep -n needle demo/nested/find-me.ts; find demo -name \"*.ts\" | head -2"
}
```

输出

```text
1:export const needle = 1
demo/nested/other.ts
demo/nested/find-me.ts

[exit code: 0]
```

#### 非零退出与 stderr

命令以退出码 3 结束时，`Bash` 会返回标准输出和标准错误，并显示 `[exit code: 3]`。

输入

```json
{
  "command": "printf \"out\\n\"; printf \"err\\n\" >&2; exit 3"
}
```

输出

```text
out

err

[exit code: 3]
```

#### 超时

100 毫秒的超时限制会终止运行五秒的命令，输出显示 `[exit code: signal]`。默认时限为 120000 毫秒，上限为 600000 毫秒。

输入

```json
{ "command": "sleep 5", "timeout": 100 }
```

输出

```text
[exit code: signal]
```

### 特殊情况

- 输出的各部分以空行连接：先是 stdout，再是 stderr，最后是退出行。
- 输出超过字节预算时，shell 会溢出完整捕获，下一次调用仍能恢复工作目录。如果截断时没有溢出文件，下一次调用会丢失工作目录。

### 工作目录与 shell 状态

| | DSH 原生 | 上游 ZCode | 本预设 |
| --- | --- | --- | --- |
| 跨 Bash 调用的工作目录 | 每次调用新建 shell | 保留。导出的变量和函数不保留 | 通过退出时打印的 `__ZCODE_CWD__` 标记保留，并在下一次调用时重新应用 |

## Glob

按模式匹配文件。`searchMode` 为 `tools` 时可用。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pattern` | string | 是 | 用于匹配文件的 glob 模式。 |
| `path` | string | 否 | 要搜索的目录。省略时为当前工作目录。 |

返回按修改时间排序的匹配文件路径，至多 100 条。

### 示例

#### 模式匹配

模式 `**/*.ts` 返回两个 TypeScript 文件相对于 `demo` 的路径。

文件内容 (`demo/nested/find-me.ts`)

```text
export const needle = 1
```

文件内容 (`demo/nested/other.ts`)

```text
nothing here
```

输入

```json
{
  "pattern": "**/*.ts",
  "path": "/tmp/workspace/demo"
}
```

输出

```text
nested/find-me.ts
nested/other.ts
```

### 特殊情况

- 结果上限为 100 条。达到上限时顺序按修改时间，同一时刻创建的文件并列。排列顺序可能变化，数量上限保持稳定。

### 搜索面

上游 ZCode 在启用内嵌搜索且 Bash 可用时隐藏 `Glob` 和 `Grep`。shell 方言决定 Bash 能否注入 `find` 和 `grep` 函数。仅切换方言不会改变工具的可见性。[工具注册](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/core/src/runtime/methods/embedded-search-branch.ts) · [shell 方言](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/core/src/embedded-search/shell.ts)

| | DSH 原生 | 上游 ZCode | 本预设 |
| --- | --- | --- | --- |
| Glob 和 Grep 可见性 | 优先使用专用 read/glob/grep | 当 Bash 搜索可用时，内嵌搜索分支隐藏 Glob 和 Grep | `searchMode: "bash"`（默认）隐藏二者。`searchMode: "tools"` 注册二者 |
| 搜索后端 | 系统工具 | 优先使用捆绑的 `bfs` 和 `ugrep`，ripgrep 用 `rg`，并以系统工具回退 | 使用系统的 `find` 和 `rg`/`grep`，不附带二进制文件 |

## Grep

用正则表达式搜索文件内容。`searchMode` 为 `tools` 时可用。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pattern` | string | 是 | 用于搜索文件内容的正则表达式。 |
| `path` | string | 否 | 要搜索的文件或目录，默认为当前工作目录。 |
| `glob` | string | 否 | 用于过滤文件的 glob 模式。 |
| `output_mode` | string | 否 | `content`、`files_with_matches` 或 `count`，默认为 `files_with_matches`。 |
| `-i` | boolean | 否 | 不区分大小写的搜索。 |
| `head_limit` | number | 否 | 默认为 250。设为 0 时不限制结果数量。 |
| `offset` | number | 否 | 在应用 `head_limit` 之前跳过条目。 |

基于兼容 ripgrep 的正则表达式。

### 示例

#### 内容匹配

在内容模式下搜索 `needle` 会返回匹配行，并标明文件路径和行号。

文件内容 (`demo/nested/find-me.ts`)

```text
export const needle = 1
```

输入

```json
{
  "pattern": "needle",
  "path": "/tmp/workspace/demo",
  "output_mode": "content"
}
```

输出

```text
/tmp/workspace/demo/nested/find-me.ts:1:export const needle = 1
```

#### Glob 过滤

使用 `*.ts` 过滤后，`Grep` 返回包含 `needle` 的 TypeScript 文件路径。

文件内容 (`demo/nested/find-me.ts`)

```text
export const needle = 1
```

输入

```json
{
  "pattern": "needle",
  "path": "/tmp/workspace/demo",
  "glob": "*.ts"
}
```

输出

```text
nested/find-me.ts
```

### 特殊情况

- 路径风格取决于输出模式。`content` 返回绝对路径。`files_with_matches` 和 glob 过滤返回工作区相对路径。
