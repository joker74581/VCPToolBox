# 自动选品评分算法说明（SCORING_MODEL）

> 本文件描述 `AutoProductSelection.js` 后端数学安全阀（`calculateScoringModel` +
> `decideBackendAction`）的完整评分逻辑，方便查阅与调参。代码是准则，本文档是说明；
> 若两者冲突，以代码为准。最后更新：2026-06。

## 0. 设计哲学

这套系统是**高置信度参考**，不是最终决策者。数据源（SellerSprite / Amazon 抓取）
真实性不可控，尤其是冷门词的广告派生数据失真严重。因此：

- 相对可信的数据（市场体量、转化率、竞争结构、真实 Amazon 价格/FBA/评论）**主导**评分。
- 广告经济派生数据（CPA / ACOS / ad_budget / ABA 集中度）**低权重**，只降置信度、不当硬性淘汰依据。
- 偏向"浮现给人工验证"，而不是"静默淘汰"。中分产品发出来让真人判断。
- 只有真实硬红线（负毛利、合规/侵权、负贡献利润）才硬性淘汰。

## 1. 四个分数

```
PotentialScore     = 0.30*demand + 0.20*growth + 0.25*differentiation + 0.25*market_entry
OpportunityScore   = clamp( PotentialScore * M_profit_effective * M_competition * M_compliance )
DataReliability    = 0.20*source + 0.15*freshness + 0.20*coverage + 0.20*consistency
                     + 0.15*completeness + 0.10*outlier_control   （缺省 55，缺字段每个 -6，失真 -12）
ExecutionFit       = 显式值，或 100 - complexity_severity*8
FinalScore (total) = clamp( OpportunityScore * M_confidence * M_execution_fit )
                     硬门触发时 FinalScore = 0
```

输入字段优先级：显式 `*_score` > 旧兼容字段（`demand_volume*4` 等）> 默认 50/55。

## 2. 广告经济：低权重 + 自然流量混合（改动二核心）

### 2.1 CVR 保守修正
SellerSprite `click_conversion_rate` 是行业平均，对新品保守修正：
- 默认：`base_cvr = min(raw*0.50, 0.08)`，`stress_cvr = min(raw*0.35, 0.06)`
- 成熟证据（`mature_cvr_evidence: true`）：`base = min(raw*0.65, 0.12)`，`stress = min(raw*0.45, 0.08)`

### 2.2 自然流量混合（关键）
CPA 是**付费订单**的成本，但 listing 销量是付费+自然/复购的混合。对每一单都收全额
CPA 会高估广告成本、误杀利基产品。因此：

```
paid_traffic_ratio  = raw 显式值 (0,1]，默认 0.6
blended_base_cpa    = base_cpa  * paid_traffic_ratio
blended_stress_cpa  = stress_cpa * paid_traffic_ratio
base_ad_ratio       = blended_base_cpa  / unit_contribution
stress_ad_ratio     = blended_stress_cpa / unit_contribution
```

### 2.3 广告压力 → 低权重乘数（不再砸到 0.05）
原始 `M_profit` 按 `base_ad_ratio` 平滑取值（1.20 ~ 0.45），再按低毛利率/低贡献利润各 *0.80。
然后**压缩**为有效乘数，使广告最多只削掉约 35% 机会分：

```
AD_ECONOMICS_WEIGHT = 0.35
若 unit_contribution <= 0:  M_profit_effective = 0.05   （留给硬门）
若 M_profit <= 1:           M_profit_effective = 1 - 0.35*(1 - M_profit)   （下限约 0.65）
若 M_profit > 1:            M_profit_effective = 1 + 0.35*(M_profit - 1)   （上限小幅加成）
```

OpportunityScore 用 `M_profit_effective`，不用原始 `M_profit`。

### 2.4 广告压力测试（软信号）
`ad_stress_test_failed = stress_ad_ratio > 1.8 || base_ad_ratio > 1.5`
仅写入 warnings 与降权参考，**不**触发淘汰，也**不**单独拯救弱产品。

## 3. 竞争与合规乘数

```
M_competition: severity<=2 →1.10；2-5 →1.0~0.80；5-8 →0.80~0.40；8-10 →0.40~0.10
M_compliance:  risk<=2 →1.0；2-5 →1.0~0.70；5-8 →0.70~0.20；>8 →0.05
```

## 4. 置信度 / 执行适配乘数（改动二：中上分段不再重复扣分）

