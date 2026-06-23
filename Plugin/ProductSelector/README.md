# ProductSelector 开发说明

这个目录记录 `Plugin/ProductSelector` 的当前状态、调用规则和下一步开发方向。后续新对话要继续开发时，先读这里，再读 `TVStxt/ProductSelectorToolBox.txt` 和 `plugin-manifest.json`。

## 1. 当前功能

`ProductSelector` 现在有七套主流程：

1. 选产品
2. 查竞品
3. 关键词选品
4. 关键词转化率
5. 关键词反查 (竞争对手关键词反查)
6. Amazon 商品页信息抓取
7. Amazon 评论抓取

实际支持的命令以 `Plugin/ProductSelector/plugin-manifest.json` 为准，核心命令如下：

- `get_status`
- `login_sellersprite`
- `build_sellersprite_url`
- `run_sellersprite_research`
- `build_sellersprite_competitor_url`
- `run_sellersprite_competitor_lookup`
- `build_sellersprite_keyword_url`
- `run_sellersprite_keyword_research`
- `build_sellersprite_keyword_reverse_url`
- `run_sellersprite_keyword_reverse`
- `build_sellersprite_keyword_conversion_rate_url`
- `run_sellersprite_keyword_conversion_rate`
- `build_amazon_product_url`
- `fetch_amazon_product_info`
- `build_amazon_reviews_url`
- `fetch_amazon_reviews`

## 2. 当前状态

### 选产品 与 查竞品

作用：

- 打开 SellerSprite `product-research` (选产品) 或 `competitor-lookup` (查竞品) 页面。
- 根据筛选条件或竞品 ASIN 返回商品候选，输出合并 ASIN 表。
- 供 Agent 深入分析 ASIN、价格、销量、评论、利润等。

当前约束与数据口径定义：

- `keywords` 是核心筛选字段（查竞品时可用 `asin`、`brand`、`seller` 代替）。
- 默认 `selectType=3`，`size=20`（只允许 `20 / 60 / 100`）。
- 用户无明确要求时，不要自动添加过滤限制（如价格、销量、评论等）。
- 精准细分类目优先从 `search_sellersprite_categories` 检索，然后传入完整 `nodeIdPaths`。
- 默认通过 `summary_markdown` 返回一张合并 ASIN 表。
- **输出合并表列口径与指标定义**：
  - **商品信息**:
    - 产品标题、子 ASIN、父 ASIN、品牌名（从上往下排列）。
    - 包含图片旁的特权/资质标识：
      - `[A+]`: Listing 包含 A+ 富文本图文介绍。
      - `[V]`: Listing 包含视频介绍 (Video)。
      - `[BS]`: Listing 为某细分类目的 Best Seller。
      - `[AC]`: Listing 拥有 Amazon's Choice 推荐标识。
      - `[NR]`: Listing 拥有 New Release 新品榜标识。
  - **大类BSR**:
    - 第一行：大类 BSR 排名。若为最近 30 天口径，则显示最近 1 天在 Amazon Listing 页面的 Best Sellers Rank 排名；若为历史月份，则显示该月月末那一天的排名。
    - 第二行 (增)：近 7 天 BSR 排名增长数（7天前的 BSR - 当天 BSR）。绿色/正数代表排名上升，红色/负数代表排名下降。
    - 第三行 (率)：近 7 天 BSR 排名增长率（(7天前BSR - 当天BSR) / 7天前BSR * 100%）。
  - **父销量 / 增长率**:
    - *父销量*: 基于该父体 Listing 下所有变体/跟卖的近 30 天（或特定月份）预估总销量。
    - *增长率*: 父销量环比增长的百分比。
  - **销售额**: 该产品父体近 30 天（或特定月份）总销售额。`近30天销售额 = 父体销量 * 当前子体售价`；`历史月度销售额 = 父体月销量 * 子体月度均价`。
  - **子销量 / 销售额**:
    - *子销量*: 该子体 ASIN 的近 30 天（或特定月份）预估销量。来源于亚马逊前台搜索页（如 “4K+ bought in past month” 等）。显示为 `-` 表示搜索页未开放该子体销量。
    - *销售额*: 该子体 ASIN 对应的预估销售额（`子体销量 * 平均售价`）。
  - **变体数**: 该 ASIN 所在 Listing 的变体总数量（如颜色和尺码组合数）。多变体产品与单一变体产品适用不同的运营及流量分配策略。
  - **价格 / Q&A**:
    - *价格*: 该子体 ASIN 的当前最新售价。
    - *Q&A*: 截止当前该 Listing 累积的历史问答数 (Q&A数)。
  - **评分数 / 新增**:
    - *评分数*: 该 Listing 的累积最新 Ratings (评分数)。
    - *新增*: 近 30 天（或特定月份内）新增的评分数（月底评分数 - 月初评分数）。
  - **评分 / 留评率**:
    - *评分*: Listing 的最新评分值（星级）。若选历史月份则显示对应月份的历史星级。
    - *留评率*: 近 30 天（或该自然月）评分数增长值 / 近 30 天（或该自然月）销量。常用于辅助推算 Listing 真实销量，或者排查是否存在留评作弊行为。
  - **FBA费 / 利润率**: 预估亚马逊物流配送费及扣除首程、采购及广告费用前的预估毛利率。
  - **上架 / 卖家数**:
    - *上架时间*: 取自 Keepa 系统初次抓取到该商品价格或 BSR 的时间。
    - *卖家数*: Listing 的 BuyBox 购物车下当前所有跟卖的卖家数量。
  - **卖家 / 属性**:
    - *BB (BuyBox 卖家)*: 当前获得 BuyBox 黄金购物车的卖家名称及所属国家/地区。
    - *LQS*: Listing 质量得分（Listing Quality Score），满分为 10 分。从图片、描述及评价三个维度综合评估其优化水平。
    - *属性 / 包装*: 商品实际入库重量、尺寸大小分段及含包装的总重量尺寸规格（决定 FBA 配送费的基准）。

