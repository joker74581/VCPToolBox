const AMAZON_MARKET_DOMAINS = {
  US: 'www.amazon.com',
  CA: 'www.amazon.ca',
  UK: 'www.amazon.co.uk',
  DE: 'www.amazon.de',
  FR: 'www.amazon.fr',
  IT: 'www.amazon.it',
  ES: 'www.amazon.es',
  JP: 'www.amazon.co.jp',
  AU: 'www.amazon.com.au'
};

const STAR_FILTERS = {
  all: 'all_stars',
  all_stars: 'all_stars',
  5: 'five_star',
  five: 'five_star',
  five_star: 'five_star',
  4: 'four_star',
  four: 'four_star',
  four_star: 'four_star',
  3: 'three_star',
  three: 'three_star',
  three_star: 'three_star',
  2: 'two_star',
  two: 'two_star',
  two_star: 'two_star',
  1: 'one_star',
  one: 'one_star',
  one_star: 'one_star',
  positive: 'positive',
  critical: 'critical'
};

const SORT_VALUES = {
  recent: 'recent',
  newest: 'recent',
  helpful: 'helpful',
  top: 'helpful'
};

const VARIANT_LABELS = [
  'Color',
  'Colour',
  'Size',
  'Style',
  'Pattern Name',
  'Flavor',
  'Flavour',
  'Item Package Quantity',
  'Number of Items',
  'Capacity',
  'Configuration',
  'Edition',
  'Scent'
];

const BASIC_INFO_LABELS = [
  'Material',
  'Color',
  'Colour',
  'Brand',
  'League',
  'Number of Players',
  'Size',
  'Item Weight',
  'Product Dimensions',
  'Age Range',
  'Manufacturer',
  'Style',
  'Theme',
  'Sport'
];

let cheerio = null;
try {
  cheerio = require('cheerio');
} catch (_) {
  cheerio = null;
}

function cleanLine(value) {
  return String(value || '')
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .replace(/\[([^:\]]{1,24}):\s*([^\]]+)]\([^)]+\)/g, '$2')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/^[#>*\-\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanReviewText(value, maxChars = 4000) {
  const text = cleanLine(value)
    .replace(/\b(Read more|Show more|See more|Translate review to English|Translate all reviews to English)\b/ig, '')
    .replace(/^Verified Purchase\s+/i, '')
    .replace(/\b(Permalink|Report|Helpful|Customer image|Verified Purchase)\b\s*$/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!maxChars || text.length <= maxChars) return text;
  return text.slice(0, maxChars).trim();
}

