# Codex v2 明文协作与早期错误透传

本适配是兼容绕过，不宣称修复上游加密根因。设计参考 [LiteLLM #46315](https://github.com/BerriAI/litellm/pull/46315) 的普通工具别名与明文标记机制，以及 [copilot-api #430](https://github.com/caozhiyuan/copilot-api/pull/430) 的早期错误检查方向。不使用持久化哈希数据库，不解密、迁移或省略未知旧密文。

## 请求与响应合同

两项功能只处理 HTTP `POST /responses` 和 `POST /v1/responses`，允许查询参数。compact 路由仍沿用原处理。模型按请求原始 `model` 精确匹配，不复制 4141 的模型映射。配置项分别为 `plaintextCollaborationModels` 与 `earlyResponseErrorModels`，默认 `[]`，只接受 `gpt-6-astra`、`gpt-6.1-sol`，可分别开启。

明文适配还要求工具清单中存在原生 `collaboration` 消息函数的 `message: string, encrypted: true` 合同；普通同名 namespace 不触发。激活后将整个工具 namespace 映射为 `codex_collaboration_plaintext`，只移除已识别的 `spawn_agent`、`send_message`、`followup_task` 的 `message.encrypted`。顶层、`additional_tools`、`tool_search_output` 工具清单、历史调用及显式/allowed `tool_choice` 使用同一映射。返回时恢复 `collaboration`，为对应消息调用补 `encrypted_function_args: []`，由 Codex 自身构造明文 `agent_message`。任务正文、参数字符串、调用 ID、模型、思考强度与 v2 调度保持不变，不做提示词全文替换。

这里的“明文”指任务在 Responses JSON 中采用文本表示；远程传输是否使用 TLS 仍由原连接决定。代理结构化日志不记录任务正文、参数、密文或哈希，仅增加启用状态、处理计数及错误分类。

激活适配时必须由客户端显式回放历史：缺省 `store` 补为 `false`，拒绝 `store:true`、非空 `previous_response_id` 或 `conversation`。旧 `agent_message` 密文、reasoning 与 compaction 内容原样保留，因此旧密文导致的上游失败仍可能出现。应从新聊天开始使用。

## 流与错误边界

- 早期检查只检查指定模型的成功 HTTP SSE 响应，最多 2 秒、16 个事件或 256 KiB 初始缓冲阈值。空 `response.failed` 后再等待最多 250ms，仍受总期限约束；任何模型输出开始即停止错误预检。
- 只有明确的 `invalid_request_body` / `invalid_request_error` 代码与非空诊断同时出现，才返回 HTTP 400，并保留错误代码、消息及参数。空失败、其他错误、预算外错误及输出开始后的错误保持流行为，不猜测原因、不重试；已缓冲数据和未完成读取不会丢失。
- 改写路径要求上游返回 `identity` 编码，单个 SSE 事件上限 8 MiB，非流式 JSON 上限 32 MiB。支持 UTF-8、CRLF、网络分片、多行 `data`、注释、`[DONE]` 与正常 EOF。不会缓存整条 SSE 响应。
- 请求合同或别名冲突返回 HTTP 400，且不请求上游。上游身份、加密元数据、编码或解析冲突在响应头提交前返回 HTTP 502；响应头提交后中止流并记录错误码。超限不降级为未经适配的响应。
- 已有非成功 HTTP 响应保持原状态和正文；未启用、未匹配的透传路径不受新增响应缓冲上限影响。每次入站最多发出一次上游请求，客户端自行重试仍会产生新的入站请求。

| 分类 | 代表错误码 | 处理 |
| --- | --- | --- |
| 本地请求合同 | `proxy_collaboration_stateful_request`、`proxy_collaboration_alias_conflict`、`proxy_collaboration_schema_conflict` | HTTP 400，无上游请求 |
| 工具身份 / 加密元数据 | `proxy_collaboration_identity_conflict`、`proxy_collaboration_incomplete_identity`、`proxy_collaboration_encrypted_arguments` | 请求侧 400；响应侧在提交头前 502，否则中止流 |
| 上游编码 / 格式 | `proxy_response_encoding`、`proxy_response_content_type`、`proxy_response_invalid_json`、`proxy_sse_invalid_json`、`proxy_sse_invalid_utf8` | 提交头前 502，否则中止流 |
| 改写缓冲超限 | `proxy_json_response_limit`、`proxy_sse_event_limit` | 提交头前 502，否则中止流 |
| 明确的上游非法请求 | `invalid_request_body`、`invalid_request_error` 且非空诊断 | 预检预算内、输出开始前转为 HTTP 400 |

## 手动启用与回退

先确认本版本的隔离验收结果，再手动切换：

1. 保存当前本地配置副本，将 [候选配置](../config.collaboration.example.json) 中需要启用的模型列表合入 `config.json`，保留已有图片和启动参数。两个列表可单独开启。旧 `plaintextAgentMessageHashes` / `plaintextAgentMessageSessions` 配置不受支持，应在验收通过后移除；旧会话文件保持不动。
2. 暂停新请求，按 [README 的受管启动流程](../README.md#后台运行与生命周期) 手动停止、启动整套服务。独立运行的 4141 必须由其原管理方式停止；启动器不会接管该进程。
3. 将 Codex provider 的 `base_url` 指向 `http://127.0.0.1:4142`（原来有 `/v1` 则保留）。解除用于强制 v1 的本地 `model_catalog_json` 覆盖及 `features.multi_agent_v2 = false`；保留提供方、认证、远程目录 URL 与 `ultra` 设置。其他用途的本地模型目录应先核对，不能一概删除。
4. 手动重启桌面应用并新建聊天，显式创建两种模型的子代理，检查文件读取、发送消息及同一代理 follow-up。隔离代理验收不能代替这一步，也不会将已有 v1/v2 会话自动转换。

关闭功能时将相应数组恢复为 `[]` 并手动重启受管服务。也可停止整套服务、按原方式启动上游后恢复 Codex 原连接地址。保留新旧会话文件。恢复原生加密路径后，明文历史能否继续被上游接受不属于本适配保证，应使用新聊天验证。

## 验证

运行 `npm test` 覆盖协议单元测试、真实 loopback HTTP 测试及原有图片、压缩、缓存、取消和启动测试。实际 Codex 的模型、强度、v2 协议和工具读取证据须从隔离会话记录核对，不能只采信模型自报。模型调用的客户端强度与 4141 的既有归一化分别记录，`ultra` 与线上请求 effort 不必同名。

真实验收使用独立配置、loopback 端口与会话目录；只有本次测试进程可由验收脚本启停。生产切换仍由用户操作，不修改既有会话，不自动修改全局 Codex 配置，不提交或发布。
