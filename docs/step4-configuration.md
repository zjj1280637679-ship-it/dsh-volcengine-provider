# 第四步：最小配置与可扩展 UI

本步把已有 Chat adapter 接入 Harness 的供应商目录、设置和凭据服务，并提供 Models 页面卡片。最小用户输入为**选择通道、配置该通道密钥、填写模型 ID**。高级参数折叠显示。

## 配置与边界

插件名称及设置 namespace 为 `llm-volcengine`。单个插件实例管理 `routes` 字典；每个字典项生成一张卡片，Provider ID 为 `volcengine-<routeKey>`。默认生成 `standard`、`agent-plan`、`coding-plan` 三条通道，不自动填入模型。

| 配置位置 | 字段 | 含义 |
| --- | --- | --- |
| 通道 | `kind` | `standard`、`agent-plan` 或 `coding-plan`；决定默认地址和密钥引用 |
| 通道 | `enabled` | 默认 `true`；关闭后停止注册可调用适配器，保留配置卡片 |
| 通道 | `name`、`baseURL` | 可选显示名和 API 根地址；请求拼接 `/chat/completions` 或 `/models` |
| 通道 | `apiKeyEnv` | 环境变量或 Harness 凭据引用名，不是密钥明文 |
| 通道 | `models` | 手动模型卡数组；无需先拉取供应商模型列表 |
| 模型 | `id` | 必填；可填写模型 ID 或推理接入点 ID，不使用白名单 |
| 模型 | `name` | 可选显示名称 |
| 模型 | `modalities` | 可选；按 `text`、`image`、`video`、`audio` 独立记录用户设置的三态 |
| 模型 | `customBody`、`customBodyMode` | 自定义 JSON 文本（兼容对象）及 `merge` / `patch` / `raw` 模式 |
| 模型 | `contextWindow`、`maxTokens` | 可选正整数；分别声明上下文容量、请求默认输出上限 |

模态字段缺省或为 `inherit` 时表示能力未知，插件不自动填写，也不阻止该模态请求；`force_enable` 记录用户明确开启，`force_disable` 是唯一会在本地阻断该模态的设置。供应商的 supported／unsupported／unknown 反馈和运行时成功／拒绝均不参与此计算，也不能写回模型卡。留空上下文容量时插件不向 Harness 声明容量；留空输出上限时插件不额外设置 `max_tokens`，调用方仍可提供它。

模型目录与 `resolveModel()` 不发布封闭的 Harness `inputModalities` 列表。省略该字段表示未知，避免宿主把一个有限列表解释为能力上限并在适配器收到请求前阻断图片、视频或音频。卡片首次添加模型、重新载入和保存时也不得根据模型名称、目录反馈或历史调用结果补齐 `modalities`。

通道 key 使用小写字母开头的小写字母、数字和连字符，便于形成稳定 Provider ID。`baseURL` 可自定义，但应为不含嵌入凭据、查询参数或 fragment 的 HTTP(S) 根地址。模型 ID 不得为空或在同一通道重复。

三条通道各自使用 `ARK_STANDARD_API_KEY`、`ARK_AGENT_PLAN_API_KEY`、`ARK_CODING_PLAN_API_KEY`。卡片只写入密钥，读取时仅获取是否已配置等状态；密钥不会进入 `llm-volcengine` 设置。也可只配置将要使用的一条通道，关闭其余通道。

## 安装及持久化

从本开发分支构建预编译 tarball，避免直接把未构建的 TypeScript 当成安装入口：

```sh
pnpm install --frozen-lockfile
pnpm run build
npm pack
dsh plugin --profile web add ./dsh-volcengine-provider-0.1.0-alpha.7.tgz
dsh --profile web --dump-config
dsh --profile web
```

这些相对路径以当前仓库根目录为前提；在其他目录执行时改为绝对路径。`dsh plugin` 使用 pnpm 管理 profile 依赖，因而要求 pnpm 在 PATH 中。`web` profile 首次使用会按官方模板初始化。

当前包导出宿主 `.` 入口、浏览器 `./client` 入口和 `./cordis.patch.yml`。浏览器产物以官方 `ModuleLoader` factory 格式注册，`dsh.client` 声明 Connection、Models、Plugins 与 Remotes 客户端依赖；`dsh.bundle.patch` 让 `dsh plugin add` 自动把插件配置层加入 profile，Web 客户端随后发现其卡片。

