# 本机接手：alpha.9 火山方舟插件

目标是：配置方舟供应商 → 选模型 → 用主输入框旁的彩色 `+` 添加原始媒体 → 与文本作为同一消息发送 → 收到回复或真实错误 → 完整关闭并重启同一个 Harness 后继续使用。

## 1. 先确认唯一 Harness

不要只看端口。每次安装前记录：

```powershell
npx @deepseek-ai/dsh --version
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '@deepseek-ai[\\/]dsh|dsh web' } | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine
Get-NetTCPConnection -State Listen | Where-Object LocalPort -in 3080,3081 | Select-Object LocalAddress,LocalPort,OwningProcess
```

核对 Node、DSH 包路径、profile 和监听 PID。端口健康或浏览器标题相同都不能证明来源唯一。安装与重启前先为当前 profile、lockfile 和插件包做冷备份；旧包移出活动路径，不直接删除。

## 2. 构建与安装

完整代码在本地 `codex/local-loop-20260906` 分支。`0.1.0-alpha.9` 是未发布的本地包，不要把默认分支或旧 alpha 报告当成本次候选。

```powershell
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test:ci
pnpm run build
pnpm run test:package
npm pack
dsh plugin --profile web add ./dsh-volcengine-provider-0.1.0-alpha.9.tgz
dsh --profile web --dump-config
```

真实联调只使用 Harness 已配置的凭据。不要读取、复制或输出 API Key；GitHub Actions 密钥也不会随源码下发到电脑。

包通过 `dsh.bundle` 和 `cordis.patch.yml` 自动加入 profile。运行时依赖由 Harness 自己提供；`devDependencies` 的精确版本只用于可复现编译，不是把每周更新的 Harness 锁死在旧版本。插件按公共能力检测分别挂载核心 adapter、设置卡片、输入引用和 loopback RPC；未知破坏性升级仍须重新验收。

## 3. 配置与最小使用

1. 新版 Harness 在 Models 页、`0.1.1-rc.2` 在 Plugins 页打开相应方舟卡片。
2. 本机保存该通道 API Key 和至少一个模型 ID；普通 API、Agent Plan、Coding Plan 地址与凭据互相独立。
3. 模态保持“未设置”即可真实尝试；只有用户明确“强制关闭”才本地阻断。
4. 在会话选择方舟模型。点击 Harness 原附件按钮旁边的彩色 `+`，可一次选择多个原始图片／视频／音频。
5. 在主输入框填写问题，使用原生发送或 Enter。没有 MIME 输入框、媒体问题框或独立发送按钮。

扩展名和浏览器类型冲突会在本地拒绝；图片、视频和音频字节不压缩、不抽帧、不转码。用户主动上传不受插件固定文件总大小阈值或智能体续链预算阻断；物理资源不足会明确报错，其余限制由真实方舟响应决定。

## 4. 生命周期验收

必须把插件生命周期与外层程序生命周期分开验证：

1. 冷启动 `cmd.exe /d /c npx @deepseek-ai/dsh web`，核对唯一进程树、loopback 监听、HTTP 标题与实际 PID 来源。
2. 检查三张供应商卡、密码型 API Key UI、模型卡、四种模态三态选择，以及彩色 `+` 是否紧邻原附件入口。
3. 发送纯文本，确认真实回复或结构化上游错误。
4. 选择受控原始图片、音频、完整视频；在同一主输入写问题后发送。抽帧图片不能计作视频理解验收。
5. 在媒体 chip 尚留在草稿时刷新页面，确认恢复；再完整关闭 Harness，确认旧 PID 和端口消失，重新从上述日常命令启动并确认 chip／引用恢复。
6. 覆盖普通发送、忙时 queue 和 steer；三者都必须保持一个原生 UserMessage 和同一 message ID。
7. 让方舟 API 对不支持或过大的用户媒体返回真实错误，确认插件不自动压缩、抽帧、切模型或改写模态。
8. 模拟已接收消息后的本地媒体失效，确认文本继续、媒体省略并带 `[VOLCENGINE_MEDIA_OMITTED code=…]`，Agent 可在下一轮处理。
9. 再执行第二次完整停止／冷启动，证明结果不是热加载或隐藏验证进程留下的假阳性。

## 5. 关闭后的证据

交付报告至少记录：候选 commit、包名与 SHA-256、源码归档 SHA-256、Harness/Node 版本、启动命令与来源路径、安装 profile、关闭前后 PID/端口、冷启动次数、UI 控件、受控样本 SHA-256、真实模型与 HTTP/请求 ID 结果、失败边界和回退目录。报告不得包含密钥值。

同机重启恢复依赖同一个 `DSH_HOME`。当前会话导出不保证携带插件持久媒体对象，不能把本机恢复推断成跨电脑迁移。队列 UI 也可能在消息被 Agent 领取前短暂显示内部 marker；这是当前宿主队列渲染扩展点的边界，不影响同一消息投递，但必须在报告中如实写明。

详细设计见 [原生输入栏的方舟媒体旁路](step6-original-media-ui.md)，历史 API 媒体证据见 [Coding Plan 原始媒体实测](live-coding-plan-media-2026-09-05.md)。
