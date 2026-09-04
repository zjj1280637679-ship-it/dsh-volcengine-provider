# dsh-volcengine-provider

DeepSeek Harness 的火山方舟 LLM Provider 插件（开发中）。

## 立意

**建设积极自由，同时不干涉消极自由。**

插件应尽可能帮助用户发现模型、展示供应商反馈、构造多模态请求和兼容不同方舟通道；但供应商反馈、插件内置知识和历史测试结果都不得自动成为配置、权限或调用限制。

换句话说：**知识用于辅助选择，不用于封锁实验空间。**

## v0.1 目标

- 三条独立 Route：普通方舟、Agent Plan、Coding Plan。
- 文本 / 图片 / 视频 / 音频输入能力可分别配置，并允许 `force_enable` 强制测试。
- 模型即使未声明或声明不支持某模态，也不得因插件判断而被阻止测试。
- 媒体默认 passthrough：不压缩、不抽帧、不转码、不降采样；Agent 自己决定是否处理。
- 模型卡支持自定义请求体；未知字段不得被插件过滤。
- 思考模式不在对话界面做统一开关，由模型卡自定义请求体表达。
- 火山返回的丰富模型信息兼容展示和缓存，但只属于 Feedback，不自动修改 Config。
- 禁止三条 Route 之间的隐式 fallback，避免套餐与按量计费串线。

## 默认 OpenAI 兼容 Route

| Route | Base URL |
| --- | --- |
| Standard Ark | `https://ark.cn-beijing.volces.com/api/v3` |
| Agent Plan | `https://ark.cn-beijing.volces.com/api/plan/v3` |
| Coding Plan | `https://ark.cn-beijing.volces.com/api/coding/v3` |

这些 URL 是默认值，不是硬编码权限边界；后续模型卡/Route 配置仍应允许显式自定义。

## 信息分层

```text
Model
├─ Feedback      # 供应商告诉我们的，只读参考
├─ Config        # 用户明确设置的
├─ Observations  # 实际调用得到的历史事实
└─ Effective     # 本次最终请求
```

`Feedback -> Config` 禁止自动写穿。

## Harness 兼容基线

源码目标基线：DeepSeek Harness `d347e703908d0406b7a7ef80e3a0e594d86b2215`（dsh `0.1.3-alpha.1`）。

由于该源码版本尚未同步发布全部 npm 包，当前 CI 可安装基线使用 `@deepseek-ai/dsh-llm@0.1.2-rc.1`，并保留对 `0.1.3-alpha.1` 的 peer 兼容声明。

Provider 将按 Harness 官方 `LlmAdapter.stream()` / `ctx.llm.registerAdapter()` 契约实现。

## 当前进度

### 第一步：自由度合同与核心类型 ✅

- Feedback / Config / Observations / Effective 四层分离；
- 模态 `force_enable` / `force_disable`；
- custom body `merge` / `patch` / `raw`；
- 三 Route 默认配置；
- 第一组 freedom tests；
- 复查并修复默认 Route 可被调用方污染、`__proto__` 等合法未知 JSON 字段不能可靠透传的问题。

### 第二步：Fake Ark 验证环境 ✅

已完成并通过 CI：

- 单次、无隐式 retry/fallback 的 HTTP transport；
- Fake Ark 本地请求捕获服务器；
- 三 Route path / credential 隔离测试；
- unknown model id / unknown request body 直达测试；
- image / video / audio `force_enable` 直达测试；
- 二进制与 base64/data URL 的 SHA-256 passthrough 测试；
- DSH `ContentBlockMap` / `ModelModalityMap` 的视频、音频扩展类型；
- 当前门禁：5 个测试文件、17 个测试全部通过。

详细验证环境见 [`docs/verification-environment.md`](docs/verification-environment.md)。
详细目标与验收不变量见 [`docs/design-contract.md`](docs/design-contract.md)。

## 测试策略

```text
tests/
├─ unit/        # 纯逻辑测试
├─ fake-ark/    # 本地假方舟，检查最终 HTTP/媒体字节
├─ freedom/     # 不削减实验空间的核心验收
└─ live/        # 真实火山 Smoke/E2E（后续）
```

真实测试密钥只从环境变量 / GitHub Actions Secrets 读取，不进入仓库。
