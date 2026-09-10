# Copilot 多图片请求 413 调研

调查日期：2026-09-10。本文记录故障证据与方案依据；不将离线压缩结果表述为线上修复完成。

## 本地故障证据

用户提供的日志同时包含 `failed to parse request` 和上游 HTTP **413 Request Entity Too Large**。进一步在 Codex 本地日志中关联到任务 `01a086ea-8d7a-7f93-a4db-1f72c0abe957`，项目为 `D:\Arts\QinDynasty`；同一任务在 16:38–16:40 UTC 附近出现 413 与多次重复请求。

故障前会话记录中的 `message.content[]`、`custom_tool_call_output.output[]` 共包含 **18 张 `input_image`**，不计 UI 展示事件产生的重复记录。其中 **4 张来自 Blender viewport**，其余包括用户上传和 `view_image` 读取的渲染、纹理 PNG。

| 离线样本统计 | 数值 |
| --- | ---: |
| 原始 18 张图的 base64 合计 | 48,710,028 bytes（48.71 MB / 46.45 MiB） |
| sharp 按长边 1280、JPEG 80 转换后的 base64 合计 | 3,654,908 bytes（3.65 MB / 3.49 MiB） |
| 图片 base64 减少比例 | 92.4966% |

以上统计只包括该样本的图片 base64，不包括工具定义、系统提示、其他文字和 JSON 结构，**不等于已抓取到某次上游 POST 的准确 Content-Length**。离线结果说明重新编码可以大幅缩小这一组图片；透明图、动画、坏图的保留策略也可能使其他样本的实际压缩比例不同。

原始故障材料为用户附件及只读查询的本地会话/日志；本文不复制完整提示词、base64、认证信息或请求正文。没有为调查发送新的模型推理请求。

## 已安装 copilot-api 的行为

检查时安装包为 `@jeffreycao/copilot-api` **2.5.3**。以下行号来自该版本本地 `dist/server-DriTUys0.js`，仅用于标识本次调查快照；远程 `dev` 分支以后可能变化。

| 本地实现位置 | 发现与意义 |
| --- | --- |
| 2242–2256 | HTTP 路径将完整 `payload` 以 `JSON.stringify` POST 到 Copilot `/responses`，非 2xx 直接抛出 HTTP 错误。因此这次 413 表明上游拒绝请求体，不能仅根据错误文字判断 JSON 语法损坏。 |
| 7447–7450、7462–7498 | 图片保护只按模型的单图 `max_prompt_image_size` 检查，超限时替换占位图；没有图片压缩，也没有累计图片或整体请求字节预算。 |
| 7473–7480、7505–7512 | 图片遍历包含普通消息以及 function/custom tool output。这支持在 Responses 入口统一处理上传图、`view_image` 和 Blender MCP。 |
| 7452–7458 | 图片 `detail` 只做字段值规范化。改成 `low` 本身不会缩短已有 base64。 |
| 7534–7540 | `isGpt56OrAbove` 为真时跳过这里的 context management，因此不能用该配置保证 GPT-5.6+ 的这条路径提前压缩。 |
| 11087–11107 | 入站 zstd 先解压；随后 HTTP 路径仍发送普通 JSON。只压缩 Codex 到本地的传输不能解决后一段的请求体过大。 |
| 2307–2316 | WebSocket 请求保留完整 payload，只调整传输相关字段；切换 WebSocket 不会自动减少图片字节。 |
| 244–249、12245、12294 | verbose 可以输出完整原始与转译 JSON，但没有专门的请求总字节日志。调查未为此开启 verbose，以免敏感正文和图片落盘。 |

对应第一方来源：[Responses 工具与图片处理](https://raw.githubusercontent.com/caozhiyuan/copilot-api/dev/src/routes/responses/utils.ts)、[Responses handler](https://raw.githubusercontent.com/caozhiyuan/copilot-api/dev/src/routes/responses/handler.ts)、[Copilot HTTP/WS 转发](https://raw.githubusercontent.com/caozhiyuan/copilot-api/dev/src/services/copilot/create-responses.ts)。

仓库 [issue #123](https://github.com/caozhiyuan/copilot-api/issues/123) 也记录过上游 chat-completions 的 413。该 issue 已关闭，但所读页面未提供可确认的修复说明，不能据此声称本问题已有修复。[README](https://github.com/caozhiyuan/copilot-api/blob/dev/README.md) 的 128 MiB 总请求、64 MiB 单文件、16 文件限制针对 `/v1/images/edits` multipart，不能套用到 `/responses`。

本次未找到 GitHub 对这一 Copilot `/responses` 接口的确定总请求体上限。HTTP 413 与大量图片的相关性有本地证据；准确上游阈值、逐次 POST 大小及压缩后的线上稳定性仍应按实际请求验证。

## 方案选择

采用独立本地服务，连接顺序为 `Codex -> 图片代理 -> 原 copilot-api -> GitHub Copilot`。项目与 npx 缓存分开管理，原 copilot-api 包、进程和认证机制不因图片转换而修改。

选择 API 入口而非仅包装 Blender MCP，是因为故障样本中的 Blender viewport 只占 4/18 张。代理处理当前请求携带的全部历史图片，保留文字、工具调用、ID 与未知字段，避免通过删历史或删图片改变任务语义。

默认长边 1280、JPEG 80 可配置；透明图片保留 PNG，动画和无法解码的图片原样保留，不自动降低到更差档位。原文件不变，转换结果只在内存中缓存。需要检查更细的纹理、文字或几何边缘时，应明确提高配置并确认请求仍在预算内。

默认 **24 MiB** 是本项目采取的本地发送预算，**不是 GitHub 官方阈值**。预算以转换后的完整 UTF-8 JSON 为准；超限在本地明确失败，不隐藏重试、不删除图片、不再次降档。保留上游 HTTP 错误和 SSE 流；Codex 自身可能重试，本项目不会改变其全局策略。

## 验收边界

离线验证应覆盖三类图片位置、保留未知字段和工具 ID、透明/多帧/坏图、zstd、完整请求预算、缓存和稳定输出。HTTP 验证应覆盖模型列表与纯文本透传、compact、SSE 首块及时交付、客户端取消、上游 413 只转发一次。

真实任务还需确认：图片细节可读，模型能继续完成 Blender/工具工作，连续多轮积累图片后不再出现 413。自动检查和离线减少 92.4966% 只证明各自范围，在线结果应另行记录，不由本调研文档预先判定。
