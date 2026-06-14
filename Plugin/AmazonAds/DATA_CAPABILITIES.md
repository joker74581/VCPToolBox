# AmazonAds Data Capabilities

This document describes the public, account-neutral data capabilities of `Plugin/AmazonAds`. It intentionally contains no real account name, profile ID, account ID, campaign name, ASIN, SKU, report output, or signed URL.

## Direct Queries

These commands query current account or advertising structure and do not create reports:

| Data | Command |
| --- | --- |
| Plugin/MCP health | `get_status` |
| Wrapped capabilities | `list_capabilities` |
| Advertising accounts | `list_accounts`, `get_account` |
| Campaigns | `list_campaigns` |
| Ad groups | `list_ad_groups` |
| Ads | `list_ads` |
| Targets / keywords / product targets | `list_targets` |
| Product eligibility | `check_product_eligibility` |
| Billing status | `get_billing_status` |
| Account users | `list_account_users` |

Use direct queries for questions like:

- Which campaigns are currently configured?
- Which targets exist under an ad group?
- Is an ASIN eligible for advertising?

Do not use direct queries for historical performance questions.

## Report-Based Queries

Historical metrics such as impressions, clicks, cost, sales, orders, ACOS, ROAS, placements, targets, and search terms usually require asynchronous reports.

High-level report commands:

| Purpose | Command |
| --- | --- |
| Create or fetch a report | `get_report_data` |
| Create a raw report job | `create_report` |
| Poll a report | `retrieve_report` |
| List local report jobs | `list_report_jobs` |
| Read archived data | `read_report_artifact` |
| Export CSV/XLSX | `export_report_artifact` |
| Aggregate archives | `aggregate_report_archives` |
| Probe candidate fields | `probe_report_fields` |

Common report kinds:

- `campaign`
- `placement`
- `target`
- `search_term`
- `keyword`

## Field Presets

The plugin keeps field presets in `lib/fieldPresets.js`. Field availability can vary. A field listed in the plugin should be treated as a maintained default, not a universal Amazon guarantee.

If Amazon rejects a field combination:

1. Reduce the date range.
2. Probe a small batch of candidate fields.
3. Re-run the business report with the confirmed fields.

## Local State

The plugin writes local report indexes and downloads to:

```text
Plugin/AmazonAds/state/
```

This directory is private runtime data. Do not commit it to Git. It may contain:

- account names or IDs
- campaign names
- ASIN/SKU values
- search terms
- report IDs
- signed URLs
- raw metrics
- CSV/XLSX exports

## Public Example Account Placeholders

Use placeholders in documentation and sample prompts:

```text
accountName: <YOUR_ACCOUNT_NAME>
adsAccountId: <YOUR_ADS_ACCOUNT_ID>
profileId: <YOUR_PROFILE_ID>
entityId: <YOUR_ENTITY_ID>
marketplace: US
```

Each user should fill these values in `Plugin/AmazonAds/config.env` or the root `config.env`.
