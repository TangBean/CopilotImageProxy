# v2 受管启动说明

v2 的入口负责启动官方 `@jeffreycao/copilot-api` 与图片代理，并限定停止操作的进程范围。当前实现面向 Windows，官方包的缓存代码保持原样。

## 命令与版本解析

```powershell
copilot-image-proxy [--config FILE] -- <copilot-api 原参数列表>
```

命令名通过本项目的 `npm link` 安装，也可换成 `node <项目路径>\src\index.mjs`。无参数时采用 `start --proxy-env`。`--config` 属于图片代理，须放在分隔符前；其相对路径按调用者当前目录解析。分隔符后的每个参数作为独立 argv 原样交给官方 CLI，不拼接成 shell 命令。

每次真正启动新实例时，启动器执行以下步骤：

1. 在线解析 npm `latest`，固定本次要运行的版本。查询失败即失败，不离线回退到缓存旧版。
2. 使用 npm 的执行缓存准备这个官方版本，并读取其 `package.json` 中的 CLI 入口。
3. 用 Node 直接执行该入口，`shell: false`，保留用户的工作目录、环境和参数顺序。npm 准备包时需要的内部工作目录不改变最终 CLI 的工作目录。

不会向缓存包打补丁、注入修改或重写其源码。运行中的实例不会每请求检查版本；重新启动才重新查询。后台重复启动若确认同一实例仍在运行，会报告现有实例，不另起一份或更新其版本。

| 调用 | 行为 |
| --- | --- |
| 无参数 / `npm start` | 执行 `start --proxy-env`，启动整套代理。 |
| `-- start ...` | 托管服务器，启动图片代理并管理官方 CLI。 |
| `-- --help`、`-- auth`、`-- debug ...`、`-- mcp ...` | 运行官方命令，保留 stdio 与退出码，不启动图片代理监听端口。 |
| `-- start --help` | 官方帮助模式，不启动代理监听。 |
| `--proxy-help` | 显示本启动器的用法。 |

上游的 `--host`、`--port` 和其他参数仍由官方 CLI 接收。受管模式从有效绑定设置派生连接地址，覆盖 `config.upstream`；前端地址仍由代理配置的 `host` / `port` 决定。两个端口不能相同。支持显式配置时应区分“上游 CLI 参数”和“代理配置文件”。

## 进程归属与停止

```text
前台终端或后台 start.ps1
└─ 外层 Node 启动器
   └─ JobHost.exe：持有专属 Windows Job handle
      └─ 受管 Node（加入 Job）
         ├─ HTTP 图片代理 + 按需启动的图片 worker
         └─ npm 准备进程 / 官方 copilot-api 及其普通子孙
```

JobHost 使用 `CREATE_SUSPENDED` 创建受管 Node，成功加入 Job 后才恢复执行。Job 开启 `KILL_ON_JOB_CLOSE`，handle 不传给子进程；普通 npm/copilot 子孙继承归属，不开启 breakaway。主进程未能加入 Job 时启动失败并清理，不退回失去归属保障的启动方式。

JobHost 持有外层启动器与受管 Node 的进程 handle。受管 Node 自行退出时传播退出码并回收剩余子孙；外层启动器退出也会触发清理；JobHost 被硬杀时，内核关闭其 Job handle 并回收整组。关闭前台终端同样以回收为保障，不承诺在系统结束进程前完成优雅退出。受管命令另行创建 Windows 服务、计划任务等外部进程不属于普通子孙管理契约。

JobHost 的管道只允许当前 Windows 用户连接，每条命令仍需验证本次运行令牌。`ping` 返回 supervisor 与受管 Node 的 PID、父 PID 和字符串形式的 UTC 启动 ticks；端口查询同时检查 IPv4、IPv6 的监听归属，没有监听或混有外部 owner 时返回未拥有。

正常停止路径：

1. 通过受管应用的认证控制管道请求停止：不再接受新的 HTTP 连接，最多给现有请求 3 秒完成，然后断开连接并退出。
2. 应用控制通道不可用时，向 JobHost 发出停止请求；有兼容控制台时尝试给受管进程组发送 Ctrl+Break，最多等待 5 秒，随后回收 Job。无控制台时直接执行 Job 回收。
3. 控制通道仍失败时，停止脚本只通过已核验并持有的 supervisor handle 终止该实例；不会按端口号或进程名称批量结束程序。

前台 `Ctrl+C` 也会进入停止处理。代理、上游或 supervisor 意外退出后不自动重启，不重放旧请求，避免无提示地重复推理。

## 后台状态与端口冲突

```powershell
& 'D:\Codes\Github\CopilotImageProxy\scripts\start.ps1' -Config '.\proxy-config.json' -CopilotArgs @('start', '--proxy-env')
& 'D:\Codes\Github\CopilotImageProxy\scripts\stop.ps1'
```

后台脚本从自身位置找到本项目，但配置相对路径和传给官方 CLI 的工作目录都来自调用者。隐藏后台模式不适合首次交互认证；先在前台运行官方 `auth` 或受管启动完成认证。后台入口只接受服务器启动命令。

`.run/service.json` 保存 run ID、supervisor PID 与 UTC 启动 ticks、路径、配置及参数摘要、端口和控制管道信息。其中控制令牌用于本地停止认证，不是可公开的验收数据。停止前核验 PID、创建时间和可执行文件路径，并保持 handle，防止 PID 重用后误停其他进程。运行状态不匹配时拒绝操作。启动/停止锁用于避免本项目的并发生命周期操作。

启动前检测代理与上游端口。若端口已有外部实例，立即失败，不接管、不停止。检测后仍可能发生端口竞争，因此就绪阶段还要确认实际监听 PID 属于当前 Job，并有 HTTP 响应；仅“该端口可以连接”不够。`upstreamStartupTimeoutMs` 默认 180000，约束等待上游就绪的时间。

从 v1 升级时，应先用旧版方式关闭旧代理，再在其原启动位置停止独立 copilot-api，之后启动 v2。v2 的停止操作会一起关闭它拥有的上游；若要恢复独立运行，需停止 v2 后重新启动独立的官方 CLI。

## worker 与容量保护

HTTP 主线程先做保守的字节标记检查。无 `input_image` 且无 `\u` 时直接透传并执行完整请求预算；遇到图片或 Unicode 转义候选时，把 JSON 和图片转换交给按需创建的单例 worker。worker 不是额外的 copilot-api 实例，不额外发送推理请求。

`maxImageQueueMiB` 默认 256 MiB，用于限制候选请求队列容量；满时返回本地 503，尚未请求上游。`maxInputMiB` 分别限制入站和解压后的字节，`maxOutputMiB` 限制转换后的完整 JSON；默认 24 MiB 是本地策略，不是 Copilot 官方公布的上限。`cacheMiB` 限制最终图片结果与索引的缓存预算，不是 worker 或服务的总 RSS 上限。

停止服务时不再接收新工作，并取消或关闭剩余请求与处理任务；最后由受管进程退出和 Job 回收保证整套服务结束。该机制不改变 Codex 自身的重试逻辑。

首次启动会使用 Windows .NET Framework 编译器构建 `bin/JobHost.<源码 SHA-256>.exe`。构建使用对应源码快照，完成后才发布；并发启动复用同一版本，源码变化产生新文件，不覆盖仍在运行的旧版本。状态文件记录实际可执行路径，停止脚本同时兼容旧版 `bin/JobHost.exe`。构建产物不提交。也可执行 `npm run build:supervisor`。进程回收、CLI 兼容性和 worker 性能的实测记录见 [v2 验收记录](validation-v2.md)；文档里的默认值与设计行为不替代真实上游验收。
