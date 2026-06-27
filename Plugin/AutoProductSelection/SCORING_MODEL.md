# 自动选品评分引擎 v3 ·《棱镜》决策模型（SCORING_MODEL）

> 本文件描述 `AutoProductSelection.js` 后端评分与决策引擎（`calculateScoringModel` +
> `decideBackendAction`）的完整逻辑。**代码是准则，本文档是说明**；若两者冲突，以代码为准。
> 引擎版本：**v3（Prism / 棱镜）**。全部数学常量通过 `config.env` 的 `APS_SCORE_*` 暴露，可在不改代码的前提下重新标定，便于开源后不同卖家适配自身优势。最后更新：2026-06。

---

## 0. 设计哲学：从"乘法绞杀"到"证据棱镜"

旧版 v2 是一条**全乘法链**：`潜力 × M_profit × M_competition × M_compliance × M_confidence × M_execution`。它有一个结构性缺陷——**温和的平庸会被复利式绞杀**。四个各自"还不错"（0.8）的维度连乘，结果坍缩到 0.41；一个数据齐全、各项中等偏上的合理产品，最终分往往只有 25–35，而发布门槛在 50。系统因此长期"选不出产品"，并在重选预算耗尽时被迫强出一个。

v3 的设计原则是把评分从"惩罚链"重构为**多棱镜证据聚合**：

1. **信号分层信任**：相对可信的数据（市场体量、真实 Amazon 价格/FBA/评论、竞争结构）**主导**评分；广告经济派生数据（CPA / ACOS / ad_budget / ABA 集中度）以及冷门词 CVR 是 SellerSprite 最不可靠的输出，**只降低权重与置信度，绝不单独定生死**。
2. **几何聚合而非乘法绞杀**：机会核用**加权几何平均**聚合五大支柱。某个支柱接近零（如无利润）仍会强力拖低（这是对的），但数个中等支柱聚合后仍是中等，不再坍缩。
3. **区间决策而非单点切割**：引擎输出的不是一个分数，而是一个**置信区间 [悲观, 乐观]**。只有当**乐观估计都不及格**时才淘汰；稳健地越过推荐线才支持推荐；中间区间浮现给熔炉业务裁决，不因不确定就静默淘汰。`WATCHLIST` 只保留给有正期权价值、但关键假设未闭合的方向。
4. **卖家优势参数化**：把卖家的核心结构性优势（Listing 场景代入能力）作为一个**显式数学杠杆**注入，而非靠提示词空喊。
5. **始终偏向"浮现给人工"而非"静默淘汰"**：本系统是**高置信度参考**，不是最终决策者。

---

## 1. 引擎总览

```
Layer 0  硬门否决        → 触发即 FinalScore=0、强制 DROP（合规红线 / 负贡献利润 / 禁售）
Layer 1  字段标定        → 每个原始字段 → 子分 s∈[0,1]，并附信任权重 w∈[0,1]
Layer 2  机会核聚合      → Opportunity = WeightedGeoMean(五支柱) × 合规软降权
Layer 3  Listing 杠杆    → 差异化支柱按 代入感弹性 × 卖家技能 增益
Layer 4  区间决策        → 点估计 P ± 不确定带 U，按 [P-U, P+U] 三段裁决
```

四个对外兼容分数（`OpportunityScore / DataReliabilityScore / ExecutionFitScore / FinalScore`）
仍然写入 scored，供论坛报告与旧读取器使用；FinalScore 即区间点估计 `point_estimate`。

> **口径清理（2026-06）**：后端**不再输出** v2 全乘法链机会分（旧 `backend_math_validation_v2.opportunity_score = potentialScore × M_profit × M_competition × M_compliance`）。后端机会判断的**唯一口径**是 v3 几何平均 `point_estimate`（写在 `backend_math_scoring.v3_interval_decision`）。scored 里同时保留熔炉 `scored_candidate_pack` 的业务四分（另一角度，多一层业务判断），两套分数分口径并列、各自标注，互不覆盖。已废弃的 v2 乘数（competition/compliance/confidence/execution）不再写入 scored，仅保留 v3 profit 支柱实际消费的 `profit` / `profit_effective`。
> **解析防御（2026-06）**：后端计算前会剥离自己上一次写入的 `action` / `total_score` / `backend_math_*` / `warnings` 注解，避免二次计算读到旧数学块。所有评分字段先进入 `buildCanonicalScoringInput()` 规范化适配层，再进入 v3 支柱计算。熔炉 `score_inputs` 支持两种历史量纲：分数字段 `0-100` 或 `0-1`（如 `0.80` 自动视作 `80`）；严重度字段 `competition_severity` / `compliance_risk` / `complexity_severity` 支持 `0-10`、`0-1` 与旧百分制样式（如 `35` 自动视作 `3.5/10`）。发生量纲修正时，后端会在 `backend_math_scoring.input_normalization` 中写入审计说明。

