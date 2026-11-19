# Copilot Image Proxy 2.0

在 Codex 与 `@jeffreycao/copilot-api` 之间压缩 Responses 请求里的图片，并统一启动、停止两者。适用于长任务反复携带 Blender 截图、渲染图和纹理图的情况。当前支持 Windows。

```text
Codex → 图片代理 127.0.0.1:4142 → 受管 copilot-api 127.0.0.1:4141 → GitHub Copilot
```

每次实际启动新实例时，启动器在线查询官方包的 `latest`，通过 npm 缓存准备该版本，再执行其 `package.json` 声明的 CLI 入口。**不修改官方包或 npx 缓存中的代码；不会在每个推理请求到来时更新版本。** 查询失败会报错，不会静默退回旧版。

## 安装与前台运行

需要 Node.js 22.16 或更新版本、npm，以及 Windows 自带的 .NET Framework C# 编译器。首次启动自动构建本项目的 Job supervisor，后续复用构建缓存；不需要 NuGet 或额外的 .NET SDK。

```powershell
Set-Location 'D:\Codes\Github\CopilotImageProxy'
npm ci
npm start
```

`npm start` 或无参数启动等价于向官方 CLI 传入 `start --proxy-env`。它同时启动图片代理与 copilot-api，前台保留标准输入输出，便于完成认证；`Ctrl+C` 停止整套服务。

需要直接使用命令名时，在本项目执行一次 `npm link`，之后可运行：

```powershell
copilot-image-proxy
copilot-image-proxy -- --help
copilot-image-proxy -- auth
copilot-image-proxy -- start --proxy-env --host 127.0.0.1 --port 4143
```

未安装命令名时，等价入口为：

```powershell
node 'D:\Codes\Github\CopilotImageProxy\src\index.mjs' -- start --proxy-env
node 'D:\Codes\Github\CopilotImageProxy\src\index.mjs' --config '.\config.json' -- start --proxy-env
```

`--` 之后是原 copilot-api 的参数列表。启动器保留参数值、顺序、调用者工作目录和用户环境，通过 `shell: false` 执行官方 CLI。`auth`、`debug`、`mcp`、官方帮助等非服务器命令继承标准输入输出及退出码，**不会额外启动 4142**。本项目自身的简短帮助用 `--proxy-help`。

只有 `start` 进入代理托管模式。上游 `--host` / `--port` 仍交给原 CLI，并用于派生代理实际连接的地址；例如上述 `--port 4143` 改变的是上游端口，图片代理仍按自己的配置监听 4142。

## 后台运行与生命周期

先在前台完成需要交互的认证，再使用后台脚本：

```powershell
& 'D:\Codes\Github\CopilotImageProxy\scripts\start.ps1' -CopilotArgs @('start', '--proxy-env')
& 'D:\Codes\Github\CopilotImageProxy\scripts\stop.ps1'
```

也可指定其他配置文件。`-Config` 和 CLI 的 `--config` 都接受绝对路径，相对路径按**调用者当前目录**解析：

```powershell
& 'D:\Codes\Github\CopilotImageProxy\scripts\start.ps1' -Config '.\proxy-config.json' -CopilotArgs @('start', '--proxy-env', '--port', '4143')
```

后台启动使用隐藏进程，日志位于项目 `.run` 目录；不创建开机任务。重复启动会核验已记录的运行身份及配置、参数和启动上下文，发生变化时要求先停止再启动。后台脚本只接受受管的 `start`，其他命令使用前台 CLI。

Windows Job Object 绑定本次启动的代理及其 npm/copilot 子孙。正常停止先尝试关闭 HTTP 请求，再由 supervisor 回收整组；关闭终端、硬杀启动器、代理或 supervisor 也会触发回收。**没有自动重启或自动重放推理请求。** 外部进程占用前端或上游端口时启动失败，不会接管或杀掉该进程。

停止脚本先验证 supervisor 的 PID、启动时间和可执行文件路径，再使用认证控制管道；失联时只终止已验证且持有 handle 的 supervisor。`.run/service.json` 包含运行身份与本地控制令牌，不应作为公开报告。详细流程和限制见 [受管启动说明](docs/managed-launcher.md)。

