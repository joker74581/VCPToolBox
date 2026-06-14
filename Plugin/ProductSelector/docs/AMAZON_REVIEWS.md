# Amazon Reviews Feature

## Purpose

`fetch_amazon_reviews` turns an ASIN into compact Amazon review records.
ChromeBridge is only the browser transport. ProductSelector owns URL
construction, page identity checks, extraction order, field naming, fallback
parsing, tab cleanup, and compact output.

## Commands

- `build_amazon_reviews_url`
- `fetch_amazon_reviews`

## Input

Required:

- `asin`, or `url` / `review_url` containing `/dp/`, `/gp/product/`, or `/product-reviews/`.

Optional:

- `market` / `station`: default `US`, mapped to `www.amazon.com`.
- `maxReviews` / `max_reviews`: default `10`, maximum `50`.
- `page_number` / `pageNumber` / `page`: review page number.
- `sort_by` / `sortBy`: `recent`, `newest`, `helpful`, or `top`.
- `filter_by_star` / `filterByStar` / `star`: `all`, `5`, `4`, `3`, `2`, `1`, `positive`, `critical`.
- `result_mode`: `compact`, `debug`, or `full`.
- `include_summary`: default `false`; set `true` to return `summary_markdown`.
- `cleanup_tabs`: default `true`; cleans ChromeBridge-opened tabs from previous runs before opening a fresh review page.
- `cleanup_tabs_after`: default `false`; set `true` to also close ChromeBridge-opened tabs after a completed fetch.

## Extraction Order

1. Build `https://www.amazon.com/product-reviews/{ASIN}` for US unless optional query filters are passed.
2. Open the URL through ChromeBridge.
3. Wait for the active page URL to contain the requested ASIN, then validate `page_state.url` before parsing.
4. Prefer DOM/HTML extraction from `#cm_cr-review_list`.
5. Parse review nodes such as `li.review` and `div[data-hook="review"]`.
6. Fill aggregate rating fields only from targeted Amazon summary DOM.
7. Fall back to Markdown `page_info` review parsing if DOM review extraction fails.

If ChromeBridge returns DOM or Markdown from a different Amazon ASIN page, the
command rejects that payload and returns `page_mismatch=true` instead of
reusing stale reviews from another product.

## Compact Output

Compact review fields:

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
- `image_urls`

Compact mode returns clean structured fields only. It omits raw page info,
review-table HTML, browser command payloads, and duplicate `summary_markdown`
unless `result_mode=debug/full` or `include_summary=true` is explicitly
requested.

Each live fetch also returns:

- `run_id`
- `fetched_at`
- `fresh_fetch=true`
- `tabs_closed_after_fetch` when automatic cleanup runs

## Aggregate Rating

Aggregate fields are returned when parseable:

- `average_rating`
- `global_rating_count`
- `total_review_count`
- `rating_breakdown`

These fields are extracted only from targeted Amazon summary DOM such as
`.reviewNumericalSummary`, `[data-hook="rating-out-of-text"]`,
`[data-hook="average-star-rating"]`, `[data-hook="total-review-count"]`,
`#histogramTable`, `#reviews-filter-info`, or `#cm_cr-product_info`.
`rating_breakdown` is a compact numeric percentage object:

```json
{
  "5_star": 86,
  "4_star": 14,
  "3_star": 0,
  "2_star": 0,
  "1_star": 0
}
```

ProductSelector does not infer aggregate rating from the first review or
arbitrary full-page text, because that can match ads or recommended products.

If targeted aggregate extraction fails, fields remain `null`.

## Image Filtering

Review images are limited to real customer review images such as
`data-hook="review-image-tile"` or `alt="Customer image"`. Pixel placeholders,
transparent images, and default avatars are filtered out.

## Failure Behavior

If Amazon shows a CAPTCHA or robot check, the command returns:

- `success=false`
- `page_blocked=true`
- `needs_manual_action=true`

The user should handle the browser challenge manually and retry.

If the active Amazon page is for a different ASIN, the command returns:

- `success=false`
- `page_mismatch=true`
- `reviews=[]`