### 关键词选品

作用：

- 打开 SellerSprite `keyword-research` 页面
- 返回关键词搜索量、购买量、增长、ABA、PPC 等指标

当前约束与数据口径定义：

- 使用 `includeKeywords` / `excludeKeywords`。
- 默认不要勾选“新细分市场 / 仅包含该市场”。
- 只有用户明确要求新兴市场时才传 `withYearlyGrowth=true`。
- 默认使用上一个完整月份。
- 优先抽表格，失败后再用页面文本兜底。
- **输出合并表列口径与指标定义**：
  - **月搜索量** (月搜)：指一个自然月，该关键词在亚马逊站内的搜索次数。搜索量一定要结合搜索趋势看才更客观，每月月初更新上个月的数据。
  - **日均搜索量** (日搜)：月搜索量分摊到每天的估算值。
  - **月购买量 / 购买率**:
    - *月购买量*: 指一个自然月，在亚马逊站内搜索该关键词后产生购买的次数。例：某用户搜索 iphone charger，然后一次购买了1个充电器和2条关联推荐商品（数据线），则购买量=1。购买量 = 搜索量 * 购买率。
    - *购买率*: 指在买家输入该搜索词并点击此细分市场中的任意商品后，买家的购买次数占买家输入该搜索词总次数的比例。反映关键词的精准度，越精准、决策周期越短的产品，购买率越高。
  - **展示量 / 点击量**:
    - *展示量*: 指一个自然月，在某个关键词搜索结果页中所有 ASIN 的总展示次数（非单个 ASIN 在关键词下的曝光量）。
    - *点击量*: 指一个自然月，在某个关键词搜索结果页中被点击的总次数（非单个 ASIN 在关键词下的点击量）。
  - **增长率**: 指本月搜索量相对于上月增长的百分比。如上月100万，本月120万，增长率 = (120万 - 100万) / 100万 = 20%。增长快可能是因为季节性、节日性、事件性，也可能是潜力爆款。
  - **同比增长 / 近3月增长**:
    - *同比增长*: 月搜索量同比增长值、增长率(括号内)。同比搜索量增长值 = (今年)当月搜索量 - (去年)该月搜索量。增长值越大表示该市场越有潜力，但要注意是否属于季节性词。
    - *近3月增长*: 取最近三个月每月的增长值和增长率，以最小增长值/增长率作为近3个月搜索量增长值/增长率。可用于发现近3个月飙升较快的关键词，寻找潜力市场。
  - **ABA集中度** (点击总占比 / 转化总占比)：来源于亚马逊后台的ABA数据报告。周时间范围取最近一周，历史月份取当月对应数据。
    - *点击总占比*: 指该关键词下点击排名前三 ASIN 的点击总占比之和。点击总占比越高，垄断程度越高。
    - *转化总占比*: 指该关键词下点击排名前三 ASIN 的转化共享（销量占整个词销量的比例）之和。
  - **ABA排名**: 关键词的月度 ABA 排名，来源于亚马逊 ABA 数据的月度关键词搜索频率排名（Search Frequency Rank，SFR），每月月初更新上个月数据。
  - **货流值**: 反映关键词的引流成本。计算规则：货流值 = 历史最高 PPC 竞价(短语匹配) / 点击排名前 3 的 ASIN 的商品价格中位数 * 100%。货流值越小，引流成本越低，竞争越小；也可能意味着该词延伸的细分市场还处于蓝海。
  - **PPC竞价**: 站内广告的建议竞价及范围（每周更新）。默认为【精准匹配】模式下的建议竞价，包含三个价格：推荐最低、平均、最高。反映市场竞争度和营销费用。
  - **需供比 / 商品数**:
    - *需供比*: 需供比 = 搜索量(需求) / 商品数(供应)，需供比值越高，代表市场需求越强劲。
    - *商品数*: 指搜索该关键词后出现了多少相关产品 (All Departments类目)。
  - **市场分析** (价格分布 / 评分数分布 / 评分值分布)：数据取自点击排名前 3 ASIN 的价格/评分数/评分值“中位数”。
    - *价格分布*: 判断哪个价格区间可能有机会 (价格差异化) 及哪个区间竞争最激烈。
    - *评分数分布*: 说明打造新品的难度，中低评分数占比大说明新品进入壁垒不高。
    - *评分值分布*: 说明市场成熟度，4.5以上的商品多说明市场成熟，建立差异化壁垒难；3.5分多可能存在改进空间。
  - **SPR**: 卖家精灵推荐的排至搜索首页第一页所需的销售量指标。
  - **标题密度**: 搜索前页商品中包含完整关键词的商品比例。