```
M_confidence / M_execution_fit （同曲线）:
  score >= 75  → 1.00      （足够好，不再惩罚）
  65 - 75      → 0.92 ~ 1.00
  50 - 65      → 0.75 ~ 0.92
  35 - 50      → 0.55 ~ 0.75
  < 35         → 0.45
```

旧曲线在 70-85 仍 ×0.9，会重复扣分；新曲线让"数据足够好"的产品不被二次惩罚。

## 5. 数据失真安全网

把失真数据当作**置信度问题**而非裁决依据。命中任一即 `data_distortion_suspected=true`，
`DataReliability -= 12`：

- 成本字段（bom/fba/shipping）> 售价 → 回退保守默认 + 记号
- `ppc_bid` > 售价 → 回退保守默认
- 提供的 `click_conversion_rate` > 40% 或 < 0.2% → 记号（只降置信度，不改 CVR 之外逻辑）
- `cpa` > 售价 → 记号
- `acos` > 150% → 记号

## 6. 硬门（Hard Gate，FinalScore 强制 0 → DROP）

`hard_gate_triggered` = 内容含 `hard_gates.passed: false` / 非空 `triggered_gates`
/ `compliance_risk >= 9` / **负或零贡献利润**。命中即 `DROP_AND_RESELECT`，与数据质量无关。

## 7. 后端动作决策（decideBackendAction）

仅当原始动作是 `PUBLISH_FINAL` 时才接管；否则原样返回（LOOPBACK/DROP 由熔炉决定）。

顺序：
1. **硬门触发** → `DROP_AND_RESELECT`（永远，无视预算）。
2. **失真数据**：
   - RECOMMEND + 失真 → `LOOPBACK_TO_HAWKEYE`（重抓一次干净数据）；预算耗尽则终态发布。
   - WATCHLIST/RESEARCH_GAP/DATA_INSUFFICIENT/REJECT + 失真 → 维持发布。
   - 无明确 verdict + 失真 → 同 RECOMMEND。
3. **分数分段**（核心）：
   - `score >= 75` → 维持原动作发布（强）。
   - `50 <= score < 75` → `PUBLISH_FINAL`（中分：作为 WATCHLIST 浮现给人工验证，**不淘汰**）。
   - `score < 50`：
     - 若熔炉已是 WATCHLIST/RESEARCH_GAP/DATA_INSUFFICIENT → 维持发布。
     - 否则 → `DROP_AND_RESELECT`（预算内）/ 终态发布（预算耗尽）。

## 8. 跨方向重选预算（改动一：防无限循环）

`MAX_RESELECT_PER_TRIGGER = 4`。每次 DROP_AND_RESELECT 把 `reselect_count` +1 并**持久化**
注入新 brief 的计数器块（`injectLoopbackCounters`），随 run_id 变化与进程重启不丢失。

- `decideBackendAction` 读到 `reselect_count >= 4` 时，所有本应 DROP 的分支改为终态 `PUBLISH_FINAL`，
  让闭环能收敛、driver 自终止。
- DROP 分支自身：`reselect_count + 1 > MAX` 时写 `failure_type: reselect_budget_exhausted` 的
  failed 文件并收尾，不再派发新 scout。
- 结构兜底：driver 的 `create_brief` 在一个 trigger 内超过 `MAX_RESELECT_PER_TRIGGER` 次即
  `stopWorkflowDriver`。`failedDelegationAttempts` / `scoredDelegationAttempts` 各自 3 次后强制归档。

## 9. 与三个 Agent 的关系

- 鹰眼（scout）：抓 Min Evidence Pack，写 raw。失真数据写入 `unfetchable_gaps`/记号，不硬编造。
- 熔炉（reviewer）：先 Hard Gates 再四分，写 scored。回环受守卫限制。
- 后端（本算法）：在 scored 写入时与 `apply_reviewer_decision` 时各跑一次，覆盖/校正动作，
  把数学安全阀与预算守卫强加在 Agent 判断之上。

## 10. 调参入口（常用）

| 目的 | 变量 | 当前值 |
|------|------|--------|
| 跨方向重选上限 | `MAX_RESELECT_PER_TRIGGER` | 4 |
| 广告经济权重 | `AD_ECONOMICS_WEIGHT` | 0.35 |
| 自然流量默认占比 | `paidTrafficRatio` 默认 | 0.6 |
| 广告压力阈值 | `adStressTestFailed` | stress>1.8 / base>1.5 |
| 发布门槛（强） | decideBackendAction `score >= 75` | 75 |
| 浮现门槛（中分发布） | decideBackendAction `score >= 50` | 50 |
| 委托重试上限 | `MAX_FAILED_DELEGATIONS` | 3 |
