## ADDED Requirements

### Requirement: Mock LLM 服务
评测工程 SHALL 提供 OpenAI 兼容的 mock LLM 服务，支持流式与非流式 `/v1/chat/completions`，首 token 延迟与 token 间隔可配置；在 JSON 模式下，根据请求内容返回平台可解析的评审、分块翻译与术语抽取 JSON，使平台的短文本与文档链路都能完整跑通而不依赖真实模型。

#### Scenario: 文档链路
- **WHEN** 平台默认模型指向 mock 服务并提交一篇文档任务
- **THEN** 任务完成，每个可翻译段都有 mock 译文

### Requirement: 压测脚本与报告
评测工程 SHALL 提供 Locust 压测脚本，覆盖 REST 查询、短文本流式翻译（记录首事件时间与完成时间）和文档任务吞吐三个场景，在 10 / 50 / 100 并发下各运行 60 秒，输出 RPS、p50 / p95 / p99 延迟与错误率。压测 MUST 使用 mock LLM，并为每个虚拟用户准备独立账号以避免触发翻译限流；压测结束后 SHALL 恢复原有的默认模型配置。

#### Scenario: 压测后恢复
- **WHEN** 压测脚本执行结束（含异常退出）
- **THEN** 默认模型恢复为压测前的配置，mock 模型配置被停用

#### Scenario: 首事件时间
- **WHEN** 执行短文本流式场景
- **THEN** 报告中包含首事件时间的 p50 / p95 / p99