### 关键词反查

作用：

- 打开 SellerSprite `keyword-reverse` 竞争对手关键词反查页面
- 输入 ASIN 反查出该产品的所有流量词、自然词、广告词，并获取其流量占比、排名等指标

当前约束与数据口径定义：

- 必须通过 `asin / q / asins` 参数传递竞品 ASIN
- 默认 `market=US` (marketId=1)
- 默认 `badges` 包含全部流量词类型，支持以下友好别名（支持数组或逗号分隔串形式）：
  - `"广告"` / `"广告词"` / `"投放"` -> 自动转换为 `SPONSOR_BRAND,SPONSOR_VIDEO,ADS` (SP广告 + 品牌广告 + 视频广告)
  - `"自然"` / `"自然搜索"` / `"自然搜索词"` -> 自动转换为 `NATURAL_SEARCHING,AMAZON_CHOICE,EDITORIAL_RECOMMENDATIONS,FOUR_STAR,HIGHLY_RATED`
  - 单项映射（如 `"sp"`/`"sp广告"` -> `ADS`；`"品牌"`/`"sb"` -> `SPONSOR_BRAND`；`"ac"` -> `AMAZON_CHOICE` 等）
- 默认在页面查找第一张大表（selector 默认为 `'body'`，获取 27 列高精度指标，提取失败时尝试兜底解析）
- **输出合并表列口径与指标定义**：
  - **关键词 / 流量类型**:
    - *关键词*: 该 ASIN 近 30 天或某个自然月进入过亚马逊搜索结果前 3 页的所有搜索流量词及其中文释义。
    - *流量类型*: 该 ASIN 流量词的主要类型（如自然搜索词、AC推荐词、ER推荐词、4星推荐词，以及SP广告词、视频广告词、品牌广告词、HR推荐词）。
  - **流量占比 / 周曝光 / 类别**:
    - *流量占比*: 产品通过不同流量词获得的曝光量占比（第一行）。
    - *周曝光*: 该关键词本周内给产品带来的预估曝光量，非该词在亚马逊的总搜索量（第二行）。
    - *类别*: 流量类别与转化效果。
      - 流量类别：
        - 美国站：主要流量词 (占比≥5%且自然排名在第一页前8位，或占比≥10%)；精准流量词 (周曝光量≥2000且自然排名在第一页前8位)；精准长尾词 (500≤周曝光量<2000且自然排名在第一页前8位)。
        - 其它站：主要流量词 (同上)；精准流量词 (周曝光量≥1000且第一页前8位)；精准长尾词 (200≤周曝光量<1000且第一页前8位)。
      - 转化效果：
        - 美国站：转化优质词 (ABA转化共享≥5%且周曝光量≥2000，或转化共享≥10%且周曝光量≥1000)；转化平稳词 (ABA近2周转化共享≥3%且周曝光量≥500)；转化流失词 (上周转化共享>0%，本周为0%，且50≤周曝光量<1000)；无效曝光词 (有点击记录，但没有转化)。
        - 其它站：转化优质词 (ABA转化共享≥5%且周曝光量≥1000，或转化共享≥10%且周曝光量≥500)；转化平稳词 (同上)；转化流失词 (上周有转化，本周无转化，且20≤周曝光量<500)；无效曝光词 (有点击记录，但没有转化)。
  - **自然 / 广告排名**:
    - *自然排名*: 该 ASIN 在此关键词下的自然搜索绝对排名、实际展现位置（如 `第2页, 5/25`）及最近一次获取排名时间。
    - *广告排名*: 该 ASIN 广告位在此关键词下的绝对排名、实际展现位置及最近一次获取排名时间。
  - **月搜 / 日搜 / ABA周**:
    - *月搜索量*: 关键词最近一个自然月搜索总次数（每月月初更新）。
    - *日均搜索量*: 月搜索量 / 30 天。
    - *ABA周排名*: 数据来源于亚马逊 ABA 数据的最新一周关键词搜索频率排名（Search Frequency Rank），数字越小表示排名越靠前。
  - **月购买 / 购买率**:
    - *月购买量*: 一个自然月内在亚马逊搜索该关键词后产生购买的次数（月购买量 = 月搜索量 * 购买率）。
    - *购买率*: 搜索点击该细分市场中商品后的购买次数占总搜索次数比例。反映词的精准度和用户决策速度。
  - **展示 / 点击**: 该关键词搜索结果页下所有 ASIN 的月度总展示次数和总点击次数。
  - **需供比 / 商品数**:
    - *需供比*: 搜索量(需求) / 商品数(供应)，比值越高代表需求越强劲。
    - *商品数*: 指搜索该关键词后出现的 All Departments 类目的相关产品总数。
  - **ABA点击 / 转化**: 该关键词下点击排名前三 ASIN 的点击总占比和转化总占比之和。
  - **PPC低 / 均 / 高**: 关键词建议竞价（精准匹配）的最低价、平均价和最高价。
  - **SPR / 密度 / 广告竞品**:
    - *SPR*: 将产品维持在第一页的前 8 天预估销量要求。SPR 数值越大，首页竞争越激烈。
    - *标题密度*: 搜索结果第一页产品标题包含该关键词的产品数量。
    - *广告竞品数*: 近 7 天内进入过该关键词前 3 页的广告产品总数（包含 SP/HR/品牌/视频广告）。

