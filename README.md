# dsh-volcengine-provider

DeepSeek Harness 的火山方舟供应商插件，当前为 `0.1.0-alpha.3` 开发版本。提供普通 API、Agent Plan、Coding Plan 三张独立供应商卡片，以及手动模型配置。

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
dsh plugin --profile web add ./dsh-volcengine-provider-0.1.0-alpha.3.tgz
dsh --profile web --dump-config
dsh --profile web
```

以上命令在本仓库根目录执行。包提供宿主入口 `dist/index.js`、浏览器入口 `dist/client.js` 和 `cordis.patch.yml`；`dsh.bundle` 会在 `plugin add` 后把插件加入 profile 的组合层，`dsh.client` 让 Web 宿主加载卡片，不再需要额外 patch 才能激活。要预填示例模型，可在 dump 和启动命令上另加 `--patch ./examples/coding-plan-media.yml`；该覆盖层会替换插件行的完整配置。

从 GitHub commit 直接安装时，包的 `prepare` 会构建 TypeScript；pnpm 10 及以上要求用户在该 profile 明确授权 git 依赖的构建脚本。无需授予构建权限的交付路径仍是上面的预编译 `.tgz`。

这是本地 alpha 包验证流程；`private: true` 保留，尚未发布 npm 或正式 Release。前置开发工作仍在草稿 PR 链上，不应把默认分支当成完整安装版本。

## 已实现与验证边界

- Chat adapter 仅实现 OpenAI-compatible Chat Completions，支持请求序列化、SSE 和非流式 JSON 回复、文本／推理／工具调用／用量转换；HTTP 错误保留结构化事实。Responses 与 Anthropic Messages 是不同 wire protocol，本版本不以换路径冒充支持。
- Cordis 插件注册供应商目录、模型目录、设置 namespace 和凭据引用；保存配置与轮换密钥作用于后续请求。
- Web 卡片在新版宿主使用官方 Models slot 与 namespaced Remotes，在 `0.1.1-rc.2` 使用稳定的 Plugins slot 与 `connection.api`；两条路径共用同一表单，支持本地草稿、JSON 校验、保存失败提示、重新载入和通道停用。
- 模型发现保留丰富原始 Feedback；当前自定义卡片以手动模型为入口，尚无丰富反馈查看器。
- 本地验证覆盖 Fake Ark HTTP、Cordis/LLM 宿主组合、设置热更新及卡片组件。2026-09-05 的真实 Coding Plan 测试中，`doubao-seed-2.0-lite` 与 `glm-5.3-flash` 均经生产适配器返回 HTTP 200、SSE 和 `OK`；详见 [运行记录](docs/live-coding-plan-2026-09-05.md)。2026-09-06 又在固定的 Harness `0.1.3-alpha.1` 源码宿主中完成了预编译包安装、自动激活、Web 配置、真实流式回复、重启持久化及最终包重装复验，见 [完整宿主闭环报告](docs/harness-web-loop-2026-09-06.md)。
- 真实媒体测试中，flash 图片／视频通过内容检查；lite 图片可读，但把正方形称为矩形，严格形状检查未通过；lite 音频被当前 Coding Plan 通道以 HTTP 400 拒绝。四项请求的媒体字节均保持一致，见 [真实媒体报告](docs/live-coding-plan-media-2026-09-05.md)。

媒体入口增加 `/ark-media video/mp4,audio/mpeg -- 提问`：先选择方舟模型，附加文件，再由用户按附件顺序填写 MIME。模态保持未设置即可尝试；只有模型卡中被用户明确强制关闭的模态会被阻断。入口仅在宿主提供 commands 与原文件 `readFileStream` 时注册；采用能力检测，不按精确版本锁定。

在具备公共文件上传服务的 Harness 中，会话输入区新增**“方舟原始媒体”**：添加原图／音频／视频后，必须由用户填写 MIME；浏览器的 `File.type` 不会自动带入。音频格式可由用户另行填写，也可在发送时从用户填写的 MIME 推导协议所需格式；这两种方式都不会反写模型配置或文件草稿。上传失败或取消保留当前草稿，支持复用已完成上传；不改变主输入草稿或自动切模型。详见 [第六步原始媒体 UI](docs/step6-original-media-ui.md)。

原文件图片／视频／音频在适配器边界保持原字节，不压缩、不抽帧、不转码；Chat 音频使用 `input_audio.data` 裸 Base64 与格式标识。普通图片附件可能已被 Harness 规范化，严格原图应使用上述原始媒体入口。npm `0.1.2-rc.1` 缺少原文件接口，不挂载新面板；固定 `0.1.3-alpha.1` 源码具备公共接口，插件按能力检测启用。完整 Harness Web 的文本链路和媒体面板挂载已验收；本轮没有再次从系统文件选择框发送媒体，真实图片／视频结果仍以 2026-09-05 的报告为准。协议与历史兼容细节见 [第五步媒体输入](docs/step5-media-input.md)。

官方 `ark-plan-api` 与本插件使用不同的配置行和 Provider ID，技术上可共存，但会出现含义相近、凭据与协议路径不同的方舟卡片。验收或长期使用时建议在隔离 profile 中明确选择一种，尤其不要把 Coding Plan 密钥误发到普通 `/api/v3` 通道。

当前历史界面将专用媒体块显示为 JSON；会话导出不会自动携带这些块的媒体字节，同机共用原 `DSH_HOME` 可继续读取，但导出包尚不能保证移机完整重放。

源码设计与完整宿主验收基线均为 DeepSeek Harness [`d347e703908d0406b7a7ef80e3a0e594d86b2215`](https://github.com/deepseek-ai/deepseek-harness/tree/d347e703908d0406b7a7ef80e3a0e594d86b2215)（`dsh-v0.1.3-alpha.1`）；可安装组件验证还覆盖 npm `0.1.2-rc.1`。`0.1.0-alpha.3` 额外兼容 Harness `0.1.1-rc.2`：Models 页保留宿主的通用供应商行，已配置通道的高级方舟卡片改在 Plugins 页挂载；供应商注册、热配置、凭据状态、文本和宿主标准图片链路均可用。该宿主没有原文件读取接口，因此原始图片／音频／视频面板仍不会挂载。兼容声明与已验证版本分别记录，未验证的升级不等于通过验收。

设计资料：[第一阶段基本闭环](docs/phase1-basic-loop-2026-09-05.md) · [自由度合同](docs/design-contract.md) · [验证环境](docs/verification-environment.md) · [第三步适配器](docs/step3-adapter-plan.md) · [第四步配置与 UI](docs/step4-configuration.md) · [第五步媒体输入](docs/step5-media-input.md) · [完整宿主闭环](docs/harness-web-loop-2026-09-06.md)
