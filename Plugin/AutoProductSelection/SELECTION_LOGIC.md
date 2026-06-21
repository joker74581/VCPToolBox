# AutoProductSelection 选品逻辑说明

本文描述自动选品系统的业务逻辑契约。状态机和派发由 `AutoProductSelection.js` 控制；市场数据由 `ProductSelector` 提供；三位 Agent 只负责各自阶段的内容判断。

## 总体目标

系统从“抓数据后总结推荐”升级为：

1. 鹰眼输出最小可判断证据包 Min Evidence Pack。
2. 熔炉独立评估四类分数：
   - `OpportunityScore`
   - `DataReliabilityScore`
   - `ExecutionFitScore`
   - `FinalScore`
3. 后端执行数学安全阀：
   - Hard Gates
   - CVR 保守修正
   - PPC 压力测试
   - UnitContribution
   - 重复回环守卫
4. 枢纽发布完整证据链、风险、缺口、Kill Criteria 和下一步验证计划。

## 策略创建

后端工作流驱动程序在派发创建 Brief 任务时，会自动读取策略文件：

```text
Plugin/AutoProductSelection/AutoSelectionStrategyProfile.zh-CN.md (优先)
或 Plugin/AutoProductSelection/AutoSelectionStrategyProfile.md (备用)
```

后端会将策略文件内容作为 `【当前选品策略指导 (Strategy Profile)】` 直接注入到任务提示词中。默认策略是宽泛探索。除非策略文件明确收窄，枢纽应从场景、人群、痛点、周边配件、收纳清洁、替换件和低成本改良角度发散。枢纽无需且不能调用 `ServerFileOperator.ReadFile` 重复读取。

Brief 应包含：

- `run_id`
- 研究假设
- 目标场景
- 目标客户
- 价格带
- 3-5 个不同角度英文种子词
- 排除红线
- Min Evidence Pack 输出要求

## 鹰眼取证

鹰眼分三层取证：

- Level 1：方向体检。优先关键词选品、关键词转化率、产品/竞品表。
- Level 2：候选验证。仅当 Level 1 有潜力时补关键词反查、Amazon 商品页和评论。
- Level 3：回环补采。只补熔炉指定字段，保留旧 raw，合并写回。

空数据规则：

- 冷门长尾词可能没有 SellerSprite 数据。
- 同义词/父词最多补查 1 次。
- 同类数据连续 2 次为空后写入 `unfetchable_gaps`。
- 不得编造 CVR、PPC、销量、FBA 或评论样本。
- 系统阻断如 429/500、账号、验证码、页面阻断立即停止。

## 评分与决策总览

当前评分是“两层制”：

1. **熔炉做业务评审**：读取 raw，基于证据输出 `scored_candidate_pack`，包含 Hard Gates、四类分数、财务字段、数据置信审计、裁决和下一步动作。
2. **后端做数学安全阀**：`AutoProductSelection.js` 在 scored 写入和应用决策时重新抽取关键字段，注入 `backend_math_validation_v2`，并在必要时覆盖错误动作。

这样设计的目的：

- 熔炉负责商业判断和解释。
- 后端负责保守数学、广告压力、硬门槛和防误推荐。
- 低置信或数据不足可以发布阻断/观察报告，但不能伪装成推荐。

## 熔炉评分输出

熔炉必须先 Hard Gates，再评分。四个分数必须同时输出，不能只输出总分。

### 0. Hard Gates

以下情况一票否决：

- 明确侵权或强品牌绑定
- FDA/医疗/补剂
- 服装鞋帽
- 超大件/重货
- 高认证门槛
- 高售后/高退货
- 负贡献利润
- 广告压力测试明显倒挂
- 小卖家资金不可承受
- MOQ 或交期明显不可接受
- 关键数据严重缺失且无法推演
- 平台禁售或高封号风险

触发后：

```yaml
hard_gates:
  passed: false
scores:
  final_score: 0
final_disposition:
  verdict: REJECT
post_forge_action:
  action: DROP_AND_RESELECT
```

