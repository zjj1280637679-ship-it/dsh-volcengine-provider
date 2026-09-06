# dsh-volcengine-provider

DeepSeek Harness 的火山方舟供应商插件，当前为 `0.1.0-alpha.9` 预发布版本。提供普通 API、Agent Plan、Coding Plan 三张独立供应商卡片，以及手动模型配置。

**建设积极自由，同时不干涉消极自由。** 供应商反馈用于辅助选择；模型、输入模态、请求参数由用户决定。反馈不自动改写配置，不生成模型白名单或调用限制。

## 最小配置

在新版 Harness 的 Models 设置页、或 `0.1.1-rc.2` 的 Plugins 设置页打开对应方舟卡片，填写**该通道的 API Key 和至少一个模型 ID**，点击**“保存方舟配置”**，保存后即可在模型列表中选择。已有环境凭据时不用重复填写密钥。插件启动、打开卡片和列出手动模型都不触发方舟请求。

本次选定的 lite／flash 模型另有 [Coding Plan 最小媒体配置](examples/coding-plan-media.yml)。示例只填写用户选择的模型 ID，刻意不预填任何模态；未设置表示未知且允许尝试，不代表插件判断模型支持或不支持某种输入。

| 通道 | 默认 API 地址 | 默认密钥引用 | Harness Provider ID |
| --- | --- | --- | --- |
| 普通 API | `https://ark.cn-beijing.volces.com/api/v3` | `ARK_STANDARD_API_KEY` | `volcengine-standard` |
| Agent Plan | `https://ark.cn-beijing.volces.com/api/plan/v3` | `ARK_AGENT_PLAN_API_KEY` | `volcengine-agent-plan` |
| Coding Plan | `https://ark.cn-beijing.volces.com/api/coding/v3` | `ARK_CODING_PLAN_API_KEY` | `volcengine-coding-plan` |

