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
   - PPC/CPA 压力测试（软风险）
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

- Level 1：方向体检。优先关键词选品、关键词转化率、产品/竞品表。当方向是具体形态、或种子词天然跨类目时，先用 `search_sellersprite_categories` 取细分类目 `nodeIdPath` 再做产品选品/查竞品，从源头把盘面收敛到同类产品（这是抬高标杆可比性的最廉价手段；`nodeIdPaths` 只对产品选品/查竞品有效，且必须由该命令解析、不得自拼）。并基于已抓到的 `candidate_products` 字段（形态/标题、价格带、`review_count`/`putaway_date` 成熟度）廉价产出 `comparable_anchors` 候选清单：从证据里筛出与目标方向**真正同类**（形态、价格带、经营成熟度都可比）的 ASIN，并**反向标记**那些被引用为 Top/标杆但其实不可比的 ASIN。这一步只做判断、不做关键词反查。
- Level 2：候选验证。仅当 Level 1 有潜力时补关键词反查、Amazon 商品页和评论。当熔炉通过 `loopback_request` 指出可比性证据缺口时，本层对 **≥2 个**真同类标杆（不含想被推翻的争议 Top1）做定向关键词反查，平行验证自然/广告流量结构。
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
2. **后端做数学安全阀**：`AutoProductSelection.js` 在 scored 写入和应用决策时重新抽取关键字段，注入 `backend_math_validation` 与 `backend_math_scoring`，并在必要时覆盖错误动作。

这样设计的目的：

- 熔炉负责商业判断和解释。
- 后端负责保守数学、广告压力软降权、硬门槛和防误推荐；业务裁决以熔炉 scored 为准，后端数学不替代熔炉。
- 低置信或数据不足可以发布阻断/观察报告，但不能伪装成推荐。

## 熔炉评分输出

熔炉必须先 Hard Gates，再评分。四个分数必须同时输出，不能只输出总分。

引用任何 ASIN 作为赛道结论的证据前，熔炉要先确认它与目标方向可比；被标为 `not_comparable` 的 ASIN 不得作为经济性基准。出 verdict 前，熔炉还要做一次 `self_consistency_check`：主动扫描“是否存在被自己否定（如承认不可比、承认数据冲突）却又被采用进综合分的证据”。这是路径无关的最后一道保险——发现矛盾即在 `self_consistency_check.conflicts` 列出并置 `passed: false`，后端会据此触发回环。

### 0. Hard Gates

以下情况一票否决：

- 明确侵权或强品牌绑定
- FDA/医疗/补剂
- 服装鞋帽
- 超大件/重货
- 高认证门槛
- 高售后/高退货
- 负贡献利润
- 小卖家资金不可承受
- MOQ 或交期明显不可接受
- ProductSelector 可获取的关键数据严重缺失且无法推演
- 平台禁售或高封号风险

以下不是插件层 Hard Gate，只能进入风险、Kill Criteria 和 Next Validation Plan：

- BOM/1688 真实询价未完成
- USPTO/Google Patents/专利排雷未完成
- 真人打样、承重/耐用/装配测试未完成
- Seller Central FBA Calculator 最终实测未完成，但已有 SellerSprite 竞品 FBA 样本或合理估算
- SellerSprite 广告压力偏高或保守 CVR 压测倒挂，但单件贡献利润仍为正且无其它硬红线

这些人工验证项也不应单独把 `RECOMMEND` 降级为 `WATCHLIST`。`RECOMMEND` 表示“当前工具链证据足够好，值得进入人工验证/立项验证”，不是“已经可以直接下单生产”。

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

熔炉输出的是业务评审分，不再把旧版多乘法链当作最终数学裁决。后端 v3 会从 scored 中重新抽取关键字段，用五支柱加权几何平均与区间决策生成最终安全阀结果。

子项含义：