### 关键词转化率

作用：

- 打开 SellerSprite `keyword-conversion-rate` 页面
- 输入最多 1000 个关键词，读取亚马逊商机探测器/ABA 的关键词行业平均搜索、点击、购买、点击转化率和广告利润模型指标
- 供 agent 结合 PPC、CPA、ACOS 与产品均价做广告预算、利润空间和关键词成交潜力判断

当前约束与数据口径定义：

- 必须传 `keywordList` 或 `keywords`
- 默认按“单词单查”执行；若一次传入多个关键词，插件默认会要求拆成多次调用。只有显式传 `allow_multi_keywords=true` 时才放行多词同查
- 默认 `marketId=1` (US)，`reverseType=W` (周口径)，也支持 `reverseType=90D`
- 默认 `bidMatchType=1` (PPC 精准)，支持 `1/2/3` 或 `精准/词组/广泛`
- `keywordMatchType` 默认 `all`
- 默认最多解析 50 条；如果输入单词会拓展出相关关键词，若商机探测器没有数据则返回空结果
- compact 结果只返回 `summary_markdown` 和 `metric_notes`；完整 `candidates` 仅在 `result_mode=debug/full` 时返回
- 关键词转化率是行业平均点击与购买行为参考值，不代表单一商品真实转化表现
- SellerSprite 对多个差异较大的关键词同查时，可能只显示部分词结果；自动选品应优先一词一查，再串行补查其它词
- **输出合并表列口径与指标定义**：
  - **关键词**: 该关键词及其中文释义（包含搜索词中任意一个词根的相关关键词）。
  - **搜索 / 点击 / 购买**:
    - *周搜索量*: 在指定的时间段内，买家在亚马逊上输入该词的总搜索次数（来源于商机探测器）。
    - *周点击量*: 买家搜索该词后点击商品的总次数。
    - *周购买量*: 买家搜索该词后，点击商品并完成购买的总次数。
  - **搜索转化 / 点击转化**:
    - *搜索转化率*: 周期内 `购买量 / 搜索量`。
    - *点击转化率*: 周期内 `购买量 / 点击量`。
  - **PPC / CPA (低/中/高)**:
    - *PPC 竞价*: 广告建议最低竞价、推荐平均价、推荐最高价（精准匹配模式）。
    - *CPA*: 每次行动成本（Cost Per Action），即平均每笔广告订单的推广成本。公式：`CPA ≈ PPC竞价 / 点击转化率`。分别取 PPC 竞价最小、中位、最大值换算得出。
  - **均价 / ACOS (低/中/高)**:
    - *均价*: 该关键词下自然排名前 48 名商品的平均售价（第一行和第三行分别为最低和最高价）。
    - *ACOS*: 广告投入产出比。公式：`ACOS ≈ CPA / 产品均价`。以 CPA 中位数分别除以产品均价的最低、中位、最高价换算得出。
  - **预算 / ABA集中度**:
    - *广告预算*: 为获取首个广告订单的建议预估广告预算。默认计算 80% 出单概率下的首单广告预算（公式：`预算 = 点击次数 * PPC`，通过二项分布和转化率换算）。
    - *ABA集中度*: 点击总占比（第一行，前3ASIN点击总占比）与转化总占比（第二行，前3ASIN销量占整个词销量的比例之和）。
  - **Top3点击ASIN份额**:
    - *Top3点击ASIN*: 周期内点击量最高的三个 ASIN 的点击份额与转化份额（格式：`第一位 ASIN 的点击份额 / 转化份额；第二位...`）。

