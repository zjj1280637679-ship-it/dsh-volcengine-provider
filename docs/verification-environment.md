# 第二步验证环境：Fake Ark

本文定义 v0.1 第二步的验证环境。目标不是模拟火山模型智能，而是证明 Provider 在真实 HTTP 边界前没有擅自删改请求、媒体或 Route。

## 1. 为什么先做 Fake Ark

真实火山返回 4xx/5xx 只能证明服务端拒绝了请求，不能证明请求在到达服务端前是否被插件过滤、压缩、换路由或删除未知字段。

Fake Ark 因此承担“最终事实探针”的职责：

```text
Harness / request builder
        ↓
Volcengine transport
        ↓
Fake Ark
        ↓
Capture
├─ method
├─ URL path
├─ headers
├─ raw body bytes
└─ parsed JSON（仅便于断言）
```

## 2. 第二步范围

本阶段实现并自动验证：

1. Standard / Agent Plan / Coding Plan 三条 Route 的 URL path 严格隔离；
2. 每次 transport 调用只有一个显式 Route，不包含 fallback / retry 链；
3. 未出现在目录中的 model id 原样到达服务器；
4. 自定义请求体未知字段原样到达服务器；
5. `image` / `video` / `audio` 即使 Feedback 报告 unsupported，`force_enable` 后仍能到达 Fake Ark；
6. 二进制 upload transport 不改变任何 byte；
7. base64 / data URL 只做透明编码，解码后 SHA-256 与输入一致；
8. 默认 Route 常量不能被调用方意外修改；
9. `__proto__` 等合法 JSON key 被当作普通自有字段，而不是 JavaScript 原型操作。

本阶段**不**实现真实火山 SSE 解析、工具调用翻译、模型发现 API 或真实媒体 wire schema；这些在 Fake Ark 基础门禁稳定后再进入正式 Adapter。

## 3. Fake Ark 行为

`tests/support/fake-ark.ts` 启动本地 `127.0.0.1` 随机端口 HTTP 服务。

它默认返回简单 JSON，也可以由测试排队指定任意状态码和响应体。它不会做模型能力判断。

捕获项：

- `method`
- `path`
- `headers`
- 原始 `Uint8Array` 请求体
- 当 `content-type` 为 JSON 时的便利解析值

因此测试既可以验证语义 JSON，也可以直接验证原始媒体字节。

## 4. Route 验收

Fake Ark 使用同一服务器模拟三个前缀：

```text
/api/v3
/api/plan/v3
/api/coding/v3
```

调用：

```text
chat/completions
```

必须分别得到：

```text
/api/v3/chat/completions
/api/plan/v3/chat/completions
/api/coding/v3/chat/completions
```

Coding Plan 返回 429 时，捕获请求数必须仍为 1；不得再出现 `/api/v3/...` 请求。

## 5. 媒体 passthrough 的精确定义

“Provider 默认不压缩”在这里定义为：

> **进入本 Provider 媒体 transport 的字节，不得被 Provider 主动 resize、重编码、抽帧、转码、降采样或截断。**

允许透明 transport adaptation：

```text
bytes → base64 → bytes
bytes → HTTP upload → bytes
```

两端 SHA-256 必须一致。

### DSH 上游边界

DeepSeek Harness 当前核心 `ImageAttachmentRef` 是“规范化后的图片引用”；其附件服务明确允许在入库时缩放/重新编码。相对地，`FileAttachmentRef` 表示 byte-for-byte 的原始文件。

因此必须区分：

```text
浏览器原始图片 bytes
        ↓ 可能发生 DSH core image admission normalization
Provider adapter 收到的 image bytes
        ↓ 本插件禁止再次变换
火山 wire bytes
```

本项目承诺的是 **Provider 边界 passthrough**。

如果未来需要“浏览器上传原图 → 火山收到原图”全链路严格 byte identity，应使用 DSH 的 verbatim file attachment 路径或为图片增加专门的原始文件 ingress，而不能把核心 `ImageAttachmentRef` 错当成原始上传文件。

视频和音频当前优先设计为 verbatim file reference，因此更适合严格字节透传。

## 6. DSH 多模态扩展结论

在当前 Harness 基线中：

- `ContentBlockMap` 是 declaration-merge 可扩展接口；
- `ModelModalityMap` 同样可扩展；
- 核心当前内置 `text` / `image` 模态，但插件可以增加 `video` / `audio`；
- 为避免未来 DSH 核心正式增加 `video` / `audio` block 后发生类型命名冲突，本插件暂用 namespaced content block：
  - `volcengine-video`
  - `volcengine-audio`
- 模型能力层仍使用通用 modality：`video` / `audio`。

参考基线：DeepSeek Harness commit `d347e703908d0406b7a7ef80e3a0e594d86b2215`。

## 7. 第一阶段复查修正

第二步开始前对第一阶段进行了代码复查，并修正两项：

### 默认 Route 可变

旧实现 `getDefaultRoute()` 直接返回共享对象。调用方可能意外改变全局默认 URL/密钥变量名。

修正：

- 默认 Route 对象冻结；
- `getDefaultRoute()` 返回 caller-owned copy；
- 加入回归测试。

### 自定义请求体原型形状字段

旧 deep merge 对未知 key 使用普通 `target[key] = value`。合法 JSON 中的 `__proto__` 可能触发继承 setter，既无法“未知字段原样保留”，也会带来不必要的原型副作用。

修正：

- 只读取 own property；
- 使用 `Object.defineProperty()` 写入普通 enumerable data property；
- `__proto__` / `constructor` 仍可作为供应商未知字段发送；
- 不修改 `Object.prototype`。

## 8. CI 门禁

PR CI 顺序：

```text
install
  ↓
typecheck
  ↓
freedom tests + fake-ark tests
```

任何一项失败都视为第二步未完成。

## 9. 下一阶段

Fake Ark 通过后再实现真正的 DSH `LlmAdapter`：

```text
GenerateOptions
  ↓
Volcengine protocol encoder
  ↓
Ark transport
  ↓
SSE parser
  ↓
StreamChunk
```

正式 Adapter 仍必须复用本阶段 transport 和 freedom tests，而不是另造一套绕过门禁的请求路径。
