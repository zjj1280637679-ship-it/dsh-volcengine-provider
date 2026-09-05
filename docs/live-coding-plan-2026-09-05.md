# Coding Plan 真实短文本验证：2026-09-05

用户配置 `ARK_CODING_PLAN_API_KEY` 后，使用明确指定的 `doubao-seed-2.0-lite` 和 `glm-5.3-flash` 执行最小真实请求。密钥存在性检查及两次 Chat 请求均通过。

证据：[GitHub Actions 运行 33969952911](https://github.com/zjj1280637679-ship-it/dsh-volcengine-provider/actions/runs/33969952911)，被测试提交为 `23f0931dd8e6db0c37eda531dfdd84cdc0d0fffa`。报告开始时间为 `2026-09-05T13:48:32.946Z`。

| 检查 | 结果 |
| --- | --- |
| Secret 对本次工作流可用 | 通过 |
| Coding Plan 根地址 | `https://ark.cn-beijing.volces.com/api/coding/v3` |
| `GET /models` | HTTP 200，130 条目录记录 |
| `doubao-seed-2.0-lite` | HTTP 200，SSE，回复 `OK`，结束原因为 `stop` |
| `glm-5.3-flash` | HTTP 200，SSE，回复 `OK`，结束原因为 `stop` |

| 模型 | 输入 tokens | 输出 tokens | 其中推理 tokens | 总 tokens |
| --- | ---: | ---: | ---: | ---: |
| `doubao-seed-2.0-lite` | 60 | 23 | 22 | 83 |
| `glm-5.3-flash` | 23 | 59 | 54 | 82 |

Token 数值来自供应商响应并经插件转换，两次调用合计 165 tokens；不据此推断套餐实际计费。没有额外设置 `thinking` 或 `reasoning_effort`。

## 目录与实际调用

本次返回的 130 条模型目录记录中，没有与上述两个 ID 完全相同的字符串。插件仍按用户提供的 ID 发起请求，两者均成功。这是本次实际观测，说明目录反馈不能自动成为调用白名单；不据此推断所有目录、别名或账号行为。

目录探测只查询 `GET /models`，Chat 每模型只发起一次请求。没有重试、跨通道回退、修改模型卡或自动选择其他模型。

## 验证路径与范围

[工作流](../.github/workflows/live-coding-plan.yml) 从源码构建，再执行 [真实探测脚本](../scripts/live-coding-plan.mjs)。请求经过生产 `VolcengineChatAdapter` 的消息序列化、HTTP transport、SSE 解析及 Harness chunk 转换。测试提示为 `This is a connection test. Reply with exactly OK.`，每次输出预算为 256 tokens、超时 90 秒。

密钥仅在最终请求步骤注入。准备和构建阶段只检查是否配置；报告保留状态、模型、回复、用量及诊断信息，不包含密钥内容或请求头。请求仅允许 Coding Plan 的模型目录和 Chat 地址，拒绝重定向。

离线预检验证了固定通道、恰好三次尝试、目录失败不拦截手动模型、缺密钥时零请求、认证失败状态，以及供应商诊断包含测试密钥时的脱敏。真实运行则证明本次账号和两个指定模型的短文本流式调用可用。

本次没有验证图片、视频、音频输入、工具调用、完整 Harness Web 上传或会话导出；不扩大短文本结果的适用范围。此前媒体字节保真和命令接口的本地验证见 [第五步媒体输入](step5-media-input.md)。

`push` 触发仅限 `live-coding-plan-v0.1` 分支的工作流或脚本变动。工作流也声明了手动触发；GitHub 的手动入口需该工作流在默认分支存在后才可用。它不属于普通 PR CI，不会因编辑本文档自动重发付费请求。

## 官方接入依据

- [Coding Plan 其他工具接入](https://www.volcengine.com/docs/82379/2188959)：OpenAI 兼容根地址。
- [个人版快速开始](https://www.volcengine.com/docs/82379/1928261)：`doubao-seed-2.0-lite` 模型 ID。
- [个人版 OpenClaw 接入](https://docs.volcengine.com/docs/ark/coding-plan-personal-ai-openclaw?lang=zh)：`glm-5.3-flash` 模型 ID。
- [个人版 DeepSeek Harness 接入](https://docs.volcengine.com/docs/ark/coding-plan-personal-ai-deepseek-harness?lang=zh)：Coding Plan API Key 的配置说明。

官方资料用于核对接入形式；是否支持 `GET /models` 在本次测试前没有找到明确文档保证，其 HTTP 200 仅记录为本次实测结果。
