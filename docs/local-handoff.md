# 本机接手：alpha.6 火山方舟插件

目标为：配置方舟供应商 → 选模型 → 从会话 UI 发送文本或用户主动选择的媒体 → 收到回复或明确错误 → 完整关闭并重启同一个 Harness 后仍能继续。插件复用 Harness 的配置、凭据、模型选择、命令和会话接口；旧宿主缺少原文件上传能力时，仅在 loopback Web 中补一个原始 MP4 分块入口。

## 1. 获取并验证插件

准备 Git、Node.js `^22.19.0 || >=24.0.0`、pnpm `11.7.0`。以下命令可在 Windows PowerShell 中逐行执行；任一步失败时先停下检查输出。

```powershell
git clone --branch media-live-v0.1 --single-branch https://github.com/zjj1280637679-ship-it/dsh-volcengine-provider.git
cd dsh-volcengine-provider
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test:ci
pnpm run build
pnpm run test:package
npm pack
```

完整代码目前在本地 `codex/local-loop-20260906` 分支，基于 `media-live-v0.1`（PR #6），不要使用尚不完整的 `main`。这是未发布的 `0.1.0-alpha.6` 包；打包产物为 `dsh-volcengine-provider-0.1.0-alpha.6.tgz`。离线复验不需要方舟密钥，不调用真实方舟服务；真实联调只使用 Harness 已配置的凭据，不读取或输出密钥值。

## 2. 确认宿主，再安装启用

下列命令以电脑上已经安装、可运行的 Harness CLI `dsh` 为前提。

新版宿主的原始媒体入口使用公共 `fileUpload`、Commands 和附件 `readFileStream`。兼容安装目标 Harness `0.1.1-rc.2` 没有原文件接口，也没有 `remote.llm`；`alpha.6` 不把后者设为硬依赖，而是在当前 loopback Web 中通过 authority-aware RPC 分块暂存一个用户明确选择并声明为 `video/mp4` 的原始 MP4，再由 token-only 命令写入当前会话。入口不扫描桌面或其它用户目录，不抽帧、不转码、不修改文件字节。`0.1.1-rc.2` 的高级方舟表单在 Plugins 页挂载，Models 页仍用于查看和选择模型。插件按公共能力检测挂载，不按精确宿主版本锁定；升级后仍必须复验 ABI、UI 和真实请求。

