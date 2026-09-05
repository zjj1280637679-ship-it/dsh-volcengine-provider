# 第六步：原始媒体 UI 与真实通道验证

在会话输入区增加可折叠的“方舟原始媒体”面板。它将图片、音频、视频原 `File` 交给官方 `fileUpload`，再把上传凭证交给官方 `/ark-media` 命令。图片也使用原文件链，解决宿主默认图片入口可能规范化图片的问题。

## 使用

1. 在 Models 中保存方舟通道的密钥及模型并选择该模型。模态未设置时表示未知且允许尝试；只有用户明确强制关闭的模态会被阻断。
2. 展开“方舟原始媒体”并添加文件。每个新文件的 MIME 初始保持空白，即使浏览器提供 `File.type` 也不自动带入；必须由用户明确填写，例如 `image/png`、`audio/mpeg` 或 `video/mp4`。
3. 音频可以选择性填写 `format`，例如 `mp3`；新格式也可自行声明。留空时允许协议序列化从用户填写的 MIME 临时推导，且不回写文件草稿或模型配置。填写问题后点击“发送媒体”。任务运行时按钮会说明消息将插入当前任务。

本次选择的模型可使用 [coding-plan-media.yml](../examples/coding-plan-media.yml) 作为启动 patch，替代基础 `cordis.yml`。它只列出 lite 与 flash 的模型 ID，不预填文本、图片、视频或音频设置；普通 API 和 Agent Plan 卡片仍保留。用户若需要可在卡片中明确强制开启或关闭，但未设置本身不会阻断尝试。本次 Coding Plan 音频拒绝只是历史运行证据，没有改写插件权限或示例配置。

GitHub Actions 的测试密钥只在 CI 中可用，不会复制到用户的 Harness。实际安装后的密钥应通过 Models 卡片或该 Harness 的启动环境提供。

面板保持附件顺序，发送失败／上传取消保留文件与填写内容；已完成上传的凭证可用于用户主动重试。切模型、取消或卸载会阻止尚未提交的消息继续发送。若命令调用已发出而连接中断，提示先检查会话是否收到消息，避免盲目重复提交。草稿属于当前面板，刷新、切换会话或关闭页面不保证保留。

## 公共接口与扩展性

| 接缝 | 使用方式与边界 |
| --- | --- |
| `conversation.input.dock` | 追加一个 session 面板，不替换宿主附件栏或主输入草稿 |
| `fileUpload.upload` | 直接传入原始 `File`，不解码图片、不压缩、不转码；上传凭证由宿主管理，`File.type` 不用于自动填写 MIME 草稿 |
| `remote.commands.list/execute` | 检查 `ark-media` 的附件能力，发送 `file` receipt；命令负责准入与持久化 |
| `modelDirectories` | 使用官方模型选择器共享状态，包括待生效选择；提交前再次确认未切换 |
| `remote.llm` | 通过 `settingsNs` 判断路由是否属于本插件，不靠固定模型名或目录反馈作白名单 |
| `media-declaration.ts` | UI 与命令共用用户填写的 MIME／音频格式校验，保留扩展字段；协议格式推导不修改草稿，也不把旧模型格式当全局限制 |

仅在新公共服务存在且 slot 可用时挂载。按钮还检查原文件上传可用、普通会话、已启用的方舟路由与命令存在；旧 npm 的文字及现有图片功能继续可用，没有增加新的硬依赖或精确版本锁。检查入口不会向方舟发送推理请求。

凭证缓存按会话及连接代次隔离；官方命令准入只解析 receipt、不消费它，因此命令拒绝后允许复用。连接重置时缓存失效。Zero-argument LLM Remote 和单参数 `commands.list` 严格按官方参数数量调用；可取消的 `commands.execute` 使用正式 signal 参数。

## 验证与待验收范围

新增 10 项验证：原 File 对象和字节直传、显式格式与顺序、上传部分失败及命令错误后的凭证复用、取消、切模型、连接重置、非本插件路由、重复点击、组件卸载、真实 SlotRegistry 条件挂载与卸载等。全量 17 个测试文件、94 项测试及 TypeScript、构建、安装包验证通过。

真实供应商结果见 [Coding Plan 媒体实测](live-coding-plan-media-2026-09-05.md)：GLM 图片／视频的内容检查通过；lite 图片可读但严格形状检查有差异；lite 音频被该通道以 400 拒绝。真实测试走生产内容构造器与适配器，完整 Harness Web 上传到会话再到方舟的端到端人工验收尚未完成。

历史媒体播放器与移机导出仍受宿主边界限制，详见 [第五步](step5-media-input.md)。新增上传面板不代表这两项已经解决。

## 固定官方源码依据

- [文件上传公共契约](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/client/file-upload/src/client/contract.ts)
- [receipt 生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/client/file-upload/src/index.ts)
- [命令 list、execute 和附件准入](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/interaction/commands/src/index.ts)
- [共享模型选择状态](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/client/ui-model-selection/src/client/directory.ts)
- [session slot 注入缓存与生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/client/ui-renderer/src/client/scoped-slots.tsx)
- [官方追加 dock 示例](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/client/ui-goal/src/client/index.ts)
