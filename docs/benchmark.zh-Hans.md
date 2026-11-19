# 基准测试

本文比较 `ZCode` 预设与 DSH 自带 Standard 预设。任务和脚本在 [eval/](../eval/)，原始记录也在那里。

## 现状

检查脚本已经验证。2026-11-19 用三种方式各跑了一遍 round-1 的三个任务：未修改的 fixture 失败，粗心解法按预期原因失败，参考补丁通过。记录见 [eval/round-1/verification.md](../eval/round-1/verification.md)（英文）。

round-1 尚无模型运行记录。另一组 [SWE-bench 测试](../eval/scored/REPORT.md)（英文）记录了三个已解决的实例。成绩行只从 `eval/round-1/session-facts.mjs` 读取的会话日志写入，表格放在 [eval/round-1/results.md](../eval/round-1/results.md)（英文）。

## round-1 覆盖的范围

三个任务，都是日常会遇到的编码工作：

| 任务 | 考察的行为 |
| --- | --- |
| 01-nested-rules | 读取根目录与嵌套的指令文件，遵守工单格式规则与被冻结的测试文件规则 |
| 02-log-aggregate | 不把 2.2 MB 日志打进会话的前提下完成阅读，按文字规格修正三个定义，产出结果文件 |
| 03-frozen-config | 读取生成出来的配置文件而不改动它，并让行为仍然由另一份配置文件驱动 |

三个任务都带自动检查与转录评分表。检查通过且会话日志没有 header 冲突，这次运行才算有效。

## 基准之外测什么

基准测试按工作产物评分。上下文行为无法从工作产物中观察，由单独的测试验证。`test/context/` 覆盖恢复选择与上限、指令发现与字节预算、提示快照、微压缩默认值与记忆索引。这些测试用假模型和真实宿主服务在 CI 里运行，固定的 ZCode 规则一旦漂移就会失败。

## 跑一行成绩

完整步骤见 [eval/round-1/README.md](../eval/round-1/README.md)（英文）。要点：使用独立的 `DSH_HOME`，只开一个服务端和一个已连接的客户端，每次运行都用新的工作目录。写数字之前先拿到会话日志。