### 1. OpportunityScore：产品机会分

`OpportunityScore` 回答：“这个市场本身有没有机会？”

```text
PotentialScore =
0.30 * demand_score
+ 0.20 * growth_score
+ 0.25 * differentiation_score
+ 0.25 * market_entry_score

OpportunityScore =
PotentialScore * M_profit * M_competition * M_compliance
```

子项含义：

- `demand_score`：搜索、购买、购买率、需求稳定性。
- `growth_score`：增长趋势、近期评论增长、季节窗口。
- `differentiation_score`：差评痛点是否集中，低成本改良是否可做。
- `market_entry_score`：Review 门槛、头部集中度、价格带、Listing 难度。
- `M_profit`：利润和广告压力乘数。
- `M_competition`：竞争严重度乘数。
- `M_compliance`：合规/侵权/平台风险乘数。

### 2. DataReliabilityScore：数据置信度分

`DataReliabilityScore` 回答：“我们有多确定？”

```text
DataReliabilityScore =
0.20 * source_reliability_score
+ 0.15 * freshness_score
+ 0.20 * sample_coverage_score
+ 0.20 * cross_source_consistency_score
+ 0.15 * field_completeness_score
+ 0.10 * outlier_control_score
```

字段已进入 `unfetchable_gaps` 时，熔炉不得继续要求同字段回环，只能接受缺口、降低置信度并裁决。

置信度映射：

```text
>=85   High         M_confidence = 1.00
70-84  Medium-High M_confidence = 0.90
55-69  Medium      M_confidence = 0.75
40-54  Low         M_confidence = 0.60
<40    Very Low    M_confidence = 0.40
```

`DataReliabilityScore < 40` 时输出 `DATA_INSUFFICIENT` 或 `REJECT`，原则上不做商业推荐。
`DataReliabilityScore < 70` 时，即使机会分高，也只能 `WATCHLIST`、`RESEARCH_GAP` 或具体回环。

### 3. ExecutionFitScore：小卖家执行适配分

`ExecutionFitScore` 回答：“这个机会是不是适合小卖家？”

```text
ExecutionFitScore =
0.25 * capital_friendliness_score
+ 0.20 * supply_chain_simplicity_score
+ 0.20 * listing_launch_difficulty_score
+ 0.20 * after_sales_risk_score
+ 0.15 * iteration_speed_score
```

执行适配乘数：

```text
>=85   M_execution_fit = 1.00
70-84  M_execution_fit = 0.90
55-69  M_execution_fit = 0.75
40-54  M_execution_fit = 0.60
<40    M_execution_fit = 0.40
```

`ExecutionFitScore < 45` 时不得 `RECOMMEND`。

### 4. FinalScore：最终排序分

```text
FinalScore = OpportunityScore * M_confidence * M_execution_fit
```

这意味着：

- 机会高但数据弱，会被置信度折扣压低。
- 数据可靠但机会弱，会低分拒绝。
- 市场不错但小卖家做不动，会被执行适配折扣压低。

## 后端数学安全阀

后端会在 scored 写入和应用决策时注入 `backend_math_validation_v2`。该安全阀不是替代熔炉，而是校准熔炉输出，防止乐观推荐。

### 字段抽取与缺失默认

后端会从 scored 文本里抽取：

- `selling_price`
- `bom_cost`
- `shipping_cost`
- `fba_fee`
- `referral_fee`
- `packaging_cost`
- `return_reserve`
- `coupon_cost`
- `storage_reserve`
- `raw_click_conversion_rate` 或 `click_conversion_rate`
- `raw_ppc_bid` 或 `ppc_bid`
- `demand_score`、`growth_score`、`differentiation_score`、`market_entry_score`
- `competition_severity`、`compliance_risk`、`complexity_severity`
- 数据置信子项或旧字段 `data_confidence`

缺失时使用保守压力测试，不制造高分：

