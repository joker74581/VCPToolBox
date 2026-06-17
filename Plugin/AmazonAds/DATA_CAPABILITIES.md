# AmazonAds 数据能力说明

本文档描述了 `Plugin/AmazonAds` 的公开、不绑定账户的数据能力。本文档有意不包含任何真实的账户名、Profile ID、账户 ID、Campaign 名称、ASIN、SKU、报表输出或签名 URL。

## 直接查询结构

这些命令用于查询当前的账户或广告结构，不创建报表：

| 数据 | 命令 |
| --- | --- |
| 插件/MCP 健康状态 | `get_status` |
| 封装的能力列表 | `list_capabilities` |
| 广告账户 | `list_accounts`, `get_account` |
| 广告活动 (Campaigns) | `list_campaigns` |
| 广告组 (Ad groups) | `list_ad_groups` |
| 广告 (Ads) | `list_ads` |
| 投放目标/关键词/商品投放 | `list_targets` |
| 商品投放资格检查 | `check_product_eligibility` |
| 账单状态 | `get_billing_status` |
| 账户用户 | `list_account_users` |

在以下场景使用直接查询：

- 当前配置了哪些广告活动？
- 某个广告组下存在哪些投放目标？
- 某个 ASIN 是否有资格投放广告？

不要使用直接查询来获取历史表现数据。

## 报表查询

曝光量 (impressions)、点击量 (clicks)、花费 (cost)、销售额 (sales)、订单量 (orders)、ACOS、ROAS、广告位 (placements)、投放目标 (targets) 和搜索词 (search terms) 等历史指标通常需要异步报表。

高级报表命令：

| 目的 | 命令 |
| --- | --- |
| 创建或获取报表 | `get_report_data` |
| 创建原始报表任务 | `create_report` |
| 轮询报表 | `retrieve_report` |
| 列出本地报表任务 | `list_report_jobs` |
| 读取归档数据 | `read_report_artifact` |
| 导出 CSV/XLSX | `export_report_artifact` |
| 聚合归档报表 | `aggregate_report_archives` |
| 探测候选字段 | `probe_report_fields` |

常见的报表类型 (report kinds)：

- `campaign`
- `placement`
- `target`
- `search_term`
- `keyword`

## 字段预设 (Field Presets)

插件在 `lib/fieldPresets.js` 中维护了字段预设。字段的可用性可能会有所不同。插件中列出的字段应被视为维护的默认值，而不是 Amazon 的通用保证。

如果 Amazon 拒绝了某个字段组合：

1. 缩短日期范围。
2. 探测小批量的候选字段。
3. 使用确认后的字段重新运行业务报表。

## 本地状态

插件将本地报表索引和下载文件写入：

```text
Plugin/AmazonAds/state/
```

该目录是私有的运行时数据。不要将其提交到 Git。它可能包含：

- 账户名或 ID
- Campaign 名称
- ASIN/SKU 值
- 搜索词
- 报表 ID
- 签名下载 URL
- 原始指标数据
- CSV/XLSX 导出文件

## 公开示例账户占位符

在文档和示例提示词中使用以下占位符：

```text
accountName: <YOUR_ACCOUNT_NAME>
adsAccountId: <YOUR_ADS_ACCOUNT_ID>
profileId: <YOUR_PROFILE_ID>
entityId: <YOUR_ENTITY_ID>
marketplace: US
```

每个用户都应该在 `Plugin/AmazonAds/config.env` 或根目录的 `config.env` 中填写这些值。
