# AmazonSPAPI 中文说明

`AmazonSPAPI` 是一个面向 VCPToolBox 的 Amazon Selling Partner API 只读分析插件。它用于读取店铺参与站点、订单聚合指标、FBA 库存、Listing、价格、目录、费用估算、财务事件、报表和入仓货件等信息。

公开版本不包含真实 Seller ID、Merchant Token、品牌、SKU、ASIN、Refresh Token、Client Secret 或下载报表。

## 安全模型

- 默认只读。
- 默认不请求 Restricted Data Token。
- 默认不读取买家地址、电话等受限 PII。
- 真实凭据放在 `Plugin/AmazonSPAPI/config.env`，该文件被 Git 忽略。
- 下载报表和运行状态放在 `Plugin/AmazonSPAPI/state/`，该目录被 Git 忽略。

## 安装与配置

1. 创建或配置 Amazon SP-API 应用。
2. 对你的卖家账户完成授权。
3. 复制配置模板：

```bash
cp Plugin/AmazonSPAPI/config.env.example Plugin/AmazonSPAPI/config.env
```

4. 填写你的真实配置：

```env
AMAZON_SPAPI_LWA_CLIENT_ID=<YOUR_LWA_CLIENT_ID>
AMAZON_SPAPI_LWA_CLIENT_SECRET=<YOUR_LWA_CLIENT_SECRET>
AMAZON_SPAPI_REFRESH_TOKEN=<YOUR_REFRESH_TOKEN>
AMAZON_SPAPI_ENDPOINT=https://sellingpartnerapi-na.amazon.com
AMAZON_SPAPI_MARKETPLACE_IDS=ATVPDKIKX0DER
AMAZON_SPAPI_SELLER_ID=<YOUR_SELLER_ID_OR_MERCHANT_TOKEN>
```

## 区域和站点

| 区域 | Endpoint | 示例站点 |
| --- | --- | --- |
| 北美 | `https://sellingpartnerapi-na.amazon.com` | 美国 `ATVPDKIKX0DER` |
| 欧洲 | `https://sellingpartnerapi-eu.amazon.com` | 英国 `A1F83G8C2ARO7P` |
| 远东 | `https://sellingpartnerapi-fe.amazon.com` | 日本 `A1VC38T7YXB528` |

注意：Marketplace ID 不是 Seller ID。请根据你的销售站点填写对应 Marketplace ID。

## 命令概览

| 命令 | 用途 |
| --- | --- |
| `get_status` | 检查配置和 Token 交换是否正常。 |
| `get_marketplace_participations` | 读取店铺参与站点和 Listing 状态。 |
| `get_order_metrics` | 读取订单和销售聚合指标。 |
| `get_orders` | 读取近期订单，不包含受限买家 PII。 |
| `get_inventory_summaries` | 读取 FBA 库存。 |
| `search_listings_items` | 查询卖家 Listing 列表。 |
| `get_listings_item` | 查询单个 SKU Listing。 |
| `get_pricing` | 按 ASIN/SKU 查询价格。 |
| `get_competitive_pricing` | 查询竞争价格。 |
| `search_catalog_items` / `get_catalog_item` | 查询目录数据。 |
| `get_my_fees_estimate_for_sku` / `get_my_fees_estimate_for_asin` | 估算销售费用。 |
| `list_financial_events` | 查询财务事件。 |
| `create_report`, `get_report`, `get_report_and_download` | 使用 Reports API。 |
| `list_inbound_shipments`, `get_inbound_shipment_items` | 查询 FBA 入仓货件。 |
| `raw_get` | 受限的只读 raw GET 辅助命令。 |

## 调用示例

健康检查：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonSPAPI「末」,
command:「始」get_status「末」,
validate:「始」true「末」
<<<[END_TOOL_REQUEST]>>>
```

销售趋势：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonSPAPI「末」,
command:「始」get_order_metrics「末」,
dateFrom:「始」2026-01-01「末」,
dateTo:「始」2026-01-07「末」,
granularity:「始」Day「末」
<<<[END_TOOL_REQUEST]>>>
```

FBA 库存：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonSPAPI「末」,
command:「始」get_inventory_summaries「末」,
details:「始」true「末」
<<<[END_TOOL_REQUEST]>>>
```

查询 Listing：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonSPAPI「末」,
command:「始」search_listings_items「末」,
pageSize:「始」20「末」
<<<[END_TOOL_REQUEST]>>>
```

单个 SKU：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonSPAPI「末」,
command:「始」get_listings_item「末」,
sku:「始」<YOUR_SKU>「末」
<<<[END_TOOL_REQUEST]>>>
```

费用估算：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonSPAPI「末」,
command:「始」get_my_fees_estimate_for_sku「末」,
sku:「始」<YOUR_SKU>「末」,
listingPrice:「始」29.99「末」,
currency:「始」USD「末」,
isAmazonFulfilled:「始」true「末」
<<<[END_TOOL_REQUEST]>>>
```

创建报表：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonSPAPI「末」,
command:「始」create_report「末」,
reportType:「始」open_listings「末」
<<<[END_TOOL_REQUEST]>>>
```

## 推荐工作流

- 店铺健康检查：`get_marketplace_participations -> get_order_metrics -> get_inventory_summaries -> search_listings_items`
- 销售趋势：`get_order_metrics`
- 库存风险：`get_inventory_summaries + get_order_metrics`
- Listing 审计：`search_listings_items -> get_listings_item`
- 价格检查：`get_pricing -> get_competitive_pricing`
- 费用和利润估算：`get_my_fees_estimate_for_sku` 或 `get_my_fees_estimate_for_asin`
- 报表流程：`create_report -> get_report -> get_report_and_download`

## 公开仓库注意事项

不要提交：

- `Plugin/AmazonSPAPI/config.env`
- `Plugin/AmazonSPAPI/state/`
- 下载后的报表
- 真实 Seller ID、Merchant Token、SKU、ASIN、Order ID、财务数据
