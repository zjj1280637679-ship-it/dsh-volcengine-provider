# 第六步：原始媒体 UI 与真实通道验证

在会话输入区增加默认展开、仍可折叠的“方舟原始媒体”面板。新版宿主将图片、音频、视频原 `File` 交给官方 `fileUpload`，再把上传凭证交给官方 `/ark-media` 命令。图片也使用原文件链，解决宿主默认图片入口可能规范化图片的问题。

`0.1.0-alpha.6` 另为缺少 `fileUpload/readFileStream` 的旧 Web 宿主提供本机兼容路径：面板仍由用户通过浏览器文件选择器明确选择文件，但一次只接收一个显式声明为 `video/mp4` 的原始 MP4。文件按小块经 authority-aware loopback RPC 写到插件专属磁盘 staging，再由不记入会话的短期 token 交给 `/ark-media-local`。服务端不接收桌面路径，也不扫描用户目录。

## 使用

1. 在 Models 中保存方舟通道的密钥及模型并选择该模型。模态未设置时表示未知且允许尝试；只有用户明确强制关闭的模态会被阻断。
2. 展开“方舟原始媒体”并添加文件。每个新文件的 MIME 初始保持空白，即使浏览器提供 `File.type` 也不自动带入；必须由用户明确填写，例如 `image/png`、`audio/mpeg` 或 `video/mp4`。旧宿主的兼容路径显示“选择原始 MP4”，只接受一个 `video/mp4`；它不是模态选择器，而是真实文件输入口。
3. 音频可以选择性填写 `format`，例如 `mp3`；新格式也可自行声明。留空时允许协议序列化从用户填写的 MIME 临时推导，且不回写文件草稿或模型配置。填写问题后点击“发送媒体”。任务运行时按钮会说明消息将插入当前任务。

本次选择的模型可使用 [coding-plan-media.yml](../examples/coding-plan-media.yml) 作为启动 patch，替代基础 `cordis.yml`。它只列出 lite 与 flash 的模型 ID，不预填文本、图片、视频或音频设置；普通 API 和 Agent Plan 卡片仍保留。用户若需要可在卡片中明确强制开启或关闭，但未设置本身不会阻断尝试。本次 Coding Plan 音频拒绝只是历史运行证据，没有改写插件权限或示例配置。

GitHub Actions 的测试密钥只在 CI 中可用，不会复制到用户的 Harness。实际安装后的密钥应通过 Models 卡片或该 Harness 的启动环境提供。

面板保持附件顺序，发送失败／上传取消保留文件与填写内容；已完成上传的凭证可用于用户主动重试。切模型、取消或卸载会阻止尚未提交的消息继续发送。若命令调用已发出而连接中断，提示先检查会话是否收到消息，避免盲目重复提交。草稿属于当前面板，刷新、切换会话或关闭页面不保证保留。

兼容路径的 token 绑定 session、用户确认的 provider 和 model；命令投递前后都重读宿主权威选择，变化即拒绝，不会把视频转送到另一个方舟模型。上传使用显式取消、无自动重试；客户端取消不会等待可能悬挂的后台 discard，服务端卸载则中断并等待已进入的 staging 操作后只清理本实例文件。

用户主动上传没有插件定义的总文件大小门禁。Node/Data URL 无法表示或本机实时磁盘／V8／系统内存不足属于请求到达 API 前的物理失败，会明确返回；其余大小与模型条件由方舟真实响应裁决。带媒体的请求按进程串行完成读取、Base64／JSON 编码及 HTTP 请求体提交，等待可取消，收到响应头后释放；纯文本请求不进该队列。预检按附件声明大小保守估算，但其它 JSON 文本仍可能使接近 Node 极限的请求在 `JSON.stringify` 时显式失败，因此不承诺任意大小必然可发。方舟 Chat Base64 教程当前注明视频小于 50 MB、请求体不超过 64 MB；该条件不被插件扩张成通用模型能力。Files API 尚未接入。