---

## 2. Layer 1 — 五支柱与信任权重

每个支柱归一化到 `[0,1]`，并携带一个**输入信任度** `trust`（衡量该支柱底层字段的可靠程度）：

| 支柱 | 含义 | 默认权重 | 默认信任 | config 键 |
|------|------|---------|---------|-----------|
| demand | 需求/增长/进入窗口的复合 | 0.25 | 0.90 | `APS_SCORE_W_DEMAND` / `_TRUST_DEMAND` |
| competition | 竞争余地（severity 越低越高） | 0.20 | 0.85 | `APS_SCORE_W_COMPETITION` / `_TRUST_COMPETITION` |
| profit | 经净化的单位经济性 | 0.25 | 0.55 | `APS_SCORE_W_PROFIT` / `_TRUST_PROFIT` |
| differentiation | 差异化 + Listing 杠杆 | 0.18 | 0.70 | `APS_SCORE_W_DIFFERENTIATION` / `_TRUST_DIFFERENTIATION` |
| execution | 小卖家执行适配 | 0.12 | 0.75 | `APS_SCORE_W_EXECUTION` / `_TRUST_EXECUTION` |

支柱构造：

```
demand_pillar        = 0.45*demand + 0.30*growth + 0.25*market_entry      （各先归一到 /100）
competition_pillar   = 1 - (competition_severity/10) * 0.85
profit_pillar        = unit_contribution<=0 ? floor : clamp(M_profit_effective / 1.2)
differentiation_pillar = applyListingLeverage(differentiation/100, listing_leverage)
execution_pillar     = execution_fit_score / 100
```

> **信任度低的支柱（profit=0.55）并不直接扣分**——它的作用是在 Layer 4 把整体置信度拉低、
> 从而**加宽不确定带**。失真 ≠ 证明差，这是 v3 与 v2 最本质的区别。

---

## 3. Layer 1 附 — 单位经济性与失真净化（继承自 v2，仍是 profit 支柱的输入）

### 3.1 贡献利润
```
unit_contribution = selling_price - referral_fee - bom_cost - shipping_cost
                    - fba_fee - packaging_cost - return_reserve - coupon_cost - storage_reserve
```
缺失字段按保守默认补齐（如 bom 25%、fba max(18%, $3)），并写入 `missing_critical_fields`。

字段性质分层：
- `selling_price` / `fba_fee` / `click_conversion_rate` / `ppc_bid` 属于插件链路可抓或应交付的关键字段，缺失会进入关键缺失与数据置信扣分。
- `bom_cost` 若无真实询价，可由鹰眼/熔炉按材料、套装、重量、工艺给 `bom_estimate_per_set_usd` 区间或中位估算；它是人工验证项，不是 ProductSelector 抓取失败。
- USPTO/专利排雷、真人打样、Seller Central 最终 FBA 实测属于人工验证项，只能进入风险、Kill Criteria 与下一步验证，不应作为插件层硬门或单独把执行支柱打死。

`score_inputs` 的规范量纲：
- `demand_score`、`growth_score`、`differentiation_score`、`market_entry_score`、`data_reliability_score`、`execution_fit_score`：`0-100`。
- `competition_severity`、`compliance_risk`、`complexity_severity`：`0-10`，越高越危险/越难。
- `listing_leverage_score`：`0-1`。

后端兼容历史输出，但新 scored 应优先按上面量纲写入，避免让“0.8 是 0.8 分还是 80 分”这类歧义进入业务解释层。

### 3.2 CVR 保守修正
```
默认（小卖家/新品）：base_cvr = min(raw*0.50, 0.08)，stress_cvr = min(raw*0.35, 0.06)
成熟证据 mature_cvr_evidence:true：base = min(raw*0.65, 0.12)，stress = min(raw*0.45, 0.08)
```

### 3.3 自然流量混合（关键反误杀机制）
CPA 是**付费订单**成本，但销量是付费+自然/复购的混合。对每单收全额 CPA 会高估广告成本、误杀利基：
```
paid_traffic_ratio = raw 显式值 (0,1]，默认 0.6
blended_cpa  = cpa * paid_traffic_ratio
ad_ratio     = blended_cpa / unit_contribution
```