Coding Plan 接入条件以[火山方舟 DeepSeek Harness 专项文档](https://console.volcengine.com/ark/region:cn-beijing/docs/82379/2637930?lang=zh)为准：本插件选择其列出的 OpenAI Chat Completions 协议、`https://ark.cn-beijing.volces.com/api/coding/v3` 与 `ark-code-latest`。不要把 Coding Plan 密钥改配到普通 `/api/v3`，否则会进入按量计费通道。

需要从源码准备宿主时，按该版本的 [官方源码运行说明](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/README.zh.md) 构建。在宿主源码目录中执行安装／启动命令时用 `pnpm dsh`，并把下面插件包与 patch 的相对路径改为本机绝对路径。

在插件仓库根目录执行：

```powershell
dsh --version
dsh plugin --profile web add ./dsh-volcengine-provider-0.1.0-alpha.6.tgz
dsh --profile web --dump-config
dsh --profile web
```

打开启动日志给出的本机地址。包内置 `dsh.bundle` 和 `cordis.patch.yml`；安装成功后应在 dump 中看到 `dsh-volcengine-provider` 层和 `llm-volcengine` 行，不再需要额外 patch 才能启用。

`coding-plan-media.yml` 只预填用户选定的 `doubao-seed-2.0-lite` 和 `glm-5.3-flash`，**不预填模态**。需要该示例时，给上面的 dump 和启动命令另加 `--patch ./examples/coding-plan-media.yml`；不加就是空白模型卡。覆盖层会替换 `llm-volcengine` 行的完整配置，不要再叠加 `examples/cordis.yml` 或在 profile 中重复插入同一行。

也可锁定可信 commit 从 GitHub 安装；此时 `prepare` 会在本机执行构建，pnpm 10 及以上需要按 CLI 提示在目标 profile 的 `pnpm-workspace.yaml` 中明确授权该包。预编译 `.tgz` 不需要这项构建授权。

## 3. 在 Models / Plugins 中配置

1. 新版 Harness 在 Models 页打开对应方舟供应商卡片；`0.1.1-rc.2` 在 Plugins 页打开已配置通道的高级方舟卡片，Models 页仍用于查看和选择模型。在本机填写该通道 API Key，确认模型 ID，点击“保存方舟配置”。普通 API、Agent Plan、Coding Plan 的地址和凭据互相独立。
2. 图片／视频／音频可保持“未设置”：它表示未知，允许尝试，不代表已知支持或不支持。只有用户明确选择 `force_disable` 才会因模态策略在本地阻断。
3. 选择该模型后发送。目录反馈、模型名称及成功／失败结果都不能自动填写或修改模态。

GitHub Actions 中的 `ARK_CODING_PLAN_API_KEY` 不会随克隆下发到电脑，需要在本机重新保存。不要把密钥写进仓库、示例、截图或提交日志。

## 4. 最小人工验收

先发文本，再在会话输入区使用默认展开的“方舟原始媒体”。MIME 必须按实际文件由你手动填写，不会根据扩展名或浏览器类型自动带入；音频格式可以手填，也可在发送时从你填写的 MIME 临时推导，不回写草稿或模型配置。当前 `0.1.1-rc.2` 兼容路径只显示“选择原始 MP4”，一次选择一个文件并要求明确填写 `video/mp4`；图片和音频行只适用于具有宿主原文件上传服务的较新版本。

| 输入 | 操作示例 | 验收点 |
| --- | --- | --- |
| 文本 | 发送“只回复 OK” | 有正常回复，流内错误不会报成功 |
| 图片 | 添加 PNG，手填 `image/png`，询问图中内容 | 媒体请求可送出，原文件不被插件压缩 |
| 视频 | 添加 MP4，手填 `video/mp4`，询问画面变化 | 媒体请求可送出，不自动抽帧或转码 |
| 音频 | 添加 MP3，手填 `audio/mpeg`，询问说话内容 | 请求按音频接口送出，回复或服务端拒绝都明确可见 |

每次发送后检查 Models：未设置的模态仍未设置，手动设置仍原样；拒绝后再次尝试不应被自动禁止。用户主动媒体没有插件总大小阈值，只有 Node 可表示范围以及实时磁盘／内存不足等物理条件会在 API 前明确失败；带媒体请求在进程内串行编码，排队可取消。方舟 API 的模型和请求大小条件由真实响应裁决。然后必须完全关闭外层 Harness、确认原 PID 和监听端口消失，再从日常裸命令启动同一 profile，确认模型配置、本机凭据状态、媒体入口和历史引用仍可使用。

历史真实 Coding Plan 文本和图片链路已联调；lite 音频曾由该通道返回“不支持音频输入”。这些历史结果不能代替当前包的 Web 文件选择、原始 MP4、整程序关闭和重启复验，也不能据此修改模态。原始媒体上传失败／取消会保留草稿；命令一旦被宿主接收会清空媒体草稿，接收并不等于模型最终回复成功，请以会话中的结果为准。任何通过预先抽帧再发图片得到的结论都必须从“原始视频理解”验收中排除。

## 验收边界

- 发布包安装验收不能只看端口或插件热加载：需要核对启动命令、Node 与 DSH 来源、profile 依赖和安装实体，再执行完整停止、冷启动、UI 文件选择、真实上游请求和第二次停止／冷启动。
- 智能体工具结果的图片／视频使用模型卡中的“智能体媒体续链预算”：默认 45 十进制 MB、0 关闭。超额媒体只从本次请求省略，文本和机器可读错误保留；不删除源文件、不自动重试、压缩或切模型。该预算不作用于用户上传。
- 本机兼容路径的持久对象支持同一 `DSH_HOME` 重启后重读，但当前不自动垃圾回收；异常进程崩溃可能留下本实例 staging 目录。会话导出也不保证携带媒体字节或在另一台电脑完整重放。
- 最终交付是否真正通过，以对应安装包的独立实验报告为准；旧版本报告和旧 tgz 只能作为回退资料，不能证明当前版本。

遇到失败时，记录宿主版本、插件 commit、通道／模型 ID、文件 MIME、完整错误码与请求 ID；不要提供 API Key。已有证据见 [第一阶段基本闭环](phase1-basic-loop-2026-09-05.md)和[完整宿主闭环](harness-web-loop-2026-09-06.md)。
