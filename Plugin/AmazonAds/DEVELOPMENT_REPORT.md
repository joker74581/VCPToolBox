# AmazonAds Development Notes

This file is a public development summary for the community version of the plugin. Private account validation notes, real report samples, campaign names, ASINs, profile IDs, and signed URLs should be stored outside Git.

## Current Scope

- Wrap selected Amazon Ads MCP read flows behind stable VCP commands.
- Keep agent-facing commands compact and predictable.
- Archive report jobs locally for reuse and aggregation.
- Support optional OAuth token refresh without exposing tokens in responses.
- Keep write operations guarded by safe mode and an operation password.

## Main Modules

| File | Responsibility |
| --- | --- |
| `lib/service.js` | Command routing and plugin lifecycle. |
| `lib/config.js` | Config loading and defaults. |
| `lib/mcpClient.js` | MCP transport and tool invocation. |
| `lib/reporting.js` | Report create/retrieve/download orchestration. |
| `lib/reportStore.js` | Local state, artifacts, CSV/XLSX export, aggregation. |
| `lib/fieldPresets.js` | Maintained report presets and candidate fields. |
| `lib/tokenRefresh.js` | Optional OAuth refresh flow. |
| `lib/toolRegistry.js` | Tool metadata and capability presentation. |

## Public Data Hygiene

Before publishing:

- Keep `Plugin/AmazonAds/config.env` untracked.
- Keep `Plugin/AmazonAds/state/` untracked.
- Keep MCP config files untracked.
- Remove real account names, account IDs, profile IDs, campaign IDs, ASINs, SKUs, search terms, and signed URLs from docs.
- Use `<YOUR_...>` placeholders in examples.

## Suggested Manual Validation

Use a private local config, then run:

```text
AmazonAds.get_status
AmazonAds.list_capabilities
AmazonAds.list_accounts
AmazonAds.list_campaigns
AmazonAds.get_report_data
AmazonAds.list_report_jobs
```

Do not commit the generated state directory after validation.
