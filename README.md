# dsh-volcengine-provider

DeepSeek Harness 的火山方舟供应商插件，当前为 `0.1.0-alpha.1` 开发版本。提供普通 API、Agent Plan、Coding Plan 三张独立供应商卡片，以及手动模型配置。

**建设积极自由，同时不干涉消极自由。** 供应商反馈用于辅助选择；模型、输入模态、请求参数由用户决定。反馈不自动改写配置，不生成模型白名单或调用限制。

## 最小配置

在 Harness 的 Models 设置页打开对应方舟卡片，填写**该通道的 API Key 和至少一个模型 ID**，点击**“保存方舟配置”**，保存后即可在模型列表中选择。已有环境凭据时不用重复填写密钥。插件启动、打开卡片和列出手动模型都不触发方舟请求。

| 通道 | 默认 API 地址 | 默认密钥引用 | Harness Provider ID |
| --- | --- | --- | --- |
| 普通 API | `https://ark.cn-beijing.volces.com/api/v3` | `ARK_STANDARD_API_KEY` | `volcengine-standard` |
| Agent Plan | `https://ark.cn-beijing.volces.com/api/plan/v3` | `ARK_AGENT_PLAN_API_KEY` | `volcengine-agent-plan` |
| Coding Plan | `https://ark.cn-beijing.volces.com/api/coding/v3` | `ARK_CODING_PLAN_API_KEY` | `volcengine-coding-plan` |

三条通道分别保存地址、密钥引用和模型列表。适配器每次只发送一次请求，不内置重试或跨通道回退；上层 Harness 的重试策略仍由宿主管理。地址可以在高级配置中修改；表中地址是插件默认值，实际服务是否接受请求需真实联调确认。

每个模型的高级配置包括：

- 文本、图片、视频、音频三态开关：继承、强制开启、强制关闭；继承时文本开启，其余关闭。
- 自定义请求体 JSON：`merge` 合并、`patch` 以 `null` 删除字段、`raw` 完整替换；未知 JSON 字段保留。
- 可选显示名称、上下文容量和输出上限；不根据供应商反馈自动填写容量。

思考模式在模型的自定义请求体中设置，不新增对话界面的统一思考开关。通道和模型中已有的普通未知配置字段会保留，便于继续增加 UI 控件。请求体通过 JSON 文本保存，避免宿主设置对象合并改写特殊字段；详见 [第四步说明](docs/step4-configuration.md)。

## 本地构建与安装

需要 Node.js `^22.19.0 || >=24.0.0`、本仓库声明的 pnpm，以及已安装的 Harness CLI。

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
npm pack
dsh plugin --profile web add ./dsh-volcengine-provider-0.1.0-alpha.1.tgz
dsh --profile web --patch ./examples/cordis.yml --dump-config
dsh --profile web --patch ./examples/cordis.yml
```

以上命令在本仓库根目录执行。包提供宿主入口 `dist/index.js` 和浏览器入口 `dist/client.js`；`dsh.client` 让 Web 宿主加载卡片。当前包没有 `dsh.bundle`：安装只添加依赖，需通过上述 patch 启用。长期使用可将 [examples/cordis.yml](examples/cordis.yml) 的条目追加到 `$DSH_HOME/profiles/web/cordis.patch.yml` 的 YAML 数组，然后使用 `dsh --profile web` 启动。

这是本地 alpha 包验证流程；`private: true` 保留，尚未发布 npm 或正式 Release。前置开发工作仍在草稿 PR 链上，不应把默认分支当成完整安装版本。

## 已实现与验证边界

- Chat adapter 支持请求序列化、SSE 和非流式 JSON 回复、文本／推理／工具调用／用量转换；HTTP 错误保留结构化事实。
- Cordis 插件注册供应商目录、模型目录、设置 namespace 和凭据引用；保存配置与轮换密钥作用于后续请求。
- Web 卡片使用官方 Models slot、settings 和 credentials Remote；支持本地草稿、JSON 校验、保存失败提示、重新载入和通道停用。
- 模型发现保留丰富原始 Feedback；当前自定义卡片以手动模型为入口，尚无丰富反馈查看器。
- 本地验证覆盖 Fake Ark HTTP、Cordis/LLM 宿主组合、设置热更新及卡片组件。真实方舟 API 未测试，完整 Harness Web 安装后的人工验收仍需补齐。

媒体入口增加 `/ark-media video/mp4,audio/mpeg -- 提问`：先选择方舟模型并开启对应模态，附加文件，再按附件顺序填写 MIME。仅在宿主提供 commands 与原文件 `readFileStream` 时注册；采用能力检测，不按精确版本锁定。

原文件图片／视频／音频在适配器边界保持原字节，不压缩、不抽帧、不转码；Chat 音频使用 `input_audio.data` 裸 Base64 与格式标识。普通图片附件可能已被 Harness 规范化，**严格原图必须走官方 file upload 文件链**，目前没有新增原图上传按钮。npm `0.1.2-rc.1` 缺少原文件接口，固定 `0.1.3-alpha.1` 源码具备相关接缝；完整 Web 和真实方舟媒体链路仍未验收。使用方式、来源及 UI 扩展约定见 [第五步媒体输入](docs/step5-media-input.md)。

当前历史界面将专用媒体块显示为 JSON；会话导出不会自动携带这些块的媒体字节，同机共用原 `DSH_HOME` 可继续读取，但导出包尚不能保证移机完整重放。

源码设计基线为 DeepSeek Harness [`d347e703908d0406b7a7ef80e3a0e594d86b2215`](https://github.com/deepseek-ai/deepseek-harness/tree/d347e703908d0406b7a7ef80e3a0e594d86b2215)；本地可安装组件验证使用 `0.1.2-rc.1`。兼容声明与已验证版本分别记录，未验证的升级不等于通过验收。

设计资料：[自由度合同](docs/design-contract.md) · [验证环境](docs/verification-environment.md) · [第三步适配器](docs/step3-adapter-plan.md) · [第四步配置与 UI](docs/step4-configuration.md) · [第五步媒体输入](docs/step5-media-input.md)
