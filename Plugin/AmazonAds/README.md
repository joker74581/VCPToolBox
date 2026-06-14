# AmazonAds

`AmazonAds` is a VCP plugin for read-first Amazon Ads analysis through the official Amazon Ads MCP server. It wraps common advertising workflows so agents do not need to call every low-level MCP tool directly.

The plugin is designed for community use. No seller, brand, profile, account, token, report output, or signed download URL should be committed to this repository.

## Features

- Check Amazon Ads MCP connectivity without printing tokens.
- List accessible advertising accounts.
- Read campaign, ad group, ad, target, billing, eligibility, and account-user data.
- Create, retrieve, download, summarize, archive, aggregate, and export Amazon Ads reports.
- Maintain local report indexes and field presets under `Plugin/AmazonAds/state/`.
- Keep write operations behind safe mode and an optional operation password.
- Optionally refresh Amazon OAuth tokens and write short-lived access tokens back to an MCP config file.

## What This Plugin Does Not Do By Default

- It does not ship with any real Amazon account.
- It does not expose access tokens, refresh tokens, client secrets, profile IDs, or signed report URLs.
- It does not perform bid, budget, or campaign state changes unless safe mode and operation-password settings explicitly allow the corresponding `apply_*` command.

## Setup

1. Configure an Amazon Ads MCP server. A common layout is:

```json
{
  "mcpServers": {
    "amazon_ads": {
      "url": "https://your-amazon-ads-mcp-endpoint.example/mcp",
      "headers": {
        "Authorization": "Bearer <ACCESS_TOKEN>",
        "Amazon-Ads-ClientId": "<AMAZON_ADS_CLIENT_ID>"
      }
    }
  }
}
```

2. Copy the example config if plugin-level overrides are needed:

```bash
cp Plugin/AmazonAds/config.env.example Plugin/AmazonAds/config.env
```

3. Fill placeholders in `Plugin/AmazonAds/config.env`.

4. Keep `Plugin/AmazonAds/config.env`, `Plugin/AmazonAds/state/`, and any generated reports out of Git.

## Required Configuration

Most deployments need these values:

```env
AMAZON_ADS_MCP_CONFIG_PATH=/absolute/path/to/mcp-config.json
AMAZON_ADS_MCP_SERVER_NAME=amazon_ads
AMAZON_ADS_DEFAULT_ACCOUNT_NAME=<YOUR_ACCOUNT_NAME>
AMAZON_ADS_DEFAULT_ACCOUNT_ID=<YOUR_ADS_ACCOUNT_ID>
AMAZON_ADS_DEFAULT_PROFILE_ID=<YOUR_PROFILE_ID>
AMAZON_ADS_DEFAULT_ENTITY_ID=<YOUR_ENTITY_ID>
AMAZON_ADS_DEFAULT_MARKETPLACE=US
```

If the plugin should refresh tokens by itself, also configure:

```env
AMAZON_ADS_ENABLE_TOKEN_REFRESH=true
AMAZON_CLIENT_ID=<YOUR_AMAZON_CLIENT_ID>
AMAZON_CLIENT_SECRET=<YOUR_AMAZON_CLIENT_SECRET>
AMAZON_REFRESH_TOKEN=<YOUR_AMAZON_REFRESH_TOKEN>
```

If an external process already refreshes the MCP config, keep `AMAZON_ADS_ENABLE_TOKEN_REFRESH=false`.

## Basic Health Check

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonAds「末」,
command:「始」get_status「末」
<<<[END_TOOL_REQUEST]>>>
```

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonAds「末」,
command:「始」list_capabilities「末」
<<<[END_TOOL_REQUEST]>>>
```

## Account And Entity Queries

List accessible accounts:

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonAds「末」,
command:「始」list_accounts「末」
<<<[END_TOOL_REQUEST]>>>
```

List campaigns:

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonAds「末」,
command:「始」list_campaigns「末」,
accountName:「始」<YOUR_ACCOUNT_NAME>「末」,
marketplace:「始」US「末」,
maxResults:「始」50「末」
<<<[END_TOOL_REQUEST]>>>
```

Other direct entity commands:

- `list_ad_groups`
- `list_ads`
- `list_targets`
- `check_product_eligibility`
- `get_billing_status`
- `list_account_users`

These commands read current account structure. They do not answer historical performance questions such as spend, ROAS, ACOS, sales, or search-term conversions. Historical performance needs reports.

## Report Workflow

Amazon Ads reports are asynchronous:

1. Create or find a matching report job.
2. Poll until the report is `COMPLETED`.
3. Download and parse the report.
4. Read rows, export CSV/XLSX, or aggregate archives.

Recommended high-level entry:

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonAds「末」,
command:「始」get_report_data「末」,
reportKind:「始」campaign「末」,
dateFrom:「始」2026-01-01「末」,
dateTo:「始」2026-01-07「末」,
marketplace:「始」US「末」,
mode:「始」get_or_create「末」
<<<[END_TOOL_REQUEST]>>>
```

Common `reportKind` values:

- `campaign`
- `placement`
- `target`
- `search_term`
- `keyword`

Useful archive commands:

- `list_report_jobs`
- `read_report_artifact`
- `export_report_artifact`
- `aggregate_report_archives`

## Field Probing

Report field support may vary by account, marketplace, ad product, and Amazon Ads MCP version. Use field probing only when needed:

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonAds「末」,
command:「始」probe_report_fields「末」,
preset:「始」campaign_basic「末」,
candidateFields:「始」budgetCurrency.value,metric.sales「末」,
days:「始」1「末」
<<<[END_TOOL_REQUEST]>>>
```

Do not probe large field batches. Probing creates report jobs and can trigger rate limits.

## Safety Notes

- Never commit `config.env`, MCP config files, OAuth credentials, `state/`, downloaded reports, or report preview payloads.
- Treat signed report URLs as secrets while valid.
- Keep `AMAZON_ADS_SAFE_MODE=true` unless you are intentionally testing guarded write commands.
- Keep `AMAZON_ADS_OPERATION_PASSWORD` empty unless you want to allow `apply_*` operations.

## Files

- `lib/service.js`: plugin command dispatcher.
- `lib/mcpClient.js`: minimal MCP client.
- `lib/reporting.js`: report creation, retrieval, and download flow.
- `lib/reportStore.js`: local report index and archive helpers.
- `lib/fieldPresets.js`: maintained report field presets.
- `config.env.example`: safe placeholder configuration.
- `state/`: local private runtime data, ignored by Git.