健康检查：

```powershell
Invoke-RestMethod 'http://127.0.0.1:4142/healthz'
```

返回包含 `service`、`status`、`pid` 和 `version: 2.0.0`。受管启动会先确认上游监听属于本次 Job 且有 HTTP 响应；健康检查仍不代表账号、所选模型或真实推理已验收。

## 配置

默认读取项目根目录的 `config.json`，修改后重启。文件可只覆盖部分字段：

```json
{
  "host": "127.0.0.1",
  "port": 4142,
  "upstream": "http://127.0.0.1:4141",
  "maxEdge": 1280,
  "jpegQuality": 80,
  "maxOutputMiB": 24,
  "maxInputMiB": 128,
  "cacheMiB": 64,
  "imageConcurrency": 2,
  "connectTimeoutMs": 10000,
  "upstreamStartupTimeoutMs": 180000,
  "maxImageQueueMiB": 256,
  "logLevel": "info",
  "sessionIndexPath": null,
  "sqliteDbPath": null,
  "usageTimezone": "+08:00",
  "plaintextCollaborationModels": [],
  "earlyResponseErrorModels": []
}
```

| 字段 | 含义 |
| --- | --- |
| `host` / `port` | 图片代理前端的监听地址与端口；地址限本机回环。与上游 CLI 的同名参数分别生效。 |
| `upstream` | 保留的底层 HTTP 代理配置字段；受管 `start` 会用原 CLI 的实际监听设置覆盖它。 |
| `maxEdge` / `jpegQuality` | 静态图最长边与不透明图 JPEG 质量，默认 1280 / 80；不会放大小图。 |
| `maxOutputMiB` | 转换后完整请求体的本地预算，默认 24 MiB，包含文字、工具定义、图片与 JSON 结构。 |
| `maxInputMiB` | 接收请求及解压后请求分别适用的大小上限，默认 128 MiB。 |
| `cacheMiB` | 图片结果及缓存索引的内存预算，默认 64 MiB；设为 0 禁用跨请求缓存。不是进程总内存上限。 |
| `imageConcurrency` | 共享的图片转换并发上限，默认 2。 |
| `connectTimeoutMs` | 建立上游连接的超时，默认 10 秒；不限制整次推理或 SSE 的读取时长。 |
| `upstreamStartupTimeoutMs` | 等待 copilot-api 就绪的时限，默认 180 秒。 |
| `maxImageQueueMiB` | 图片候选请求的 worker 队列容量预算，默认 256 MiB；满时本地返回 503，不发送上游。 |
| `logLevel` | 代理日志最低级别，默认 `info`；支持 `debug`、`info`、`warn`、`error`、`silent`，修改后手动重启生效。 |
| `sessionIndexPath` | Codex 会话标题索引路径；默认 `null`，使用当前用户主目录下的 `.codex/session_index.jsonl`。可指定非空路径字符串，相对路径按代理进程当前目录解析。 |
| `sqliteDbPath` | 相对日用量及 Today 小时速度的只读 SQLite 路径。默认 `null` 时优先使用 `COPILOT_API_SQLITE_DB_PATH`，否则读取上游 API home 中的 `copilot-api.sqlite`。受管启动使用上游的 `--api-home` 或 `COPILOT_API_HOME`，默认目录为 `~/.local/share/copilot-api`。相对路径按启动时的工作目录解析。 |
| `usageTimezone` | 相对日的自然日时区，默认 `+08:00`；支持 `Z` 或 `-14:00` 到 `+14:00` 的固定 UTC 偏移（`±HH:mm`），例如 `-05:00`、`+05:30`。不支持地区名或夏令时切换。 |
| `plaintextCollaborationModels` | 为列表内模型启用 Codex v2 明文协作适配，默认 `[]`。首版仅接受 `gpt-6-astra`、`gpt-6.1-sol`，精确匹配入站 `model`。 |
| `earlyResponseErrorModels` | 为列表内模型启用初始 SSE 错误检查，默认 `[]`；支持相同两个模型，与明文适配独立。 |

