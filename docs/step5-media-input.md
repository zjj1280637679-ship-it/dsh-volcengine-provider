# 第五步：原字节媒体输入与宿主接缝

本页保留第五步实现时的范围；后续已新增原始媒体上传面板并执行真实 Coding Plan 媒体测试，当前进展见 [第六步 UI](step6-original-media-ui.md) 与 [实测记录](live-coding-plan-media-2026-09-05.md)。下文“本步没有上传按钮／不执行真实 API”描述的是第五步当时的验收范围。

本步在现有 Chat Completions 适配器上纠正音频格式，并通过 Harness 官方附件和命令服务补充最小媒体入口。原图、视频、音频均可使用原文件引用；插件读取和编码时不压缩、不抽帧、不转码、不降采样。

## 最小使用流程

1. 在 Models 中选择方舟模型。模态未设置／`inherit` 时保持未知并允许尝试，无需程序或用户先补出一张能力表；只有用户明确 `force_disable` 的模态会被阻断。
2. 通过宿主支持的文件附件入口添加媒体，等待上传完成。
3. 按附件顺序填写一个 MIME，使用 `/ark-media` 提交问题。例如先附加 MP4，再附加 MP3：

```text
/ark-media video/mp4,audio/mpeg -- 视频动作与音频节奏是否一致？
```

每个附件对应一个 MIME，多个 MIME 用逗号分隔；`--` 必须填写，后面的问题可以为空。音频可以显式覆盖发送给方舟的格式标识：

```text
/ark-media audio/x-custom=vendorformat -- 描述这段声音。
```

格式覆盖只改变本次请求的 `input_audio.format`，不改变字节，也不说明模型一定支持该格式。文件引用没有 MIME 信息，MIME 必须由用户填写，插件不根据文件名或浏览器 `File.type` 猜测。普通图片引用则必须填写宿主准入后的 MIME；不匹配时命令会报告实际类型，仍保留原来的普通图片引用。插件不读取用户文本中的本地路径或附件句柄来寻找媒体。

命令仅在宿主同时提供公共 commands 服务和 `readFileStream` 方法时注册。这只能确认接口存在：新版附件基类的方法可能返回 `ATTACHMENT_FILES_UNSUPPORTED`，实际存储提供方不支持原文件时仍明确失败。提交时只接受当前选中的本插件方舟供应商；未选方舟、无法确认选中模型、附件与 MIME 数量不符、附件类型不符等情况应明确失败，不改选供应商或自动回退到按量通道。命令不会自动填写、开启或关闭模型模态；未设置允许尝试，只有模型卡中用户明确 `force_disable` 才阻断。

## 图片的两条链路

| 来源 | 插件内容块／读取方式 | 字节保证 |
| --- | --- | --- |
| 宿主普通图片附件 | `image` → `attachments.readImage` | 保留宿主交给适配器的图片字节；宿主图片准入可能已规范化或重编码，不能保证用户原图 |
| 宿主原文件附件，显式声明图片 MIME | `volcengine-image` → `readFileStream` | 从已保存的原文件到 HTTP 内容编码保持原字节 |
| 宿主原视频／音频文件附件 | `volcengine-video` / `volcengine-audio` → `readFileStream` | 同上；视频内音轨也随完整文件保留 |

严格原图必须先进入官方 file upload 原文件链。源码基线的默认 Web `createDrafts` 会把可识别图片分到普通图片链；本步没有提供“以原文件上传图片”的新按钮，也无法恢复已经被宿主重编码的原始字节。`volcengine-image` 是为原文件链与未来 UI 保留的明确入口，不能把普通图片附件改名为该内容块后声称恢复原图。

## 当前 Chat 媒体格式

| 媒体 | `messages[].content[]` 中的默认编码 |
| --- | --- |
| 图片 | `{"type":"image_url","image_url":{"url":"data:image/png;base64,…"}}` |
| 视频 | `{"type":"video_url","video_url":{"url":"data:video/mp4;base64,…"}}` |
| 音频 | `{"type":"input_audio","input_audio":{"data":"裸Base64","format":"mp3"}}` |

