-- =====================================================================
-- V4：评审模型与自动采用术语（见 openspec/changes/improve-agent-from-experiments design D1 / D4）
--   均为兼容性改动（加列、放宽约束），存量数据不变：旧任务的自动采用术语保持 CONFIRMED。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 模型配置：全局唯一的评审模型标记（维护规则与 is_default 相同）
-- ---------------------------------------------------------------------
ALTER TABLE biz.model_config ADD COLUMN is_review_default boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX uk_model_config_review_default ON biz.model_config (is_review_default)
  WHERE is_review_default AND NOT deleted;

COMMENT ON COLUMN biz.model_config.is_default IS '是否默认模型（译者），未删除的配置中最多一个';
COMMENT ON COLUMN biz.model_config.is_review_default IS '是否评审模型，未删除的配置中最多一个；停用或删除时清除；可与默认模型为同一配置';

-- ---------------------------------------------------------------------
-- 文档任务：创建时解析的评审模型（继续执行时沿用）
-- ---------------------------------------------------------------------
ALTER TABLE biz.doc_task ADD COLUMN review_model_config_id bigint;

COMMENT ON COLUMN biz.doc_task.review_model_config_id IS '评审模型配置 id（创建时按 显式指定 → 管理员设置的评审模型 → NULL 解析；NULL 表示与译者相同）';

-- ---------------------------------------------------------------------
-- 任务术语：新增 AUTO（未开启人工确认时自动采用的抽取术语，软约束）
-- ---------------------------------------------------------------------
ALTER TABLE biz.doc_task_term DROP CONSTRAINT doc_task_term_status_check;
ALTER TABLE biz.doc_task_term ADD CONSTRAINT doc_task_term_status_check
  CHECK (status IN ('PENDING','CONFIRMED','REJECTED','AUTO'));

COMMENT ON COLUMN biz.doc_task_term.status IS 'PENDING 待确认 / CONFIRMED 已确认或术语库命中（硬约束）/ REJECTED 已拒绝 / AUTO 自动采用的抽取术语（软约束，仅供参考）';