- `selling_price` 缺失：用 `$25.00` 压测，并标记 `selling_price` 缺失。
- `bom_cost` 缺失：按售价 `25%`。
- `shipping_cost` 缺失：按售价 `10%` 且最低 `$1.25`。
- `fba_fee` 缺失：按售价 `18%` 且最低 `$3.00`，并标记关键缺失。
- `referral_fee` 缺失：按售价 `15%`。
- `packaging_cost` 缺失：按售价 `3%` 且最低 `$0.75`。
- `return_reserve` 缺失：按售价 `5%`。
- `coupon_cost` 缺失：按售价 `5%`。
- `storage_reserve` 缺失：按售价 `2%`。
- `click_conversion_rate` 缺失：按 `6%` 行业参考压测，并标记关键缺失。
- `ppc_bid` 缺失：按 `$1.15/$1.35` 压测，并标记关键缺失。

每个关键字段缺失会让 `DataReliabilityScore` 扣分；存在 `unfetchable_gaps` 也会继续扣分。

### UnitContribution

后端使用单件贡献利润，而不是只看毛利率：

```text
UnitContribution =
selling_price
- referral_fee
- bom_cost
- shipping_cost
- fba_fee
- packaging_cost
- return_reserve
- coupon_cost
- storage_reserve
```

```text
UnitContributionRate = UnitContribution / selling_price
BreakEvenACOS = UnitContribution / selling_price
```

`UnitContribution <= 0` 会触发利润硬风险，`FinalScore = 0`。

### CVR 保守修正

SellerSprite 的 `click_conversion_rate` 是行业参考，不是新品真实转化率。后端必须折减：

默认小卖家/新品口径：

```text
base_cvr = min(raw_cvr * 0.50, 0.08)
stress_cvr = min(raw_cvr * 0.35, 0.06)
```

只有 scored 中明确给出成熟证据，例如 `mature_cvr_evidence: true` 或 `cvr_adjustment_mode: mature`，才使用较宽松口径：

```text
base_cvr = min(raw_cvr * 0.65, 0.12)
stress_cvr = min(raw_cvr * 0.45, 0.08)
```

### PPC、CPA 与广告压力

PPC 使用规则：

- 如果 scored 显式提供 `used_ppc` 和 `stress_ppc`，优先使用。
- 否则有 `raw_ppc_bid`/`ppc_bid` 时：
  - `used_ppc = raw_ppc_bid * 1.15`
  - `stress_ppc = raw_ppc_bid * 1.35`
- PPC 缺失时：
  - `used_ppc = 1.15`
  - `stress_ppc = 1.35`

```text
base_cpa = used_ppc / base_cvr
stress_cpa = stress_ppc / stress_cvr
base_ad_ratio = base_cpa / UnitContribution
stress_ad_ratio = stress_cpa / UnitContribution
estimated_acos = base_cpa / selling_price
```

如果：

```text
stress_ad_ratio > 1.5
或 base_ad_ratio > 1.3
```

则标记 `ad_stress_test_failed=true`，不得 `RECOMMEND`。

### M_profit

后端利润乘数按 `base_ad_ratio` 调整：

```text
UnitContribution <= 0 => M_profit = 0.05
base_ad_ratio <= 0.4 => M_profit = 1.20
0.4 - 1.0            => 从 1.20 平滑降到 0.80
1.0 - 1.5            => 从 0.80 平滑降到 0.30
> 1.5                => M_profit = 0.05
```

附加惩罚：

```text
UnitContributionRate < 25% => M_profit *= 0.70
UnitContribution < $6      => M_profit *= 0.70
```

### M_competition 与 M_compliance

后端会根据旧兼容字段或新字段中的严重度计算乘数：

```text
competition_severity: 0-10，越高越难进入
compliance_risk: 0-10，越高越危险
complexity_severity: 0-10，用于补算 market_entry 和 execution_fit
```

`compliance_risk >= 9` 会被后端视作 Hard Gate。

## 后端注入字段

后端会把校准结果写回 scored front matter：