- `demand_score`：搜索、购买、购买率、需求稳定性。
- `growth_score`：增长趋势、近期评论增长、季节窗口。
- `differentiation_score`：差评痛点是否集中，低成本改良是否可做。
- `market_entry_score`：Review 门槛、头部集中度、价格带、Listing 难度。
- `competition_severity`：竞争严重度，后端会反向映射为竞争余地支柱。
- `compliance_risk`：合规/侵权/平台风险；高风险先走 Hard Gate，非硬门风险只做软降权。
- `listing_leverage_score`：场景代入弹性，后端用来放大差异化支柱。

后端 v3 支柱为：

```text
demand_pillar          = demand/growth/market_entry 复合
competition_pillar     = 竞争余地
profit_pillar          = 单件贡献利润 + 经压缩的广告经济性
differentiation_pillar = differentiation_score + listing_leverage_score 杠杆
execution_pillar       = execution_fit_score
```

量纲约定：

- `demand_score`、`growth_score`、`differentiation_score`、`market_entry_score`、`DataReliabilityScore`、`ExecutionFitScore` 优先写 `0-100`。
- `competition_severity`、`compliance_risk`、`complexity_severity` 优先写 `0-10`，越高越危险/越难。
- `listing_leverage_score` 写 `0-1`。
- 后端兼容历史输出：分数字段 `0-1` 会自动转成 `0-100`；严重度字段 `0-1` 会自动转成 `0-10`，大于 `10` 的旧百分制严重度会除以 `10`。

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

字段已进入 `unfetchable_gaps` 时，熔炉不得继续要求同字段回环，只能接受缺口、降低置信度并裁决。`unfetchable_gaps` 只应记录 ProductSelector 尝试后仍不可得的字段；BOM、专利、真人打样、Seller Central 最终实测不应写成 ProductSelector 缺口。

置信度分层：

```text
>=85   High
70-84  Medium-High
60-69  Medium，可谨慎推荐；若关键证据会改变结论则观察
55-59  Medium-Low，通常观察或具体回环
40-54  Low
<40    Very Low
```

`DataReliabilityScore < 40` 时输出 `DATA_INSUFFICIENT` 或 `REJECT`，原则上不做商业推荐。
`DataReliabilityScore 40-59` 且机会不错时，通常输出 `WATCHLIST` 或一次明确回环。
`DataReliabilityScore >= 60` 且低分只来自 BOM/专利/打样/Seller Central 最终实测等人工验证项时，不得因此阻止 `RECOMMEND`；应把这些移出数据置信扣分，转为 Next Validation Steps 与 Kill Criteria。

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

`ExecutionFitScore < 45` 时不得 `RECOMMEND`。但不得仅因“尚未真人询价/排雷/打样”把执行分压到低位；只有 raw 已证明 MOQ、工艺、认证、尺寸重量、售后或资金模型确实不适配小卖家时，才应大幅扣执行分。

### 4. FinalScore：最终排序分

`FinalScore` 是熔炉的业务排序参考分；后端最终会写入 `backend_math_validation.final_score` 与 `backend_math_scoring.final_score`，并以 v3 区间决策做安全阀审计。

这意味着：

- 机会高但 ProductSelector 可抓的关键证据仍然弱，不能直接 `RECOMMEND`，通常进入 `WATCHLIST` 或具体回环。
- 数据可靠但机会弱，应终态 `REJECT` / `DROP_AND_RESELECT`；只有具备正期权价值且有明确翻盘假设时才发布观察。
- 市场不错但小卖家做不动，不能 `RECOMMEND`。
- `WATCHLIST` 不是“不能推荐就先放着”的缓冲池。它只用于：无 Hard Gate、无证实负贡献利润、仍有正期权价值，但缺少一个会显著改变结论的关键证据；必须写明升级条件与淘汰条件。

### 5. verdict 三态与推荐强度

底层 `verdict` 只保留三态：

- `RECOMMEND`：可行动，进入人工验证/立项验证。
- `WATCHLIST`：待观察，具备正期权价值但关键假设未闭合。
- `REJECT` / `DATA_INSUFFICIENT`：阻断，硬红线、负贡献、系统性不可评估或机会弱且无翻盘假设。