### 查竞品

作用：

- 打开 SellerSprite `competitor-lookup` 页面
- 按 ASIN / Amazon 商品链接、关键词、品牌或卖家查看竞品基础数据
- 返回字段与“选产品”候选结果保持一致，便于 agent 继续做 ASIN、价格、销量、评论、利润等横向对比

当前约束：

- 至少传 `asin/asins/product_url`、`keywords`、`brand/includeBrands`、`seller/includeSellers` 之一
- 默认 `market=US`
- 默认 `monthName=bsr_sales_nearly`，即最近 30 天口径
- 默认不选择类目，`nodeIdPaths=[]`
- 默认 `size=60`
- 默认按 `amz_unit` 倒序
- 返回结果使用“选产品保留字段”，默认不额外保留标题、品牌、图片、详情链接
- 默认 compact 结果同样只返回 `summary_markdown` 合并表；完整 `candidates` 仅在 `result_mode=debug/full` 或 `include_candidates=true` 时返回

### Amazon 商品页信息抓取

作用：

- 根据 ASIN 构造 `https://www.amazon.com/dp/{ASIN}?th=1`
- 通过 ChromeBridge 打开真实浏览器页面
- 解析标题、评分、评分数、价格、基础信息表、五点描述、评分分布和商品页 top reviews

