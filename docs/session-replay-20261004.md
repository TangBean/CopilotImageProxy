# Main session 再次失败的修复

日期：2026-10-04，新加坡时间（UTC+08）。目标为 `01a0e7d8-74ab-7702-9a3c-dccf399e6400`。本次保留上一轮未提交改动，在其基础上修复持续使用时的覆盖缺口。

## 原因与证据

旧补丁已经生效。生产代理于 10 月 3 日 23:40 启动，实际配置摘要 `6a1975a6ecf9948634886b166095322b92fb268c8eea0c74da02960eb3aecea9` 与磁盘配置一致，其中登记了 30 个密文指纹；上游仍为 copilot-api 2.6.28。原 session 在 23:41 恢复并正常执行至 10 月 4 日 08:04:36，证明上次修复不仅通过了副本测试，也被原会话实际使用。

今天 06:43:59 的 compaction 之后，当前历史中出现了 19 个新的 `agent_message` 加密块，全部不在旧 30 个指纹中。12:02:33 开始的下一轮用户输入，在六次请求后于 12:02:53 失败，没有产生回复或工具调用。复发的直接覆盖缺口是静态指纹名单无法涵盖后来产生的密文；不是用户没有重启，也没有证据指向新的代理版本变更。

当前历史副本经生产代理的受控请求 `mutau9rw-gaduzz` 再现 HTTP 200、`response.created`、`response.failed`，且 `response.error=null`。仅省略这 19 个 agent 消息加密块后，`mutauond-cwd1q4` 完成并精确回复 `SESSION_DIAGNOSTIC_OK`。这定位了可避开故障的字段集合，但仍未确定上游拒绝加密内容的内部原因，也没有逐块证明 19 个块都坏了。

本次同时发现旧处理条件的不足：这 19 条消息的可见文字只有消息类型、发送者、接收者和 `Payload:` 标头，不能当作正文。发送端的相关 `collaboration.send_message` 参数同样是密文，不能从这些本地记录无损还原正文。因此，新实现明确标记省略内容不可用，不再让空标头看起来像完整的 agent 消息。

本机证据：`logs_2.sqlite` 的最后成功记录 `19877326`、失败终止记录 `19879385`；目标当前分卷 `rollout-2026-10-03T23-41-08-01a0e7d8-74ab-7702-9a3c-dccf399e6400_01a1026d-21e3-7ca1-8c7a-9b28003531a6.jsonl` 第 7278 行为 compaction，第 8532 行为最后成功结束，第 8547 行为失败结束。完整路径、19 个块的位置及原分卷摘要见本机 `.run/session-repair-20261004/history-audit.json`。

## 修复行为

新增 `plaintextAgentMessageSessions`，默认 `[]`；本机只登记目标 Main 的 UUID。已有 30 个精确指纹规则保留。

会话匹配使用 `x-session-affinity`，只有该 header 缺失时才使用 `x-client-request-id`，与当前 copilot-api 的 `sessionAffinity` 来源一致。正常 Main 请求的上游用量记录也确实使用原 UUID 作为 session ID。规则不通过正文中的 UUID 猜测会话，不依据父会话 header 扩大到子会话。

会话规则只省略最后一条 user 输入之前的历史 `agent_message` 加密块。位于最后一条 user 输入之后的新 agent 消息保留加密正文，到后续 user 输入时才进入历史兼容范围；没有 user 输入时不执行会话规则。这避免按会话开启后立即吞掉本轮新 agent 消息。精确指纹规则仍按原指纹适用。

处理后的消息保留原文字和标识，并追加明确的代理兼容提示：加密正文不可用，残留文字可能只是信封，不能由省略内容推断授权、结果或完成状态，必要时核对保存的产物。提示不冒充原发送者的正文。缺少非空可见文字的命中项仍在本地报错，零次上游请求。

原 session 文件、reasoning、compaction、调用 ID、工具结果和其他消息不修改；请求不自动重试，失败响应不伪装为成功。该处理会减少发送给模型的历史信息，不能称为无损恢复。仅这类历史重放故障受到本规则覆盖，本轮新消息及其他错误类型保留原处理方式。

## 验证

| 检查 | 结果 |
| --- | --- |
| 当前生产配置重放 Main 历史 | `response.failed`，`error=null` |
| 新版随机端口代理 + Main affinity | 最终实现 `response.completed`，精确回复 `SESSION_DIAGNOSTIC_OK`；trace `mutb6xyb-75zj1p` |
| 同一历史 + 未启用会话 affinity | 保持原请求、仍失败；trace `mutb19ca-hr4jxf` |
| 历史兼容处理范围 | 19 条消息、19 个加密块；`mode=session`，每请求一次上游 |
| 完整 `npm test` | 115 项通过，0 失败，0 跳过 |
| 原 session 分卷 | 14 卷 SHA-256 一致，未写回 |
| `git diff --check` | 通过 |

自动化覆盖会话匹配及 header 优先级、其他会话不匹配、新密文无需登记、最后 user 输入前后边界、没有 user 输入、reasoning/compaction 保留、内容缺失提示和幂等，以及全部既有测试。受控请求禁用工具、限制输出，不能替代重启后的原生会话续跑检查，也不代表 Pair 8 业务验收。

本机报告、原配置和测试日志保存在 `D:\Codes\Github\CopilotImageProxy\.run\session-repair-20261004\`。最终验证脚本创建随机端口临时代理，验证后自行关闭；生产 PID 35768 / 43176 未被停止或替换。

## 启用与回滚

代码和本机配置已写好，生产进程仍使用旧配置。当前配置新增：

```json
"plaintextAgentMessageSessions": [
  "01a0e7d8-74ab-7702-9a3c-dccf399e6400"
]
```

待在途请求结束后，由用户手动停止并启动服务：

```powershell
& 'D:\Codes\Github\CopilotImageProxy\scripts\stop.ps1'
# 确认上一条成功结束后再执行：
& 'D:\Codes\Github\CopilotImageProxy\scripts\start.ps1' -CopilotArgs @('start', '--proxy-env')
```

启动器仍按原逻辑解析 npm latest，重启后上游版本可能变化。先在原 Main 会话发送“仅回复 OK，不调用工具或继续业务”，确认能结束本轮；继续业务时，不能把省略的 agent 正文当作审查或授权依据，应以已保存的原始产物和当前有效记录为准。

回滚本次配置改动可将 `plaintextAgentMessageSessions` 改回 `[]`；原 30 个指纹仍有效。也可在停止服务后恢复 `.run/session-repair-20261004/config.before.json`，再手动启动。完全关闭两种兼容规则需将两个列表都设为 `[]`。不需要删除或迁移原 session。