推荐强度不扩展 verdict，而写入 `recommendation_tier`：

| 条件 | verdict | tier label | 中文 |
|------|---------|------------|------|
| `FinalScore 65-74` | `RECOMMEND` | `CAN_TRY` | 可以尝试 |
| `FinalScore 75-84` | `RECOMMEND` | `RECOMMEND` | 推荐 |
| `FinalScore >=85` | `RECOMMEND` | `STRONG_RECOMMEND` | 强烈推荐 |
| `FinalScore >=85` 且后端 `point_estimate >=75` | `RECOMMEND` | `TOP_RECOMMEND` | 极力推荐 |
| 有正期权价值但关键假设未闭合 | `WATCHLIST` | `WATCHLIST` | 待观察 |
| 阻断类 | `REJECT` / `DATA_INSUFFICIENT` | `BLOCKED` / `DATA_INSUFFICIENT` | 阻断 / 数据不足 |

后端发布层会读取该字段；若熔炉漏写，后端会按 `FinalScore` 与棱镜 `point_estimate` 兜底推导展示强度。数学算法本身不因 tier 改变。

## 后端数学安全阀

后端会在 scored 写入和应用决策时注入 `backend_math_validation` 与 `backend_math_scoring`。该安全阀不是替代熔炉，而是审计熔炉输出、兜住硬门和明显数学错误，保留 v3《棱镜》模型：五支柱加权几何平均、Listing 杠杆、广告数据低信任压缩、失真安全网与区间决策。

后端计算前会剥离自己上一次写入的 `action`、`total_score`、`backend_math_*` 与 `warnings` 注解，再读取熔炉原始 `scored_candidate_pack`，避免二次计算读到旧数学块。

所有评分输入会先通过 `buildCanonicalScoringInput()` 统一规范化，再进入 v3 支柱：

- `0-100` 分数字段若历史输出为 `0-1`，会自动视为比例并换算到 `0-100`。
- `0-10` 严重度字段若历史输出为 `0-1`，会换算到 `0-10`；若历史输出为旧百分制，如 `35`，会换算为 `3.5/10`。
- `listing_leverage_score` 使用 `0-1`，兼容 `80` / `80%` 这类历史写法为 `0.8`。
- 发生量纲修正时，后端会写入 `backend_math_scoring.input_normalization`，便于 debug 追踪。

这层适配是兼容旧 scored 的安全网；新熔炉输出仍应严格按规范量纲写入，避免业务解释层出现“0.8 分还是 80 分”的歧义。

### 字段抽取与缺失默认

后端会从 scored 文本里抽取：

- `selling_price`
- `bom_cost` / `bom_estimate_per_set_usd`
- `shipping_cost` / `head_freight_usd`
- `fba_fee` / `fba_fee_estimate_usd` / `median_fba_fee`
- `referral_fee`
- `packaging_cost`
- `return_reserve`
- `coupon_cost`
- `storage_reserve`
- `raw_click_conversion_rate` 或 `click_conversion_rate`
- `raw_ppc_bid` 或 `ppc_bid`
- `demand_score`、`growth_score`、`differentiation_score`、`market_entry_score`
- `competition_severity`、`compliance_risk`、`complexity_severity`
- `data_reliability_score`、`execution_fit_score`、数据置信子项或旧字段 `data_confidence`
- `listing_leverage_score`

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

