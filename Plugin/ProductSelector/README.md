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

### 选产品

作用：

- 打开 SellerSprite `product-research` 页面
- 根据关键词返回产品候选
- 供 agent 继续分析 ASIN、价格、销量、评论、利润等

当前约束：

- `keywords` 是核心字段
- 默认 `selectType=3`
- 默认 `size=20`
- `size` 只允许 `20 / 60 / 100`
- 用户没有明确要求时，不要自动加价格、评论数、评分、销量等筛选
- `categories` 必须来自 `get_status.supported_categories`
- 不要自己猜 nodeId
- 返回结果要精简，默认不保留 `title`、`brand`、`image_url`、`detail_url`、`id`
- 默认 compact 结果通过 `summary_markdown` 返回一张合并 ASIN 表，不再返回完整 `candidates` JSON
- 需要排障或机器消费完整候选对象时，使用 `result_mode=debug/full` 或显式 `include_candidates=true`

### 关键词选品

作用：

- 打开 SellerSprite `keyword-research` 页面
- 返回关键词搜索量、购买量、增长、ABA、PPC 等指标

当前约束：

- 使用 `includeKeywords` / `excludeKeywords`
- 默认不要勾选“新细分市场 / 仅包含该市场”
- 只有用户明确要求新兴市场时才传 `withYearlyGrowth=true`
- 默认使用上一个完整月份
- 优先抽表格，失败后再用页面文本兜底

### 关键词反查

作用：

- 打开 SellerSprite `keyword-reverse` 竞争对手关键词反查页面
- 输入 ASIN 反查出该产品的所有流量词、自然词、广告词，并获取其流量占比、排名等指标

当前约束：

- 必须通过 `asin / q / asins` 参数传递竞品 ASIN
- 默认 `market=US` (marketId=1)
- 默认 `badges` 包含全部流量词类型，支持以下友好别名（支持数组或逗号分隔串形式）：
  - `"广告"` / `"广告词"` / `"投放"` -> 自动转换为 `SPONSOR_BRAND,SPONSOR_VIDEO,ADS` (SP广告 + 品牌广告 + 视频广告)
  - `"自然"` / `"自然搜索"` / `"自然搜索词"` -> 自动转换为 `NATURAL_SEARCHING,AMAZON_CHOICE,EDITORIAL_RECOMMENDATIONS,FOUR_STAR,HIGHLY_RATED`
  - 单项映射（如 `"sp"`/`"sp广告"` -> `ADS`；`"品牌"`/`"sb"` -> `SPONSOR_BRAND`；`"ac"` -> `AMAZON_CHOICE` 等）
- 默认在页面查找第一张大表（selector 默认为 `'body'`，获取 27 列高精度指标，提取失败时尝试兜底解析）

### 关键词转化率

作用：

- 打开 SellerSprite `keyword-conversion-rate` 页面
- 输入最多 1000 个关键词，读取亚马逊商机探测器/ABA 的关键词行业平均搜索、点击、购买、点击转化率和广告利润模型指标
- 供 agent 结合 PPC、CPA、ACOS 与产品均价做广告预算、利润空间和关键词成交潜力判断

当前约束：

- 必须传 `keywordList` 或 `keywords`
- 默认按“单词单查”执行；若一次传入多个关键词，插件默认会要求拆成多次调用。只有显式传 `allow_multi_keywords=true` 时才放行多词同查
- 默认 `marketId=1` (US)，`reverseType=W` (周口径)，也支持 `reverseType=90D`
- 默认 `bidMatchType=1` (PPC 精准)，支持 `1/2/3` 或 `精准/词组/广泛`
- `keywordMatchType` 默认 `all`
- 默认最多解析 50 条；如果输入单词会拓展出相关关键词，若商机探测器没有数据则返回空结果
- compact 结果只返回 `summary_markdown` 和 `metric_notes`；完整 `candidates` 仅在 `result_mode=debug/full` 时返回
- 关键词转化率是行业平均点击与购买行为参考值，不代表单一商品真实转化表现
- SellerSprite 对多个差异较大的关键词同查时，可能只显示部分词结果；自动选品应优先一词一查，再串行补查其它词

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

- 先调用 `get_status`
- 读 `supported_categories`
- 只用顶层类目
- 不要自己拼不存在的 nodeId
- 多个类目可能都合理时，可以分开尝试，但每次都要用合法白名单值

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