**非对称证据规则**：保守默认（0.6）免费，但**调低** `paid_traffic_ratio` 是乐观动作（摊薄广告成本，足以把倒挂洗成健康）。仅当 `paid_traffic_ratio_basis: anchor_reverse_verified` 且 `source_asins` 列出**≥2 个互不相同、都标 `comparable`** 的真同类标杆反查证据（不能只用想被推翻的争议 Top1 一个）时，后端才接受低于默认的值；否则**钳回 0.6** 并记失真信号。数值可写成扁平 `paid_traffic_ratio` 或嵌套 `paid_traffic_ratio_basis.value`，后端两种形状都读，单锚或缺证据一律钳回。多个口径的 `base_ad_ratio` 并存时取**最保守值**，极差 >2x 记失真信号。

### 3.4 广告经济权重压缩
广告派生字段最不可信，故 `M_profit` 经压缩后只能削掉有限机会分：
```
AD_ECONOMICS_WEIGHT = 0.35
unit_contribution<=0 → M_profit_effective = 0.05   （交给硬门）
M_profit<=1          → 1 - 0.35*(1 - M_profit)
M_profit>1           → 1 + 0.35*(M_profit - 1)
```

### 3.5 失真安全网（命中即 `data_distortion_suspected=true`，`DataReliability -= 12`）
**数值异常**：
- 成本字段 / `ppc_bid` / `cpa` > 售价 → 回退保守默认 + 记号
- 提供的 `click_conversion_rate` > 40% 或 < 0.2% → 记号
- `acos` > 150% → 记号

**内部逻辑自相矛盾**（推导链自证伪，即便数字都在合理区间）：
- `self_consistency_check.passed: false`
- `comparable_anchors` 中存在 `not_comparable` 标杆却被当作经济性基准
- 无 `anchor_reverse_verified` 证据、或证据不足 ≥2 个可比标杆，却下调 `paid_traffic_ratio`（已被 3.3 钳回）
- 多口径 `base_ad_ratio` 极差 > 2x

失真信号不裁决，只加宽 Layer 4 的不确定带；但 `RECOMMEND + 失真` 会在预算内 `LOOPBACK_TO_HAWKEYE` 补一次干净/可比证据再重评（见 6.2）。其中“广告洗白”这一子类（钳回 `paid_traffic_ratio` 或可比性矛盾）一旦无法再回环治愈（预算耗尽或已进强制裁决），终局**降档为 WATCHLIST 发布**，而不是按 RECOMMEND 发——运动员/裁判分离的最后一道闸。

---

## 4. Layer 2 — 加权几何平均机会核

```
Opportunity_core = ( Π pillarᵢ^(wᵢ/Σw) ) × compliance_mult
compliance_mult  = clamp( max(compliance_mult_floor, 1 - (compliance_risk/10)*0.6) )
pillar 下限 floor = APS_SCORE_PILLAR_FLOOR（默认 0.05，避免 log(0)）
```

几何平均的数学性质恰好对症：
- 任一支柱趋零 → 整体趋零（一个致命缺陷足以否决，符合直觉）；
- 多个中等支柱（0.6）→ 聚合仍约 0.6，**不再坍缩**（修复"打回太多"）。

合规作为**软降权**（>=9 的红线已由 Layer 0 硬门接管），不参与几何平均，避免双重惩罚。

---

## 5. Layer 3 — Listing 场景代入杠杆（卖家核心优势的数学化）

卖家的结构性优势是 **Listing 呈现能力**（主图、A+、场景代入）显著强于同档竞品。但该优势的价值
**高度依赖品类**：购买决策由"场景/情绪/呈现"驱动的产品（摆件、玩具、礼品、家居氛围）能充分放大它；
购买由"规格/功能"驱动的产品（锤子、扳手、线缆、替换件）则几乎用不上。

引擎用两个量刻画：
- `listing_leverage` (L) ∈[0,1]：**品类的代入感弹性**。由熔炉依据评论主题判定并写入
  `listing_leverage_score`（评论偏"好看/送礼/氛围"→高；偏"能用/结实/功能"→低）；缺省取
  `APS_SCORE_LISTING_LEVERAGE_DEFAULT`。
- `seller_listing_skill` (σ)：卖家固定结构性优势强度，`APS_SCORE_SELLER_LISTING_SKILL`（默认 0.8）。