每个关键字段缺失会让 `DataReliabilityScore` 扣分；存在 `unfetchable_gaps` 也会继续扣分。`bom_cost` 缺失会按售价 25% 保守估算并写 warning，但不作为 ProductSelector 关键缺失；`fba_fee` 完全缺失才按关键缺失处理。

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
paid_traffic_ratio = 显式字段或默认 0.60
blended_base_cpa = base_cpa * paid_traffic_ratio
blended_stress_cpa = stress_cpa * paid_traffic_ratio
base_ad_ratio = blended_base_cpa / UnitContribution
stress_ad_ratio = blended_stress_cpa / UnitContribution
estimated_acos = base_cpa / selling_price
```

`paid_traffic_ratio` 采用非对称证据规则：保守默认（0.60）免费，但**调低它是乐观动作**——它会摊薄每单广告成本，足以把倒挂的 `base_ad_ratio` 洗成健康值。因此只有当熔炉给出 `paid_traffic_ratio_basis: anchor_reverse_verified`、且 `source_asins` 列出**≥2 个互不相同、都标可比**的真同类标杆反查证据（不能只用想被推翻的争议 Top1 一个）时，后端才接受低于默认的 `paid_traffic_ratio`；否则后端会把它**钳回保守默认 0.60** 并记一条失真信号。数值无论写成扁平 `paid_traffic_ratio` 还是嵌套在 `paid_traffic_ratio_basis.value`，后端都会读到；单锚自证、或拿争议 Top1 当唯一证据，都视同无证据。换句话说，“自然流量红利”这类乐观叙事必须有 ≥2 个真同类反查支撑，不能自证。

当出现多个口径的 `base_ad_ratio`（保守 CVR 口径、行业派生口径、对标反证口径）时，后端综合取**最保守值**（最高倒挂）进入模型，而不是允许挑乐观值；多口径极差过大（如最高/最低 > 2x）本身就是失真信号，会降低数据置信度。

如果：

```text
stress_ad_ratio > 1.8
或 base_ad_ratio > 1.5
```

则标记 `ad_stress_test_failed=true`。这是软风险：后端写 warning、压低利润支柱并扩大不确定性，但不会单凭 SellerSprite 派生广告字段硬淘汰。熔炉可据此把边缘机会降为 `WATCHLIST`；只有单位贡献利润为负或其它 Hard Gate 成立时才硬淘汰。

### M_profit

后端利润乘数按 `base_ad_ratio` 调整：

```text
UnitContribution <= 0 => M_profit = 0.05
base_ad_ratio <= 0.4 => M_profit = 1.20
0.4 - 1.0            => 从 1.20 平滑降到 0.90
1.0 - 1.8            => 从 0.90 平滑降到 0.55
> 1.8                => M_profit = 0.45
```

附加惩罚：

```text
UnitContributionRate < 25% => M_profit *= 0.80
UnitContribution < $6      => M_profit *= 0.80
```

然后进入广告经济权重压缩：

```text
AD_ECONOMICS_WEIGHT = 0.35
UnitContribution <= 0 => M_profit_effective = M_profit
M_profit <= 1         => M_profit_effective = 1 - 0.35 * (1 - M_profit)
M_profit > 1          => M_profit_effective = 1 + 0.35 * (M_profit - 1)
profit_pillar         = clamp(M_profit_effective / 1.2)
```

因此广告压力会拖累机会分，但在贡献利润为正时不会把强市场直接打成 0 分。

### M_competition 与 M_compliance

后端会根据旧兼容字段或新字段中的严重度计算乘数：

```text
competition_severity: 0-10，越高越难进入
compliance_risk: 0-10，越高越危险
complexity_severity: 0-10，用于补算 market_entry 和 execution_fit
```

`compliance_risk >= 9` 会被后端视作 Hard Gate。

### 失真与自相矛盾安全网

`data_distortion_suspected` 命中后会下调数据置信度，并让 `RECOMMEND` 在预算内回环补一次干净证据，而不是直接发布。它覆盖两类信号：

- **数值异常**（原有）：成本/PPC/CPA 超过售价、`click_conversion_rate` 异常偏高（>40%）或偏低（<0.2%）、`acos` 异常偏高（>150%）。
- **内部逻辑自相矛盾**（新增）：研报自己否定却仍采用的证据，例如熔炉 `self_consistency_check.passed: false`、`comparable_anchors` 中存在 `not_comparable` 标杆却被当作经济性基准、无 `anchor_reverse_verified` 证据（或证据不足 ≥2 个可比标杆）却下调 `paid_traffic_ratio`、多口径 `base_ad_ratio` 极差过大。

第二类是本系统从“数据本身异常”扩展到“推导链自相矛盾”的关键：一份承认证据不可比却仍据此立项的研报，即便每个数字都在合理区间，也会被识别为失真并触发回环。其中“广告洗白”子类（钳回 `paid_traffic_ratio` 或可比性矛盾）若已无法回环治愈（预算耗尽或强制裁决），终局会被**降档为 WATCHLIST 发布**，发帖与日记都按观察口径，而不是按 RECOMMEND 强发——这是“运动员/裁判分离”的最后一道闸，专门兜住本次 Solar Lantern 这种“单锚自证 + force_decision 强出推荐”的翻车。

## 后端注入字段

后端会把校准结果写回 scored front matter：

```yaml
action:
total_score:
backend_math_validation:
  scoring_version: v3
  total_score:
  final_score:
backend_math_scoring:
  data_reliability_score:
  execution_fit_score:
  final_score:
  confidence_level:
  hard_gate_triggered:
  ad_stress_test_failed:
  data_distortion_suspected:
  distortion_signals:
  v3_interval_decision:
    point_estimate:
    optimistic_score:
    pessimistic_score:
    uncertainty_band:
    overall_trust:
    listing_leverage:
  v3_pillars:
    demand:
    competition:
    profit:
    differentiation:
    execution:
  profit_multipliers:
    profit:
    profit_effective:
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
    paid_traffic_ratio:
    blended_base_cpa:
    blended_stress_cpa:
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
- `data_distortion_suspected=true` 且 `verdict=RECOMMEND`：优先 `LOOPBACK_TO_HAWKEYE` 补一次干净/可比数据；无法再回环时（预算耗尽或强制裁决），普通数值失真终态发布谨慎报告，“广告洗白”子类（钳回 `paid_traffic_ratio`／可比性矛盾）终态**降档为 WATCHLIST 发布**。
- `optimistic_score < APS_SCORE_DROP_CEILING`（默认 42）：连乐观估计都不及格，才允许 `DROP_AND_RESELECT`；若熔炉已选择 `WATCHLIST` / `RESEARCH_GAP` / `DATA_INSUFFICIENT` 这类终态谨慎裁决，则维持发布。
- `pessimistic_score >= APS_SCORE_RECOMMEND_FLOOR`（默认 62）：悲观估计也过线，熔炉的 `RECOMMEND` 可以成立。
- 其余中间区间：`PUBLISH_FINAL`，由熔炉 verdict 决定推荐或待观察；若是 `WATCHLIST`，必须具备正期权价值与明确升级/淘汰条件，不静默淘汰。

因此：

- `WATCHLIST` 可以发布观察报告，但仅限有正期权价值的方向。
- `RESEARCH_GAP` 可以发布数据缺口报告。
- `DATA_INSUFFICIENT` 可以发布阻断报告。
- 硬红线和证实负贡献利润不能发布为 `RECOMMEND`。
- 广告压力偏高但贡献利润为正时是软风险，可把有机会价值的方向拉向 `WATCHLIST` 或扩大区间不确定性；若机会弱且无翻盘假设，应淘汰而不是进入观察池。

## 回环守卫

允许回环的前提：

- 只用于 Critical Gap 或最多一次 Important Gap。
- 必须输出具体 `loopback_request`。
- 必须指定字段、工具、关键词或 ASIN。

“高价值候选缺真同类标杆反查证据”是一类合法的 Critical Gap：当方向已进入候选 `RECOMMEND` 区间，但经济性结论依赖一个未经真同类反查证成的乐观假设（典型是下调 `paid_traffic_ratio` 的“自然流量红利”叙事，或 Top 标杆被标为 `not_comparable`）时，值得回环让鹰眼 Level 2 反查 **≥2 个可比标杆**（平行验证，不含想被推翻的争议 Top1）。低价值候选不触发回环，直接用保守默认值降档为观察。这就是按候选价值分流、控制工具调用成本的混合策略。注意：单锚自证不构成证据，且即便靠 `force_decision` 强行收口，后端也会把这类“广告洗白”终局降档为 WATCHLIST，而不是放它以 RECOMMEND 发布。

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