音频此前写成 `audio` + `audio_url`，本步按 [方舟音频理解教程](https://docs.volcengine.com/docs/82379/2377589?lang=zh) 纠正为 `input_audio`；其中 `data` 是裸 Base64，不带 `data:audio/...;base64,` 前缀。协议要求 `format` 时，序列化器可以从用户手动填写的 MIME 临时推导已知格式；用户仍可显式填写其他格式。推导结果只存在于本次请求，不回写模型配置或文件草稿，也不生成模型能力白名单。

图片和视频使用 Data URL，分别依据 [图片理解](https://docs.volcengine.com/docs/82379/1362931?lang=zh) 与 [视频理解](https://docs.volcengine.com/docs/82379/1895586?lang=zh) 教程。默认编码不自行添加 `fps` 或图片 detail 参数；自定义请求体与 `encodeMediaPart` 扩展仍保留，参数是否被模型接受需实际请求确认。

## 协议资料与实现范围

以下为 2026-09-05 整理的官方示例，不应把不同 API 的内容块混用：

| 输入 | Chat Completions | Responses | 本步 |
| --- | --- | --- | --- |
| 图片 URL／Data URL | `image_url.url` | `input_image.image_url` | 原文件字节编码为 Chat Data URL |
| 视频 URL／Data URL | `video_url.url` | `input_video.video_url` | 原文件字节编码为 Chat Data URL |
| 视频 File ID | `video_url.file_id` | `input_video.file_id` | 尚未接入 Files 上传／等待／引用流程 |
| 音频 Base64 | `input_audio.data` + `format` | `input_audio.audio_url` 使用 Data URL | 使用 Chat 裸 Base64 形式 |

**Chat 视频也支持 `file_id`**，不能写成 Responses 独有；最新视频教程已有这种形状。音频 URL 和 File ID 以及图片 File ID 的具体例子以对应教程为准，不由本步的上传入口实现。SDK 的 `file://` 示例是 SDK 代为上传的便利写法，不能直接作为裸 HTTP 的本地文件地址。本插件没有实现 Responses、Files 上传、远程媒体抓取或自动格式转换。

官方教程提供的可复用示例素材为 [示例图片](https://ark-project.tos-cn-beijing.volces.com/doc_image/ark_demo_img_1.png)、[示例视频](https://ark-project.tos-cn-beijing.volces.com/doc_video/ark_vlm_video_input.mp4)、[示例音频](https://ark-project.tos-cn-beijing.volces.com/doc_audio/ark_demo_audio.mp3)。它们可以用于后续显式冒烟验证，本轮没有用这些素材调用真实方舟 API。

## Harness 能力差异

| 能力 | npm `0.1.2-rc.1` 测试基线 | 固定 `0.1.3-alpha.1` 源码基线 |
| --- | --- | --- |
| 普通图片附件及 `readImage` | 已有 | 已有，图片准入仍有规范化 |
| 通用 `FileBlock` 与 `FileAttachmentRef` | 未提供 | 已有；文件存储原字节，不携带 MIME |
| `readFileStream` | 未提供 | 已有，读取过程校验长度和摘要 |
| 命令接收通用文件附件 | 不能假定具备新版文件链 | 已有；文件上传凭证由宿主解析为已准入引用 |
| 默认通用文件的模型投影 | 没有新版 `FileBlock` | 在提供方前投影为句柄文本，不自动成为视频／音频 |

这里的源码基线为 [`d347e703908d0406b7a7ef80e3a0e594d86b2215`](https://github.com/deepseek-ai/deepseek-harness/tree/d347e703908d0406b7a7ef80e3a0e594d86b2215)。源码具备接口不等于 npm 包或用户当前运行环境具备它；插件按公开能力是否存在启用入口，不以精确版本号封锁运行。旧宿主仍可使用已有文字与普通图片适配路径；直接调用缺少原文件读取能力的媒体路径会明确返回错误。

`/ark-media` 从命令调用的有序、已准入附件构造内容块，媒体在前、问题在后，再通过 `agent.steer` 显式交给当前 agent。命令成功仅表示提交给 agent，不表示方舟请求或模型理解已成功。插件和依赖服务卸载时会撤销命令注册。

供应商选择读取宿主的待生效模型投影、会话请求头、默认模型，依次取可用结果；未知时明确失败。命令不扫描通用文件的文本投影、不从聊天历史恢复附件授权、不增加另一套上传 RPC。宿主仍拥有上传、凭证解析、持久保存和取消；适配器拥有字节读取及协议编码。

## 保留 UI 扩展性

内容构造与命令语法分离：`buildMediaContent(attachments, declarations, prompt?)` 接受结构化 MIME／音频 format 声明，`buildMediaCommandContent` 负责斜杠命令语法。后续 UI 可以直接调用纯构造函数，让每个附件独立显示 MIME 和音频格式选择，无需拼接命令字符串。模型卡仍拥有用户显式模态策略与高级请求体；输入控件只表示本次附件如何提交，不根据供应商反馈、运行结果或文件元数据改写模型卡。

| 官方 slot | 可添加的未来 UI |
| --- | --- |
| `conversation.input.left` / `right` | 原文件媒体入口、显式模式按钮 |
| `conversation.input.dock` | 每个附件的 MIME／格式编辑及待提交摘要 |

这些 slot 是可追加的列表。`conversation.input.attachments` 是宿主单席位，本步不覆盖该附件栏，也不修改宿主 DOM。未来上传按钮仍应复用官方文件上传、命令或输入服务；UI 不能直接把任意字符串包装成已授权文件引用。

## 旧插件可以借鉴什么

旧仓库固定参考 [`astrbot_plugin_volcengine_provider`，commit `8aa824bb52bc0178b6f51413b3f8817440605f97`](https://github.com/zjj1280637679-ship-it/astrbot_plugin_volcengine_provider/tree/8aa824bb52bc0178b6f51413b3f8817440605f97)，版本 `0.1.34`。

| 旧实现 | 本步取舍及来源 |
| --- | --- |
| 保持图片位置及 `detail` | 可借鉴有序内容处理；[图片适配](https://github.com/zjj1280637679-ship-it/astrbot_plugin_volcengine_provider/blob/8aa824bb52bc0178b6f51413b3f8817440605f97/adapters/image.py) 中的缩放／转 JPEG 不迁移，避免损失原图和 Alpha |
| 视频 Original 模式 | 借鉴读取原字节后 Base64 编码；[视频适配](https://github.com/zjj1280637679-ship-it/astrbot_plugin_volcengine_provider/blob/8aa824bb52bc0178b6f51413b3f8817440605f97/adapters/video.py) 的 Compressed 模式及文本标记扫描不迁移 |
| 音频 `input_audio` | 借鉴裸 Base64 的 Chat 结构；[音频适配](https://github.com/zjj1280637679-ship-it/astrbot_plugin_volcengine_provider/blob/8aa824bb52bc0178b6f51413b3f8817440605f97/adapters/audio.py) 中为 QQ Silk／AMR 转 WAV、16kHz 单声道 PCM16 的归一化不迁移 |
| 模态开关与画质偏好分开保存 | 借鉴关闭能力不抹掉其他配置的原则；[模型字段](https://github.com/zjj1280637679-ship-it/astrbot_plugin_volcengine_provider/blob/8aa824bb52bc0178b6f51413b3f8817440605f97/capabilities/model_fields.py) 不作为新模型能力限制 |

旧插件 [TEST_HISTORY](https://github.com/zjj1280637679-ship-it/astrbot_plugin_volcengine_provider/blob/8aa824bb52bc0178b6f51413b3f8817440605f97/docs/TEST_HISTORY.md) 的 HTTP 200 属于当时 AstrBot、账号、模型和媒体条件下的历史结果，不能证明本轮 Harness 或当前套餐可用。旧实现只有普通 API 与 Agent Plan，不能作为 Coding Plan 已验证的证据。

## 验证边界及来源

本轮类型检查、构建、安装包检查及全部 15 个测试文件、84 项测试通过。新增媒体验证覆盖协议形状、原文件与解码后媒体的 SHA-256 一致、附件顺序、显式 MIME／格式覆盖、方舟供应商选择门槛、缺少宿主接口时不注册入口，以及卸载后清理注册。

6 项媒体 HTTP 集成测试使用真实磁盘文件和重新加载的消息 JSON、已发布的 Cordis／LLM 运行时，以及结构化附件服务实现，最终由 Fake Ark 捕获 HTTP 请求；包含透明 PNG、MP4、MP3 和保持 48 kHz 立体声的 WAV。21 项命令测试使用真实 Cordis 生命周期和命令／Agent 边界替身。这些检查验证插件行为，不代表新版宿主完整上传、会话日志或真实模型理解已经验收。实现入口为 [media-command.ts](../src/media-command.ts)、[media.ts](../src/media.ts) 和 [Chat 序列化](../src/chat/serialize.ts)。

本轮不执行真实方舟 API、完整 Harness Web profile 端到端、Responses 或 Files 上传验收。默认图片链的上游规范化、当前 UI 无严格原图文件模式、旧 npm 缺少原文件能力，都应在后续验收中分别处理。

会话历史与导出也有当前宿主边界：

- 原生历史界面会把 `volcengine-image`／`volcengine-video`／`volcengine-audio` 显示为“附加内容块”（Extra content block）的 JSON，尚无这些块的专用预览或视频／音频播放器。参见 [MessageItem](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/client/ui-chat/src/client/chat/MessageItem.tsx)。
- 宿主 [会话导出附件收集](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/session-query/session-log-export/src/archive.ts) 只识别 `image`／`file`。命令转换后的专用块不会让导出器收集对应媒体字节，`command/run` 也不保存可补足它们的附件列表，因此不能宣称会话导出包可以移机完整重放。
- [本地附件存储](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/attachment/attachment-local/README.zh.md) 不自动删除原文件。同机续聊或分叉共用原来的 `DSH_HOME`，且文件仍在时，可以继续读取原引用；这与导出包是否携带媒体是两件事。

本步不为这些显示和导出缺口扩大宿主改动，后续需分别确认历史渲染和导出收集的扩展接口。

| 固定官方 Harness 来源 | 依据 |
| --- | --- |
| [附件公共类型](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/attachment/attachment/src/types.ts) | 原文件引用、已准入图片／文件、MIME 归属 |
| [附件服务](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/attachment/attachment/README.zh.md) | 原文件读写、摘要校验、通用文件投影 |
| [图片规范化](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/attachment/attachment-local/src/normalization.ts) | 普通图片路径可能重编码，与原文件不同 |
| [命令服务](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/interaction/commands/README.zh.md) | 有序可信附件、命令生命周期、显式安排 agent 工作 |
| [会话模型选择](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/api/session-controller/src/agent.ts) | 待生效选择、会话请求头、默认模型的读取次序 |
| [输入与上传服务](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/client/ui-conversation/src/client/service.ts) | 默认图片分类、文件上传凭证、提交顺序 |
| [Conversation slots](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/client/ui-conversation/src/client/contract/slots.ts) | left／right／dock 可追加，附件栏不覆盖 |

方舟协议来源：[Chat API](https://docs.volcengine.com/docs/82379/1494384?lang=zh)、[Responses API](https://docs.volcengine.com/docs/82379/1569618?lang=zh)、上述图片／视频／音频教程。资料中的模型、大小、时长和格式说明只作当前服务参考，不自动变成插件权限或能力配置。