[火山方舟的 DeepSeek Harness 专项文档](https://console.volcengine.com/ark/region:cn-beijing/docs/82379/2637930?lang=zh)明确把 OpenAI Chat Completions、`/api/coding/v3` 和 `ark-code-latest` 列为 Coding Plan 的可用组合。Coding Plan 密钥不要配到普通 `/api/v3`：该地址属于按量计费通道，不会消耗 Coding Plan 套餐额度。

三条通道分别保存地址、密钥引用和模型列表。适配器每次只发送一次请求，不内置重试或跨通道回退；上层 Harness 的重试策略仍由宿主管理。地址可以在高级配置中修改；表中地址是插件默认值，实际服务是否接受请求需真实联调确认。

每个模型的高级配置包括：

- 文本、图片、视频、音频三态开关：未设置（继承）、强制开启、强制关闭。未设置表示能力未知，不自动填入能力，也不阻止请求；只有用户明确选择强制关闭才在本地阻断。
- 智能体媒体续链预算：默认 `45` 十进制 MB，`0` 关闭。它只检查 `tool-result` 新带入的图片和视频；累计超过预算的媒体只从本次模型请求省略，工具文本和机器可读诊断仍交给模型，让下一轮由 AI 自行选择策略。它不删除原文件、不压缩、不重试，也不作用于用户主动上传。
- 自定义请求体 JSON：`merge` 合并、`patch` 以 `null` 删除字段、`raw` 完整替换；未知 JSON 字段保留。
- 可选显示名称、上下文容量和输出上限；不根据供应商反馈自动填写容量。

插件不向 Harness 发布封闭的 `inputModalities` 列表；字段缺省表示未知，避免宿主在请求到达适配器前把未列出的媒体视为禁用。供应商反馈和运行时成功／拒绝都只作为证据，不会新增、开启、关闭或改写模型卡设置。

思考模式在模型的自定义请求体中设置，不新增对话界面的统一思考开关。通道和模型中已有的普通未知配置字段会保留，便于继续增加 UI 控件。请求体通过 JSON 文本保存，避免宿主设置对象合并改写特殊字段；详见 [第四步说明](docs/step4-configuration.md)。

## 本地构建与安装

在自己电脑接手，请按 [本机接手指南](docs/local-handoff.md) 获取完整开发分支、安装并完成最小验收。

需要 Node.js `^22.19.0 || >=24.0.0`、本仓库声明的 pnpm，以及已安装的 Harness CLI。

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
npm pack
dsh plugin --profile web add ./dsh-volcengine-provider-0.1.0-alpha.9.tgz
dsh --profile web --dump-config
dsh --profile web
```

以上命令在本仓库根目录执行。包提供宿主入口 `dist/index.js`、浏览器入口 `dist/client.js` 和 `cordis.patch.yml`；`dsh.bundle` 会在 `plugin add` 后把插件加入 profile 的组合层，`dsh.client` 让 Web 宿主加载卡片，不再需要额外 patch 才能激活。要预填示例模型，可在 dump 和启动命令上另加 `--patch ./examples/coding-plan-media.yml`；该覆盖层会替换插件行的完整配置。

从 GitHub commit 直接安装时，包的 `prepare` 会构建 TypeScript；pnpm 10 及以上要求用户在该 profile 明确授权 git 依赖的构建脚本。无需授予构建权限的交付路径仍是上面的预编译 `.tgz`。

这是 GitHub alpha 预发布流程；`private: true` 保留，因此不会发布到 npm。正式安装以 [`v0.1.0-alpha.9` Release](https://github.com/zjj1280637679-ship-it/dsh-volcengine-provider/releases/tag/v0.1.0-alpha.9) 的预编译 `.tgz` 为准；默认分支、版本标签和 Release 附件均应指向同一候选提交。

## 已实现与验证边界

- Chat adapter 仅实现 OpenAI-compatible Chat Completions，支持请求序列化、SSE 和非流式 JSON 回复、文本／推理／工具调用／用量转换；HTTP 错误保留结构化事实。Responses 与 Anthropic Messages 是不同 wire protocol，本版本不以换路径冒充支持。
- Cordis 插件注册供应商目录、模型目录、设置 namespace 和凭据引用；保存配置与轮换密钥作用于后续请求。
- Web 卡片在新版宿主使用官方 Models slot 与 namespaced Remotes，在 `0.1.1-rc.2` 使用稳定的 Plugins slot 与 `connection.api`；两条路径共用同一表单，支持本地草稿、JSON 校验、保存失败提示、重新载入和通道停用。
- 模型发现保留丰富原始 Feedback；当前自定义卡片以手动模型为入口，尚无丰富反馈查看器。
- 本地验证覆盖 Fake Ark HTTP、Cordis/LLM 宿主组合、设置热更新及卡片组件。2026-09-05 的真实 Coding Plan 测试中，`doubao-seed-2.0-lite` 与 `glm-5.3-flash` 均经生产适配器返回 HTTP 200、SSE 和 `OK`；详见 [运行记录](docs/live-coding-plan-2026-09-05.md)。2026-09-06 还曾在固定的 Harness `0.1.3-alpha.1` 源码宿主中完成隔离实例验证；那是 [alpha.7 前的历史记录](docs/harness-web-loop-2026-09-06.md)，不能替代当前 `alpha.9` 的唯一实例与冷重启验收。
- 历史真实媒体测试中，flash 图片与原始 MP4 的输出通过内容检查；lite 图片可读，但把正方形称为矩形，严格形状检查未通过；lite 音频被当前 Coding Plan 通道以 HTTP 400 拒绝。发送侧的媒体字节均保持一致，但这只能证明 raw MP4 到 API 的链路与时序输出，不能证明供应商内部未抽帧或等同于 Seed 的原生视频处理，见 [真实媒体报告](docs/live-coding-plan-media-2026-09-05.md)。

`alpha.9` 把媒体入口收敛为 Harness 原生输入栏中、原有附件按钮旁边的一个彩色 `+`。它没有独立问题框、MIME 框或发送按钮：用户一次可选择多个方舟 Chat 支持的原图、原视频或原音频，附件显示为原生引用 chip，问题仍写在 Harness 主输入框，并由原生发送键、Enter、排队或插话路径提交。插件借用 Harness 的 `conversation.input.left`、输入引用 codec 和原生 `Session.prompt` 接口，因此文本与媒体只形成一条用户消息，而不是两套会话。

文件类型由扩展名和浏览器声明共同核验，不由用户手填；两者冲突会在本机拒绝，未知能力仍交给模型和 API 裁决。当前 Chat 路径接收方舟文档列出的图片、MP4／AVI／MOV，以及 MP3／WAV／AAC／M4A；PDF 属于 Responses／Files 路径，本适配器不会伪装成 Chat 支持。模态保持未设置即可尝试，只有模型卡中被用户明确强制关闭的模态才会阻断。

彩色 `+` 仅是输入旁路：浏览器把用户主动选择的文件按服务端公布的块大小原样写入插件专属、loopback-only 的持久暂存区；不接收本机路径，也不扫描桌面。暂存引用精确绑定 session、provider 和 model，选择变化即拒绝提交。Harness 用自己的引用持久化格式保存草稿，插件在页面刷新或整个 Harness 重启后重新解析并恢复 chip。旧 `/ark-media` 与 MP4 token 接口仅作为已有会话／调用方的内部兼容层保留，不再构成另一套用户界面。

删除 chip 会取消仍在进行的传输并退役 bundle/manifest，但内容寻址对象是会话附件的耐久存储，不能在没有历史引用账本时按单个 bundle 草率删除：同一 SHA-256 对象可能已被其他持久化消息复用。当前版本优先保证历史与重启可读；被放弃且未被任何消息采用的唯一内容对象尚无自动安全 GC，维护时必须先建立或核对引用索引。

用户主动选择的文件没有插件定义的总文件大小上限，也不受“智能体媒体续链预算”影响。安全整数、Node 可表示范围、实时磁盘容量及 V8／系统内存不足属于必须显式报告的物理边界；其余请求体、模型和服务限制交给方舟 API 返回真实错误。带媒体的请求在进程内逐个完成完整原字节读取、Base64／JSON 编码及 HTTP 请求体提交，排队可取消，纯文本不受媒体编码闸门影响。这不是任意大小必然可发的承诺，也不会把文档示例值偷换成插件硬限制。

原图片／视频／音频在适配器边界保持原字节，不压缩、不抽帧、不转码；Chat 音频使用 `input_audio.data` 裸 Base64 与格式标识。媒体引用进入 Harness 后若在 bundle 物化阶段失效，插件保留该条用户文本并添加机器可读诊断；已通过续链预算的 Agent `tool-result` 图片／视频若单块读取、完整性校验或编码失败，也只省略该块并退还预算。取消、显式模态禁用以及请求级 Node 可表示性／实时内存不足仍明确中止，不伪装成成功。用户直接提交后收到的真实方舟拒绝则原样可见，不自动改模型、压缩、重试或抽帧。详见 [第六步原始媒体 UI](docs/step6-original-media-ui.md) 与 [第五步媒体输入](docs/step5-media-input.md)。

官方 `ark-plan-api` 与本插件使用不同的配置行和 Provider ID，技术上可共存，但会出现含义相近、凭据与协议路径不同的方舟卡片。验收或长期使用时建议在隔离 profile 中明确选择一种，尤其不要把 Coding Plan 密钥误发到普通 `/api/v3` 通道。

当前历史界面将专用媒体块显示为 JSON；会话导出不会自动携带这些块的媒体字节，同机共用原 `DSH_HOME` 可继续读取，但导出包尚不能保证移机完整重放。

宿主兼容按公共能力判断，不按 `@deepseek-ai/dsh-*` 的预发布版本号判断。这些模块由 Harness 安装的依赖闭包提供，发布包不会把某一周的宿主组件写成 peer 版本锁，也不会私带一份旧宿主实现；`devDependencies` 中的精确版本只用于可复现编译和测试。当前适配器核心、模型目录、模型发现、设置挂载、UI 插槽和媒体入口分别探测：可选能力缺失时只停用对应界面或入口，核心 LLM 接口缺失时插件显式告警并保持宿主可启动。媒体上传代次优先订阅新版公开的 `connection.generation`，并兼容旧版公开的 `connection.hostDescription`；两者都不存在就不挂载入口，避免重连后误用旧上传。ABI 门禁同时检查这些 client 类型与方法结构。此策略覆盖经过验证的同一公共接口族，不承诺未知破坏性版本或未来 major 自动兼容。

源码设计与完整宿主验收基线均为 DeepSeek Harness [`d347e703908d0406b7a7ef80e3a0e594d86b2215`](https://github.com/deepseek-ai/deepseek-harness/tree/d347e703908d0406b7a7ef80e3a0e594d86b2215)（`dsh-v0.1.3-alpha.1`）；可安装组件验证还覆盖 npm `0.1.2-rc.1`。`0.1.0-alpha.9` 额外兼容 Harness `0.1.1-rc.2`：Models 页保留宿主的通用供应商行，已配置通道的高级方舟卡片改在 Plugins 页挂载；供应商注册、热配置、凭据状态、文本以及彩色 `+` 原始多媒体旁路均按公共能力挂载。兼容声明与已验证版本分别记录，未验证的升级不等于通过验收。

设计资料：[第一阶段基本闭环](docs/phase1-basic-loop-2026-09-05.md) · [自由度合同](docs/design-contract.md) · [验证环境](docs/verification-environment.md) · [第三步适配器](docs/step3-adapter-plan.md) · [第四步配置与 UI](docs/step4-configuration.md) · [第五步媒体输入](docs/step5-media-input.md) · [历史隔离闭环](docs/harness-web-loop-2026-09-06.md)