当前约束：

- `asin` 是核心字段，也可以传 Amazon 商品页 URL
- 默认 `market=US`
- 默认 `maxReviews=5`，最大 `50`
- 默认 compact 输出不包含完整页面内容、HTML 或浏览器命令负载；只有 `result_mode=debug/full` 或显式 `include_summary=true` 才返回调试/摘要负载
- 如果 Amazon 触发验证码或机器人检查，返回 `page_blocked=true` / `needs_manual_action=true`
- 如果当前页面 URL 不匹配目标 ASIN，返回 `page_mismatch=true`，不解析疑似旧页面

### Amazon 评论抓取

作用：

- 根据 ASIN 构造 `https://www.amazon.com/product-reviews/{ASIN}`
- 通过 ChromeBridge 打开真实浏览器页面，复用用户已经处理好的登录态
- 解析前校验当前页面 URL 是否匹配目标 ASIN，避免批量抓取时复用旧页面评论
- 优先从 `#cm_cr-review_list` / `li.review` / `div[data-hook="review"]` 的 DOM/HTML 抽取评论
- DOM 抽取失败后，回退到 ChromeBridge Markdown `page_info` 解析
- 默认只返回 agent 需要的干净结构化字段，避免完整页面文本、HTML 或重复摘要干扰分析

当前约束：

- `asin` 是核心字段，也可以传 Amazon 商品页或评论页 URL
- 默认 `market=US`
- 默认 `maxReviews=10`，最大 `50`
- 默认 compact 输出不包含完整页面内容、HTML、浏览器命令负载或 `summary_markdown`；只有 `result_mode=debug/full` 或显式 `include_summary=true` 才返回调试/摘要负载
- 每次实时抓取返回 `run_id`、`fetched_at`、`fresh_fetch=true`；默认每轮开始前清理上轮 ChromeBridge 打开的旧标签页，抓取完成后保留当前页便于调试；需要完成后也清理时可显式传 `cleanup_tabs_after=true`
- `average_rating` / `global_rating_count` / `total_review_count` / `rating_breakdown` 只从 Amazon 评论页汇总 DOM 定点提取；取不到保持 `null`，不从整页文本或首条评论推断
- `image_urls` 只保留真实 Customer image，过滤 pixel 占位图和默认头像
- 如果 Amazon 触发验证码或机器人检查，返回 `page_blocked=true` / `needs_manual_action=true`

## 3. 类目规则

类目是这次开发里最容易出错的点，所以统一规则如下：

