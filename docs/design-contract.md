# 设计合同（v0.1）

本文档不是模型能力说明书，而是实现与验收合同。

## 1. 总原则

> 建设积极自由，同时不干涉消极自由。

### 积极自由

插件主动提供：

- 三 Route 接入与清晰隔离；
- 模型目录和丰富 Feedback 展示；
- 图片 / 视频 / 音频输入入口；
- 模态显式开关与强制开启；
- 自定义请求体和 Raw 模式；
- 流式输出、工具调用、错误结构化；
- 媒体传输适配；
- Runtime Observations 记录。

### 消极自由

插件不得因为自己的认知、供应商反馈或历史失败而阻止用户尝试请求。

允许真正阻断的情况只包括：

1. 用户自己明确 `force_disable`；
2. 本地资源物理不存在或不可读取；
3. 目标协议根本无法表达该请求且不存在透明传输方式；
4. 请求无法序列化等本地物理错误。

## 2. 三条 Route 必须独立

默认 OpenAI 兼容 Base URL：

- `standard`: `https://ark.cn-beijing.volces.com/api/v3`
- `agent-plan`: `https://ark.cn-beijing.volces.com/api/plan/v3`
- `coding-plan`: `https://ark.cn-beijing.volces.com/api/coding/v3`

每条 Route 拥有独立凭证和配置。默认禁止跨 Route fallback。

尤其禁止：Coding Plan 失败后静默回退普通 Ark，因为这可能把套餐请求变成按量计费请求。

## 3. 四个信息面物理分离

### Feedback

供应商返回的信息。可展示、缓存、搜索、排序、供 Agent 参考；不得自动写入 Config。

### Config

用户明确设置的策略，是本地权限与请求生成的主要依据。

### Observations

实际调用产生的事实，例如成功/失败次数、HTTP 状态、某模态曾被服务端接受。它仍然只是证据，不是权限。

### Effective Request

本次调用经过用户配置与 request override 后真正发出的请求。

不变量：

```text
Feedback != Config
Observations != Config
```

任何 Feedback/Observation 到 Config 的改变都必须由用户明确触发。

## 4. 模态策略

一级输入模态：

- text
- image
- video
- audio

供应商能力反馈使用观察状态：

- `supported`
- `unsupported`
- `unknown`

用户策略使用：

- `inherit`
- `force_enable`
- `force_disable`

关键不变量：`reported_support` 不参与硬阻断。

即使：

```text
reported_support = unsupported
policy = force_enable
```

请求仍必须发送。

## 5. 媒体默认 passthrough

Provider 是传输层，不是多模态预处理器。

默认禁止自动：

- 图片 resize / 有损重编码；
- 视频压缩 / 抽帧 / 降帧率 / 降分辨率 / 裁切 / 提取音轨；
- 音频转码 / 降采样 / ASR / 截断。

允许透明的 transport adaptation，例如二进制转 base64、原字节上传后换取 file id。

Fake Ark 测试应通过 SHA-256 验证解码/上传后的媒体字节与输入一致。

超出服务端限制时，Provider 应报告结构化错误，把压缩/切片/换模型决策留给 Agent。

## 6. 自定义请求体

自定义请求体必须允许未知字段通过，不得先映射到严格白名单 Schema 再丢弃未知项。

计划支持：

- `merge`: object 深合并；scalar 后者覆盖；array 后者整体替换；
- `patch`: 可显式覆盖/删除已有字段；
- `raw`: 最高自由度的原始请求体模式。

思考模式、reasoning 参数、供应商实验字段等都属于模型卡自定义请求体，不做统一聊天 UI 开关。

## 7. Feedback 只提供证据

可以：

- 显示 `video: unsupported`；
- 根据 Feedback 推荐更可能成功的模型；
- 把模型状态为 unavailable 的项降低默认排序；
- 显示完整 Raw JSON。

禁止：

- 自动关闭 video；
- 自动生成 thinking/reasoning 参数；
- 自动限制 max output；
- 自动禁止 unavailable 模型请求；
- 用 Feedback 覆盖用户模型卡。

## 8. Harness 边界

兼容基线：DeepSeek Harness commit `d347e703908d0406b7a7ef80e3a0e594d86b2215` / `0.1.3-alpha.1`。

当前官方契约要求 Provider 通过 `LlmAdapter` 实现 `stream()` 并由 `ctx.llm.registerAdapter()` 注册。Provider HTTP 请求需合并 Harness attribution headers，并使用稳定 `LlmError` 表达传输/协议错误。

由于 Harness 的部分 `resolveModel()` 元数据会参与调用前校验，供应商丰富 Feedback 不应未经筛选直接注入 correctness-sensitive metadata，避免 Harness 在 adapter 收到请求之前削减实验空间。

## 9. v0.1 Freedom Tests

至少覆盖：

1. 未出现在模型目录中的 model id 仍能发送；
2. Feedback=image unsupported + force_enable -> 图片仍发送；
3. Feedback=video unsupported + force_enable -> 视频仍发送；
4. Feedback=audio unsupported + force_enable -> 音频仍发送；
5. Feedback=unavailable -> 用户明确调用仍能到达 Fake Ark；
6. 未知 custom body 字段不被删除；
7. 嵌套未知 JSON 不被删除；
8. 媒体字节不被修改；
9. 不发生隐式跨 Route fallback；
10. 用户 force_disable 的模态会被本地拒绝。

## 10. v0.1 暂不负责

- 多 Agent 派工与组织结构；
- 自动选择便宜模型；
- 自动视频压缩/抽帧；
- 统一思考档位；
- 根据模型家族猜测专有参数；
- 自动把 Feedback 变成配置。

这些能力可以在上层 Harness 或后续可选模块建设，但不得污染 Provider 的透明传输边界。