安装包内的默认配置层为：

```yaml
- insert:
    - id: llm-volcengine
      name: dsh-volcengine-provider
      config: {}
```

随后启动 `dsh --profile web`：新版宿主在 Models 页面完成密钥及模型配置，`0.1.1-rc.2` 在 Plugins 页面使用同一组高级卡片并在 Models 页面选择模型。`config: {}` 使用三个默认卡片。若用户要覆盖配置，可在 profile 的 `cordis.patch.yml` 中重述完整 `llm-volcengine` 行，或使用一次性的 `--patch` overlay；后层按行替换，不会深度合并 `config`。

如果偏好部署时只声明 Coding Plan，可以将该插件行的 `config` 改为：

```yaml
config:
  routes:
    coding-plan:
      kind: coding-plan
      apiKeyEnv: ARK_CODING_PLAN_API_KEY
      models:
        - id: YOUR_MODEL_ID
```

`YOUR_MODEL_ID` 必须换成用户自己的模型或接入点 ID；密钥在卡片或启动环境中设置。显式提供 `routes` 时按该字典生成卡片，不自动补齐其余两个默认项。Harness 的组合 patch 替换目标行完整 `config`，修改已有部署配置时应保留该行需要的全部字段；运行时设置则通过 namespace 路径编辑。

## 高级请求体

| 模式 | 行为 |
| --- | --- |
| `merge`（默认） | 对象递归合并，数组整体替换，标量覆盖，`null` 作为值保留 |
| `patch` | 合并补丁对象；`null` 删除相应字段，数组整体替换；不是 JSON Patch 操作数组 |
| `raw` | 用自定义对象替换完整请求体；用户负责 `model`、`messages` 等全部所需字段 |

例如需要试验供应商的思考参数时，UI 中填写 `{"thinking":{"type":"enabled"}}`。部署配置推荐使用 YAML 文本形式：

```yaml
customBodyMode: merge
customBody: |-
  {
    "thinking": { "type": "enabled" },
    "future_vendor_option": { "enabled": true }
  }
```

此例只说明透传形式，不表示所有方舟模型支持这些字段。UI 将请求体保存为 JSON 文本，在适配器构造请求时才解析。这样连 `__proto__` 等合法未知 JSON 键也能穿过宿主 settings 的对象合并过程。既有程序传入的对象仍兼容；若需要保留此类特殊键，应使用文本形式。普通未知通道／模型字段也会保留，但宿主对象合并本身对特殊键的限制仍存在，不据此宣称任意配置对象完全无损。

自定义请求体在常规消息序列化之后应用，所以 `raw` 也不会跳过输入消息本身的内容块校验和附件读取。卡片校验 JSON 对象，不自动从供应商反馈或运行时结果推导请求参数。

## UI 扩展协议

在提供该卡位的新版宿主中，使用官方 `settings.models.provider-card` slot，以 `llm-volcengine` namespace 注册一次；宿主通过 `provider.settingsNs` 和 `provider.settingsPath` 传入当前卡片地址。`0.1.1-rc.2` 没有该 Models 卡位，插件改在稳定的 `settings.plugin.item` slot 注册一个 wrapper，由 wrapper 从已脱敏的 settings 描述中列出当前实际配置的 routes，不为部分 profile 制造不存在的卡片。未来新增任意动态 route 时，新版 Models 卡和 rc2 wrapper 都可复用，目前 UI 尚无“新建任意通道”按钮。

浏览器组件只接收读取设置、描述凭据、保存设置、保存凭据的回调。新版宿主由官方 namespaced Remotes 完成，`0.1.1-rc.2` 由官方 `connection.api` 完成；两种路径的凭据读取都只返回配置状态，不返回值。保存设置带 namespace revision；发生并发冲突或服务错误时显示失败，用户可重新载入。

官方 provider-card slot 是卡片附加区域，不能替换宿主原生表单。宿主面对未知 namespace 时仍可能显示通用高级设置提示或禁用的 Apply 按钮；本插件应使用**“保存方舟配置”**按钮提交。本步不通过修改宿主 DOM 隐藏这些控件。

扩展时保持以下约定：

