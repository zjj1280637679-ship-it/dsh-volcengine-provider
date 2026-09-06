# Step 3 — Production Chat Adapter

> 历史阶段记录：下文的测试数量、待办和当时入口只描述该阶段。当前安装、配置保存、自动识别文件类型和原生媒体入口以 [README](../README.md)、[alpha.10 发布说明](releases/alpha.10.md) 与 [本机接手指南](local-handoff.md) 为准。

第三步在独立的 `adapter-v0.1` 分支开发，并以 `bootstrap-v0.1` 为叠加基线。

## 目标

把第二步已经验证过的单次 HTTP transport 接成真正的 DeepSeek Harness `LlmAdapter`：

```text
GenerateOptions
      ↓
chat/serialize.ts
      ↓
transport.ts        ← 只有一次 HTTP 尝试，不知道 fallback
      ↓
chat/sse.ts         ← SSE framing
      ↓
chat/translate.ts   ← StreamChunk 状态机
      ↓
Harness
```

模型目录走独立旁路：

```text
GET /models
   ↓
chat/discovery.ts
   ├─ id/name/description → advisory LlmModelInfo
   └─ 其余所有字段 → 只读 Raw Feedback
```

## 干净边界

### Adapter 只负责协调

`VolcengineChatAdapter` 不重复实现：

- 请求体 merge/patch/raw；
- Route 拼接；
- 媒体 base64/data URL；
- SSE framing；
- StreamChunk 状态机；
- model feedback 缓存；
- HTTP 错误分类。

这些均为独立模块，可以单测。

### Chat / Responses / Anthropic 不杂糅

本步骤只实现 OpenAI-compatible Chat Completions：

`POST {baseURL}/chat/completions`

Responses API 和 Anthropic Messages API 后续分别做协议适配器，不在一个类里堆条件分支。

### 思考模式不做统一映射

Adapter 不向 Harness 暴露 `reasoning` selectable metadata，也不根据模型反馈生成 `thinking` / `reasoning_effort`。

模型卡通过 custom body 直接设置供应商字段。

如果外部调用者显式给 `GenerateOptions.reasoningEffort`，Adapter 返回稳定的 `UNSUPPORTED_REASONING_EFFORT`，避免静默丢参或猜模型家族。

### Feedback 仍不是权限

`/models` 返回的：

- input modalities；
- context window；
- reasoning；
- status；
- 限额；
- 未知新字段；

全部可以保留在 Raw Feedback，但本步骤只把 `id/name/description` 映射到 Harness advisory model list。

特别禁止把 `supports_video=false` 变成 Harness 的输入限制。

### 错误事实与恢复策略分离

HTTP 失败使用 Harness 公共机器码（如 `AUTH / RATE_LIMIT / QUOTA / INVALID_REQUEST / SERVER / CONTEXT_WINDOW_EXCEEDED`），并尽量保存：

- HTTP status；
- provider request id；
- Retry-After。

这些只是结构化事实。Adapter 和 transport 本身仍不执行重试，也不知道其他 Route，因此不会因为得到 `RATE_LIMIT` 就自行切换 Standard / Agent Plan / Coding Plan。

### 文件兼容边界

当前 npm 可安装基线 `0.1.2-rc.1` 尚无 core `file` ContentBlock；更新的 Harness 源码已经拥有 file block，并规定在 Provider 前投影成文本。

因此本 Adapter 不重复拥有通用 file 语义，也不伪造兼容类型：

- 旧版：没有 file block；
- 新版：由 Harness 在 Provider 前投影；
- 其他未知 merge-extensible block：明确 `UNSUPPORTED_CONTENT`，禁止静默丢弃。

## 多模态

已知默认 Chat wire encoder：

- image → `image_url`
- video → `video_url`
- audio → `input_audio` + `input_audio.data`（裸 Base64）+ `input_audio.format`

音频形状在[第五步](step5-media-input.md)核对官方 Chat 教程后纠正；第三步原先的 `audio` / `audio_url` 编码不能作为当前协议依据。

Provider 只进行透明 data URL/base64 封装，不做压缩、抽帧、转码或降采样。

同时 `encodeMediaPart` 是可注入 seam；若某一模型/未来接口的媒体 JSON 形状发生变化，可以替换 wire encoder，而不改附件读取和 Adapter 主流程。

## 第三步验收 ✅

以下项目已经由 CI 自动验证：

1. 文本 SSE 正常转为 `StreamChunk`；
2. reasoning、文本、分段 tool call 状态正确；
3. usage 在 finish 前；finish 最后；
4. SSE 缺 `[DONE]` 判为 `STREAM_CLOSED`；
5. malformed SSE JSON 不被静默跳过；
6. `stream:false` custom body 仍能转换完整 JSON 响应；
7. Coding Plan 429 只有一次 HTTP 请求；
8. 429 保留公共 `RATE_LIMIT` code、HTTP 429、request id、Retry-After；
9. Harness attribution header 到达 Fake Ark；
10. 未知 model id / unknown custom body 到达真实 HTTP 边界；
11. image/video/audio provider-boundary 字节 SHA-256 一致；
12. `/models` 丰富字段进入 Raw Feedback，但不进入 `inputModalities/context/reasoning`；
13. npm 发布基线 `@deepseek-ai/dsh-llm@0.1.2-rc.1` typecheck 通过；
14. Step 1/2 的 Freedom + Fake Ark 回归测试继续全部通过。

最终门禁：

```text
TypeScript typecheck: PASS
Test files:          8 / 8 PASS
Tests:              29 / 29 PASS
```

## 本步骤不做

- 真密钥 live E2E；
- Responses API；
- Anthropic Messages；
- 设置页/模型卡 UI 与 Cordis 配置装配；
- 自动模型路由；
- 自动压缩；
- 跨 Route fallback；
- Feedback 自动配置。
