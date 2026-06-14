# AmazonSPAPI

`AmazonSPAPI` is a read-only VCP plugin for Amazon Selling Partner API operations analysis. It lets agents inspect marketplace participation, orders, sales metrics, FBA inventory, listings, pricing, catalog data, fee estimates, financial events, reports, and inbound shipments.

The public version contains no seller ID, merchant token, brand, SKU, ASIN, refresh token, client secret, or downloaded report data.

## Safety Model

- Read-only by default.
- Does not request Restricted Data Tokens by default.
- Does not read buyer address, phone, or other restricted PII.
- Keeps real credentials in `Plugin/AmazonSPAPI/config.env`, which is ignored by Git.
- Keeps downloaded reports and runtime state under `Plugin/AmazonSPAPI/state/`, which is ignored by Git.

## Setup

1. Create or configure an Amazon SP-API application.
2. Self-authorize the application for your selling account.
3. Copy the config template:

```bash
cp Plugin/AmazonSPAPI/config.env.example Plugin/AmazonSPAPI/config.env
```

4. Fill in your own values:

```env
AMAZON_SPAPI_LWA_CLIENT_ID=<YOUR_LWA_CLIENT_ID>
AMAZON_SPAPI_LWA_CLIENT_SECRET=<YOUR_LWA_CLIENT_SECRET>
AMAZON_SPAPI_REFRESH_TOKEN=<YOUR_REFRESH_TOKEN>
AMAZON_SPAPI_ENDPOINT=https://sellingpartnerapi-na.amazon.com
AMAZON_SPAPI_MARKETPLACE_IDS=ATVPDKIKX0DER
AMAZON_SPAPI_SELLER_ID=<YOUR_SELLER_ID_OR_MERCHANT_TOKEN>
```

## Region And Marketplace Examples

| Region | Endpoint | Example marketplace |
| --- | --- | --- |
| North America | `https://sellingpartnerapi-na.amazon.com` | US `ATVPDKIKX0DER` |
| Europe | `https://sellingpartnerapi-eu.amazon.com` | UK `A1F83G8C2ARO7P` |
| Far East | `https://sellingpartnerapi-fe.amazon.com` | JP `A1VC38T7YXB528` |

Use marketplace IDs for the marketplace you operate in. Do not use seller IDs as marketplace IDs.

## Commands

| Command | Purpose |
| --- | --- |
| `get_status` | Validate configuration and token exchange. |
| `get_marketplace_participations` | Read marketplace participation and listing suspension status. |
| `get_order_metrics` | Read aggregated order/sales metrics. |
| `get_orders` | Read recent orders without restricted buyer PII. |
| `get_inventory_summaries` | Read FBA inventory summaries. |
| `search_listings_items` | List seller listings. |
| `get_listings_item` | Read one SKU listing. |
| `get_pricing` | Read pricing by ASIN/SKU. |
| `get_competitive_pricing` | Read competitive pricing. |
| `search_catalog_items` / `get_catalog_item` | Read catalog data. |
| `get_my_fees_estimate_for_sku` / `get_my_fees_estimate_for_asin` | Estimate selling fees. |
| `list_financial_events` | Read financial events. |
| `create_report`, `get_report`, `get_report_and_download` | Work with Reports API. |
| `list_inbound_shipments`, `get_inbound_shipment_items` | Inspect FBA inbound shipments. |
| `raw_get` | Restricted raw GET helper for supported read-only paths. |

## Manual Tool Examples

Health check:

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonSPAPI「末」,
command:「始」get_status「末」,
validate:「始」true「末」
<<<[END_TOOL_REQUEST]>>>
```

Sales metrics:

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonSPAPI「末」,
command:「始」get_order_metrics「末」,
dateFrom:「始」2026-01-01「末」,
dateTo:「始」2026-01-07「末」,
granularity:「始」Day「末」
<<<[END_TOOL_REQUEST]>>>
```

Inventory:

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonSPAPI「末」,
command:「始」get_inventory_summaries「末」,
details:「始」true「末」
<<<[END_TOOL_REQUEST]>>>
```

Listings:

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonSPAPI「末」,
command:「始」search_listings_items「末」,
pageSize:「始」20「末」
<<<[END_TOOL_REQUEST]>>>
```

Single SKU listing:

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonSPAPI「末」,
command:「始」get_listings_item「末」,
sku:「始」<YOUR_SKU>「末」
<<<[END_TOOL_REQUEST]>>>
```

Catalog item:

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonSPAPI「末」,
command:「始」get_catalog_item「末」,
asin:「始」<YOUR_ASIN>「末」,
includedData:「始」summaries,images,salesRanks「末」
<<<[END_TOOL_REQUEST]>>>
```

Fee estimate:

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

Report:

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonSPAPI「末」,
command:「始」create_report「末」,
reportType:「始」open_listings「末」
<<<[END_TOOL_REQUEST]>>>
```

## Recommended Agent Workflows

- Store health check: `get_marketplace_participations -> get_order_metrics -> get_inventory_summaries -> search_listings_items`
- Sales trend: `get_order_metrics`
- Inventory risk: `get_inventory_summaries + get_order_metrics`
- Listing audit: `search_listings_items -> get_listings_item`
- Pricing check: `get_pricing -> get_competitive_pricing`
- Fee/margin estimate: `get_my_fees_estimate_for_sku` or `get_my_fees_estimate_for_asin`
- Reports: `create_report -> get_report -> get_report_and_download`

## Do Not Commit

- `Plugin/AmazonSPAPI/config.env`
- `Plugin/AmazonSPAPI/state/`
- downloaded report documents
- real seller IDs, merchant tokens, SKUs, ASINs, order IDs, or financial data
