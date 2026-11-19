# 配置

[English](configuration.md)

在 DSH 的插件页面打开 `@spectershell/dsh-harness-zcode` 即可调整以下选项。保存后，同一配置下使用 ZCode 预设的会话会在下次使用相应设置时采用新值，无需重启。

## 设置

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `searchMode` | `bash` | `bash` 隐藏 Glob 和 Grep，经由 shell 搜索，对应 ZCode 的内嵌搜索分支。`tools` 把 Glob 和 Grep 注册为独立工具。 |
| `surfaceAllow` | 空 | 额外保留的继承工具名称，用逗号或空格分隔。 |
| `headless` | 关 | 在无交互展示上下文的情况下运行。关闭记忆提取，且不改写已存储的字段。 |
| `memoryEnabled` | 开 | 启用 ZCode 记忆上下文。 |
| `memoryExtractionEnabled` | 开 | 从交互会话中提取持久记忆。 |
| `compactionEnabled` | 开 | 启用压缩上下文。 |
| `microcompactionEnabled` | 关 | 允许宿主在达到微压缩阈值后请求缩短较早的工具结果。 |
| `compactionThreshold` | 0.9 | 触发完全压缩的上下文压力比例，0.5 到 1。 |
| `microcompactionThreshold` | 0.7 | 宿主请求微压缩所需的最低上下文窗口使用比例，范围为 0.25 到 1。 |
| `memoryMaxBytes` | 32768 | 注入工作区记忆的最大 UTF-8 字节预算，1024 到 1048576。 |
| `workspaceMemoryRoot` | `.zcode/memory` | ZCode 记忆文件的工作区相对根目录。 |
