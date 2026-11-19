# Tools

[简体中文](tools.zh-Hans.md)

The preset mounts Read, Write, Edit and Bash, plus Glob and Grep when `searchMode` is `tools`. With the default `searchMode: "bash"`, Glob and Grep are hidden and search runs through Bash, matching ZCode's embedded search branch.

The output blocks show the text returned by the executor. Examples use `/tmp/workspace` for the workspace path.

## Read

Reads a file from the local filesystem.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `file_path` | string | yes | The absolute path to the file to read. |
| `offset` | number | no | The 0-based line offset to start reading from. |
| `limit` | number | no | The number of lines to read. |

Reads up to 2000 lines by default and rejects files over 256 KiB. Results use `cat -n` style line numbers starting at 1.

### Examples

#### Offset and limit

With `offset: 1` and `limit: 1`, `Read` returns only line 2, `beta`. Offsets start at zero.

File contents (`demo/hello.txt`)

```text
alpha
beta
gamma
```

Input

```json
{
  "file_path": "/tmp/workspace/demo/hello.txt",
  "offset": 1,
  "limit": 1
}
```

Output

```text
2	beta
```

#### Missing file

Reading a file that does not exist returns a `File not found` error with the requested path.

Input

```json
{
  "file_path": "/tmp/workspace/demo/absent.txt"
}
```

Output

```text
Error: File not found: /tmp/workspace/demo/absent.txt
```

### Special cases

- A file that ends in a trailing newline currently renders one extra numbered blank line, and an empty file renders `1	`.
- A file that starts with a UTF-8 BOM reads without the BOM: the BOM never reaches the model.

### Permissions and sandbox

| | DSH native | Upstream ZCode | This preset |
| --- | --- | --- | --- |
| Sandbox enforcement | Session access mode with an approval prompt for escalation | A permission service with allow, ask and deny behaviors, plan-mode policy and preapproved rules | Tools consume the session sandbox policy and expose no escalation arguments of their own |
| Missing enforcement provider | n/a | n/a | The tool row remains unregistered, which prevents fail-open execution |

### File read tracking

| | DSH native | Upstream ZCode | This preset |
| --- | --- | --- | --- |
| Per-file touch state for compaction restore | Not declared as a preset behavior | One record per file. Read, Write and Edit overwrite it. Bash and recall fill it only when no record exists | One record per canonical path and tool via `ZCodeFileTouches`. Only Read, Write and Edit qualify for restore |

### File encoding

