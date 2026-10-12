# document-pipeline Specification

## Purpose
TBD - created by archiving change add-document-translation-agent. Update Purpose after archive.
## Requirements
### Requirement: 任务流与事件流
Spring 与 AI 服务之间 SHALL 通过两条持久化的 Redis Stream 通信：任务流 `tl:doc-tasks`（命令 start、resume、retry、cancel，消费组 `ai-worker`）和事件流 `tl:doc-events`（事件 phase、parsed、analysis、awaiting_confirm、chunk_done、consistency、trace、completed、failed、cancelled，消费组 `spring`）。消息字段 MUST 为字符串，结构化内容以单行 JSON 存放。双方启动时 SHALL 幂等地创建所需的流和消费组。

#### Scenario: 首次启动
- **WHEN** Redis 中不存在这两条流，Spring 和 Python 依次启动
- **THEN** 两条流及各自的消费组被创建；重复启动不报错

### Requirement: 处理后确认与重启恢复
消费方 SHALL 在处理完成（Spring 为落库成功）后才确认消息。消费方启动时 SHALL 认领闲置超过 60 秒的未确认消息并重新处理，使任一端在任意时刻重启都不丢失命令或事件。

#### Scenario: Spring 重启期间的事件
- **WHEN** Spring 停止期间 AI 服务上报了 3 个 chunk_done 事件，随后 Spring 重启
- **THEN** Spring 消费这 3 个事件并更新段落和进度，结果与不停机时一致

### Requirement: 事件幂等
每个任务的事件 SHALL 带有单调递增的 eventSeq。Spring MUST 记录每个任务已处理的最大 eventSeq，对不大于该值的重复事件直接确认并跳过。

#### Scenario: 重复投递
- **WHEN** 同一个 chunk_done 事件被投递两次
- **THEN** 进度只增加一次，第二次被跳过

### Requirement: 取消传播
用户取消任务后，Spring SHALL 写入 cancel 命令；AI 服务收到后 MUST 取消该任务正在执行的协程及在途的 LLM 调用，并上报 cancelled 事件。处于待确认状态的任务没有运行中的协程，AI 服务 MUST 直接上报 cancelled。

#### Scenario: 翻译中取消
- **WHEN** 任务正在翻译第 4 块时被取消
- **THEN** 第 4 块的 LLM 调用被中止，不再执行后续块，任务最终为 CANCELLED

### Requirement: 执行并发
AI 服务的 worker SHALL 以可配置的全局并发（默认 2）执行任务；处于术语确认中断的任务 MUST 释放并发槽。同一任务的块级并发由分块策略决定（parallel / hybrid 默认 3）。

#### Scenario: 排队
- **WHEN** worker 并发为 2，3 个任务几乎同时创建
- **THEN** 前 2 个任务开始执行，第 3 个保持 PENDING，直到有槽位释放

### Requirement: 检查点与缓存清理
任务被删除后，AI 服务 SHALL 清理该任务的执行检查点和分块结果缓存。

#### Scenario: 删除已完成任务
- **WHEN** 用户删除一个已完成的任务
- **THEN** ai schema 中不再有该任务的检查点和分块结果