模型卡另有“智能体媒体续链预算”，默认 45 十进制 MB、0 关闭。它只处理 `tool-result` 新带入的图片／视频：按整次请求累计预算，超额块在读取前从本次 wire 请求省略，原工具文本与机器可读错误仍送给模型，源文件不删除。用户主动消息与音频不走这条回退；插件也不自动压缩、重试、切模型或替 AI 选择下一步。

## 公共接口与扩展性

| 接缝 | 使用方式与边界 |
| --- | --- |
| `conversation.input.dock` | 追加一个 session 面板，不替换宿主附件栏或主输入草稿 |
| `fileUpload.upload` | 直接传入原始 `File`，不解码图片、不压缩、不转码；上传凭证由宿主管理，`File.type` 不用于自动填写 MIME 草稿 |
| `remote.commands.list/execute` | 检查 `ark-media` 的附件能力，发送 `file` receipt；命令负责准入与持久化 |
| authority-aware `connection.rpc` | 仅 loopback 兼容路径使用 `begin/append/commit/discard` 分块暂存原始 MP4；单 RPC 传输顶限不构成文件总大小上限 |
| `/ark-media-local` | 使用一次性 token 取回同 session/provider/model 的已提交 staging；`recordInput: false`，token 不作为用户输入写入历史 |
| `modelDirectories` | 使用官方模型选择器共享状态，包括待生效选择；提交前再次确认未切换 |
| 服务端 `/ark-media`、`/ark-media-local` | 在最终投递边界复核当前 provider 确由本插件持有并已启用；客户端 provider 前缀只作界面可用性提示，不是安全判定 |
| `media-declaration.ts` | UI 与命令共用用户填写的 MIME／音频格式校验，保留扩展字段；协议格式推导不修改草稿，也不把旧模型格式当全局限制 |

面板按公共能力动态选择原生上传或 loopback MP4 兼容路径：原生 `fileUpload` 出现时优先使用且不硬依赖 `connection`；移除时若 loopback RPC 可用则退回兼容路径；两者都缺失才不挂载。按钮检查普通会话、方舟 provider 形式、可路由模型与命令存在，最终所有权仍由服务端复核。旧 npm 的文字及现有图片功能继续可用，没有增加新的宿主版本锁。检查入口不会向方舟发送推理请求。

凭证缓存按会话及连接代次隔离；官方命令准入只解析 receipt、不消费它，因此命令拒绝后允许复用。连接重置时缓存失效。客户端不要求旧 rc2 并不存在的 `remote.llm`；单参数 `commands.list` 严格按官方参数数量调用，可取消的 `commands.execute` 使用正式 signal 参数。

## 验证与待验收范围

自动验证覆盖：原生 File 对象和字节直传、显式格式与顺序、上传部分失败及命令错误后的凭证复用、取消、切模型、连接重置、非本插件路由、重复点击、组件卸载、动态 SlotRegistry；以及兼容路径的分块 SHA-256、磁盘容量、session/provider/model 绑定、防重放、取消／卸载、跨实例 staging 隔离、持久引用重读和 Fake Ark 解码后一致性。精确全量测试数以最终安装实验报告为准。

历史供应商结果见 [Coding Plan 媒体实测](live-coding-plan-media-2026-09-05.md)：GLM 图片与 raw MP4 的输出通过内容检查；lite 图片可读但严格形状检查有差异；lite 音频被该通道以 400 拒绝。raw MP4 字节到达 API 并得到时序答案不说明供应商内部是否抽帧，也不替代 Seed 模型的当前 Web 端到端实验；任何客户端先抽帧的尝试均不计入视频验收。

历史媒体播放器与移机导出仍受宿主边界限制，详见 [第五步](step5-media-input.md)。新增上传面板不代表这两项已经解决。

## 固定官方源码依据

- [文件上传公共契约](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/client/file-upload/src/client/contract.ts)
- [receipt 生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/client/file-upload/src/index.ts)
- [命令 list、execute 和附件准入](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/interaction/commands/src/index.ts)
- [共享模型选择状态](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/client/ui-model-selection/src/client/directory.ts)
- [session slot 注入缓存与生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/client/ui-renderer/src/client/scoped-slots.tsx)
- [官方追加 dock 示例](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/client/ui-goal/src/client/index.ts)