**24 MiB 是本项目选择的预算，不是 GitHub 公布的请求限制。** 超限时返回 `413 / proxy_payload_budget_exceeded` 和字节统计，且上游请求次数为零。代理不删图，不继续降低画质。可以提前整理上下文，或显式调整画质和预算。

## 请求处理与性能边界

- 处理 `POST /responses`、`/responses/compact` 及带 `/v1` 前缀的对应路由。图片位置包括消息 `content[]`、`function_call_output.output[]` 和 `custom_tool_call_output.output[]`。历史里仍携带的旧图也会处理。
- 不透明静态图转换为 JPEG；真正透明的图保留 PNG；处理方向与色彩空间。动画、多帧、无法处理的图保留原内容。已满足要求且重编码无收益的图保留原数据。
- 保留图片顺序、文字、工具调用 ID 和其他字段。不下载 HTTP 图片 URL，也不改写 `file_id`。
- 两项协作兼容配置均为空时，无图片标记且无 Unicode 转义的请求直接通过，不做 JSON 解析；存在 `input_image` 或 `\u` 候选时回退解析，防止转义图片类型漏过。配置了兼容模型列表时，普通 Responses 请求另行解析以匹配模型与工具合同。无图路径仍检查字节预算；无图的畸形 JSON 交给上游验证。
- 图片候选请求的 JSON 与图片处理使用按需创建的单例 worker，避免这些同步计算占用 HTTP 主线程。队列有独立容量上限；worker 的性能实测以验收记录为准。
- 两级内存缓存分别识别相同 data URL 和相同解码内容，保存最终输出 URL，重复历史图命中时避免再次解码或有损编码。缓存不把原图写到磁盘，缓存容量不等于整个服务的 RSS。
- 支持解压 zstd、gzip 和 deflate 入站请求，向上游发送普通 JSON 并更新长度、编码相关 headers。`GET /healthz` 由本地处理。Web Dashboard 的会话标题、相对日用量和 Today 小时速度在上游确认访问范围后读取本地数据，`GET /usage-viewer` 按下述条件改写页面，其余路由按字节流透传。
- 默认 SSE 逐块转发；启用协作兼容时按预算预检或按事件改写，写入仍遵守背压。客户端取消会取消对应上游请求。上游 HTTP 错误透传，每个入站请求最多发出一次上游请求。Codex 自身的重试仍可能产生新的入站请求。

## 用量页面：相对自然日与 Codex 会话标题

通过代理打开 `http://127.0.0.1:4142/usage-viewer`，Session Breakdown 中已匹配的 Codex 会话显示标题，鼠标悬浮显示原始 ID。使用代理监听端口的本机页面时，默认数据 endpoint 沿用地址栏中的 `localhost`、`127.0.0.1` 或 `[::1]`。`?endpoint=` 可指定其他地址。

使用 `http://127.0.0.1:4142/usage-viewer?period=-1d` 查看昨天，`period=-2day` 查看前天，`period=-34d` 查看 34 天前。不再限制为 1–10 天；每个值只选中 **N 天前的一个自然日**，以 `usageTimezone` 的 00:00 为起点、次日 00:00 为终点，包含起点、不包含终点。例如当地今天为 2026-11-04 时，`-34d` 查询 2026-10-01 全天；`-1day` 的终点恰好是今天 00:00。

`GET /token-usage`、`/token-usage/daily`、`/token-usage/events`、`/token-usage/sessions` 均支持相同的 `period`。接受 `-Nd` 和 `-Nday`，忽略大小写，允许数字与后缀之间有一个空格或下划线：`-34%20D`、`-34+Day`、`-34_day` 均规范化为 `-34day`。N 必须为无前导零的正整数；`-0d`、`-0day`、`-01d`、小数、非数字、只写 `-1`、复数 `-1days` 和其他多余后缀均返回 400。`from` / `to` 参数仍返回 400。`today` 等原有周期保持上游行为。