function parseInteger(value) {
  if (!value) return null;
  const parsed = parseInt(String(value).replace(/[,\s]/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeAsin(value) {
  const raw = String(value || '').trim();
  const pathMatch = raw.match(/(?:\/(?:dp|gp\/product|product-reviews)\/)([A-Z0-9]{10})/i);
  if (pathMatch) return pathMatch[1].toUpperCase();
  const directMatch = raw.match(/\b([A-Z0-9]{10})\b/i);
  return directMatch ? directMatch[1].toUpperCase() : null;
}

function getMarketDomain(market) {
  const normalized = String(market || 'US').trim().toUpperCase();
  return AMAZON_MARKET_DOMAINS[normalized] || AMAZON_MARKET_DOMAINS.US;
}

function normalizePageNumber(args = {}) {
  const parsed = Number(args.page_number ?? args.pageNumber ?? args.page);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return 1;
}

function normalizeSortBy(value) {
  if (value === undefined || value === null || value === '') return null;
  return SORT_VALUES[String(value).trim().toLowerCase()] || null;
}

function normalizeStarFilter(value) {
  if (value === undefined || value === null || value === '') return null;
  return STAR_FILTERS[String(value).trim().toLowerCase()] || null;
}

function normalizeReviewArgs(args = {}) {
  const asin = normalizeAsin(args.asin || args.ASIN || args.url || args.review_url || args.reviewUrl);
  const market = String(args.market || args.station || 'US').trim().toUpperCase();
  const pageNumber = normalizePageNumber(args);
  const sortBy = normalizeSortBy(args.sort_by ?? args.sortBy);
  const filterByStar = normalizeStarFilter(args.filter_by_star ?? args.filterByStar ?? args.star);
  const reviewerType = String(args.reviewer_type ?? args.reviewerType ?? '').trim();
  const maxReviews = Math.min(Math.max(Number(args.maxReviews || args.max_reviews) || 10, 1), 50);

  return {
    asin,
    market,
    domain: getMarketDomain(market),
    pageNumber,
    sortBy,
    filterByStar,
    reviewerType,
    maxReviews,
    warnings: [
      ...(asin ? [] : ['Missing a valid ASIN. Pass asin or an Amazon review/detail URL.']),
      ...((args.sort_by || args.sortBy) && !sortBy ? [`Ignored unsupported sort_by: ${args.sort_by ?? args.sortBy}`] : []),
      ...((args.filter_by_star || args.filterByStar || args.star) && !filterByStar ? [`Ignored unsupported filter_by_star: ${args.filter_by_star ?? args.filterByStar ?? args.star}`] : [])
    ]
  };
}

function normalizeProductArgs(args = {}) {
  const asin = normalizeAsin(args.asin || args.ASIN || args.url || args.product_url || args.productUrl);
  const market = String(args.market || args.station || 'US').trim().toUpperCase();
  const maxReviews = Math.min(Math.max(Number(args.maxReviews || args.max_reviews) || 5, 0), 50);

  return {
    asin,
    market,
    domain: getMarketDomain(market),
    th: String(args.th ?? '1'),
    maxReviews,
    warnings: [
      ...(asin ? [] : ['Missing a valid ASIN. Pass asin or an Amazon detail URL.'])
    ]
  };
}

function buildReviewUrl(filters = {}) {
  if (!filters.asin) throw new Error('buildReviewUrl requires asin.');
  const url = new URL(`https://${filters.domain || AMAZON_MARKET_DOMAINS.US}/product-reviews/${filters.asin}`);
  if (filters.pageNumber && filters.pageNumber > 1) url.searchParams.set('pageNumber', String(filters.pageNumber));
  if (filters.sortBy) url.searchParams.set('sortBy', filters.sortBy);
  if (filters.filterByStar) url.searchParams.set('filterByStar', filters.filterByStar);
  if (filters.reviewerType) url.searchParams.set('reviewerType', filters.reviewerType);
  return url.toString();
}

function buildProductUrl(filters = {}) {
  if (!filters.asin) throw new Error('buildProductUrl requires asin.');
  const url = new URL(`https://${filters.domain || AMAZON_MARKET_DOMAINS.US}/dp/${filters.asin}`);
  if (filters.th !== undefined && filters.th !== null && filters.th !== '') {
    url.searchParams.set('th', String(filters.th));
  }
  return url.toString();
}

function parseRatingTitle(line) {
  const text = cleanLine(line);
  if (/%\s*$/.test(text)) return null;
  const match = text.match(/([1-5](?:\.\d)?)\s+out of\s+5\s+stars?\s*(.*)$/i);
  if (match) {
    return {
      rating: Number(match[1]),
      title: cleanReviewText(match[2], 240) || null
    };
  }
  const shortMatch = text.match(/^([1-5](?:\.\d)?)\s*stars?\s*(.*)$/i);
  if (shortMatch) {
    const title = cleanReviewText(shortMatch[2], 240) || null;
    if (title && /%/.test(title)) return null;
    return {
      rating: Number(shortMatch[1]),
      title
    };
  }
  return null;
}

function parseReviewedLine(line) {
  const text = cleanLine(line);
  const full = text.match(/Reviewed in\s+(.+?)\s+on\s+(.+)$/i);
  if (full) {
    return {
      region: cleanLine(full[1]),
      date: cleanLine(full[2])
    };
  }
  const dateOnly = text.match(/Reviewed on\s+(.+)$/i);
  if (dateOnly) {
    return {
      region: null,
      date: cleanLine(dateOnly[1])
    };
  }
  return null;
}

function isReviewDateLine(line) {
  return Boolean(parseReviewedLine(line));
}

function isRatingLine(line) {
  return Boolean(parseRatingTitle(line));
}

function isSkipLine(line) {
  const text = cleanLine(line);
  if (!text) return true;
  return /^(Customer reviews|Top reviews|Top reviews from|There was a problem|Translate review|Report|Permalink|Search this page|Sort by|Filter by|Previous page|Next page|See more reviews|Showing \d|Back to top)$/i.test(text);
}

function isMetadataLine(line) {
  const text = cleanLine(line);
  if (!text) return true;
  const labelPattern = VARIANT_LABELS.map(label => label.replace(/\s+/g, '\\s+')).join('|');
  return /^(Verified Purchase|Vine Customer Review(?: of Free Product)?|Customer image|One person found this helpful|\d+ people found this helpful|Helpful|Report)$/i.test(text) ||
    new RegExp(`^(${labelPattern}):`, 'i').test(text);
}

function parseAggregate(lines) {
  const joined = lines.join(' ');
  const average = joined.match(/([1-5](?:\.\d)?)\s+out of\s+5/i);
  const ratingCount = joined.match(/([\d,]+)\s+(?:global\s+)?ratings?/i) || joined.match(/([\d,]+)\s+ratings?\b/i);
  const reviewCount = joined.match(/([\d,]+)\s+(?:with\s+)?reviews?/i);

  let ratingBreakdown = null;
  const histMatches = joined.matchAll(/([1-5])\s*stars?\s*[:\-]?\s*(\d+)%/gi);
  for (const match of histMatches) {
    if (!ratingBreakdown) ratingBreakdown = {};
    setRatingBreakdownValue(ratingBreakdown, match[1], match[2]);
  }

  return {
    average_rating: average ? Number(average[1]) : null,
    global_rating_count: ratingCount ? parseInteger(ratingCount[1]) : null,
    total_review_count: reviewCount ? parseInteger(reviewCount[1]) : null,
    rating_breakdown: finalizeRatingBreakdown(ratingBreakdown),
    histogram: ratingBreakdownToHistogram(ratingBreakdown)
  };
}

function parseAggregateText(text) {
  const clean = cleanLine(text);
  return parseAggregate(clean ? [clean] : []);
}

function emptyAggregate() {
  return {
    average_rating: null,
    global_rating_count: null,
    total_review_count: null,
    rating_breakdown: null,
    histogram: null
  };
}

function parsePercentage(value) {
  const parsed = Number(String(value || '').replace('%', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function setRatingBreakdownValue(target, star, percentage) {
  if (!target) return;
  const starNumber = Number(star);
  const parsedPercentage = parsePercentage(percentage);
  if (!Number.isInteger(starNumber) || starNumber < 1 || starNumber > 5 || parsedPercentage === null) return;
  target[`${starNumber}_star`] = parsedPercentage;
}

function finalizeRatingBreakdown(value) {
  if (!value || Object.keys(value).length === 0) return null;
  const result = {};
  [5, 4, 3, 2, 1].forEach(star => {
    const key = `${star}_star`;
    if (value[key] !== undefined) result[key] = value[key];
  });
  return Object.keys(result).length > 0 ? result : null;
}

function ratingBreakdownToHistogram(value) {
  const breakdown = finalizeRatingBreakdown(value);
  if (!breakdown) return null;
  return Object.fromEntries(Object.entries(breakdown).map(([key, pct]) => [key, `${pct}%`]));
}

function parseHistogramStarFromAttrs($, element) {
  const el = $(element);
  const ariaLabel = el.attr('aria-label') || '';
  const ariaMatch = ariaLabel.match(/([1-5])\s+stars?\s+represent\s+([\d.]+)%/i);
  if (ariaMatch) return { star: ariaMatch[1], percentage: ariaMatch[2] };
  const percentMatch = ariaLabel.match(/([\d.]+)\s+percent\s+of\s+reviews\s+have\s+([1-5])\s+stars?/i);
  if (percentMatch) return { star: percentMatch[2], percentage: percentMatch[1] };

  const stateParam = el.attr('data-reviews-state-param') || '';
  const href = el.attr('href') || '';
  const combined = `${stateParam} ${href}`;
  const starMap = {
    five_star: 5,
    four_star: 4,
    three_star: 3,
    two_star: 2,
    one_star: 1
  };
  const filterMatch = combined.match(/(?:filterByStar["'=:%\s]+|filterByStar=)(five_star|four_star|three_star|two_star|one_star)/i) ||
    combined.match(/(five_star|four_star|three_star|two_star|one_star)/i);
  const star = filterMatch ? starMap[filterMatch[1].toLowerCase()] : null;
  const progress = el.find('[role="progressbar"], .a-meter').first().attr('aria-valuenow');
  if (star && progress !== undefined) return { star, percentage: progress };

  return null;
}

function parseRatingBreakdownHtml($, scope) {
  const ratingBreakdown = {};
  const seen = new Set();
  const candidates = scope
    .filter('[aria-label*="represent"], [aria-label*="percent of reviews"], [class*="histogram-row-container"], .histogram-row-container, #histogramTable li')
    .add(scope.find('[aria-label*="represent"], [aria-label*="percent of reviews"], [class*="histogram-row-container"], .histogram-row-container, #histogramTable li'));

  candidates.each((_, element) => {
    const parsed = parseHistogramStarFromAttrs($, element);
    if (!parsed) return;
    const key = `${parsed.star}_star`;
    if (seen.has(key)) return;
    seen.add(key);
    setRatingBreakdownValue(ratingBreakdown, parsed.star, parsed.percentage);
  });

  return finalizeRatingBreakdown(ratingBreakdown);
}

function parseAggregateHtml(html) {
  if (!cheerio || !html) {
    return emptyAggregate();
  }

  const $ = cheerio.load(String(html));
  const summaryRoot = $('.reviewNumericalSummary, #cm_cr-product_info, #reviewsMedley, #cm_cr_dp_d_rating_histogram, #averageCustomerReviews, #averageCustomerReviews_feature_div').first();
  const scope = summaryRoot.length > 0 ? summaryRoot : $.root();
  const firstText = selector => cleanLine(
    scope.filter(selector).add(scope.find(selector)).first().text()
  );

  const averageText = cleanLine([
    firstText('[data-hook="rating-out-of-text"]'),
    firstText('[data-hook="average-star-rating"]'),
    firstText('#acrPopover .a-icon-alt'),
    firstText('.a-icon-alt'),
    firstText('.AverageCustomerReviews')
  ].filter(Boolean).join(' '));

  const countText = cleanLine([
    firstText('[data-hook="total-review-count"]'),
    firstText('[data-hook="cr-filter-info-review-rating-count"]'),
    firstText('#acrCustomerReviewText'),
    firstText('#reviews-filter-info'),
    firstText('#filter-info-section'),
    firstText('#cm_cr-product_info'),
    firstText('.averageStarRatingNumerical')
  ].filter(Boolean).join(' '));

  const average = averageText.match(/([1-5](?:\.\d)?)\s+out of\s+5/i);
  const ratingCount = countText.match(/([\d,\s]+)\s+(?:global\s+)?ratings?/i) ||
    countText.match(/([\d,\s]+)\s+ratings?\b/i);
  const reviewCount = countText.match(/showing\s+\d+\s*[-–]\s*\d+\s+of\s+([\d,\s]+)\s+reviews?/i) ||
    countText.match(/([\d,\s]+)\s+(?:with\s+)?reviews?/i);
  const ratingBreakdown = parseRatingBreakdownHtml($, scope) || parseRatingBreakdownHtml($, $.root());

  return {
    average_rating: average ? Number(average[1]) : null,
    global_rating_count: ratingCount ? parseInteger(ratingCount[1]) : null,
    total_review_count: reviewCount ? parseInteger(reviewCount[1]) : null,
    rating_breakdown: ratingBreakdown,
    histogram: ratingBreakdownToHistogram(ratingBreakdown)
  };
}

function parseVariantText(text) {
  const source = cleanLine(text)
    .replace(/Amazon Vine Customer Review of Free Product[\s\S]*$/i, '')
    .replace(/Vine Customer Review[\s\S]*$/i, '')
    .replace(/Verified Purchase[\s\S]*$/i, '')
    .trim();
  if (!source) return {};

  const labelPattern = VARIANT_LABELS.map(label => label.replace(/\s+/g, '\\s+')).join('|');
  const re = new RegExp(`(${labelPattern})\\s*:\\s*`, 'ig');
  const matches = [];
  let match;
  while ((match = re.exec(source)) !== null) {
    matches.push({
      label: match[1],
      valueStart: re.lastIndex,
      matchStart: match.index
    });
  }

  const variant = {};
  matches.forEach((item, index) => {
    const next = matches[index + 1];
    let value = cleanReviewText(
      source.slice(item.valueStart, next ? next.matchStart : source.length)
        .replace(/Verified Purchase[\s\S]*$/i, '')
        .replace(/\s*\|\s*$/, ''),
      160
    );
    if (/^(Item Package Quantity|Number of Items)$/i.test(item.label)) {
      const quantity = value.match(/^\d+/);
      if (quantity) value = quantity[0];
    }
    if (value) variant[item.label.toLowerCase()] = value;
  });
  return variant;
}

function collectReviewMetadataText($, root) {
  const parts = [];
  root.find('[data-hook="avp-badge"], [data-hook="format-strip"], .review-purchase').each((_, node) => {
    const text = cleanLine($(node).text());
    if (text) parts.push(text);
  });
  root.find('span').each((_, span) => {
    const el = $(span);
    if (
      el.is('[data-hook="review-body"], [data-hook="review-date"], .a-icon-alt, .a-profile-name') ||
      el.closest('[data-hook="review-body"], [data-hook="genome-widget"], h5').length > 0
    ) {
      return;
    }
    const text = cleanLine(el.text());
    if (!text) return;
    if (/Verified Purchase/i.test(text) || Object.keys(parseVariantText(text)).length > 0) {
      parts.push(text);
    }
  });
  return parts.join(' | ');
}

function parseReviewHtml(html, options = {}) {
  if (!cheerio || !html) {
    return null;
  }

  const $ = cheerio.load(String(html));
  const rootText = $.root().text();
  const pageTitle = $('title').text() || '';
  const isDogged = /Page Not Found|we couldn't find that page|Looking for something\? We're sorry/i.test(pageTitle) ||
                   /we're sorry\. The Web address you entered is not a functioning page/i.test(rootText) ||
                   $('#g').length > 0 ||
                   /dogs-page|dogs_page/i.test(html) ||
                   /sorry_page/i.test(html);

  if (isDogged) {
    return {
      average_rating: null,
      global_rating_count: null,
      total_review_count: null,
      rating_breakdown: null,
      histogram: null,
      reviews: [],
      review_count: 0,
      page_blocked: /Enter the characters you see below|not a robot|captcha|Robot Check/i.test(rootText),
      page_dogged: true,
      warnings: ['Amazon 评论页展示 404 或变狗，ASIN 疑似已被下架或不存在。'],
      raw_page_info_excerpt: String(html).slice(0, 3000)
    };
  }
  const maxReviews = Math.min(Math.max(Number(options.maxReviews) || 10, 1), 50);
  const maxBodyChars = Number(options.maxBodyChars) || 4000;
  const reviews = [];
  const reviewNodes = $('[data-hook="review"], li.review, .review').toArray();

  reviewNodes.slice(0, maxReviews).forEach(node => {
    const root = $(node);
    root.find('script, style, noscript').remove();
    const ratingText = cleanLine(root.find('[data-hook="review-star-rating"], [data-hook="cmps-review-star-rating"], .review-rating, .a-icon-alt').first().text());
    const ratingTitle = parseRatingTitle(ratingText);
    const rawTitle = cleanLine(root.find('[data-hook="review-title"], .review-title, h5').first().text());
    const title = cleanReviewText(rawTitle.replace(/^[1-5](?:\.\d)?\s+out of\s+5\s+stars?\s*/i, ''), 240) || ratingTitle?.title || null;
    const formatStripText = cleanLine(root.find('[data-hook="format-strip"]').text());
    const variant = parseVariantText(formatStripText);

    let review_type = 'direct_review';
    if (root.find('[data-hook="avp-badge"]').length > 0) {
      review_type = 'verified_purchase';
    } else if (root.find('.a-color-success.a-text-bold').length > 0) {
      review_type = 'vine';
    }

    const helpfulText = cleanLine(root.find('[data-hook="helpful-vote-statement"], .cr-vote-text').text());
    let helpful_count = null;
    if (/One person found this helpful/i.test(helpfulText)) {
      helpful_count = 1;
    } else {
      const match = helpfulText.match(/([\d,]+)\s+people found this helpful/i);
      if (match) helpful_count = parseInteger(match[1]);
    }

    const image_count = root.find('img[alt="Customer image"]').length || 0;

    const reviewed = parseReviewedLine(root.find('[data-hook="review-date"], .review-date').first().text());
    const body = cleanReviewText(root.find('[data-hook="review-body"], [data-hook="reviewRichContentContainer"], [data-hook="reviewText"], .review-content').first().text(), maxBodyChars);
    if (!body) return;

    reviews.push({
      review_id: root.attr('id') || root.closest('[data-reviewid]').attr('data-reviewid') || undefined,
      rating: ratingTitle?.rating || null,
      title,
      body,
      author: cleanReviewText(root.find('.a-profile-name, .review-user, [data-hook="review-author"]').first().text(), 120) || null,
      date: reviewed?.date || null,
      region: reviewed?.region || null,
      verified_purchase: review_type === 'verified_purchase',
      review_type,
      variant: Object.keys(variant).length > 0 ? variant : undefined,
      helpful_count,
      image_count,
      image_urls: root.find('img').toArray()
        .filter(img => isReviewImage($, img))
        .map(img => $(img).attr('src'))
        .filter(url => isRealReviewImageUrl(url))
        .slice(0, 10)
    });
  });
  const aggregate = parseAggregateHtml(html);
  return {
    ...aggregate,
    reviews,
    review_count: reviews.length,
    page_blocked: /Enter the characters you see below|not a robot|captcha|Robot Check/i.test(rootText),
    page_dogged: false,
    warnings: reviews.length === 0 ? ['No review blocks were found in #cm_cr-review_list HTML.'] : [],
    raw_page_info_excerpt: String(html).slice(0, 3000)
  };
}

function parseReviewTableData(tableData, options = {}) {
  if (tableData?.html) {
    const parsed = parseReviewHtml(tableData.html, options);
    if (parsed) return parsed;
  }
  return null;
}

function parseAggregateTableData(tableData) {
  if (tableData?.html) return parseAggregateHtml(tableData.html);
  const text = [
    tableData?.text,
    ...(Array.isArray(tableData?.rows) ? tableData.rows.map(row => row?.text || row?.cells?.join(' ')) : [])
  ].filter(Boolean).join(' ');
  return parseAggregateText(text);
}

function firstCleanText($, selectors, scope) {
  const root = scope || $.root();
  for (const selector of selectors) {
    const text = cleanLine(root.find(selector).first().text());
    if (text) return text;
  }
  return null;
}

function parseProductPrice($) {
  const directPrice = firstCleanText($, [
    '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
    '#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen',
    '#corePrice_feature_div .a-price .a-offscreen',
    '#apex_desktop .a-price .a-offscreen',
    '#tp_price_block_total_price_ww .a-offscreen',
    '#priceblock_ourprice',
    '#priceblock_dealprice',
    '#price_inside_buybox'
  ]);
  if (directPrice && /\d/.test(directPrice)) return directPrice;

  const priceRoot = $('#corePriceDisplay_desktop_feature_div .a-price, #corePrice_feature_div .a-price, #apex_desktop .a-price, #ppd .priceToPay, #centerCol .priceToPay, #buybox .priceToPay, #rightCol .priceToPay').first();
  const offscreen = cleanLine(priceRoot.find('.a-offscreen').first().text());
  if (offscreen && /\d/.test(offscreen)) return offscreen;

  const symbol = cleanLine(priceRoot.find('.a-price-symbol').first().text()) || '$';
  const whole = cleanLine(priceRoot.find('.a-price-whole').first().text()).replace(/[^\d,]/g, '');
  const fraction = cleanLine(priceRoot.find('.a-price-fraction').first().text()).replace(/[^\d]/g, '');
  if (whole) return `${symbol}${whole}${fraction ? `.${fraction}` : ''}`;
  return null;
}

function parsePriceText(text) {
  const source = cleanLine(text);
  if (!source) return null;

  const spacedCents = source.match(/([$£€¥])\s*(\d[\d,]*)\s*(?:\.|\s)\s*(\d{2})(?!\d)/);
  if (spacedCents) {
    return `${spacedCents[1]}${spacedCents[2]}.${spacedCents[3]}`;
  }

  const decimal = source.match(/([$£€¥])\s*(\d[\d,]*\.\d{2})/);
  if (decimal) return `${decimal[1]}${decimal[2]}`;

  const wholeOnly = source.match(/([$£€¥])\s*(\d[\d,]*)\b/);
  return wholeOnly ? `${wholeOnly[1]}${wholeOnly[2]}` : null;
}

function parseProductBasicInfo($) {
  const info = {};
  $('table.a-normal.a-spacing-micro tr, #productOverview_feature_div tr, #poExpander tr').each((_, row) => {
    const key = cleanLine($(row).find('.a-text-bold').first().text()).replace(/:$/, '');
    const value = cleanLine($(row).find('.po-break-word, td').last().text());
    if (key && value && key !== value) info[key] = value;
  });
  return Object.keys(info).length > 0 ? info : null;
}

function parseBasicInfoFromTableRows(rows) {
  const info = {};
  if (!Array.isArray(rows)) return null;
  const allowedLabels = new Set(BASIC_INFO_LABELS.map(label => label.toLowerCase()));

  rows.forEach(row => {
    const values = Array.isArray(row?.values)
      ? row.values
      : (Array.isArray(row?.cells) ? row.cells : []);
    if (values.length < 2) return;
    const key = cleanLine(values[0]).replace(/:$/, '');
    const value = cleanReviewText(values.slice(1).join(' '), 240);
    if (!allowedLabels.has(key.toLowerCase())) return;
    if (!key || !value || key.toLowerCase() === value.toLowerCase()) return;
    info[key] = value;
  });

  return Object.keys(info).length > 0 ? info : null;
}

function normalizeAmazonPageTitle(value) {
  let title = cleanReviewText(value, 500)
    .replace(/^Amazon\.com\s*:\s*/i, '')
    .replace(/\s*:\s*Amazon\..*$/i, '')
    .replace(/\s*-\s*Amazon\..*$/i, '')
    .trim();
  if (!title || /^(Amazon\.com|Page Not Found|Robot Check|Sorry)/i.test(title)) return null;
  const parts = title.split(/\s+:\s+/).map(part => part.trim()).filter(Boolean);
  if (parts.length > 1 && parts[0].length >= 12) title = parts[0];
  if (isNonProductTitle(title)) return null;
  return title || null;
}

function isNonProductTitle(value) {
  const title = cleanLine(value);
  if (!title) return true;
  return /^(Compare with similar items?|Compare with similar|Products related to this item|Similar items|Customers also bought|Frequently bought together|From the brand|Product information|Important information|Customer reviews|Looking for specific info|Videos|Product description|Sponsored|Report an issue with this product or seller|Chat history|New chat|Get started|Load more|Start of chat history|How can I help\??|Ask Alexa|Alexa AI|Product summary|Buying options|Reviews)$/i.test(title);
}

function normalizeProductTitle(value) {
  const title = cleanReviewText(value, 500);
  if (!title || isNonProductTitle(title)) return null;
  return title;
}

function hasProductCoreFields(parsed) {
  if (!parsed) return false;
  const title = normalizeProductTitle(parsed.title);
  const hasBullets = Array.isArray(parsed.feature_bullets) && parsed.feature_bullets.length > 0;
  const hasBasicInfo = parsed.basic_info && Object.keys(parsed.basic_info).length > 0;
  const hasStrongField = Boolean(parsed.price || parsed.rating != null || parsed.review_count != null || hasBullets);
  return Boolean(title && (hasStrongField || hasBasicInfo));
}

function parseFeatureBullets($) {
  const bullets = [];
  $('#feature-bullets li .a-list-item').each((_, item) => {
    const text = cleanReviewText($(item).text(), 1200);
    if (text && !/Make sure this fits|Enter your model number/i.test(text)) bullets.push(text);
  });
  if (bullets.length > 0) return bullets;
  return parseFeatureBulletsFromText($.root().text());
}

function mergeProductParsedData(primary, fallback) {
  if (!primary || !fallback) return primary || fallback || null;
  const merged = { ...primary };
  if (isNonProductTitle(merged.title)) merged.title = null;
  [
    'title',
    'rating',
    'review_count',
    'price',
    'average_rating',
    'global_rating_count',
    'total_review_count',
    'rating_breakdown',
    'histogram'
  ].forEach(field => {
    if (merged[field] == null && fallback[field] != null) merged[field] = fallback[field];
  });
  if (isNonProductTitle(merged.title)) merged.title = null;

  merged.basic_info = {
    ...(fallback.basic_info || {}),
    ...(primary.basic_info || {})
  };
  if (Object.keys(merged.basic_info).length === 0) merged.basic_info = null;

  if ((!Array.isArray(merged.feature_bullets) || merged.feature_bullets.length === 0) && fallback.feature_bullets?.length > 0) {
    merged.feature_bullets = fallback.feature_bullets;
  }
  if ((!Array.isArray(merged.reviews) || merged.reviews.length === 0) && fallback.reviews?.length > 0) {
    merged.reviews = fallback.reviews;
    merged.top_review_count = fallback.top_review_count;
  }
  if ((!Array.isArray(merged.variations) || merged.variations.length === 0) && fallback.variations?.length > 0) {
    merged.variations = fallback.variations;
    merged.variation_count = fallback.variation_count;
  }
  merged.warnings = [
    ...(primary.warnings || []),
    ...(fallback.warnings || [])
  ].filter((warning, index, all) => warning && all.indexOf(warning) === index);
  if (merged.title) {
    merged.warnings = merged.warnings.filter(item => !/No product title/i.test(item));
  }
  return merged;
}

function htmlToProductText($, pageTitle) {
  const clone = $.root().clone();
  clone.find('script, style, noscript').remove();
  clone.find('br, li, tr, p, h1, h2, h3, h4, h5, h6, div, section, table').each((_, node) => {
    const el = $(node);
    el.before('\n');
    el.after('\n');
  });
  return [
    pageTitle ? `# ${pageTitle}` : '',
    clone.text()
  ].filter(Boolean).join('\n');
}

function parseProductHtml(html, options = {}) {
  if (!cheerio || !html) return null;

  const $ = cheerio.load(String(html));
  $('script, style, noscript').remove();
  const rootText = $.root().text();
  const pageTitle = $('title').text() || '';
  const isDogged = /Page Not Found|we couldn't find that page|Looking for something\? We're sorry/i.test(pageTitle) ||
                   /we're sorry\. The Web address you entered is not a functioning page/i.test(rootText) ||
                   $('#g').length > 0 ||
                   /dogs-page|dogs_page/i.test(html) ||
                   /sorry_page/i.test(html);

  if (isDogged) {
    return {
      title: null,
      rating: null,
      review_count: null,
      price: null,
      basic_info: null,
      feature_bullets: [],
      average_rating: null,
      global_rating_count: null,
      total_review_count: null,
      rating_breakdown: null,
      histogram: null,
      reviews: [],
      top_review_count: 0,
      page_blocked: false,
      page_dogged: true,
      warnings: ['Amazon 商品页展示 404 或变狗，ASIN 疑似已被下架或不存在。'],
      raw_page_info_excerpt: String(html).slice(0, 3000)
    };
  }

  const title = normalizeProductTitle($('#productTitle').first().text()) ||
    normalizeProductTitle(firstCleanText($, ['#title', 'h1'])) ||
    normalizeAmazonPageTitle(pageTitle);
  const ratingText = firstCleanText($, [
    '#acrPopover .a-icon-alt',
    '#averageCustomerReviews .a-icon-alt',
    '[data-hook="average-star-rating"]',
    '[data-hook="rating-out-of-text"]',
    '#acrPopover [aria-hidden="true"].a-size-small.a-color-base'
  ]);
  const ratingMatch = String(ratingText || '').match(/([1-5](?:\.\d)?)/);
  const reviewCountText = cleanLine($('#acrCustomerReviewText').first().attr('aria-label') || $('#acrCustomerReviewText').first().text());
  const reviewCountMatch = reviewCountText.match(/([\d,]+)/);
  const reviewCount = reviewCountMatch ? parseInteger(reviewCountMatch[1]) : null;
  const aggregate = parseAggregateHtml(html);
  const reviewParsed = parseReviewHtml(html, {
    maxReviews: options.maxReviews ?? 5,
    maxBodyChars: options.maxBodyChars || 4000
  }) || { reviews: [], review_count: 0, warnings: [] };

  const parsed = {
    title,
    rating: ratingMatch ? Number(ratingMatch[1]) : aggregate.average_rating,
    review_count: reviewCount ?? aggregate.global_rating_count,
    price: parseProductPrice($),
    basic_info: parseProductBasicInfo($),
    feature_bullets: parseFeatureBullets($),
    average_rating: aggregate.average_rating ?? (ratingMatch ? Number(ratingMatch[1]) : null),
    global_rating_count: aggregate.global_rating_count ?? reviewCount,
    total_review_count: aggregate.total_review_count ?? (reviewCount ?? null) ?? (reviewParsed.reviews?.length ? reviewParsed.reviews.length : null),
    rating_breakdown: aggregate.rating_breakdown,
    histogram: aggregate.histogram,
    reviews: reviewParsed.reviews || [],
    top_review_count: Array.isArray(reviewParsed.reviews) ? reviewParsed.reviews.length : 0,
    variations: [],
    variation_count: 0,
    page_blocked: /Enter the characters you see below|not a robot|captcha|Robot Check/i.test(rootText),
    page_dogged: false,
    warnings: [
      ...(title ? [] : ['No product title was found on the Amazon detail page.']),
      ...((reviewParsed.warnings || []).filter(item => !/No review blocks/i.test(item)))
    ],
    raw_page_info_excerpt: String(html).slice(0, 3000)
  };

  if (!hasProductCoreFields(parsed) || !parsed.rating_breakdown || parsed.feature_bullets.length === 0) {
    const textFallback = parseProductPageInfo(htmlToProductText($, pageTitle), options);
    const merged = mergeProductParsedData(parsed, textFallback);
    if (merged?.page_blocked || merged?.page_dogged) return merged;
    return hasProductCoreFields(merged) ? merged : null;
  }

  return parsed;
}

function parseStructuredAmazonProduct(data, options = {}) {
  if (!data || typeof data !== 'object') return null;
  const maxReviews = Math.min(Math.max(Number(options.maxReviews) || 5, 0), 50);
  const maxBodyChars = Number(options.maxBodyChars) || 4000;
  const basicInfo = {};
  const allowedLabels = new Set(BASIC_INFO_LABELS.map(label => label.toLowerCase()));
  Object.entries(data.basic_info || {}).forEach(([key, value]) => {
    const label = cleanLine(key).replace(/:$/, '');
    const text = cleanReviewText(value, 240);
    if (label && text && allowedLabels.has(label.toLowerCase()) && !isIgnoredBasicInfoValue(text)) {
      basicInfo[label] = text;
    }
  });

  const ratingBreakdown = {};
  Object.entries(data.rating_breakdown || {}).forEach(([key, value]) => {
    const star = String(key).match(/([1-5])/)?.[1];
    if (star) setRatingBreakdownValue(ratingBreakdown, star, value);
  });

  const reviews = Array.isArray(data.reviews)
    ? data.reviews.slice(0, maxReviews).map(review => {
        const reviewed = parseReviewedLine(review.date);
        const body = cleanReviewText(review.body, maxBodyChars);
        if (!body) return null;
        const rating = Number(review.rating);
        return {
          rating: Number.isFinite(rating) ? rating : null,
          title: cleanReviewText(review.title, 240) || null,
          body,
          author: cleanReviewText(review.author, 120) || null,
          date: reviewed?.date || cleanLine(review.date) || null,
          region: reviewed?.region || null,
          verified_purchase: review.review_type === 'verified_purchase',
          review_type: review.review_type || 'direct_review',
          helpful_count: Number.isFinite(Number(review.helpful_count)) ? Number(review.helpful_count) : null,
          image_count: Number.isFinite(Number(review.image_count)) ? Number(review.image_count) : 0
        };
      }).filter(Boolean)
    : [];
  const variations = Array.isArray(data.variations)
    ? data.variations.map(item => {
        const dimension = cleanReviewText(item.dimension, 120);
        const options = Array.isArray(item.options)
          ? item.options.map(option => {
              const asin = normalizeAsin(option.asin);
              const value = cleanReviewText(option.value, 180);
              if (!asin || !value) return null;
              return {
                asin,
                value,
                selected: option.selected === true,
                available: option.available !== false
              };
            }).filter(Boolean)
          : [];
        if (!dimension || options.length === 0) return null;
        return {
          dimension,
          selected: cleanReviewText(item.selected, 180) || options.find(option => option.selected)?.value || null,
          option_count: options.length,
          options
        };
      }).filter(Boolean)
    : [];

  const rating = Number(data.rating);
  const reviewCount = Number(data.review_count);
  const parsed = {
    title: normalizeProductTitle(data.title),
    rating: Number.isFinite(rating) ? rating : null,
    review_count: Number.isFinite(reviewCount) ? reviewCount : null,
    price: cleanLine(data.price) || null,
    basic_info: Object.keys(basicInfo).length > 0 ? basicInfo : null,
    feature_bullets: Array.isArray(data.feature_bullets)
      ? data.feature_bullets.map(item => cleanReviewText(item, 1200)).filter(Boolean).slice(0, 12)
      : [],
    average_rating: Number.isFinite(rating) ? rating : null,
    global_rating_count: Number.isFinite(reviewCount) ? reviewCount : null,
    total_review_count: Number.isFinite(reviewCount) ? reviewCount : (reviews.length || null),
    rating_breakdown: finalizeRatingBreakdown(ratingBreakdown),
    histogram: ratingBreakdownToHistogram(ratingBreakdown),
    reviews,
    top_review_count: reviews.length,
    variations,
    variation_count: variations.reduce((total, item) => total + item.options.length, 0),
    page_blocked: false,
    page_dogged: false,
    warnings: [],
    raw_page_info_excerpt: ''
  };

  return hasProductCoreFields(parsed) || parsed.rating_breakdown || parsed.reviews.length > 0 || parsed.variations.length > 0 ? parsed : null;
}

function parseProductTableData(tableData, options = {}) {
  const rowBasicInfo = parseBasicInfoFromTableRows(tableData?.rows);
  const structuredParsed = parseStructuredAmazonProduct(tableData?.amazon_product, options);
  const htmlParsed = tableData?.html ? parseProductHtml(tableData.html, options) : null;
  const parsed = mergeProductParsedData(htmlParsed, structuredParsed);
  if (!parsed) {
    if (!options.allowBasicInfoOnly) return null;
    return rowBasicInfo ? {
      title: null,
      rating: null,
      review_count: null,
      price: null,
      basic_info: rowBasicInfo,
      feature_bullets: [],
      average_rating: null,
      global_rating_count: null,
      total_review_count: null,
      rating_breakdown: null,
      histogram: null,
      reviews: [],
      top_review_count: 0,
      variations: [],
      variation_count: 0,
      page_blocked: false,
      page_dogged: false,
      warnings: [],
      raw_page_info_excerpt: ''
    } : null;
  }
  if (rowBasicInfo) {
    parsed.basic_info = { ...(parsed.basic_info || {}), ...rowBasicInfo };
  }
  if (!parsed.page_blocked && !parsed.page_dogged && !hasProductCoreFields(parsed)) {
    return null;
  }
  return parsed;
}

function isIgnoredBasicInfoValue(value) {
  return /^(Features & Specs|Measurements|Item details|User guide|Additional details|Warranty & Support)$/i.test(cleanLine(value));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseInlineBasicInfoLine(line, labels) {
  const matches = [];
  labels.forEach(label => {
    const pattern = new RegExp(`(^|\\s)(${escapeRegExp(label)})\\s*[:：]?\\s+`, 'ig');
    let match;
    while ((match = pattern.exec(line)) !== null) {
      matches.push({
        label,
        labelStart: match.index + match[1].length,
        valueStart: pattern.lastIndex
      });
    }
  });

  matches.sort((a, b) => a.labelStart - b.labelStart);
  const info = {};
  matches.forEach((item, index) => {
    const next = matches[index + 1];
    const value = cleanReviewText(line.slice(item.valueStart, next ? next.labelStart : line.length), 240);
    if (value && value.toLowerCase() !== item.label.toLowerCase() && !isIgnoredBasicInfoValue(value)) {
      info[item.label] = value;
    }
  });
  return info;
}

function parseBasicInfoFromLines(lines) {
  const aboutIndex = lines.findIndex(line => /^About this item$/i.test(line));
  const scanLines = (aboutIndex >= 0 ? lines.slice(0, aboutIndex) : lines)
    .map(line => {
      const text = cleanLine(line);
      const aboutMatches = [...text.matchAll(/\bAbout this item\b/gi)];
      if (aboutMatches.length === 0) return text;
      return text.slice(0, aboutMatches[aboutMatches.length - 1].index).trim();
    })
    .filter(Boolean);
  const labels = BASIC_INFO_LABELS;
  const info = {};
  scanLines.forEach((line, index) => {
    const inlineInfo = parseInlineBasicInfoLine(line, labels);
    if (Object.keys(inlineInfo).length > 0) {
      Object.assign(info, inlineInfo);
      return;
    }
    for (const label of labels) {
      const sameLine = line.match(new RegExp(`^${label}\\s*[:：]?\\s+(.+)$`, 'i'));
      if (sameLine) {
        const value = cleanReviewText(sameLine[1], 240);
        if (value && value.toLowerCase() !== label.toLowerCase() && !isIgnoredBasicInfoValue(value)) info[label] = value;
        return;
      }
      if (line.toLowerCase() === label.toLowerCase()) {
        const value = cleanReviewText(scanLines[index + 1], 240);
        if (value && value.toLowerCase() !== label.toLowerCase() && !isIgnoredBasicInfoValue(value)) info[label] = value;
        return;
      }
    }
  });
  return Object.keys(info).length > 0 ? info : null;
}

function splitAmazonBulletText(text) {
  const source = cleanReviewText(text, 3000);
  if (!source) return [];
  const cleanBullet = value => cleanReviewText(
    String(value || '').replace(/(?:Report an issue with this product or seller|Customer reviews|Products related to this item|Similar items|Customers also bought|Frequently bought together)[\s\S]*$/i, ''),
    1200
  );
  const bracketPattern = /(?:^|\s)(【[^】]{2,80}】\s*[-–—:]?\s*)/g;
  const bracketMatches = [];
  let bracketMatch;
  while ((bracketMatch = bracketPattern.exec(source)) !== null) {
    bracketMatches.push({
      start: bracketMatch.index + (bracketMatch[0].startsWith(' ') ? 1 : 0)
    });
  }

  if (bracketMatches.length >= 2) {
    return bracketMatches
      .map((item, index) => {
        const next = bracketMatches[index + 1];
        return cleanBullet(source.slice(item.start, next ? next.start : source.length));
      })
      .filter(item => item.length >= 20)
      .slice(0, 8);
  }

  const headingPattern = /(?:^|\s)([A-Z][A-Za-z0-9 &/+-]{2,48})\s*[:：]\s*/g;
  const matches = [];
  let match;
  while ((match = headingPattern.exec(source)) !== null) {
    matches.push({
      heading: match[1].trim(),
      start: match.index + (match[0].startsWith(' ') ? 1 : 0),
      bodyStart: headingPattern.lastIndex
    });
  }

  if (matches.length < 2) return [source];

  return matches
    .map((item, index) => {
      const next = matches[index + 1];
      return cleanBullet(source.slice(item.start, next ? next.start : source.length));
    })
    .filter(item => item.length >= 20)
    .slice(0, 8);
}

function isFeatureBulletNoise(text) {
  return /^(Report an issue with this product or seller|Similar items|Not interested|Customers also bought|Based on products|This item:|These items are shipped|Products related|Sponsored|Frequently bought together|Compare with similar|Looking for specific info|Alexa AI)\b/i.test(cleanLine(text));
}

function extractFeatureBulletsFromStart(lines, start) {
  const stopPattern = /^(Report an issue with this product or seller|Product information|Customer reviews|Videos|From the manufacturer|Product Description|Important information|Looking for specific info|Compare with similar items|Top reviews|Products related|Similar items|Customers also bought|Frequently bought together)/i;
  const bullets = [];
  for (let i = start + 1; i < lines.length && bullets.length < 8; i++) {
    const line = cleanReviewText(lines[i], 4000);
    if (!line) continue;
    if (stopPattern.test(line)) break;
    if (/^(See more product details|Make sure this fits|Enter your model number|›)$/i.test(line)) continue;
    if (isFeatureBulletNoise(line)) continue;
    if (line.length < 20) continue;
    const split = splitAmazonBulletText(line).filter(item => !isFeatureBulletNoise(item));
    split.forEach(item => {
      if (bullets.length < 8) bullets.push(item);
    });
    if (split.length >= 2) break;
  }
  return bullets;
}

function parseFeatureBulletsFromText(text) {
  const source = cleanReviewText(text, 12000);
  if (!source) return [];

  const starts = [];
  const startRe = /About this item/gi;
  let startMatch;
  while ((startMatch = startRe.exec(source)) !== null) {
    starts.push(startMatch.index + startMatch[0].length);
  }

  const stopRe = /\b(?:See more product details|Product information|From the brand|Product description|Customer reviews|Products related to this item|Important information|Looking for specific info|Videos)\b/gi;
  for (const start of starts) {
    stopRe.lastIndex = start;
    const stopMatch = stopRe.exec(source);
    const segment = cleanReviewText(source.slice(start, stopMatch ? stopMatch.index : source.length), 4000);
    if (!segment || segment.length < 40) continue;
    if (/^(Buying options|Videos|Reviews|Keyboard shortcuts)\b/i.test(segment)) continue;
    const bullets = splitAmazonBulletText(segment)
      .filter(item => !/^(Buying options|Videos|Reviews|Keyboard shortcuts|Search alt|Cart shift|Home shift|Orders shift)\b/i.test(item))
      .filter(item => !isFeatureBulletNoise(item));
    if (bullets.length >= 2) return bullets;
  }
  return [];
}

function parseFeatureBulletsFromLines(lines) {
  const startIndexes = [];
  lines.forEach((line, index) => {
    if (/^About this item$/i.test(line)) startIndexes.push(index);
  });
  for (const start of startIndexes) {
    const bullets = extractFeatureBulletsFromStart(lines, start);
    if (bullets.length >= 2) return bullets;
  }
  return parseFeatureBulletsFromText(lines.join(' '));
}

function parseProductPageInfo(pageInfo, options = {}) {
  const rawText = String(pageInfo || '');
  const rawLines = rawText.split(/\r?\n/);
  const lines = rawLines.map(cleanLine).filter(Boolean);
  const pageTitleLine = rawLines.find(line => /^#\s+/.test(String(line || '').trim())) || '';
  const pageTitle = String(pageTitleLine).replace(/^#\s+/, '').trim();
  const joined = lines.join(' ');
  const pageBlocked = /Enter the characters you see below|not a robot|captcha|Robot Check/i.test(rawText);
  const isDogged = /Page Not Found|we couldn't find that page|Looking for something\? We're sorry/i.test(rawText) ||
    /we're sorry\. The Web address you entered is not a functioning page/i.test(rawText) ||
    /dogs-page|dogs_page/i.test(rawText) ||
    /sorry_page/i.test(rawText);

  if (isDogged) {
    return {
      title: null,
      rating: null,
      review_count: null,
      price: null,
      basic_info: null,
      feature_bullets: [],
      average_rating: null,
      global_rating_count: null,
      total_review_count: null,
      rating_breakdown: null,
      histogram: null,
      reviews: [],
      top_review_count: 0,
      page_blocked: pageBlocked,
      page_dogged: true,
      warnings: ['Amazon 商品页展示 404 或变狗，ASIN 疑似已被下架或不存在。'],
      raw_page_info_excerpt: rawText.slice(0, 3000)
    };
  }

  const aggregate = parseAggregate(lines);
  const reviewParsed = parseReviews(rawText, {
    maxReviews: options.maxReviews ?? 5,
    maxBodyChars: options.maxBodyChars || 4000
  });
  const title = normalizeAmazonPageTitle(pageTitle) ||
    normalizeAmazonPageTitle(lines.find(line =>
      line.length >= 20 &&
      line.length <= 500 &&
      !/^URL:|^\[|^Amazon\.com$|^Skip to|^Search Amazon/i.test(line) &&
      /\b[A-Za-z]{3,}\b/.test(line)
    ));
  const ratingMatch = joined.match(/([1-5](?:\.\d)?)\s+out of\s+5/i) ||
    joined.match(/\b([1-5](?:\.\d)?)\s+stars?\b/i);
  const reviewCountMatch = joined.match(/([\d,]+)\s+(?:global\s+)?ratings?/i) ||
    joined.match(/([\d,]+)\s+reviews?/i);

  const parsed = {
    title: title || null,
    rating: ratingMatch ? Number(ratingMatch[1]) : aggregate.average_rating,
    review_count: reviewCountMatch ? parseInteger(reviewCountMatch[1]) : aggregate.global_rating_count,
    price: parsePriceText(joined),
    basic_info: parseBasicInfoFromLines(lines),
    feature_bullets: parseFeatureBulletsFromLines(lines),
    average_rating: aggregate.average_rating ?? (ratingMatch ? Number(ratingMatch[1]) : null),
    global_rating_count: aggregate.global_rating_count ?? (reviewCountMatch ? parseInteger(reviewCountMatch[1]) : null),
    total_review_count: aggregate.total_review_count ?? (reviewCountMatch ? parseInteger(reviewCountMatch[1]) : null) ?? (reviewParsed.reviews?.length ? reviewParsed.reviews.length : null),
    rating_breakdown: aggregate.rating_breakdown,
    histogram: aggregate.histogram,
    reviews: reviewParsed.reviews || [],
    top_review_count: Array.isArray(reviewParsed.reviews) ? reviewParsed.reviews.length : 0,
    page_blocked: pageBlocked,
    page_dogged: false,
    warnings: [],
    raw_page_info_excerpt: rawText.slice(0, 3000)
  };
  if (!hasProductCoreFields(parsed)) {
    parsed.warnings.push('No product fields were found in Amazon page_info fallback.');
  }
  return parsed;
}

function buildProductSummary({ asin, url, parsed }) {
  const lines = [];
  lines.push('# Amazon product extraction result');
  lines.push('');
  lines.push(`- ASIN: ${asin}`);
  lines.push(`- URL: ${url}`);
  if (parsed.title) lines.push(`- Title: ${parsed.title}`);
  if (parsed.price) lines.push(`- Price: ${parsed.price}`);
  if (parsed.rating) lines.push(`- Rating: ${parsed.rating}`);
  if (parsed.review_count) lines.push(`- Reviews: ${parsed.review_count}`);
  if (parsed.rating_breakdown) {
    const breakdown = [5, 4, 3, 2, 1]
      .map(star => parsed.rating_breakdown[`${star}_star`] !== undefined ? `${star} star ${parsed.rating_breakdown[`${star}_star`]}%` : null)
      .filter(Boolean)
      .join('; ');
    if (breakdown) lines.push(`- Rating breakdown: ${breakdown}`);
  }
  if (parsed.feature_bullets?.length > 0) {
    lines.push('');
    lines.push('## Feature bullets');
    parsed.feature_bullets.slice(0, 5).forEach((bullet, index) => {
      lines.push(`${index + 1}. ${bullet}`);
    });
  }
  if (parsed.reviews?.length > 0) {
    lines.push('');
    lines.push('## Top reviews');
    parsed.reviews.slice(0, 5).forEach((review, index) => {
      lines.push(`${index + 1}. ${review.title || '(no title)'}${review.rating ? ` - ${review.rating} stars` : ''}`);
    });
  }
  return lines.join('\n');
}

function isRealReviewImageUrl(url) {
  const value = String(url || '');
  if (!value) return false;
  if (/grey-pixel|transparent-pixel|\/default\.png|amazon-avatars-global\/default|\/x-locale\/common\//i.test(value)) return false;
  return /^https?:\/\/.+/i.test(value) || value.startsWith('//');
}

function isReviewImage($, img) {
  const el = $(img);
  const alt = cleanLine(el.attr('alt'));
  return el.is('[data-hook="review-image-tile"], .review-image-tile') ||
    /Customer image/i.test(alt) ||
    el.closest('[data-hook="review-image-container"], .review-image-container').length > 0;
}

function findRatingIndex(lines, dateIndex, previousDateIndex) {
  const min = Math.max(previousDateIndex + 1, dateIndex - 30);
  for (let i = dateIndex - 1; i >= min; i--) {
    if (isRatingLine(lines[i])) return i;
  }
  return -1;
}

function findAuthor(lines, ratingIndex, previousDateIndex) {
  const min = Math.max(previousDateIndex + 1, ratingIndex - 4);
  for (let i = ratingIndex - 1; i >= min; i--) {
    const text = cleanReviewText(lines[i], 120).replace(/^By\s+/i, '');
    if (!text || isSkipLine(text) || isRatingLine(text) || isReviewDateLine(text)) continue;
    if (text.length > 80) continue;
    return text;
  }
  return null;
}

function parseHelpfulCount(lines, start, end) {
  for (let i = start; i <= end; i++) {
    const text = cleanLine(lines[i]);
    if (/^One person found this helpful$/i.test(text)) return 1;
    const match = text.match(/^([\d,]+)\s+people found this helpful$/i);
    if (match) return parseInteger(match[1]);
  }
  return null;
}

function splitTrailingReviewTitle(body, title) {
  const text = cleanReviewText(String(body || '').replace(/(?:无标题按钮\s*)+/g, ' '), 4000);
  if (!text || title) return { body: text, title };

  const patterns = [
    /^(.*[.!?])\s+(?:Amazon|Kindle)\s+Customer\s+(.{3,120})$/i,
    /^(.*)\s+(?:Amazon|Kindle)\s+Customer\s+(.{3,120})$/i,
    /^(.*[.!?])\s+[A-Z][A-Z]+(?:\s+[A-Z]\.)?\s+(.{3,120})$/,
    /^(.*[.!?])\s+[A-Z][A-Za-z0-9._'’-]{1,30}\s+([A-Z][a-z][^.!?]{3,120})$/,
    /^(.*[.!?])\s+[A-Z][A-Za-z0-9._'’-]{1,30}(?:\s+(?![A-Z]{2,}\b)[A-Z][A-Za-z0-9._'’-]{1,30})?\s+(.{3,120})$/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const candidateBody = cleanReviewText(match[1], 4000);
    const candidateTitle = cleanReviewText(match[2], 240);
    const titleWordCount = candidateTitle.split(/\s+/).filter(Boolean).length;
    if (
      candidateBody.length >= 20 &&
      candidateTitle.length >= 3 &&
      candidateTitle.length <= 120 &&
      titleWordCount <= 12 &&
      /^[A-Z0-9"“'’]/.test(candidateTitle) &&
      !/^(Verified Purchase|Report|Helpful|Customer reviews)$/i.test(candidateTitle)
    ) {
      return { body: candidateBody, title: candidateTitle };
    }
  }

  return { body: text, title };
}

function extractReviewBody(lines, start, end, options = {}) {
  const body = [];
  const metadata = {};
  for (let i = start; i <= end; i++) {
    let text = cleanLine(lines[i]);
    if (!text) continue;

    if (/^Vine Customer Review(?: of Free Product)?\b/i.test(text)) {
      metadata.vine = true;
      metadata.review_type = 'vine';
      text = cleanLine(text.replace(/^Vine Customer Review(?: of Free Product)?\s*/i, ''));
      if (!text) continue;
    }

    if (/^Verified Purchase\b/i.test(text)) {
      metadata.verified_purchase = true;
      text = cleanLine(text.replace(/^Verified Purchase\s*/i, ''));
      if (!text) continue;
    } else if (/\bVerified Purchase\b/i.test(text)) {
      metadata.verified_purchase = true;
    }

    const variantText = text.replace(/\|\s*Verified Purchase\b[\s\S]*$/i, '').replace(/\bVerified Purchase\b[\s\S]*$/i, '').trim();
    const variant = parseVariantText(variantText);
    if (Object.keys(variant).length > 0) {
      metadata.variant = metadata.variant || {};
      Object.assign(metadata.variant, variant);
      if (isMetadataLine(variantText)) continue;
    }
    if (isMetadataLine(text) || isSkipLine(text)) continue;
    if (isRatingLine(text) || isReviewDateLine(text)) continue;
    body.push(cleanReviewText(text));
  }
  return {
    body: cleanReviewText(body.join('\n').trim(), Number(options.maxBodyChars) || 4000),
    metadata
  };
}

function getNextReviewStart(lines, dateIndexes, reviewIndex) {
  const nextDate = dateIndexes[reviewIndex + 1];
  if (nextDate === undefined) return lines.length;
  const ratingIndex = findRatingIndex(lines, nextDate, dateIndexes[reviewIndex]);
  if (ratingIndex >= 0) {
    const possibleAuthor = cleanLine(lines[ratingIndex - 1]);
    if (possibleAuthor && possibleAuthor.length <= 80 && !isSkipLine(possibleAuthor) && !isReviewDateLine(possibleAuthor)) {
      return ratingIndex - 1;
    }
    return ratingIndex;
  }
  return nextDate;
}

function parseReviews(pageInfo, options = {}) {
  const maxReviews = Math.min(Math.max(Number(options.maxReviews) || 10, 1), 50);
  const rawText = String(pageInfo || '');
  const lines = rawText.split(/\r?\n/).map(cleanLine).filter(Boolean);
  const dateIndexes = [];
  const warnings = [];

  const pageBlocked = /Enter the characters you see below|not a robot|captcha|Robot Check/i.test(rawText);
  const isDogged = /Page Not Found|we couldn't find that page|Looking for something\? We're sorry/i.test(rawText) ||
                   /we're sorry\. The Web address you entered is not a functioning page/i.test(rawText) ||
                   /dogs-page|dogs_page/i.test(rawText) ||
                   /sorry_page/i.test(rawText);

  if (isDogged) {
    return {
      average_rating: null,
      global_rating_count: null,
      total_review_count: null,
      rating_breakdown: null,
      histogram: null,
      reviews: [],
      review_count: 0,
      page_blocked: pageBlocked,
      page_dogged: true,
      warnings: ['Amazon 评论页展示 404 或变狗，ASIN 疑似已被下架或不存在。'],
      raw_page_info_excerpt: rawText.slice(0, 3000)
    };
  }

  lines.forEach((line, index) => {
    if (isReviewDateLine(line)) dateIndexes.push(index);
  });

  const reviews = [];
  const seen = new Set();
  for (let i = 0; i < dateIndexes.length && reviews.length < maxReviews; i++) {
    const dateIndex = dateIndexes[i];
    const previousDateIndex = i > 0 ? dateIndexes[i - 1] : -1;
    const ratingIndex = findRatingIndex(lines, dateIndex, previousDateIndex);
    const reviewed = parseReviewedLine(lines[dateIndex]);
    const ratingTitle = ratingIndex >= 0 ? parseRatingTitle(lines[ratingIndex]) : null;
    const nextStart = getNextReviewStart(lines, dateIndexes, i);
    const betweenRatingAndDate = ratingIndex >= 0 ? lines.slice(ratingIndex + 1, dateIndex).filter(line => !isSkipLine(line)) : [];
    const title = cleanReviewText(ratingTitle?.title || betweenRatingAndDate.find(line => line.length <= 160 && !/^By\s+/i.test(line)) || '', 240) || null;
    const extracted = extractReviewBody(lines, dateIndex + 1, nextStart - 1, options);
    const splitTitle = splitTrailingReviewTitle(extracted.body, title);
    const body = splitTitle.body;
    const cleanTitle = splitTitle.title || title;
    const key = `${ratingTitle?.rating || ''}|${cleanTitle || ''}|${reviewed?.date || ''}|${body.slice(0, 120)}`;
    if (!body || seen.has(key)) continue;
    seen.add(key);

    reviews.push({
      rating: ratingTitle?.rating || null,
      title: cleanTitle,
      body,
      author: ratingIndex >= 0 ? cleanReviewText(findAuthor(lines, ratingIndex, previousDateIndex), 120) || null : null,
      date: reviewed?.date || null,
      region: reviewed?.region || null,
      verified_purchase: extracted.metadata.verified_purchase === true,
      review_type: extracted.metadata.review_type || (extracted.metadata.verified_purchase === true ? 'verified_purchase' : 'direct_review'),
      variant: extracted.metadata.variant || undefined,
      helpful_count: parseHelpfulCount(lines, dateIndex + 1, nextStart - 1),
      image_count: 0
    });
  }
  if (pageBlocked) warnings.push('Amazon page appears to be blocked by CAPTCHA or robot check.');
  if (dateIndexes.length === 0) warnings.push('No Amazon review blocks were found in page text.');
  if (reviews.length === 0 && dateIndexes.length > 0) warnings.push('Review dates were found, but no clean review body could be extracted.');

  return {
    ...parseAggregate(lines),
    reviews,
    review_count: reviews.length,
    page_blocked: pageBlocked,
    page_dogged: false,
    warnings,
    raw_page_info_excerpt: rawText.slice(0, 3000)
  };
}

function buildSummary({ asin, url, parsed }) {
  const lines = [];
  lines.push('# Amazon review extraction result');
  lines.push('');
  lines.push(`- ASIN: ${asin}`);
  lines.push(`- URL: ${url}`);
  if (parsed.average_rating) lines.push(`- Average rating: ${parsed.average_rating}`);
  if (parsed.global_rating_count) lines.push(`- Global ratings: ${parsed.global_rating_count}`);
  if (parsed.total_review_count) lines.push(`- Reviews: ${parsed.total_review_count}`);
  if (parsed.rating_breakdown) {
    const breakdown = [5, 4, 3, 2, 1]
      .map(star => parsed.rating_breakdown[`${star}_star`] !== undefined ? `${star} star ${parsed.rating_breakdown[`${star}_star`]}%` : null)
      .filter(Boolean)
      .join('; ');
    if (breakdown) lines.push(`- Rating breakdown: ${breakdown}`);
  }
  lines.push(`- Extracted reviews: ${parsed.review_count}`);
  if (parsed.reviews.length > 0) {
    lines.push('');
    lines.push('## Review samples');
    parsed.reviews.forEach((review, index) => {
      const meta = [
        review.rating ? `${review.rating} stars` : null,
        review.date,
        review.verified_purchase ? 'Verified Purchase' : null
      ].filter(Boolean).join('; ');
      lines.push(`${index + 1}. ${review.title || '(no title)'}${meta ? ` - ${meta}` : ''}`);
      lines.push(`   ${review.body.slice(0, 220)}`);
    });
  }
  return lines.join('\n');
}

module.exports = {
  normalizeReviewArgs,
  normalizeProductArgs,
  buildReviewUrl,
  buildProductUrl,
  parseReviewTableData,
  parseAggregateTableData,
  parseProductTableData,
  parseProductHtml,
  parseProductPageInfo,
  hasProductCoreFields,
  parseReviews,
  buildSummary,
  buildProductSummary,
  normalizeAsin
};
