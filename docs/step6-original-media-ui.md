# 第六步：原生输入栏的方舟媒体旁路

`0.1.0-alpha.8` 不再提供独立媒体面板。会话输入栏中只有一个位于 Harness 原有附件按钮旁边的彩色 `+`；用户选择文件后，附件成为主草稿中的原生引用 chip，问题继续写在主输入框，并随 Harness 原生发送、Enter、排队或插话动作一起提交。

## 用户流程

1. 在 Models（旧宿主为 Plugins）保存方舟通道的 API Key、模型 ID 和可选模态设置，并选择该模型。
2. 点击彩色 `+`，一次选择一个或多个原始图片、视频或音频文件。
3. 在同一个 Harness 输入框中填写问题。附件 chip 与文本可以一起编辑；删除 chip 表示放弃对应 bundle。
4. 使用原生发送键或 Enter。上传未完成、模型已切换或引用无效时，Harness 保留草稿和 chip 并显示错误；成功接收后由原生输入机清空草稿。

入口没有 MIME、媒体问题或单独发送控件。扩展名与浏览器声明共同确定方舟 Chat 格式；二者冲突或格式不在当前 Chat 接口表中时直接提示。模态“未设置”仍允许尝试，只有用户在模型卡中明确强制关闭的模态才会本地阻断。

## 最小独立边界

本实现借用 Harness 已有的成熟接口逻辑，只新增媒体必须拥有的边界：

| 部分 | 责任 |
| --- | --- |
| `conversation.input.left` | 挂载一个 28 px 彩色 `+`，不另起面板 |
| `conversation.input.for(...).insertReference` | 把已选择 bundle 作为原生 chip 插入主草稿 |
| Input Trigger `ReferenceCodec` | 让 chip 参与宿主自己的提交尝试；上传或校验失败会阻止发送并保留草稿 |
| loopback RPC v3 | 分块接收浏览器明确选择的原始字节；不接收本机路径，不扫描目录 |
| 持久 bundle manifest | 把草稿中的不可见引用与同机原字节跨页面刷新、跨 Harness 重启关联 |
| `agent/pre-step` | 在消息进入模型前，将同一条用户消息中的引用替换为方舟媒体块 |
| `session/event` | 只有同 ID、同来源、同内容的用户消息确已落盘后，才确认并收尾 bundle |

文本、消息 ID、source、发送按钮、排队、插话、会话持久化和模型请求都仍由 Harness 拥有。插件不创建旁路消息，也不复制第二套聊天生命周期。

## 输入到输出的闭环

浏览器选择文件后，客户端先固定当前 `sessionId + provider + model`，通过 loopback-only RPC 顺序上传完整字节并校验 SHA-256。所有文件及 manifest 落盘后 bundle 才进入 `ready`。chip 的持久化文本是一个严格、不可猜测的 marker；页面刷新或整个 Harness 重启后，插件从当前 session 的 ready bundle 列表恢复 chip。

发送时，Harness 的引用 codec 等待当前 bundle 上传完成并再次检查选择，然后把 marker 写入它自己的 UserMessage。服务端 pre-step 只处理独立、位于文本开头的规范 marker，按 `sessionId + bundleId + messageId` 原子认领，重新检查当前 provider/model 和插件所有权，再将原文件引用加入**同一个** UserMessage。适配器读取前还会核验长度与 SHA-256，并按图片、视频、音频的 Chat wire 结构序列化。

因此正常路径是：一个主输入草稿 → 一个 Harness 用户消息 → 一个方舟模型请求 → 一个模型输出。排队或插话只改变 Harness 对同一消息的投递时机，不创建媒体专用发送支路。

## 可回退、可干涉

在消息已被 Harness 接收后，如果 bundle 重复、丢失、损坏、选择变化或物化失败，pre-step 不抛错、不拒绝整轮：它移除内部 marker，保留用户文本，省略本轮新增媒体，并加入 `[VOLCENGINE_MEDIA_OMITTED code=…]` 机器可读诊断。Agent 可在下一轮根据诊断自行处理；插件不会替它切模型、压缩、抽帧、重试或删除源文件。

用户直接上传后由方舟 API 或模型返回的限制则原样可见，不走上述本机回退。两类错误的分界是：宿主接收消息前的本机准备错误保留草稿；宿主接收消息后的本地媒体失效保文本续链；真实上游拒绝保留 API 事实。

模型卡中的“智能体媒体续链预算”仅用于工具结果中新带入的图片／视频，默认 45 十进制 MB、可由用户调整或设为 0。它不作用于彩色 `+` 的用户主动上传，不能被当作文件大小上限。

## 格式、字节与大小

当前 Chat 旁路接收：

- 图片：JPEG、PNG、GIF、WebP、BMP、TIFF、ICO、ICNS、SGI、JPEG 2000、HEIC／HEIF；
- 视频：MP4、AVI、MOV；
- 音频：MP3、WAV、AAC、M4A。

PDF 需要 Responses／Files 路径，本 Chat adapter 不把它伪装成已支持格式。输入文件保持原字节，不压缩、不抽帧、不转码；音频在 wire 上使用裸 Base64 和接口要求的 format。用户主动上传没有插件固定总大小阈值，只受安全整数、Node/V8 可表示范围、当前磁盘与内存等事实条件约束，最终 API／模型大小限制由真实响应裁决。

## 已知边界

- 当前宿主的队列行没有面向第三方引用的渲染扩展点；消息排队但尚未被 Agent 领取时，队列 UI 可能短暂显示内部 marker。模型输入和最终用户消息会在领取后的 pre-step 中清理。要完全消除该显示，需要 Harness 核心提供队列附件扩展，而不是另造发送系统。
- 成功消息落盘后、异步确认 manifest 前若进程恰好硬崩，已物化 manifest 可能残留；它仍绑定原 session/message/model，不会跨路由误发。后续可通过宿主提供的持久日志对账接口做自动回收。
- 会话导出目前不保证携带插件持久对象，因此“同机同一 `DSH_HOME` 重启恢复”不等于跨电脑迁移。

旧 `/ark-media` 和 MP4 token 协议保留用于已有历史会话与兼容测试，但不再注册独立面板，也不是推荐用户流程。

## 验收要求

自动验证至少覆盖多文件顺序、严格格式、分块 SHA-256、重复引用、跨 session、模型切换、刷新恢复、进程重建恢复、普通发送、queue/steer、marker 不进入模型、后接收失败保文本诊断、真实适配器原字节解析与插件卸载。最终安装验收还必须完整关闭外层 Harness，确认原 PID 和端口消失，再从日常 `npx @deepseek-ai/dsh web` 入口冷启动同一 profile，并检查配置、凭据状态、彩色 `+`、chip 恢复和真实上游结果。

宿主接口依据：

- [输入引用与 ReferenceCodec](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/client/ui-input-trigger/src/types.ts)
- [原生会话输入机](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/client/ui-conversation/src/client/input/machine.ts)
- [原生输入 facade](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/client/ui-conversation/src/client/input/facade.ts)
- [会话输入区 slots](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/client/ui-conversation/src/client/contract/slots.ts)
