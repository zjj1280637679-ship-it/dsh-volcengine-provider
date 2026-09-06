# Harness Web 历史隔离闭环记录（2026-09-06，alpha.7 前）

> 这是已退役的隔离实例记录，只用于保留实验谱系；其中 `3081` 验收实例和独立“方舟原始媒体”面板不属于当前安装。`0.1.0-alpha.9` 的唯一实例、原生彩色 `+`、同一消息发送和完整冷重启结论以最新本机交付报告及 [原生输入栏的方舟媒体旁路](step6-original-media-ui.md) 为准。

## 结论

预编译插件包已在隔离的 DeepSeek Harness Web profile 中完成安装、自动激活、配置、真实 Coding Plan 流式回复、进程重启和最终包重装复验。既有的本机 Harness `127.0.0.1:3080` 全程保持运行；验收实例使用 `127.0.0.1:3081`。

本报告不包含 API Key、Web 启动令牌或凭据值。验收只复用本机已有的凭据引用，不把凭据复制进仓库、示例或产物。

## 固定基线

- 插件候选基线：`media-live-v0.1` 的 `1a4a522ad58cc27b9e453fed545631ec977e242e`，再叠加本报告对应的本地完善改动。
- Harness：`dsh-v0.1.3-alpha.1`，commit `d347e703908d0406b7a7ef80e3a0e594d86b2215`。
- profile：`volcengine-e2e-20260906`。
- 路由：Coding Plan `/api/coding/v3`；模型别名 `ark-code-latest`。
- 最终包：`dsh-volcengine-provider-0.1.0-alpha.1.tgz`。具体字节数和 SHA-256 记录在仓库外的交付清单中，避免包内报告反过来改变包哈希。

## 自动化回归

依次通过：

```text
pnpm run typecheck
pnpm run test:ci       # 18 files, 141 tests
pnpm run build
pnpm run test:package  # bundle 元数据、宿主/浏览器入口、声明和包内容
```

`test:package` 验证根级 `cordis.patch.yml` 和 `dsh.bundle.patch` 元数据确实进入包内，并拒绝会在 bundle 行之外重复插入同一 ID 的示例覆盖层。自动激活不是由这个静态包检查推断，而是由后续实际 `plugin add`、profile manifest、dump 和启动结果共同证明。

## 实机步骤与结果

1. 从最终 `.tgz` 向隔离 profile 执行 `plugin add`。profile 依赖指向该文件，安装包内存在根级 `cordis.patch.yml`。
2. `--dump-config` 显示基础宿主、Web App、插件 bundle 和 profile 配置覆盖层；最终只有一个 `llm-volcengine` 配置行。
3. 启动固定 Harness 源码宿主后，Models 页面显示“火山方舟 · Coding Plan”、已配置的凭据状态和 `ark-code-latest`；模型选择器也在该供应商分组下显示并选中此模型。
4. Web 会话发送“只回复 OK”，收到流式回复 `OK`。
5. 停止且只停止 3081 的验收进程，再以同一 profile 重启；模型选择、配置和凭据引用仍可用，发送“只回复 RESTART_OK”收到 `RESTART_OK`。
6. 用重新生成的最终 `.tgz` 执行 `plugin add`，再次启动同一 profile，发送“只回复 FINAL_PACKAGE_OK”收到 `FINAL_PACKAGE_OK`。
7. “方舟原始媒体”面板在会话输入区正常挂载，并显示当前模型 `volcengine-coding-plan / ark-code-latest`。本轮未再次经系统文件选择框上传媒体；真实图片／视频 API 结果继续以 2026-09-05 的媒体报告为准。

## 验收中发现并修复的问题

- Windows 下 `spawnSync("npm")` 不能可靠定位 npm：包验证脚本在 Windows 改为用当前 Node 调用 `npm-cli.js`。
- 包缺少自动激活入口：新增根级 `cordis.patch.yml`、包导出和 `dsh.bundle.patch`。
- 用 `insert` 叠加示例会与 bundle 自动插入重复 ID：示例和 profile 改为直接按 `id` 覆盖；包测试固定此约束。
- 原媒体流此前信任声明长度：现在拒绝无效长度、溢出和截断，并避免重复分配；Base64 转换在可行时复用底层字节视图。
- 用户切换 provider、模型、路由或连接时，排队中的媒体发送可能落到旧目标：执行命令前会以配置代次中止陈旧操作；进入宿主命令执行后若响应被中断或 Remote 返回错误包，则明确报告“提交状态未确认”，避免把可能已经投递的请求误报为安全取消并诱导重复发送。确定性竞态测试覆盖协作式中止、错误 envelope 和宿主已返回成功三条路径。

## Windows 宿主说明

固定的 Harness alpha 源码在 Windows 仍静态导入 POSIX 用的 `fs-ext`，而该原生模块在这台机器缺少 C++ 构建工具。为运行官方 alpha 源码，验收 checkout 的 `node_modules` 对这个仅供 POSIX 使用的依赖采用了 Windows no-op 兼容垫片；Windows 的实际租约路径使用 Win32 semaphore，没有调用该垫片方法。插件源码、profile 和最终 `.tgz` 未包含此垫片。

因此，本次证据证明插件与固定 alpha 源码合同和实际 Windows 路径兼容，但不声称上游 Harness alpha 的 Windows 依赖安装已经无需修补。

## 发布边界

此结果仍是本地候选：`private: true` 保留，没有推送分支、合并 PR、创建 tag、GitHub Release 或 npm 发布。公开交付前还需要把草稿 PR 链整理成一个可从默认分支审阅的集成变更，并对该精确提交复跑上述门禁。