相对日的上限由 `usageTimezone` 下的当前自然日决定：目标日期必须为 **1970-01-01 或之后**（含当天），因此 N 最大为当地今天距 1970-01-01 的天数。按本地日期判断，正时区的 1970-01-01 起点可以落在 UTC 的 1969-12-31。`-99999999d` 等过大值、超出 JavaScript 安全整数范围的 N、无法表示的日期范围均返回 400，页面 URL 和四个接口使用相同的日期边界。有效目标日期早于数据库的数据起点时仍返回该完整自然日的空列表或零用量，不报日期错误。

相对日查询以只读事务汇总上游 SQLite 中的 `token_usage_events`。数据库不可读或结构不兼容时返回 501，不改查今天。响应保持 `period: "custom"`，`range` 提供毫秒和 UTC 起止时间，以及形如 `2026-10-01 (-34 Day)` 的 `display_label`。页面下拉框会增加当前相对日（如 `-34 Day`），标题使用服务端日期标签；选择与 URL 保持同步，刷新、切换 tab 和翻页保留规范化的 `period`。覆盖 `endpoint` 时，相对日功能要求目标也支持这些周期。

标题来自 `session_index.jsonl`，按 `updated_at` 取每个 ID 的最新记录，索引的修改时间或大小变化后重新读取。文件缺失、读取失败、空标题或无法匹配时保留 ID；损坏记录跳过。subagent 线程不在该索引中，因此保留原始 ID，不读取 rollout 文件补全。页面和用量 endpoint 同源时才查询标题，跨源时保留 ID。

会话标题、相对日和 Today 小时接口会先携带当前请求的凭据向上游查询一条 Today 用量记录，确认该凭据能查看全局用量。上游拒绝认证时沿用其错误响应。启用按 API key 隔离时，本地索引和汇总涵盖整台机器，这三项扩展会返回 403。原生周期的用量和趋势图继续使用上游为该 key 返回的数据。

此功能用于 Web Dashboard。代理解析上游返回的未压缩 200 HTML 和页面脚本，在当前用量页面的初始化、刷新和渲染入口接入扩展。空行、缩进和日志文案变化不影响接入。代理保留上游的凭据、隔离和分页逻辑。必要入口缺失或不明确时返回 502。请求相对日页面时，上游若返回压缩内容或其他不兼容的成功响应，也返回 502。本地相对日 API 支持来自 `localhost`、`127.0.0.1` 和 `[::1]` 的 HTTP(S) 跨来源访问及预检，便于切换本机页面地址或 endpoint。

### 按模型查看速度和成本趋势

选择非 Today 周期时，原有 Token Usage Over Time 下方依次增加独立的 Output speed (tokens/s) 和 Cost (USD) 面板。
原生周期和代理 `-Nd` 均适用；`-Nd` 仍表示 N 天前的单个自然日，因此显示一个点。
每个模型各有一条线；Cost (USD) 还提供 Total 汇总曲线，颜色与 Token Usage Over Time 的 Total 相同。模型颜色由名称确定，图例完整保留并自动换行。
速度直接取 daily 响应的 `days[].byModel[].output_tokens_per_second`，单位为 tokens/s。
该值沿用上游的加权计算：`1000 × 有效输出 token 总数 / (duration_ms - first_token_ms) 总和`。
缺失速度显示 `—` 并断线；真实的 0 保持为 0，单点也可见。
两个新图的布局、绘图区尺寸、图下图例和日期数值栏与原图一致。各自的 Filters 仅包含 Metric 按钮：All 展示全部曲线，点击模型或 Cost 的 Total 仅显示对应曲线并调整纵轴；没有 Model 下拉框。
悬停某天可查看当前可见模型的值，点击日期可更新虚线标记和图下数值栏。单位只写在标题中，图内数值不重复单位；纵轴从 0 开始，保留异常峰值。
图表随周期和刷新更新，三个图的筛选和日期选择互不影响；筛选不新增请求，lifetime 保留全部日期和历史模型。
刷新后保留有效选择；模型消失时回到 All，日期失效时选择最近有有效数值的一天，全部数值缺失时选择最后一天。
相同端点、凭据和周期的刷新会保留并淡化已有趋势图；切换查询时清空旧数据，加载失败后隐藏旧曲线和数值。
成本读取 `days[].byModel[].costs[]` 中的 USD 项，复用页面的 `getCostAmount`：优先 `amount`，否则 `total_cost_nanos / 1e9`。
Total 使用每日 `days[].totals.costs[]` 中的 USD 汇总，同样保留缺失值和真实零值，不在页面重算模型费用之和。
上游 daily 响应在模型和 totals 中都提供 `costs[]`，按日期、模型和币种汇总事件中已记录的费用。
代理 `-Nd` 的只读 SQLite 查询输出相同结构和单位，测试核对 summary 与 daily 的费用一致性。
只显示美元，不换汇、不混加其他币种；无 USD 记录时显示 `—` 并断线，已记录的零费用保持为 0。
两个面板对同一模型使用相同颜色；成本提示保留有效小数，1 nano USD 也不会显示成零。
窄屏中 Filters 排列在图下，图例与长模型名自动换行；大数和极小数的纵轴刻度使用科学计数法。