- 泛方向/初筛产品选品默认可以不限定细分类目，保持全类目或顶层类目搜索。
- 当产品词是明确形态、关键词跨类目、全类目结果混杂，或用户要求限定品类时，先调用 `search_sellersprite_categories`。
- `search_sellersprite_categories` 只查本地索引，不打开浏览器；返回的 `nodeIdPath` 可直接传给 `run_sellersprite_research` / `build_sellersprite_url` 的 `nodeIdPaths`。
- 传入完整 `nodeIdPaths` 时必须保留全路径，例如 `1055398:1063236:1063238:1063246:13159327011`，不要退化成 `1055398`。
- `run_sellersprite_keyword_research` 不使用细分类目路径，仍只支持一级 `departments/categories`。
- 多个细分类目都合理时，可以分开尝试，但每次都要使用 `search_sellersprite_categories` 返回的合法路径。

## 4. 输出字段

### 选产品保留字段

当前候选结果重点保留：

- `asin`
- `category_bsr`
- `parent_sales`
- `parent_sales_growth_rate`
- `revenue`
- `child_sales`
- `child_revenue`
- `variations`
- `price`
- `qa_count`
- `review_count`
- `monthly_new_reviews`
- `rating`
- `review_rate`
- `fba_fee`
- `profit_margin`
- `putaway_date`
- `seller_count`
- `category_top`
- `category_path`
- `category_node_id_path`
- `category_top_node_id`

### 关键词选品保留字段

当前重点保留：

- `keyword`
- `translation`
- `monthly_searches`
- `daily_searches`
- `monthly_purchases`
- `purchase_rate`
- `impressions`
- `clicks`
- `growth_rate`
- `yearly_growth`
- `recent_3_month_growth`
- `aba_click_share`
- `aba_conversion_share`
- `aba_rank`
- `goods_value`
- `ppc_bid`
- `supply_demand_ratio`
- `products`
- `avg_price`
- `avg_reviews`
- `avg_rating`
- `category`
- `market_period`
- `spr`
- `title_density`
- `top_asins`

### 关键词反查保留字段

当前重点保留：

- `rank` (排名)
- `keyword` (关键词)
- `translation` (中文释义)
- `traffic_share` (流量占比)
- `traffic_count` (流量数)
- `traffic_type` (流量词类型)
- `organic_share` (自然流量占比)
- `ad_share` (广告流量占比)
- `organic_rank` (自然排名)
- `ad_rank` (广告排名)
- `aba_week_rank` (ABA周排名)
- `monthly_searches` (月搜索量)
- `daily_searches` (日均搜索量)
- `spr` (SPR)
- `title_density` (标题密度)
- `monthly_purchases` (月购买量)
- `purchase_rate` (购买率/转化率)
- `impressions` (展示量)
- `clicks` (点击量)
- `supply_demand_ratio` (需供比)
- `products` (商品数)
- `ad_competitors` (广告竞品数)
- `aba_click_share` (ABA集中度)
- `aba_conversion_share` (ABA转化集中度)
- `ppc_bid` (PPC低/中/高竞价)

### 关键词转化率保留字段

当前重点保留：

- `rank`
- `keyword`
- `translation`
- `period_searches`
- `period_clicks`
- `period_purchases`
- `search_conversion_rate`
- `click_conversion_rate`
- `ppc_bid` (low/mid/high)
- `cpa` (low/mid/high；Cost Per Action，每笔广告订单推广成本)
- `product_price` (low/avg/high)
- `acos` (max/avg/min)
- `ad_budget`
- `aba_concentration.click_share`
- `aba_concentration.conversion_share`
- `top_clicked_asins` (top3 图片/点击份额/转化份额；ASIN 本身不一定能从页面 HTML 直接获得)

### Amazon 评论保留字段

当前评论结果重点保留：

- `review_id`
- `rating`
- `title`
- `body`
- `author`
- `date`
- `region`
- `verified_purchase`
- `variant`
- `helpful_count`
- `rating_breakdown`
- `image_urls`

### Amazon 商品页保留字段

当前商品页结果重点保留：

