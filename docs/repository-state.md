# 分支归档与交付收尾

`main` 是当前开发入口。已交付版本以不可移动的 Release 标签及附件 SHA-256 为准；归档维护提交不重新发布旧版本。

2026-09-06 的归档计划见 [.github/branch-archive-plan.json](../.github/branch-archive-plan.json)。七个完成的开发分支已包含在 `v0.1.0-alpha.10`，另两个分支仅保留历史测试工作流/脚本。所有分支头都先保存在 `archive/2026-09-06/<原分支名>` 标签，再与删除活动分支一起原子提交。头部 SHA 变化时整批停止，不覆盖继续进行的工作。

旧 PR #2–#6 的内容已进入发布历史，关闭其悬挂的分支链。原有 Release 标签保持可追溯，归档标签不属于发布版本。

需要恢复历史开发分支时：

```sh
git fetch origin --tags
git switch -c recovered-branch archive/2026-09-06/media-live-v0.1
```

交付前依次核对：已提交的工作树、候选提交、发布标签、被验证的同一个 tarball 与校验值；交付后收口已完成分支和 PR，归档临时验证材料。开发依赖和当前构建产物由现有忽略规则管理，不使用整树强制清空命令。

以后归档采用显式计划：更新分支名、准确 SHA、归档日期和归属说明，先运行 `node scripts/archive-completed-branches.mjs --check`；计划进入 main 后执行归档。未合入的产品代码需要单独判断，不能自动当成过期分支。