Today 显示同样样式的 Output speed (tokens/s) 面板，横轴固定为当天 00:00–23:00，按小时汇总每个模型的速度。没有有效速度数据的小时不画点，并在该处断线；当前小时有数据就显示，随 Refresh 更新，未来小时留空。筛选、悬停、点击小时及刷新行为与每日速度图一致。

`GET /token-usage/hourly?period=today` 使用上游原生 Today 的范围，并从 `sqliteDbPath` 指向的数据库只读统计完整请求；`usageTimezone` 仍只控制相对日。每个有效请求的全部输出 token 和输出耗时归入最后一条用量记录所在小时，再按上述公式加权计算。用量记录跨整点的请求只统计一次；跨 Today 边界、取消或计时不完整的请求按现有完整请求规则排除。

小时分桶从上游午夜起每 60 分钟划分，适用于日内 UTC 时差不变的日期（包括当前 `+08:00` 环境）。上游响应没有时区规则，夏令时切换日尚不支持：可能错标自然小时，回拨日的 Today 范围超过 24 小时后会返回 502。不能用代理的 `usageTimezone` 推断上游的夏令时规则。

小时响应提供 24 个 `hours` 桶，每桶包含 `hour`、`start_ms`、`end_ms` 和 `byModel`。页面从当前 endpoint 派生小时接口；覆盖 endpoint 时，目标也须支持该接口。数据库不可读或结构不兼容时返回 501，页面仅在速度面板显示错误，其余用量数据仍可查看。

## Codex v2 明文协作兼容

这是针对 Copilot 原生协作工具兼容问题的绕过，不是对上游加密算法或密钥的修复。明文表示仅涉及 Responses JSON 中的任务文本；远程连接仍沿用原有传输方式。默认关闭，只处理普通 HTTP Responses 路由，不改变 compact 路由，不恢复、省略或迁移未知旧密文。

明文适配将原生 `collaboration` 工具改为普通别名 `codex_collaboration_plaintext`，仅去掉三个消息工具的 `message.encrypted`。返回时恢复原 namespace 并补 `encrypted_function_args: []`，由 Codex 自身构造明文消息。任务正文、调用 ID、模型、思考强度和 v2 调度保持不变。激活后要求 `store=false` 和显式历史回放，不支持 `previous_response_id` / `conversation` 隐式续接。身份、别名或加密元数据冲突明确失败。

早期错误检查独立开启，预算为 2 秒、16 个事件或 256 KiB 初始缓冲阈值；空失败后最多再等 250ms，仍受总期限限制。只将带明确非法请求代码和非空诊断的错误转为 HTTP 400。其他错误按原流行为处理，不猜测、不重试。改写路径单事件上限 8 MiB、非流式 JSON 上限 32 MiB。

