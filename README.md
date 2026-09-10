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
  "maxImageQueueMiB": 256
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

**24 MiB 是本项目选择的预算，不是 GitHub 公布的请求限制。** 超限时返回 `413 / proxy_payload_budget_exceeded` 和字节统计，且上游请求次数为零。代理不删图，不继续降低画质。可以提前整理上下文，或显式调整画质和预算。

## 请求处理与性能边界

- 处理 `POST /responses`、`/responses/compact` 及带 `/v1` 前缀的对应路由。图片位置包括消息 `content[]`、`function_call_output.output[]` 和 `custom_tool_call_output.output[]`。历史里仍携带的旧图也会处理。
- 不透明静态图转换为 JPEG；真正透明的图保留 PNG；处理方向与色彩空间。动画、多帧、无法处理的图保留原内容。已满足要求且重编码无收益的图保留原数据。
- 保留图片顺序、文字、工具调用 ID 和其他字段。不下载 HTTP 图片 URL，也不改写 `file_id`。
- 无图片标记且无 Unicode 转义的请求直接通过，不做 JSON 解析；存在 `input_image` 或 `\u` 候选时回退解析，防止转义图片类型漏过。无图路径仍检查字节预算；无图的畸形 JSON 交给上游验证。
- 图片候选请求的 JSON 与图片处理使用按需创建的单例 worker，避免这些同步计算占用 HTTP 主线程。队列有独立容量上限；worker 的性能实测以验收记录为准。
- 两级内存缓存分别识别相同 data URL 和相同解码内容，保存最终输出 URL，重复历史图命中时避免再次解码或有损编码。缓存不把原图写到磁盘，缓存容量不等于整个服务的 RSS。
- 支持解压 zstd、gzip 和 deflate 入站请求，向上游发送普通 JSON 并更新长度、编码相关 headers。其他路由按字节流透传。
- SSE 及时逐块转发；客户端取消会取消对应上游请求。上游 HTTP 错误透传，每个入站请求最多发出一次上游请求。Codex 自身的重试仍可能产生新的入站请求。

代理自身日志只写请求类型、字节数、处理计数、耗时和状态等元数据。后台日志也会收录官方 CLI 的原始 stdout/stderr；这部分内容由上游命令及其日志选项决定。

## 从 v1 迁移、接入与验证

第一次切换到 v2 时，先使用旧版停止方式关闭 v1 的 4142，再停止原先独立运行的 4141。确认两个端口释放后启动 v2；v2 不会自动接管旧进程。之后启动或停止 v2 就同时管理两者。

Codex provider 的 `base_url` 指向图片代理，例如 `http://127.0.0.1:4142`；原地址带 `/v1` 时保留该后缀。模型、认证和 compact 配置不需要由本项目改写。启动器不会自动修改 Codex 配置。

回滚时先暂停新请求，停止整套 v2，按原方式独立启动官方 copilot-api，确认上游恢复后再把 Codex `base_url` 改回原地址。v2 停止时其受管的 4141 也会停止，不能沿用 v1“停代理后上游仍运行”的假设。

```powershell
npm run build:supervisor
npm test
```

构建产物位于 `bin/`，不纳入源码提交。问题背景见 [研究记录](docs/research.md)；[v1 验收记录](docs/validation.md) 只代表旧版本结果。v2 的 CLI、生命周期与 worker 性能结果统一记录在 [v2 验收记录](docs/validation-v2.md)，不能把旧版测试数字当作新版结论。
# CopilotImageProxy
