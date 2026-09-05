# Coding Plan 原始媒体实测：2026-09-05

使用用户配置的 `ARK_CODING_PLAN_API_KEY`，通过生产 `/ark-media` 内容构造器及 `VolcengineChatAdapter` 运行四次独立、无重试的媒体请求。地址为 `https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions`，每次上限 1024 输出 token、120 秒；未调用普通 API，也未更换模型名或做跨通道回退。

- [实际运行及完整日志](https://github.com/zjj1280637679-ship-it/dsh-volcengine-provider/actions/runs/33971576406)
- 执行 commit：`c8c7a8099e767087dc32f812b7a50b627c90d1d0`，job：`101320916708`
- 时间：2026-09-05 14:21:53 UTC
- [提取的脱敏 JSON 报告](live-coding-plan-media-2026-09-05.json)

## 结果

| 模型 | 输入 | HTTP／完成 | 内容结果 |
| --- | --- | --- | --- |
| `doubao-seed-2.0-lite` | 512 × 256 RGBA PNG | 200，SSE，stop | 识别左侧红圆及右侧蓝色矩形；严格的“蓝色正方形”检查未通过 |
| `doubao-seed-2.0-lite` | 3.422 秒、44.1 kHz 立体声 MP3 | 400 | 服务端明确拒绝音频输入，未产生模型回复 |
| `glm-5.3-flash` | 同一 PNG | 200，SSE，stop | 正确识别红色圆形与蓝色正方形，内容检查通过 |
| `glm-5.3-flash` | 6 秒、256 × 256、4 fps H.264 MP4 | 200，SSE，stop | 正确识别黄色 → 绿色 → 紫色及先后时间，内容检查通过 |

工作流如实返回 **failure**：lite 音频被拒绝，且 lite 图片回复未满足严格形状匹配。lite 图片链路已经连通、媒体内容被读取，但不把它记录成完整语义通过；不事后放宽断言或修改原始报告来使运行变绿。正方形属于矩形不影响保留这个严格测试差异。

lite 音频错误关键文本为 `audio input is not supported by this model`，request ID 为 `0217886181212410477e7d991a1abd211e987ddddb28cabc9e95b`。用户随后指出 Coding Plan 可能没有开放音频。本项目将其记录为**本账户、当前 Coding Plan 通道、该模型别名的音频拒绝**，不据此推断标准 API 的音频能力，不把失败写成插件模型白名单。没有为此反复改变音频格式重试。

三个成功完成的请求合计报告 input 1915、output 505、total 2420 token，其中 reasoning 352。被拒绝的音频请求没有返回 usage；不能用缺失 usage 推断账单。此前两个模型的文本请求均已通过，见 [文本实测记录](live-coding-plan-2026-09-05.md)。

## 原字节与协议证据

测试内容为本项目生成的受控样本，不包含用户媒体；问题不包含预期答案。样本及 SHA-256 在 [fixtures](../tests/fixtures/live-media/README.md) 中固定。图片有透明像素，音频是立体声；视频保持完整 MP4。生产请求发出前，逐项还原 Data URL／裸 Base64，与原文件逐字节比较，四项均一致：

| 文件 | 字节数 | 原始与发送内容共同的 SHA-256 |
| --- | --- | --- |
| PNG | 1848 | `2f5a55452df4dbde0bacbd30dc8449a75e70df4dd1da94e593f3a918a78d3e49` |
| MP3 | 27629 | `d9820b8c930a0f68c291fc1b6a7c1a5df3985a6631ce676533bd02e5b61496be` |
| MP4 | 2381 | `573ea1f96968c3f37fe12df641739d7cbfa5965f09b2864fae785a063b3bc2c6` |

该次 CI 中插件没有压缩、抽帧、转码或降采样。这证明适配器发送侧保持原字节并得到时序答案，不代表供应商内部不做抽帧或其它预处理，也不能将 GLM 的结果外推为 Seed 原生视频理解。该次实测经过命令纯构造器、内容 JSON 往返和生产适配器；它没有经过真实 Web 上传或完整宿主会话服务。后续任何客户端先抽帧再发送图片的尝试都必须排除在视频验收之外。

## 官方依据与通道差异

- [Coding Plan 快速开始](https://docs.volcengine.com/docs/82379/1928261?lang=zh)列出这两个模型名与 `/api/coding/v3`；[套餐概览](https://docs.volcengine.com/docs/82379/1925114?lang=zh)描述视觉能力，未完整列明本次四项组合。
- [图片理解](https://docs.volcengine.com/docs/82379/1362931?lang=zh)与[视频理解](https://docs.volcengine.com/docs/82379/1895586?lang=zh)提供 Chat 的 `image_url.url`、`video_url.url` Data URL 形状；本次样本满足所述尺寸／大小条件。
- [音频理解](https://docs.volcengine.com/docs/82379/2377589?lang=zh)使用 `input_audio.data` 裸 Base64 + `format`，示例对应标准 API 的具体版本 `doubao-seed-2-0-lite-260428`；[模型列表](https://docs.volcengine.com/docs/82379/1330310?lang=zh)也列明该版本的音频理解能力。
- 公开材料没有说明 Coding Plan 别名与该标准 API 版本的映射关系，不能据此断言旧版映射、套餐档位或额外权限是拒绝原因。当前不请求用户为了本次图片／视频验证另配普通 API 密钥。

另外逐项核对了接入规范：[音频教程](https://docs.volcengine.com/docs/82379/2377589?lang=zh)的 Chat Curl 仅要求 `POST`、`Content-Type: application/json`、`Authorization: Bearer …` 及上述内容字段；[Chat API](https://docs.volcengine.com/docs/82379/1494384?lang=zh)要求 `data` 路径提供 `format`，未要求额外握手、`modalities` 或音频禁用 SSE。[Coding Plan 其他工具](https://docs.volcengine.com/docs/82379/2188959?lang=zh)要求兼容协议、专用地址、密钥和模型名，没有额外初始化请求。带专用资源头及 WebSocket 协商的[流式语音识别](https://www.volcengine.com/docs/6561/1354869)属于独立语音产品，不移植到 Ark Chat。此次公开资料可以匿名读取，无需登录。

媒体 live 工作流在首轮授权测试后改为仅手动触发，避免 UI 或文档提交重复消耗套餐。工作流进入默认分支后才可在 Actions 页面使用 Run workflow；普通 PR CI 不注入真实密钥。后续脚本也加固错误日志：先对完整结构化诊断脱敏再截断，不记录适配器已截断的原始错误正文。上述原始运行结果保持不变。