- `asin`
- `title`
- `rating`
- `review_count`
- `price`
- `basic_info`
- `feature_bullets`
- `average_rating`
- `global_rating_count`
- `total_review_count`
- `rating_breakdown`
- `top_review_count`
- `reviews`

## 5. 调用方式

推荐的实际工作流：

1. 先读 `TVStxt/ProductSelectorToolBox.txt`
2. 再调用 `get_status`
3. 再决定走选产品还是关键词选品
4. 如果类目不确定，先按白名单挑最合理的顶层类目
5. 如果用户要更多结果，调整 `size`，但不要超过 `100`

## 6. 当前已知实现与运行规则

当前实现里还有几个行为是明确存在的：

- **自动登录与会话复用**：插件会自动登录或复用登录态。如果浏览器中已有活跃登录会话，即使未在 `config.env` 配置账号，也可正常复用。如果登录态失效或需要显式刷新，可通过 `login_sellersprite` 命令进行登录，并支持 `force_login: true`。
- **排序参数大小写不敏感**：卖家精灵后台对排序参数（`orderField`）大小写敏感（例如必须小写），但插件端和过滤器规范化层会自动将该参数值转换为小写（如 `searches`），避免抛出系统异常。
- **禁止自行拼接小类目**：类目库极其复杂，Agent 禁止在传参时计算或拼接细分类目（如 `departments[1]=xxx`），只需直接传递 `departments: ["sporting"]` 这种顶层类目参数即可，插件会自动按照正确格式索引和拼接。
- **亚马逊变狗检测 (page_dogged)**：针对商品或评论页 404（俗称“变狗”），解析模块有专门的检测（特征包含 `Page Not Found`、`Looking for something` 等）。检测到变狗时将返回 `success: false` 与 `page_dogged: true`。
- **SellerSprite 空结果口径**：等待结果页失败后会检查页面文本。若识别为“暂无结果”，返回 `success: true`、`no_results: true`、`empty_result: true`，并附 `empty_reason` 与 `next_actions`。这不是系统错误。
- **SellerSprite 登录回退**：若复用登录缓存后进入登录页，会失效登录缓存并强制重新登录一次；若仍是登录页，返回 `needs_login: true`。
- **SellerSprite 表格回退**：产品选品、查竞品、关键词选品、关键词反查会优先抽 DOM 表格；失败或字段不足时回退 Markdown/page_info。关键词转化率会在 DOM 表格失败后检查页面文本是否为空结果。
- **Amazon 错页保护**：商品页和评论页都会校验当前页面 URL 是否匹配目标 ASIN。Amazon `/error/500`、`/sorry`、登录页、验证码页、非目标 ASIN 页会按 `page_mismatch` 或 `page_blocked` 处理，不解析疑似旧页。
- **Amazon 页面回退**：商品页 DOM 解析失败会回退 Markdown page_info；评论页 DOM 抽取失败会回退 Markdown page_info，并单独尝试补采评分汇总 DOM。评论抓取失败时不能把商品页 top reviews 伪装成系统评论抓取。
- `get_status` 会回传支持类目白名单
- `page_info` 只应视为兜底或调试证据，不应作为正常结果主负载
- `result_mode=debug/full` 会返回更多调试内容

## 7. 下一步开发建议

下一步最值得拆出去的，是 Amazon 站内相关能力，尤其是评论提取。

建议把未来功能拆成独立模块或独立命令，而不是继续堆进选品手册：

- Amazon 评论采样
- ASIN 评论抓取
- Listing 详情解析
- 关键词反差分析
- 类目内竞品补充信息

这样可以避免一个文件越来越臃肿，也能让 agent 更容易稳定调用。

## 8. 给后续开发者的提醒

- 代码是准则，手册是约束，不要反过来。
- 任何新功能都尽量先明确输入、输出、异常和调试开关。
- 如果一个功能会长期演进，优先拆文档，不要继续把系统提示词撑大。