- 新的供应商或模型参数放在高级配置；基本填写流程仍围绕通道、密钥和模型 ID。
- 修改通道只提交实际编辑的路径；模型数组整体更新时从原模型对象复制，保留尚未认识的字段。
- 供应商 Feedback／Runtime Observations 与用户 Config 分开保存；未来只读查看器不能自行更改模态、容量或请求体。
- 新通道通过 `routes` 数据及官方目录注册进入 UI，不修改 Harness 页面内部组件。

## 验证状态与边界

```sh
pnpm run typecheck
pnpm test
pnpm run build
pnpm run test:package
```

本地验证包括：三通道路径和凭据隔离、未知模型与自定义参数、媒体字节一致性、Chat 流翻译、公开 Cordis/LLM 运行时注册与热更新、Loader/Include 配置组合、卡片编辑和未知字段保存。宿主集成使用测试内存 settings／credentials 提供方；Loader 测试映射模块到源码；卡片测试使用 DOM 环境并验证官方 SlotRegistry 的注册／卸载。`test:package` 打包、解包并检查 bundle 元数据与 patch、宿主导出、浏览器 ModuleLoader factory、类型声明、直接覆盖示例和包内容；真正的自动激活另由实际 `plugin add` 与 dump/启动结果证明。这些自动化验证本身不替代实机结果；独立的 Harness `0.1.3-alpha.1` Web profile 已在 2026-09-06 完成真实 Coding Plan 文本闭环，见[完整宿主闭环报告](harness-web-loop-2026-09-06.md)。

第四步仅具备媒体读取扩展；[第五步](step5-media-input.md)进一步添加显式 MIME 的 `/ark-media` 输入命令、原图文件块和正确的 Chat 音频编码。命令按 commands 与 `readFileStream` 公共能力存在与否注册；npm `0.1.2-rc.1` 仍缺少原文件接口。普通图片经 `readImage` 读取时可能已被宿主规范化，严格原图需官方 file upload 文件链。媒体模态未设置时仍允许尝试，只有用户明确 `force_disable` 才阻断。原字节透传的本地验证不能替代完整 Web 或真实媒体 API 验收。

第四步完成时尚无真实 API 密钥，因此该阶段没有发送方舟请求。后续 Coding Plan 的文本与媒体冒烟结果分别见 [文本实测](live-coding-plan-2026-09-05.md) 和 [媒体实测](live-coding-plan-media-2026-09-05.md)，完整 Web 安装闭环见[完整宿主闭环报告](harness-web-loop-2026-09-06.md)；这些结果只覆盖当次账号、通道、模型别名和样本。当前保留 `private: true`，不进行 npm 发布或正式 Release。

## 资料依据

官方资料固定在 commit `d347e703908d0406b7a7ef80e3a0e594d86b2215`，避免滚动主分支使接口依据变化；可安装组件测试基线为 npm `0.1.2-rc.1`。兼容范围不等于已验证范围。

| 官方来源 | 本步采用的接口或约定 |
| --- | --- |
| [CLI 行为参考](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/apps/cli/reference/README.zh.md) | `--profile`、`--patch`、`--dump-config`、`dsh plugin` 与 profile 持久化 |
| [打包与安装插件](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/docs/user/develop/basic/publish.zh.md) | 预编译 tarball、普通依赖与 `dsh.bundle` 的区别、配置层覆盖 |
| [LLM 适配器开发](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/docs/user/develop/practice/llm-adapter.zh.md) | `LlmAdapter`、`registerAdapter` 与手动模型目录 |
| [Settings 服务](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/settings/settings/README.zh.md) | namespace、运行时覆盖和设置生命周期 |
| [Credentials 服务](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/credentials/credentials/README.zh.md) | 配置按名引用密钥，值存于宿主凭据服务 |
| [Models slot 契约](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/client/ui-settings-models/src/client/slot-contract.ts) | namespace 分发卡片，保留第三方 UI 扩展入口 |
| [浏览器模块加载](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/client/modules/README.zh.md) | `dsh.client`、`./client` 与 ModuleLoader factory |

项目内契约：[设计合同](design-contract.md)、[第三步适配器](step3-adapter-plan.md)；实现入口：[config.ts](../src/config.ts)、[plugin.ts](../src/plugin.ts)、[客户端](../src/client/index.ts)。
