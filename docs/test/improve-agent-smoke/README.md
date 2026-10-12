# improve-agent-from-experiments 冒烟记录

> 日期：2026-10-03 · 代码版本：`baf1ca1` 起

## 后端（真实 LLM）

| 检查项 | 结果 |
|---|---|
| Flyway V4 迁移 | 启动日志 `Migrating schema "biz" to version "4 - review model"`，成功 |
| 设置评审模型 `PUT /api/admin/model-configs/3/review-default` | 配置 3（GPT-6 Luna）`isReviewDefault=true`；选项接口返回 `isReviewDefault` |
| 短文本标准路径（不带 reviewModelConfigId） | Spring 解析为管理员评审模型；`review` 事件 `reviewer="GPT-6 Luna（Anthropic协议）"`、`fallback=false` |
| 文档任务 I1–I3（30 次） | 全部完成；不确认任务的抽取术语为 `AUTO`，I3 模拟确认后为 `CONFIRMED`，I2 的分块轨迹摘要包含 `问题 critical / major / minor` 计数 |

## 前端（mock 模式，`NEXT_PUBLIC_MOCK_API=1`）

| 截图 | 检查点 |
|---|---|
| `01-model-configs.png` | 「评审」徽标与「默认」徽标并列、色调不同 |
| `02-set-review-confirm.png` | 设为评审模型的确认弹窗，说明原评审模型会被取消、与默认模型相同时等同自评 |
| `03-review-same-as-default.png` | 徽标切换到默认模型卡片（`layoutId` 滑动），顶部出现"评审模型与默认模型相同"提示条；名称完整显示，徽标换行 |
| `04-new-task-defaults.png` | 第 ② 步默认选中「混合」并带「推荐」角标，人工确认开启 |
| `05-review-on-shows-model.png` | 预设分为「推荐」与「实验对照 D0–D6」；打开评审修正后展开"评审模型：xxx"，预设自动识别为 D6 |
| `06-confirm-summary.png` | 第 ③ 步摘要显示译者模型、评审状态与评审模型；三步结构未平铺 |
| `07-terms-grouped.png` | 术语按「已确认 / 术语库（强制）」「参考（自动采用）」分组，分组说明与「参考」徽标 |

动效统一走 `MotionConfig reducedMotion="user"`，组件内用 `useReducedMotion` 关闭缩放与位移。
