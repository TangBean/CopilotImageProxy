# 旧 session 重放兼容处理验证

本页记录 2026-10-03 的实现和验证状态；持续规则与消息正文缺失标记的后续修正见 [2026-10-04 复发修复记录](session-replay-20261004.md)。

日期：2026-10-03，时间为新加坡时间（UTC+08）。验证使用 `gpt-6-astra`、当前运行的 `@jeffreycao/copilot-api 2.6.28` 和本项目的临时代理实例。

## 结论与适用边界

三个历史副本在保留原 `agent_message` 加密内容时收到 `response.failed`；仅省略含有非空 `input_text` 的 agent 消息中的加密内容后，均完成受控推理。第四个 P8-S1 历史没有这类加密块，原样请求成功。这支持在出站副本上使用本次兼容处理，不证明每一块密文都损坏，也没有定位上游为何在重新登录后拒绝它们。

首次 Main 受控请求的 trace 为 `musii25u-ehj3wa`：HTTP 200，事件顺序为 `response.created`、`response.failed`，`response.status=failed`、`response.error=null`、顶层 `error` 不存在。相同模型的空白输入对照 `musiikqu-d2ibrn` 正常完成。只移除普通消息和工具调用的可选 item ID 仍然失败；最终补丁不改任何 ID。

这是项目本地的兼容处理。OpenAI 官方把 `agent_message` 定义为可携带加密内容的 agent 间消息；官方说明不能证明可见文字与加密内容完全等价。这里保留可见文字并省略精确登记的加密块，可能失去仅存在于密文中的信息。普通 reasoning 和 compaction 密文没有改动。[官方多 agent 输出项说明](https://developers.openai.com/api/docs/guides/responses-multi-agent#new-multi-agent-output-items)，[官方 reasoning 重放说明](https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-without-stored-responses)。

## 四个历史副本的实测结果

| 逻辑角色 / 原 session ID | 原历史受控请求 | 本次省略数量 | 经新版代理受控请求 / trace |
| --- | --- | --- | --- |
| Main / `01a0e7d8-74ab-7702-9a3c-dccf399e6400` | `response.failed`，`error=null` | 6 | `response.completed` / `musir7wm-51957f` |
| #293 / `01a0e7dc-1495-7840-b68a-ec5835b78e12` | `response.failed`，`error=null` | 2 | `response.completed` / `musir7ew-ihrcd3` |
| P8-S1 / `01a0dd99-5015-7ab3-80ce-8310e54f3702` | `response.completed` | 0 | `response.completed` / `musir7kp-xo7jfa` |
| #296 / `01a0e7dc-20b7-79d2-b9b4-804c949ed612` | `response.failed`，`error=null` | 22 | `response.completed` / `musir80s-f0rule` |

最终四次集成验证在 23:00:35–23:00:45 完成。测试客户端没有自行删掉任何加密块，而是把原历史发给随机端口上的新版 `createProxyServer`，再由它转发到现有 4141。代理记录每个请求只发送一次上游；四次都得到精确的 `SESSION_DIAGNOSTIC_OK`。P8-S1 的代理记录没有 `agentMessageReplay`，其余三次分别为 6、2、22。

历史读取遵守分卷 `history_base.end_byte_offset`，以最后 compaction 的 `replacement_history` 替换先前模型历史，再附加后续 `response_item`，不重复 UI 镜像。受控请求保持原模型，使用 `tools=[]`、`tool_choice=none`、`max_output_tokens=256` 和低推理强度；没有调用业务工具。它不同于原 Codex 的 ultra 推理和完整工具环境，因此这些结果证明历史副本能完成推理，不是四个原 session 的原生续跑验收。

本次没有迁移、fork、改写或向四个原 session 发送消息。验证前后共 16 个物理分卷 SHA-256 全部一致。Todo、actorBindings、已耗额度和业务资源均未变更；Pair 8 业务完成状态不因这些诊断请求改变。

## 已实现的处理

`src/agent-message-replay.mjs` 仅检查顶层 `input[]` 的 `agent_message.content[]`。只有 `encrypted_content` 字符串的 SHA-256 命中 `plaintextAgentMessageHashes` 才省略该内容块。消息本身、全部可见文字、author/recipient、item ID、调用及结果、其他加密块、reasoning、compaction 均保留。没有可见文字的命中消息返回本地明确错误，零次上游请求。

本机 `config.json` 已登记 30 个不同指纹，来自上表三个失败历史。默认配置仍为 `[]`。匹配基于密文指纹而非 session header，复制了相同历史块的其他请求也会命中；新生成的或未登记的块不处理。代理不修改官方 npm 缓存，不自动重试，不将失败响应改写成成功。

`npm test`：111 项通过，0 失败、0 跳过。覆盖精确匹配、未登记项、缺失文字、reasoning/compaction/工具关联保留、Unicode 转义、幂等、zstd、四种 Responses/compact 路由、其他路由透传，以及既有图片、SSE、取消、并发和 Windows 生命周期测试。`git diff --check` 通过。

## 本机证据和启用

本机证据目录为 `D:\Codes\Github\CopilotImageProxy\.run\session-repair-20261003\`，不入 Git：

- `manifest.json`：原分卷路径、摘要、登记块指纹和配置前后摘要，不包含密文或可见消息正文。
- `*-baseline-*.json`、`*-strip-agent-encrypted-*.json`、`*-integrated-*.json`：各受控请求的终止事件、trace 和精确回复检查结果。
- `integrated-proxy.jsonl`：临时代理的请求次数和处理数量；`session-integrity.json`：16 卷一致性检查。
- `npm-test.log`：完整测试结果；`config.before.json`：本次修改前的原配置。

临时代理已停止。生产代理 PID 44984、copilot-api PID 22144 均在 22:40 启动，仍使用修改前配置摘要；本次没有重启它们。等当前需要保留的请求结束后，由用户手动重启：

```powershell
& 'D:\Codes\Github\CopilotImageProxy\scripts\stop.ps1'
# 确认上一条成功结束后再执行：
& 'D:\Codes\Github\CopilotImageProxy\scripts\start.ps1' -CopilotArgs @('start', '--proxy-env')
```

启动器按既有行为重新解析上游 npm latest，因此重启后的实际版本可能与本次验证的 2.6.28 不同。随后先在原 Main 聊天发送一次仅要求回复、不得调用工具的短消息，确认能结束本轮；其他三个原聊天同样各做一次。之后再按各自既有业务授权继续。若仍失败，保留新错误，不能把本次副本 PASS 当作原生续跑成功。

如需精确恢复修改前配置，先手动停止服务，再执行以下命令并按上面的命令启动：

```powershell
Copy-Item -LiteralPath 'D:\Codes\Github\CopilotImageProxy\.run\session-repair-20261003\config.before.json' -Destination 'D:\Codes\Github\CopilotImageProxy\config.json'
```

后续若另有配置调整，只将 `plaintextAgentMessageHashes` 改为 `[]`，避免恢复旧文件覆盖后续设置。关闭配置即可禁用此功能，无需删除 session 历史或卸载其他代码。