差异化支柱获得增益：
```
diff_effective = clamp( diff_base + L · σ · (1 - diff_base) · gain )
gain = APS_SCORE_LISTING_LEVERAGE_GAIN（默认 0.5）
```

语义：在感性产品（L≈1）上，卖家的 Listing 功力把可达差异化显著抬升；在纯功能件（L≈0）上增益归零。
这把"我的 Listing 比对手强"从一句口号变成了**只在正确品类上兑现的数学杠杆**。

---

## 6. Layer 4 — 区间决策（根治"打回太多 + 触顶强出"）

### 6.1 不确定带
```
overall_trust   = clamp( 0.5*pillar_trust + 0.5*(DataReliability/100) ) × (失真?0.85:1)
point_estimate  = 100 × Opportunity_core
U (band)        = uncertainty_min + (uncertainty_max - uncertainty_min) × (1 - overall_trust)
optimistic      = clamp(point + U)
pessimistic     = clamp(point - U)
```
信任越低，带越宽（默认 5 ~ 22）。证据越扎实，区间越收紧、越接近点估计。

### 6.2 三段裁决（`decideBackendAction`，仅当原动作为 PUBLISH_FINAL 时接管）

执行顺序：

1. **硬门触发** → `DROP_AND_RESELECT`（永远，无视预算与数据质量）。
2. **失真数据**：RECOMMEND+失真 → 预算内 `LOOPBACK_TO_HAWKEYE`（重抓一次干净/可比数据）；无法再回环时（预算耗尽或强制裁决），普通数值失真按谨慎结果终态发布，而“广告洗白”子类（钳回 `paid_traffic_ratio`／可比性矛盾）终态**降档为 WATCHLIST 发布**；
   已是 WATCHLIST/RESEARCH_GAP/DATA_INSUFFICIENT/REJECT → 维持发布。
3. **区间裁决（核心）**：
   ```
   optimistic  <  drop_ceiling (默认42)  → 连乐观都不及格 → DROP（预算内）/ 终态发布（预算耗尽）
                                            若熔炉已选 WATCHLIST 等终态裁决则维持发布
   pessimistic >= recommend_floor (默认62) → 稳健强势 → 维持熔炉裁决（RECOMMEND 成立）
   其余                                    → PUBLISH_FINAL，由熔炉 verdict 决定推荐/待观察；不静默淘汰
   ```

> **这就是机制核心**：后端数学负责防误杀与硬门审计，不替代熔炉业务裁决。
> 淘汰需要"连乐观估计都失败"或触发硬门；推荐/待观察的业务结论以熔炉 `verdict` 为准。
> `RECOMMEND` 表示“值得进入人工验证/立项验证”，不是“已经完成 BOM/专利/打样/FBA 实测”。
> `WATCHLIST` 表示“有正期权价值但关键假设未闭合”，不是“不能推荐就先放着”。
> 注意：后端只返回动作 `PUBLISH_FINAL`，不会重写熔炉 YAML 里的 `verdict` 文本；最终发帖阶段应尊重熔炉 verdict，并把人工验证项写为下一步计划，而不是推荐降级理由。

### 6.3 推荐强度（`recommendation_tier`）

底层流程仍只看三态 `verdict`，推荐强度用于标题、日记和人工动作优先级：

| 条件 | verdict | tier label | 中文展示 |
|------|---------|------------|----------|
| `FinalScore 65-74` | `RECOMMEND` | `CAN_TRY` | 可以尝试 |
| `FinalScore 75-84` | `RECOMMEND` | `RECOMMEND` | 推荐 |
| `FinalScore >=85` | `RECOMMEND` | `STRONG_RECOMMEND` | 强烈推荐 |
| `FinalScore >=85` 且后端棱镜 `point_estimate >=75` | `RECOMMEND` | `TOP_RECOMMEND` | 极力推荐 |

后端数学分只参与 `TOP_RECOMMEND` 加签和安全阀，不替代熔炉业务裁决。

---

## 7. Layer 0 — 硬门（Hard Gate）

`hard_gate_triggered` = 内容含 `hard_gates.passed: false` / 非空 `triggered_gates`
/ `compliance_risk >= 9` / **负或零贡献利润**。命中即 `FinalScore=0` 且 `DROP_AND_RESELECT`，与数据质量、预算无关。

---

## 8. 跨方向重选预算（防无限循环）

`MAX_RESELECT_PER_TRIGGER = 4`。每次 DROP_AND_RESELECT 把 `reselect_count` +1 并**持久化**注入新 brief
计数器块，随 run_id 变化与进程重启不丢失：

