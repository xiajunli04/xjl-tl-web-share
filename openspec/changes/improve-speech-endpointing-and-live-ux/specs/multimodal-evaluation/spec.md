## ADDED Requirements

### Requirement: E6 停顿鲁棒性评测
系统 SHALL 提供 E6 评测，用来衡量断句对句中停顿与语气词的鲁棒性。

**数据**：数据集由脚本从 `evaluation/data/speech` 的 40 句派生，生成到 `evaluation/data/speech_pause/`：
- **V0 原句**；
- **V1 句中停顿**：在整句音频 35%–65% 区间内能量最低处切开，插入 600 / 900 / 1200 ms 静音；
- **V2 停顿 + 语气词**：在切点插入合成的语气词，两侧各留 300 ms 静音；
- **V3 两句间隔**：同场景相邻两句之间留 700 ms 静音。

**离线断句评测**：直接驱动断句组件（真实 VAD、识别与判定模型，不调用 LLM），按音频时钟回放。统计：
- 碎句率：V1 / V2 中一句原句产出多于 1 个定稿的比例；
- 误合并率：V3；
- 语气词成句数；
- 判定延迟：最后一段语音结束到定稿，p50 / p90；
- 定稿文本的 CER / WER。

**对照组**：`baseline`（续说等待为 0）、`rules`（仅文本规则）、`smart`（文本规则 + Smart Turn）。三组 MUST 在同传·均衡、同传·极速、对话·均衡三档下运行。

**端到端抽检**：按 E4 方式实时推流 V0 / V1 各 10 句，统计 e2eMs、holdMs 与整句 chrF。

**结论**：E6 结论 SHALL 决定 Smart Turn 是否缺省开启。达标线为：碎句率较 baseline 下降 ≥ 50%，且 V0 判定延迟 p50 增加 ≤ 150 ms。

#### Scenario: 生成汇总
- **WHEN** 运行 E6 离线断句评测
- **THEN** 输出 `results/multimodal/e6_summary.csv` 与 `e6_latency.png`，包含三组在三档下的碎句率、误合并率、语气词成句数、判定延迟 p50/p90 与 CER/WER

#### Scenario: 模型缺失时跳过
- **WHEN** 运行 E6 时 Smart Turn 模型不存在
- **THEN** `smart` 组标记为跳过并在汇总中说明原因，其他组照常输出

#### Scenario: 数据可复现
- **WHEN** 删除 `evaluation/data/speech_pause/` 后重新运行生成脚本
- **THEN** 生成的切点与音频长度与上次一致（切点只由原音频决定）