[默认配置示例](config.example.json) 保持关闭；[候选配置示例](config.collaboration.example.json) 同时启用两个目标模型。完整合同、错误分类、旧密文限制、手动切换和回退步骤见 [协作兼容说明](docs/collaboration-compatibility.md)。代理结构化日志不记录任务正文、参数、密文或哈希。

代理自身日志只写请求类型、字节数、处理计数、耗时和状态等元数据。默认 `logLevel: "info"` 只输出启动、停止和简短异常：正常请求、健康检查、客户端断开以及完整图片/缓存统计只在 `debug` 级别显示。HTTP 4xx 使用 `warn`，HTTP 5xx、上游流异常和内部错误使用 `error`。`warn` / `error` 可进一步减少日志，`silent` 关闭代理自己的结构化日志。

调试时将 `config.json` 的 `logLevel` 改为 `debug` 后手动重启，可以恢复完整 JSON 请求统计。`status: 200` 仅代表收到响应头，不保证流完整结束；`abortSource` 记录代理首先观察到的断开来源（`client`、`upstream` 或 `proxy`），不代表网络故障根因。客户端断开后清理上游连接产生的事件不会再误记为上游错误。`durationMs` 是整个请求的耗时，不是图片编码耗时。

后台日志也会收录官方 CLI 的原始 stdout/stderr；这部分内容由上游命令及其日志选项决定，代理的 `logLevel` 不会过滤它。准备好后，在原来启动服务的工作目录及代理环境中打开 PowerShell，手动重启受管的两个服务：

```powershell
& 'D:\Codes\Github\CopilotImageProxy\scripts\stop.ps1'
# 等停止命令成功结束后，再执行启动。
& 'D:\Codes\Github\CopilotImageProxy\scripts\start.ps1' -CopilotArgs @('start', '--proxy-env')
```

启动时会重新确认 npm `latest`，原 copilot-api 包保持不修改。前台运行可在原终端按 `Ctrl+C`，退出后重新执行 `copilot-image-proxy`。

## 从 v1 迁移、接入与验证

本节的 v1 / v2 指图片代理产品版本；Codex 多代理协议的切换见上面的协作兼容说明。

第一次切换到 v2 时，先使用旧版停止方式关闭 v1 的 4142，再停止原先独立运行的 4141。确认两个端口释放后启动 v2；v2 不会自动接管旧进程。之后启动或停止 v2 就同时管理两者。

Codex provider 的 `base_url` 指向图片代理，例如 `http://127.0.0.1:4142`；原地址带 `/v1` 时保留该后缀。模型、认证和 compact 配置不需要由本项目改写。启动器不会自动修改 Codex 配置。

回滚时先暂停新请求，停止整套 v2，按原方式独立启动官方 copilot-api，确认上游恢复后再把 Codex `base_url` 改回原地址。v2 停止时其受管的 4141 也会停止，不能沿用 v1“停代理后上游仍运行”的假设。

```powershell
npm run build:supervisor
npm test
```

构建产物位于 `bin/`，不纳入源码提交。问题背景见 [研究记录](docs/research.md)；[v1 验收记录](docs/validation.md) 只代表旧版本结果。v2 的 CLI、生命周期与 worker 性能结果统一记录在 [v2 验收记录](docs/validation-v2.md)，不能把旧版测试数字当作新版结论。

[10 月 3 日](docs/session-replay-20261003.md) 与 [10 月 4 日](docs/session-replay-20261004.md) 的 session replay 调查记录保留为历史资料，其中的旧省略方案不代表当前实现。

## 验收脚本输入

`scripts/validate-sample.mjs` 和 `scripts/validate-tool-roundtrip.mjs` 要求 rollout 至少包含 1 张内嵌图片；`scripts/validate-live.mjs` 的追加图片场景要求至少 2 张。脚本只读取 `response_item` 中消息及工具结果的 `input_image`，不重复统计 UI 镜像。样本不足或 JSONL 损坏时立即失败，不发送模型请求；无图片样本不能作为图片代理验收通过的证据。