These byte comparisons use the pinned upstream and host versions described under [Evidence limits](#evidence-limits).

| Case | Upstream ZCode | DSH | This preset | Verdict |
| --- | --- | --- | --- | --- |
| Read a file with a UTF-8 BOM | `readTextFile` returns the BOM as a leading character (`efbbbf616c706861`) | `readText` strips it (`616c706861`) | renders numbered lines without it (`1\talpha`) | proven at the adapter read level. The preset Read uses DSH's `readText`, which strips the BOM before it reaches the model |
| Read a UTF-16LE file | decodes the text and records its encoding | rejects it as binary | rejects it as binary | the preset cannot observe the file for a guarded Edit or Write |

## Write

Writes a file to the local filesystem, overwriting if one exists.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `file_path` | string | yes | The absolute path to the file to write. |
| `content` | string | yes | The content to write to the file. |

### Examples

#### Create

Writing to a new path creates `created.txt` with the two lines supplied in `content`.

Input

```json
{
  "file_path": "/tmp/workspace/demo/created.txt",
  "content": "first\nsecond\n"
}
```

Output

```text
File created successfully at: /tmp/workspace/demo/created.txt (file state is current in your context — no need to Read it back)
```

#### Overwrite existing

After a full `Read`, `Write` replaces the file contents. Here the second line changes to `SECOND`.

File contents (`demo/created.txt`)

```text
first
second
```

Input

```json
{
  "file_path": "/tmp/workspace/demo/created.txt",
  "content": "first\nSECOND\n"
}
```

Output

```text
The file /tmp/workspace/demo/created.txt has been updated successfully. (file state is current in your context — no need to Read it back)
```

### File encoding

These byte comparisons use the pinned upstream and host versions described under [Evidence limits](#evidence-limits).

| Case | Upstream ZCode | DSH | This preset | Verdict |
| --- | --- | --- | --- | --- |
| UTF-8 BOM on Write overwrite | lost (the model's string has no BOM and neither writer synthesizes one) | lost | lost | agree. All three Write implementations lose the BOM. Upstream preserves it only during Edit |
| UTF-8 BOM on a new file | no BOM | no BOM | no BOM | agree |
| Existing UTF-16LE file | detects UTF-16LE and writes the new text in UTF-16LE without a BOM | `writeText` writes UTF-8 when called with write authorization | Read rejects the file as binary, so the guarded Write is refused and leaves the bytes unchanged | the preset fails closed before host conversion |
| Write an LF payload over a CRLF file | applies the file's CRLF style to the payload (`6f6e650d0a...`) | writes the payload as LF (`6f6e650a...`) | same as DSH | upstream applies the file style on overwrite. DSH writes the LF payload unchanged |

- Overwriting an existing file requires a prior Read. Creating a new file does not.
- A sandbox-denied Edit or Write leaves the file's BOM and CRLF bytes unchanged.

## Edit

Performs exact string replacement in a file.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `file_path` | string | yes | The absolute path to the file to modify. |
| `old_string` | string | yes | The text to replace. |
| `new_string` | string | yes | The replacement text. |
| `replace_all` | boolean | no | Replace all occurrences. Defaults to false. |

`old_string` must be non-empty and differ from `new_string`. The default operation requires one exact, unique match. Setting `replace_all` to true replaces every exact match. Only a prior complete Read authorizes editing an existing file. Partial, truncated and oversized reads do not authorize the edit.

### Examples

#### Unique replacement

After a full `Read`, `Edit` replaces the single occurrence of `beta` with `BETA`.

File contents (`demo/hello.txt`)

```text
alpha
beta
gamma
```

Input

```json
{
  "file_path": "/tmp/workspace/demo/hello.txt",
  "old_string": "beta",
  "new_string": "BETA"
}
```

Output

```text
The file /tmp/workspace/demo/hello.txt has been updated successfully.
```

#### Replace all

With `replace_all: true`, one edit changes both occurrences of `same` to `twice` after the file has been read.

File contents (`demo/repeat.txt`)

```text
same
same
```

Input

```json
{
  "file_path": "/tmp/workspace/demo/repeat.txt",
  "old_string": "same",
  "new_string": "twice",
  "replace_all": true
}
```

Output

```text
The file /tmp/workspace/demo/repeat.txt has been updated. All occurrences were successfully replaced.
```

#### Ambiguous match refused

If `same` matches twice and `replace_all` is omitted, `Edit` reports the ambiguous match and leaves both lines unchanged.

File contents (`demo/ambiguous.txt`)

```text
same
same
```

Input

```json
{
  "file_path": "/tmp/workspace/demo/ambiguous.txt",
  "old_string": "same",
  "new_string": "once"
}
```

Output

```text
Error: old_string matched 2 times in "/tmp/workspace/demo/ambiguous.txt"; provide a more specific old_string or set replace_all to true
```

#### Edit without a prior read refused

Editing a file before reading it in the session returns an error asking for a `Read` first.

File contents (`demo/unread.txt`)

```text
body
```

Input

```json
{
  "file_path": "/tmp/workspace/demo/unread.txt",
  "old_string": "body",
  "new_string": "other"
}
```

Output

```text
Error: edit requires reading "/tmp/workspace/demo/unread.txt" first
```

#### Stale after external change refused

`Edit` rejects the change if the file has changed since the last `Read`. Here another process appended `external` after the agent read `before`.

File contents (`demo/stale.txt`)

```text
before
external
```

Input

```json
{
  "file_path": "/tmp/workspace/demo/stale.txt",
  "old_string": "before",
  "new_string": "after"
}
```

Output

```text
Error: cannot edit "/tmp/workspace/demo/stale.txt": file changed since it was read
```

### File encoding

These byte comparisons use the pinned upstream and host versions described under [Evidence limits](#evidence-limits).

| Case | Upstream ZCode | DSH | This preset | Verdict |
| --- | --- | --- | --- | --- |
| Uniform LF, uniform CRLF, mixed EOL, CRLF in `old_string` or `new_string`, `replace_all`, no trailing newline | re-applies the detected style | same | same | agree byte for byte |
| EOL detection scope | counts CRLF vs LF across the whole file (`tool/handlers/edit.ts:648-662`) | samples only the first 4096 bytes (`dsh-fs-local` `readForEdit`) | inherits the DSH sample | diverge on a file whose first 4096 bytes and whole file have opposite majorities |
| UTF-8 BOM on Edit | keeps the BOM (`efbbbf` preserved) | drops the BOM | drops the BOM | byte-level data loss in `dsh-fs-local`, below the preset |
| UTF-16LE | reads, edits and rewrites with the BOM intact | refuses the file as binary | refuses the file as binary | UTF-16LE Edit is unsupported |

- An existing file requires a prior complete Read before Edit. With no observation row, the edit fails closed with `FS_NOT_OBSERVED`. Partial, truncated and oversized reads do not authorize the mutation.
- An Edit after an external change is refused as stale and changes nothing.
- A sandbox-denied Edit or Write leaves the file's BOM and CRLF bytes unchanged.

### Evidence limits

The upstream byte results use `zai-org/ZCode` commit `fec975905a2abd4c07e35c40d51fa097a2258ec9`. The comparison called the real `NodeFileSystemAdapter` read and write methods plus the edit matcher and normalizer in handler order. It did not run the full upstream `editHandler`, including its read gate, permission service, approval flow and tracing. DSH results use the real `dsh-fs-local` service from 0.2.2-rc.3. Preset authorization and mutation behavior is covered through the registered rows, shipped observation policy and native executor in `test/tools/editing.test.ts` and `test/tools/editing-entry.test.ts`.

The adapter comparison ran on one local filesystem with Node.js 24.22.2. Network filesystems, very large files and ApplyPatch were outside its scope. EOL detection, BOM removal and UTF-16 binary handling come from `dsh-fs-local`, which this preset delegates to.

## Bash

Executes a Bash command. The session working directory persists across calls. Each call starts a fresh shell without variables or functions from the previous call.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `command` | string | yes | The command to execute. |
| `timeout` | number | no | Optional timeout in milliseconds, 1 to 600000. Defaults to 120000. |
| `description` | string | no | Clear, concise description of what the command does. |

The working directory is tracked through a marker printed when the command exits and re-applied on the next call. With `searchMode: "bash"`, a prelude defines `find()` and `grep()` shell functions, and `grep()` prefers `rg` when it is installed. Output is bounded to 30000 bytes for stdout. The output reports stdout, stderr, a status of `completed`, `failed`, `cancelled` or `spawn_error`, the exit code or signal, whether the command was interrupted, and whether either stream was truncated.

### Examples

#### Simple command

The command prints `hello` and exits with code 0.

Input

```json
{
  "command": "printf \"hello\\n\""
}
```

Output

```text
hello

[exit code: 0]
```

#### Working directory persists across calls

After `cd demo` succeeds, `pwd` in the next `Bash` call prints `/tmp/workspace/demo`.

Input

```json
{
  "command": "cd demo && pwd"
}
```

Output

```text
/tmp/workspace/demo

[exit code: 0]
```

Second input

```json
{
  "command": "pwd"
}
```

Output

```text
/tmp/workspace/demo

[exit code: 0]
```

#### Search prelude

In Bash search mode, `grep` prints the matching line and `find` lists the TypeScript paths under `demo`.

File contents (`demo/nested/find-me.ts`)

```text
export const needle = 1
```

File contents (`demo/nested/other.ts`)

```text
nothing here
```

Input

```json
{
  "command": "grep -n needle demo/nested/find-me.ts; find demo -name \"*.ts\" | head -2"
}
```

Output

```text
1:export const needle = 1
demo/nested/other.ts
demo/nested/find-me.ts

[exit code: 0]
```

#### Non-zero exit with stderr

A command that exits with code 3 returns both output streams and reports `[exit code: 3]`.

Input

```json
{
  "command": "printf \"out\\n\"; printf \"err\\n\" >&2; exit 3"
}
```

Output

```text
out

err

[exit code: 3]
```

#### Timeout

A 100 ms timeout stops the five-second command and reports `[exit code: signal]`. The default timeout is 120000 ms and the maximum is 600000 ms.

Input

```json
{ "command": "sleep 5", "timeout": 100 }
```

Output

```text
[exit code: signal]
```

### Special cases

- Parts of the output are joined with a blank line: stdout, then stderr, then the exit line.
- When output exceeds the byte budget, the shell spills the full capture and recovers the working directory for the next call. If truncation occurs without a spill, the next call loses the working directory.

### Working directory and shell state

| | DSH native | Upstream ZCode | This preset |
| --- | --- | --- | --- |
| Working directory across Bash calls | Fresh command shell per call | Persists. Exported variables and functions do not | Persists via a `__ZCODE_CWD__` marker printed on exit and re-applied next call |

## Glob

Matches files by pattern. Available when `searchMode` is `tools`.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `pattern` | string | yes | The glob pattern to match files against. |
| `path` | string | no | The directory to search in. Omit for the current working directory. |

Returns matching file paths sorted by modification time, up to 100 entries.

### Examples

#### Pattern match

The pattern `**/*.ts` returns both TypeScript file paths relative to `demo`.

File contents (`demo/nested/find-me.ts`)

```text
export const needle = 1
```

File contents (`demo/nested/other.ts`)

```text
nothing here
```

Input

```json
{
  "pattern": "**/*.ts",
  "path": "/tmp/workspace/demo"
}
```

Output

```text
nested/find-me.ts
nested/other.ts
```

### Special cases

- Results are capped at 100 entries. At the cap the order follows modification time, and files created at the same instant tie. The order can therefore vary. The entry limit is stable.

### Search surface

Upstream ZCode hides `Glob` and `Grep` when embedded search is enabled and Bash is available. The shell dialect controls whether Bash receives the `find` and `grep` functions. Changing the dialect alone does not change tool visibility. [Tool registration](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/core/src/runtime/methods/embedded-search-branch.ts) · [Shell dialects](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/core/src/embedded-search/shell.ts)

| | DSH native | Upstream ZCode | This preset |
| --- | --- | --- | --- |
| Glob and Grep visibility | Dedicated read/glob/grep preferred | Embedded search branch hides Glob and Grep when Bash search is available | `searchMode: "bash"` (default) hides them. `searchMode: "tools"` registers them |
| Search backend | System tools | Prefers bundled `bfs` and `ugrep`, with `rg` for ripgrep and system fallback | System `find` and `rg`/`grep`. Uses no bundled binaries |

## Grep

Searches file contents with regular expressions. Available when `searchMode` is `tools`.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `pattern` | string | yes | The regular expression pattern to search for in file contents. |
| `path` | string | no | File or directory to search. Defaults to the current working directory. |
| `glob` | string | no | Glob pattern to filter files. |
| `output_mode` | string | no | `content`, `files_with_matches` or `count`. Defaults to `files_with_matches`. |
| `-i` | boolean | no | Case insensitive search. |
| `head_limit` | number | no | Defaults to 250. Use 0 for unlimited results. |
| `offset` | number | no | Skip entries before applying `head_limit`. |

Built on ripgrep-compatible regular expressions.

### Examples

#### Content match

Searching for `needle` in content mode returns the matching line with its path and line number.

File contents (`demo/nested/find-me.ts`)

```text
export const needle = 1
```

Input

```json
{
  "pattern": "needle",
  "path": "/tmp/workspace/demo",
  "output_mode": "content"
}
```

Output

```text
/tmp/workspace/demo/nested/find-me.ts:1:export const needle = 1
```

#### Glob filter

With the `*.ts` filter, `Grep` returns the path of the TypeScript file containing `needle`.

File contents (`demo/nested/find-me.ts`)

```text
export const needle = 1
```

Input

```json
{
  "pattern": "needle",
  "path": "/tmp/workspace/demo",
  "glob": "*.ts"
}
```

Output

```text
nested/find-me.ts
```

### Special cases

- Path style depends on the output mode. `content` returns absolute paths. `files_with_matches` and the glob filter return workspace-relative paths.