- `decideBackendAction` 读到 `reselect_count >= 4` 时，所有本应 DROP 的分支改为终态 `PUBLISH_FINAL`，使闭环收敛、driver 自终止。
- DROP 分支自身：超预算时写 `failure_type: reselect_budget_exhausted` 的 failed 文件收尾。
- 结构兜底：driver 的 `create_brief` 在单 trigger 内超 `MAX_RESELECT_PER_TRIGGER` 次即停；`failedDelegationAttempts` / `scoredDelegationAttempts` 各 3 次后强制归档。

> 配合鹰眼的**多方向廉价预筛**（横向 Level-1 体检所有候选、只深挖最优 1 个），换方向的成本从
> "重跑完整链路"降为"体检阶段淘汰"，重选预算极少被真正触及。

---

## 9. 与三个 Agent 的关系

- **枢纽（coordinator）**：一个 brief 给 2-3 个并列候选方向，供鹰眼横向预筛；按时间窗读记忆（[淘汰] 近一月，[经验] 永久）。
- **鹰眼（scout）**：先廉价横向体检写 `prescreen_log`，只深挖最优方向；输出 `scene_vs_function_signal` 供熔炉判定杠杆；失真数据写 `unfetchable_gaps`/记号，绝不脑补。
- **熔炉（reviewer）**：先 Hard Gates 再评分，输出 `listing_leverage_score` 与 `recommendation_tier`；负责最终业务裁决，把机会分成 RECOMMEND（推荐进入人工验证/立项验证）、WATCHLIST（有正期权价值但待补关键证据）和少量阻断。BOM 询价、USPTO/专利排雷、真人打样、Seller Central 最终实测未完成时，写入验证计划和升级/淘汰条件，不作为插件层推荐硬阻断。
- **后端（本引擎）**：在 scored 写入时与 `apply_reviewer_decision` 时各跑一次，以区间决策与预算守卫做数学审计、防误杀和硬门兜底，不替代熔炉业务裁决。

---

## 10. 调参入口（全部 config.env，无需改代码）

| 目的 | config 键 | 默认 |
|------|-----------|------|
| 卖家 Listing 优势强度 σ | `APS_SCORE_SELLER_LISTING_SKILL` | 0.8 |
| 默认代入感弹性 L | `APS_SCORE_LISTING_LEVERAGE_DEFAULT` | 0.5 |
| Listing 杠杆增益 | `APS_SCORE_LISTING_LEVERAGE_GAIN` | 0.5 |
| 五支柱权重 | `APS_SCORE_W_*` | 0.25/0.20/0.25/0.18/0.12 |
| 五支柱信任度 | `APS_SCORE_TRUST_*` | 0.90/0.85/0.55/0.70/0.75 |
| 推荐线（悲观≥） | `APS_SCORE_RECOMMEND_FLOOR` | 62 |
| 淘汰线（乐观<） | `APS_SCORE_DROP_CEILING` | 42 |
| 不确定带下限/上限 | `APS_SCORE_UNCERTAINTY_MIN` / `_MAX` | 5 / 22 |
| 支柱几何下限 | `APS_SCORE_PILLAR_FLOOR` | 0.05 |
| 合规软降权下限 | `APS_SCORE_COMPLIANCE_MULT_FLOOR` | 0.55 |
| 跨方向重选上限 | `MAX_RESELECT_PER_TRIGGER`（代码常量） | 4 |
| 广告经济权重 | `AD_ECONOMICS_WEIGHT`（代码常量） | 0.35 |

> 调参直觉：嫌选出来太多 → 调高 `RECOMMEND_FLOOR` / `DROP_CEILING`；嫌打回太多 → 调低 `DROP_CEILING`
> 或调高 profit 之外支柱权重；想让 Listing 优势更显著 → 调高 `LISTING_LEVERAGE_GAIN` 与 `W_DIFFERENTIATION`。

---

## 11. 验证

- `test_v3_scoring.js`：纯数学回归，覆盖平庸→浮现不淘汰、感性杠杆抬分、强势→推荐成立、硬门→淘汰、失真→回环不误杀、负利润→硬门、百分号 CVR 解析、0-1 `score_inputs` 兼容、旧 backend 数学块剥离、淘汰/待观察关键词提取。
- `test_math_scoring.js`：文件状态机链路回归（写 raw/scored、apply_reviewer_decision、回环守卫、硬门覆盖）。