```yaml
backend_math_validation_v2:
  opportunity_score:
  data_reliability_score:
  execution_fit_score:
  final_score:
  confidence_level:
  hard_gate_triggered:
  ad_stress_test_failed:
  multipliers:
    profit:
    competition:
    compliance:
    confidence:
    execution_fit:
  financials:
    selling_price:
    bom_cost:
    shipping_cost:
    fba_fee:
    referral_fee:
    estimated_unit_contribution:
    estimated_unit_contribution_rate:
    raw_click_conversion_rate:
    base_cvr:
    stress_cvr:
    raw_ppc_bid:
    used_ppc:
    stress_ppc:
    base_cpa:
    stress_cpa:
    estimated_acos:
    break_even_acos:
    base_ad_ratio:
    stress_ad_ratio:
  missing_critical_fields:
warnings:
```

最终论坛报告应同时展示熔炉四分和后端数学压力测试，不能只展示一个 `FinalScore`。

## 后端动作兜底

后端只会对 `PUBLISH_FINAL` 做安全兜底；如果熔炉本来输出 `LOOPBACK_TO_SCOUT` 或 `DROP_AND_RESELECT`，后端不会把它改成发布。

当 `post_forge_action.action = PUBLISH_FINAL` 时：

- Hard Gate 触发：改成 `DROP_AND_RESELECT`。
- `verdict=RECOMMEND` 且 `FinalScore < 75`：改成 `DROP_AND_RESELECT`。
- `verdict=RECOMMEND` 且广告压力失败：改成 `DROP_AND_RESELECT`。
- 没有明确 verdict 且 `FinalScore < 75`：改成 `DROP_AND_RESELECT`。
- `FinalScore < 50` 且 verdict 不是 `WATCHLIST`、`RESEARCH_GAP`、`DATA_INSUFFICIENT`：改成 `DROP_AND_RESELECT`。

因此：

- `WATCHLIST` 可以发布观察报告。
- `RESEARCH_GAP` 可以发布数据缺口报告。
- `DATA_INSUFFICIENT` 可以发布阻断报告。
- 但低分、广告倒挂或硬红线不能发布为 `RECOMMEND`。

## 回环守卫

允许回环的前提：

- 只用于 Critical Gap 或最多一次 Important Gap。
- 必须输出具体 `loopback_request`。
- 必须指定字段、工具、关键词或 ASIN。

禁止回环：

- `global_loopback_count >= 3`
- `scout_loopback_count >= 2`
- 同一 `missing_field` 已补采过
- 字段已在 `unfetchable_gaps`
- `gap_type` 不是 `Critical` 或 `Important`
- 只写“继续调研”但没有具体请求

`loopback_request` 必须形如：

```yaml
loopback_request:
  gap_type: Critical | Important
  missing_field:
  reason:
  requested_tool:
  target_keywords:
  target_asins:
  required_fields:
  max_additional_tool_calls:
  stop_after_this_loop: true
```

后端拒绝普通回环时，不直接 failed；它会删除旧 scored，保留 raw，重新派发 reviewer 进入 `force_decision_mode`，让熔炉基于现有证据输出终态：

- `RECOMMEND`
- `WATCHLIST`
- `REJECT`
- `DATA_INSUFFICIENT`

## 决策动作

- `PUBLISH_FINAL`：发布最终报告，可用于 `RECOMMEND`、`WATCHLIST`、`RESEARCH_GAP` 或 `DATA_INSUFFICIENT` 阻断报告。
- `LOOPBACK_TO_SCOUT`：只用于具体关键缺口。
- `DROP_AND_RESELECT`：当前方向已被商业否决或触发硬红线，重新选品。

## 最终报告

枢纽最终报告必须展示：

- 一句话裁决
- 四类分数
- Hard Gates
- 后端数学和广告压力测试
- 市场需求证据
- 竞争结构证据
- 利润与广告容错
- 差异化机会
- 合规/侵权/平台风险
- 供应链与资金压力
- 数据置信度审计
- 缺口与假设
- Kill Criteria
- Next Validation Plan
- 经验沉淀标签
