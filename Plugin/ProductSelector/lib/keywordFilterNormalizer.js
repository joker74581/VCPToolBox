const { parseBoolean, parseNumber, toArray } = require('./filterNormalizer');
const { KEYWORD_DEPARTMENTS, DEFAULT_KEYWORD_DEPARTMENTS } = require('./sites/sellersprite');

const CONTROL_KEYS = new Set([
  'command',
  'maid',
  'site',
  'criteria',
  'filters',
  'tool_name',
  'toolName',
  'requireAdmin',
  'authCode',
  'require_admin',
  'auth_code',
  'auto_login',
  'autoLogin',
  'strict_filters',
  'strictFilters',
  'maxCandidates',
  'force_login',
  'forceLogin',
  'login_timeout',
  'open_timeout',
  'wait_timeout',
  'page_info_timeout',
  'login_ttl_hours',
  'loginTtlHours',
  'cleanup_tabs',
  'cleanupTabs',
  'wait_text',
  'timeout',
  'extract_table',
  'extractTable',
  'table_selector',
  'tableSelector',
  'include_table_html',
  'includeTableHtml',
  'table_extract_timeout',
  'tableExtractTimeout',
  'debug'
]);

const SUPPORTED_KEYWORD_FILTERS = [
  'station',
  'month',
  'departments',
  'minSearches',
  'maxSearches',
  'minYearlyGrowth',
  'maxYearlyGrowth',
  'minGrowthTrendMin',
  'maxGrowthTrendMin',
  'withYearlyGrowth',
  'minProducts',
  'maxProducts',
  'minPurchases',
  'maxPurchases',
  'minImpressions',
  'maxImpressions',
  'minSPR',
  'maxSPR',
  'minGoodsValue',
  'maxGoodsValue',
  'minAvgPrice',
  'maxAvgPrice',
  'minAvgReviews',
  'maxAvgReviews',
  'minWordCount',
  'maxWordCount',
  'minGrowth',
  'maxGrowth',
  'minYearlyGrowthRate',
  'maxYearlyGrowthRate',
  'minGrowthRateTrendMin',
  'maxGrowthRateTrendMin',
  'marketPeriod',
  'minSupplyDemandRatio',
  'maxSupplyDemandRatio',
  'minPurchaseRate',
  'maxPurchaseRate',
  'minClicks',
  'maxClicks',
  'minTitleDensity',
  'maxTitleDensity',
  'minMonopolyClickRate',
  'maxMonopolyClickRate',
  'minCvsShareRate',
  'maxCvsShareRate',
  'minBid',
  'maxBid',
  'minAvgRating',
  'maxAvgRating',
  'includeKeywords',
  'excludeKeywords',
  'orderField',
  'orderDesc',
  'keywordBidMatchType'
];

const SUPPORTED_KEYWORD_CONVERSION_RATE_FILTERS = [
  'station',
  'marketId',
  'reverseType',
  'keywordList',
  'keywordMatchType',
  'bidMatchType',
  'minSearches',
  'maxSearches',
  'minClicks',
  'maxClicks',
  'minPurchases',
  'maxPurchases',
  'minSearchConvRate',
  'maxSearchConvRate',
  'minClickConvRate',
  'maxClickConvRate',
  'minPpc',
  'maxPpc',
  'minCpa',
  'maxCpa',
  'minProductPrice',
  'maxProductPrice',
  'minAcos',
  'maxAcos',
  'minClickingRate',
  'maxClickingRate',
  'minConversionRate',
  'maxConversionRate',
  'minPhraseCount',
  'maxPhraseCount'
];

const DIRECT_ALIASES = new Map([
  ['station', 'station'],
  ['market', 'station'],
  ['site_market', 'station'],
  ['siteMarket', 'station'],
  ['站点', 'station'],
  ['市场', 'station'],
  ['month', 'month'],
  ['月份', 'month'],
  ['数据月份', 'month'],
  ['departments', 'departments'],
  ['department', 'departments'],
  ['categories', 'departments'],
  ['category', 'departments'],
  ['类目', 'departments'],
  ['分类', 'departments'],
  ['minSearches', 'minSearches'],
  ['maxSearches', 'maxSearches'],
  ['min_searches', 'minSearches'],
  ['max_searches', 'maxSearches'],
  ['月搜索量最小值', 'minSearches'],
  ['月搜索量最大值', 'maxSearches'],
  ['minYearlyGrowth', 'minYearlyGrowth'],
  ['maxYearlyGrowth', 'maxYearlyGrowth'],
  ['minGrowthTrendMin', 'minGrowthTrendMin'],
  ['maxGrowthTrendMin', 'maxGrowthTrendMin'],
  ['withYearlyGrowth', 'withYearlyGrowth'],
  ['minProducts', 'minProducts'],
  ['maxProducts', 'maxProducts'],
  ['minPurchases', 'minPurchases'],
  ['maxPurchases', 'maxPurchases'],
  ['minImpressions', 'minImpressions'],
  ['maxImpressions', 'maxImpressions'],
  ['minSPR', 'minSPR'],
  ['maxSPR', 'maxSPR'],
  ['minGoodsValue', 'minGoodsValue'],
  ['maxGoodsValue', 'maxGoodsValue'],
  ['minAvgPrice', 'minAvgPrice'],
  ['maxAvgPrice', 'maxAvgPrice'],
  ['minPrice', 'minAvgPrice'],
  ['maxPrice', 'maxAvgPrice'],
  ['minAvgReviews', 'minAvgReviews'],
  ['maxAvgReviews', 'maxAvgReviews'],
  ['minReviews', 'minAvgReviews'],
  ['maxReviews', 'maxAvgReviews'],
  ['minWordCount', 'minWordCount'],
  ['maxWordCount', 'maxWordCount'],
  ['minGrowth', 'minGrowth'],
  ['maxGrowth', 'maxGrowth'],
  ['minYearlyGrowthRate', 'minYearlyGrowthRate'],
  ['maxYearlyGrowthRate', 'maxYearlyGrowthRate'],
  ['minGrowthRateTrendMin', 'minGrowthRateTrendMin'],
  ['maxGrowthRateTrendMin', 'maxGrowthRateTrendMin'],
  ['marketPeriod', 'marketPeriod'],
  ['minSupplyDemandRatio', 'minSupplyDemandRatio'],
  ['maxSupplyDemandRatio', 'maxSupplyDemandRatio'],
  ['minPurchaseRate', 'minPurchaseRate'],
  ['maxPurchaseRate', 'maxPurchaseRate'],
  ['minClicks', 'minClicks'],
  ['maxClicks', 'maxClicks'],
  ['minTitleDensity', 'minTitleDensity'],
  ['maxTitleDensity', 'maxTitleDensity'],
  ['minMonopolyClickRate', 'minMonopolyClickRate'],
  ['maxMonopolyClickRate', 'maxMonopolyClickRate'],
  ['minCvsShareRate', 'minCvsShareRate'],
  ['maxCvsShareRate', 'maxCvsShareRate'],
  ['minBid', 'minBid'],
  ['maxBid', 'maxBid'],
  ['minAvgRating', 'minAvgRating'],
  ['maxAvgRating', 'maxAvgRating'],
  ['minReviewRating', 'minAvgRating'],
  ['maxReviewRating', 'maxAvgRating'],
  ['includeKeywords', 'includeKeywords'],
  ['include_keywords', 'includeKeywords'],
  ['包含关键词', 'includeKeywords'],
  ['输入关键词', 'includeKeywords'],
  ['excludeKeywords', 'excludeKeywords'],
  ['exclude_keywords', 'excludeKeywords'],
  ['排除关键词', 'excludeKeywords'],
  ['否定关键词', 'excludeKeywords'],
  ['orderField', 'orderField'],
  ['orderDesc', 'orderDesc'],
  ['keywordBidMatchType', 'keywordBidMatchType']
]);

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[()（）]/g, '')
    .replace(/\s*&\s*/g, '&')
    .replace(/\s+/g, ' ');
}

function buildDepartmentAliases() {
  const map = new Map();
  for (const item of KEYWORD_DEPARTMENTS) {
    map.set(normalizeKey(item.slug), item.slug);
    map.set(normalizeKey(item.label), item.slug);
    for (const alias of item.aliases || []) {
      map.set(normalizeKey(alias), item.slug);
    }
  }
  return map;
}

const DEPARTMENT_ALIASES = buildDepartmentAliases();

function normalizeStation(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim().toUpperCase();
  if (['美国', '美国站', '美区', 'US', 'USA', 'AMAZON.COM'].includes(text)) return 'US';
  if (['日本', '日本站', '日区', 'JP', 'AMAZON.CO.JP'].includes(text)) return 'JP';
  if (['英国', '英国站', '英区', 'UK', 'GB', 'AMAZON.CO.UK'].includes(text)) return 'UK';
  if (['德国', '德国站', '德区', 'DE', 'AMAZON.DE'].includes(text)) return 'DE';
  if (['法国', '法国站', '法区', 'FR', 'AMAZON.FR'].includes(text)) return 'FR';
  if (['意大利', '意大利站', '意区', 'IT', 'AMAZON.IT'].includes(text)) return 'IT';
  if (['西班牙', '西班牙站', '西区', 'ES', 'AMAZON.ES'].includes(text)) return 'ES';
  if (['加拿大', '加拿大站', '加区', 'CA', 'AMAZON.CA'].includes(text)) return 'CA';
  if (['印度', '印度站', '印区', 'IN', 'AMAZON.IN'].includes(text)) return 'IN';
  return text;
}

function marketIdForStation(station) {
  const normalized = normalizeStation(station);
  if (normalized === 'US') return 1;
  if (normalized === 'JP') return 2;
  if (normalized === 'UK') return 3;
  if (normalized === 'DE') return 4;
  if (normalized === 'FR') return 5;
  if (normalized === 'IT') return 6;
  if (normalized === 'ES') return 7;
  if (normalized === 'CA') return 8;
  if (normalized === 'IN') return 9;
  return undefined;
}

function splitDepartmentText(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value.map(String).map(item => item.trim()).filter(Boolean);
  const text = String(value).trim();
  if (!text) return undefined;
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(String).map(item => item.trim()).filter(Boolean);
    } catch (_) {
      // fall through
    }
  }
  if (DEPARTMENT_ALIASES.has(normalizeKey(text))) return [text];
  const primaryParts = text.split(/[，、;；|/]/).map(item => item.trim()).filter(Boolean);
  const items = [];

  for (const part of primaryParts) {
    if (DEPARTMENT_ALIASES.has(normalizeKey(part)) || !part.includes(',')) {
      items.push(part);
      continue;
    }

    const tokens = part.split(',').map(item => item.trim()).filter(Boolean);
    let index = 0;
    while (index < tokens.length) {
      let matched = null;
      let matchedEnd = index + 1;
      for (let end = tokens.length; end > index; end--) {
        const candidate = tokens.slice(index, end).join(', ');
        if (DEPARTMENT_ALIASES.has(normalizeKey(candidate))) {
          matched = candidate;
          matchedEnd = end;
          break;
        }
      }
      if (matched) {
        items.push(matched);
        index = matchedEnd;
      } else {
        items.push(tokens[index]);
        index += 1;
      }
    }
  }

  return items;
}

function normalizeDepartments(value) {
  const parts = splitDepartmentText(value);
  if (!parts) return { values: undefined, unknown: [] };

  const values = [];
  const unknown = [];
  for (const part of parts) {
    const normalized = normalizeKey(part);
    const resolved = DEPARTMENT_ALIASES.get(normalized);
    if (resolved === 'any' || ['all', 'all categories', '全部类目', '所有类目', '全类目'].includes(normalized)) {
      values.push(...DEFAULT_KEYWORD_DEPARTMENTS);
    } else if (resolved) {
      values.push(resolved);
    } else {
      unknown.push(part);
    }
  }

  return {
    values: values.length > 0 ? Array.from(new Set(values)) : undefined,
    unknown
  };
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_) {
      return {};
    }
  }
  return {};
}

function assignFilter(filters, key, value, unknownFilters) {
  if (value === undefined || value === null || value === '') return;
  if (key === 'station') {
    filters.station = normalizeStation(value);
    const marketId = marketIdForStation(filters.station);
    if (marketId !== undefined) filters.marketId = marketId;
    return;
  }
  if (key === 'departments') {
    const normalized = normalizeDepartments(value);
    if (normalized.values) filters.departments = normalized.values;
    for (const item of normalized.unknown) {
      unknownFilters.push({ field: 'departments', value: item, source: 'argument', reason: 'unknown_keyword_department' });
    }
    return;
  }
  if (key === 'orderDesc' || key === 'withYearlyGrowth') {
    filters[key] = parseBoolean(value, key === 'orderDesc');
    return;
  }
  if (['includeKeywords', 'excludeKeywords', 'orderField', 'keywordBidMatchType', 'marketPeriod', 'month'].includes(key)) {
    filters[key] = String(value).trim();
    if (key === 'orderField') {
      filters[key] = filters[key].toLowerCase();
    }
    return;
  }
  if (SUPPORTED_KEYWORD_FILTERS.includes(key)) {
    const parsed = parseNumber(value);
    if (parsed !== undefined) filters[key] = parsed;
  }
}

function applyObjectFilters(filters, raw, unknownFilters) {
  for (const [rawKey, value] of Object.entries(raw || {})) {
    const canonical = DIRECT_ALIASES.get(rawKey) || DIRECT_ALIASES.get(String(rawKey).trim());
    if (canonical) {
      assignFilter(filters, canonical, value, unknownFilters);
    } else if (!CONTROL_KEYS.has(rawKey)) {
      unknownFilters.push({ field: rawKey, value, source: 'argument' });
    }
  }
}

function parseRange(text, labelPattern) {
  const regex = new RegExp(`${labelPattern}[^\\d]{0,12}(\\d+(?:\\.\\d+)?)[\\s到至~\\-—]+(\\d+(?:\\.\\d+)?)`, 'i');
  const match = text.match(regex);
  if (!match) return null;
  return { min: Number(match[1]), max: Number(match[2]) };
}

function parseSingleBound(text, labelPattern) {
  const maxRegex = new RegExp(`${labelPattern}[^\\d]{0,12}(?:小于|少于|低于|不超过|以内|以下|<=|≤|max)[^\\d]{0,8}(\\d+(?:\\.\\d+)?)|${labelPattern}[^\\d]{0,12}(\\d+(?:\\.\\d+)?)[^\\d]{0,8}(?:以内|以下)`, 'i');
  const minRegex = new RegExp(`${labelPattern}[^\\d]{0,12}(?:大于|超过|高于|不少于|不低于|以上|起|>=|≥|min)[^\\d]{0,8}(\\d+(?:\\.\\d+)?)|${labelPattern}[^\\d]{0,12}(\\d+(?:\\.\\d+)?)[^\\d]{0,8}(?:以上|起步)`, 'i');
  const minMatch = text.match(minRegex);
  if (minMatch) return { type: 'min', value: Number(minMatch[1] || minMatch[2]) };
  const maxMatch = text.match(maxRegex);
  if (maxMatch) return { type: 'max', value: Number(maxMatch[1] || maxMatch[2]) };
  return null;
}

function setFilterIfMissing(filters, key, value) {
  if (value === undefined || value === null || value === '') return;
  if (filters[key] === undefined) filters[key] = value;
}

function applyRangeCriteria(filters, text, labelPattern, minKey, maxKey) {
  const range = parseRange(text, labelPattern);
  if (range) {
    setFilterIfMissing(filters, minKey, range.min);
    setFilterIfMissing(filters, maxKey, range.max);
    return;
  }
  const bound = parseSingleBound(text, labelPattern);
  if (bound?.type === 'min') setFilterIfMissing(filters, minKey, bound.value);
  if (bound?.type === 'max') setFilterIfMissing(filters, maxKey, bound.value);
}

function applyCriteriaText(filters, criteria) {
  const text = String(criteria || '').trim();
  if (!text) return;

  if (/美国站|美国|美区|\bUS\b|\bUSA\b/i.test(text)) {
    filters.station = filters.station || 'US';
    filters.marketId = filters.marketId || 1;
  }

  applyRangeCriteria(filters, text, '(?:月搜索量同比增长值|搜索量同比增长值)', 'minYearlyGrowth', 'maxYearlyGrowth');
  applyRangeCriteria(filters, text, '(?:月搜索量近3个月增长值|搜索量近3个月增长值|近3个月增长值)', 'minGrowthTrendMin', 'maxGrowthTrendMin');
  applyRangeCriteria(filters, text, '(?:月搜索量同比增长率|搜索量同比增长率)', 'minYearlyGrowthRate', 'maxYearlyGrowthRate');
  applyRangeCriteria(filters, text, '(?:月搜索量近3个月增长率|搜索量近3个月增长率|近3个月增长率)', 'minGrowthRateTrendMin', 'maxGrowthRateTrendMin');
  applyRangeCriteria(filters, text, '(?:月搜索量增长率|搜索量增长率)', 'minGrowth', 'maxGrowth');
  applyRangeCriteria(filters, text, '(?:月搜索量(?![^,，;；。]*增长)|搜索量(?![^,，;；。]*增长)|search(?:es)?)', 'minSearches', 'maxSearches');
  applyRangeCriteria(filters, text, '(?:商品数|产品数|products)', 'minProducts', 'maxProducts');
  applyRangeCriteria(filters, text, '(?:购买量|purchases)', 'minPurchases', 'maxPurchases');
  applyRangeCriteria(filters, text, '(?:展示量|impressions)', 'minImpressions', 'maxImpressions');
  applyRangeCriteria(filters, text, '(?:\\bSPR\\b|SPR)', 'minSPR', 'maxSPR');
  applyRangeCriteria(filters, text, '(?:货流值|goods value)', 'minGoodsValue', 'maxGoodsValue');
  applyRangeCriteria(filters, text, '(?:价格|均价|price)', 'minAvgPrice', 'maxAvgPrice');
  applyRangeCriteria(filters, text, '(?:评分数|评论数|评价数|reviews?)', 'minAvgReviews', 'maxAvgReviews');
  applyRangeCriteria(filters, text, '(?:单词个数|词数|word count)', 'minWordCount', 'maxWordCount');
  applyRangeCriteria(filters, text, '(?:评分值|评分|星级|rating)', 'minAvgRating', 'maxAvgRating');
  applyRangeCriteria(filters, text, '(?:PPC竞价|竞价|bid)', 'minBid', 'maxBid');
  applyRangeCriteria(filters, text, '(?:需供比|供需比|supply demand)', 'minSupplyDemandRatio', 'maxSupplyDemandRatio');
  applyRangeCriteria(filters, text, '(?:购买率|purchase rate)', 'minPurchaseRate', 'maxPurchaseRate');
  applyRangeCriteria(filters, text, '(?:点击量|clicks?)', 'minClicks', 'maxClicks');
  applyRangeCriteria(filters, text, '(?:标题密度|title density)', 'minTitleDensity', 'maxTitleDensity');

  const include = text.match(/(?:包含关键词|输入关键词|包含词|include keywords?)[:：\s]+([^\s,，;；]+)/i);
  if (include) setFilterIfMissing(filters, 'includeKeywords', include[1]);
  const exclude = text.match(/(?:排除关键词|否定关键词|排除词|exclude keywords?)[:：\s]+([^\s,，;；]+)/i);
  if (exclude) setFilterIfMissing(filters, 'excludeKeywords', exclude[1]);
}

function normalizeKeywordArgs(args = {}) {
  const filters = {};
  const unknownFilters = [];
  const warnings = [];
  const strictFilters = parseBoolean(args.strict_filters ?? args.strictFilters, true);

  const nestedFilters = parseJsonObject(args.filters);
  applyObjectFilters(filters, nestedFilters, unknownFilters);
  applyObjectFilters(filters, args, unknownFilters);
  applyCriteriaText(filters, args.criteria);

  return {
    filters,
    unknown_filters: unknownFilters,
    warnings,
    strict_filters: strictFilters,
    needs_clarification: strictFilters && unknownFilters.length > 0,
    suggested_supported_filters: SUPPORTED_KEYWORD_FILTERS
  };
}

function normalizeKeywordReverseArgs(args = {}) {
  const filters = {};
  const warnings = [];
  
  const nestedFilters = parseJsonObject(args.filters);
  const qInputs = [
    nestedFilters.q,
    nestedFilters.asin,
    nestedFilters.asins,
    args.q,
    args.asin,
    args.asins
  ].filter(value => value !== undefined && value !== null && value !== '');
  const asinMatches = [];
  const seenAsins = new Set();
  for (const input of qInputs) {
    const values = Array.isArray(input) ? input : [input];
    for (const value of values) {
      const matches = String(value || '').match(/\b[A-Z0-9]{10}\b/gi) || [];
      for (const match of matches) {
        const asin = match.toUpperCase();
        if (!seenAsins.has(asin)) {
          seenAsins.add(asin);
          asinMatches.push(asin);
        }
      }
    }
  }
  const rawQ = qInputs.length > 0 ? qInputs[0] : '';
  const q = asinMatches[0] || String(rawQ).trim().toUpperCase();
  
  if (!q) {
    warnings.push('缺少 ASIN 或查询词 q。');
  }
  if (asinMatches.length > 1) {
    warnings.push(`关键词反查一次只支持 1 个 ASIN；收到 ${asinMatches.length} 个：${asinMatches.join(', ')}。请拆成多次调用。`);
  }

  const stationInput = nestedFilters.market || nestedFilters.station || args.market || args.station || 'US';
  const station = normalizeStation(stationInput);
  const marketId = marketIdForStation(station) || Number(nestedFilters.marketId || args.marketId) || 1;
  let date = String(nestedFilters.date ?? args.date ?? '').trim();
  if (/^\d{6}$/.test(date)) {
    date = `${date.slice(0, 4)}-${date.slice(4, 6)}`;
  }
  
  let badges = nestedFilters.badges !== undefined ? nestedFilters.badges : args.badges;
  
  function normalizeBadges(badgesInput) {
    if (badgesInput === undefined || badgesInput === null || badgesInput === '') {
      return 'NATURAL_SEARCHING,AMAZON_CHOICE,EDITORIAL_RECOMMENDATIONS,FOUR_STAR,SPONSOR_BRAND,SPONSOR_VIDEO,HIGHLY_RATED,ADS';
    }
    let list = [];
    if (Array.isArray(badgesInput)) {
      list = badgesInput.join(',').split(',').map(s => s.trim());
    } else {
      list = String(badgesInput).split(',').map(s => s.trim());
    }
    const tokenMap = {
      'sp': 'ADS',
      'sp广告': 'ADS',
      'ads': 'ADS',
      'ad': 'ADS',
      'sp_ads': 'ADS',
      '自然': 'NATURAL_SEARCHING',
      'natural': 'NATURAL_SEARCHING',
      'natural_searching': 'NATURAL_SEARCHING',
      '品牌': 'SPONSOR_BRAND',
      '品牌广告': 'SPONSOR_BRAND',
      'sb': 'SPONSOR_BRAND',
      'sponsor_brand': 'SPONSOR_BRAND',
      '视频': 'SPONSOR_VIDEO',
      '视频广告': 'SPONSOR_VIDEO',
      'video': 'SPONSOR_VIDEO',
      'sponsor_video': 'SPONSOR_VIDEO',
      'ac': 'AMAZON_CHOICE',
      'amazon_choice': 'AMAZON_CHOICE',
      'er': 'EDITORIAL_RECOMMENDATIONS',
      'editorial_recommendations': 'EDITORIAL_RECOMMENDATIONS',
      'four_star': 'FOUR_STAR',
      '4星': 'FOUR_STAR',
      'highly_rated': 'HIGHLY_RATED',
      '广告': 'SPONSOR_BRAND,SPONSOR_VIDEO,ADS',
      '广告词': 'SPONSOR_BRAND,SPONSOR_VIDEO,ADS',
      '投放': 'SPONSOR_BRAND,SPONSOR_VIDEO,ADS',
      '投放词': 'SPONSOR_BRAND,SPONSOR_VIDEO,ADS',
      '自然搜索': 'NATURAL_SEARCHING,AMAZON_CHOICE,EDITORIAL_RECOMMENDATIONS,FOUR_STAR,HIGHLY_RATED',
      '自然搜索词': 'NATURAL_SEARCHING,AMAZON_CHOICE,EDITORIAL_RECOMMENDATIONS,FOUR_STAR,HIGHLY_RATED',
      '自然词': 'NATURAL_SEARCHING,AMAZON_CHOICE,EDITORIAL_RECOMMENDATIONS,FOUR_STAR,HIGHLY_RATED',
      'ac推荐': 'AMAZON_CHOICE',
      'ac推荐词': 'AMAZON_CHOICE',
      'ac词': 'AMAZON_CHOICE'
    };
    const expandedList = [];
    for (const item of list) {
      if (!item) continue;
      const clean = item.toLowerCase().replace(/_/g, '').trim();
      let mapped = null;
      for (const key in tokenMap) {
        const cleanKey = key.toLowerCase().replace(/_/g, '');
        if (clean === cleanKey) {
          mapped = tokenMap[key];
          break;
        }
      }
      if (mapped) {
        expandedList.push(...mapped.split(','));
      } else {
        expandedList.push(item.toUpperCase());
      }
    }
    return [...new Set(expandedList)].join(',');
  }

  badges = normalizeBadges(badges);

  filters.q = q;
  filters.marketId = marketId;
  filters.date = date;
  filters.badges = badges;

  return {
    filters,
    warnings,
    needs_clarification: !q || asinMatches.length > 1
  };
}

function normalizeKeywordList(value) {
  if (value === undefined || value === null || value === '') return '';
  const raw = Array.isArray(value) ? value : String(value).split(/[\n,，;；]+/);
  return raw
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 1000)
    .join(',');
}

function normalizeKeywordConversionRatePeriod(value) {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return 'W';
  if (['W', 'WEEK', 'WEEKLY', '周', '按周', '近7天'].includes(text)) return 'W';
  if (['90D', '90', 'D90', '近90天', '90天', '3个月', '三个月'].includes(text)) return '90D';
  return text;
}

function normalizeBidMatchType(value) {
  if (value === undefined || value === null || value === '') return 1;
  const text = String(value).trim().toLowerCase();
  if (['1', 'exact', '精准', '精确'].includes(text)) return 1;
  if (['2', 'phrase', '词组'].includes(text)) return 2;
  if (['3', 'broad', '广泛'].includes(text)) return 3;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 1;
}

function assignKeywordConversionRateFilter(filters, key, value, unknownFilters) {
  if (value === undefined || value === null || value === '') return;
  if (key === 'station') {
    const station = normalizeStation(value);
    const marketId = marketIdForStation(station);
    if (marketId !== undefined) filters.marketId = marketId;
    return;
  }
  if (key === 'marketId') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) filters.marketId = parsed;
    return;
  }
  if (key === 'reverseType') {
    filters.reverseType = normalizeKeywordConversionRatePeriod(value);
    return;
  }
  if (key === 'keywordList') {
    filters.keywordList = normalizeKeywordList(value);
    return;
  }
  if (key === 'keywordMatchType') {
    filters.keywordMatchType = String(value).trim() || 'all';
    return;
  }
  if (key === 'bidMatchType') {
    filters.bidMatchType = normalizeBidMatchType(value);
    return;
  }
  if (SUPPORTED_KEYWORD_CONVERSION_RATE_FILTERS.includes(key)) {
    const parsed = parseNumber(value);
    if (parsed !== undefined) filters[key] = parsed;
    return;
  }
  unknownFilters.push({ field: key, value, source: 'argument' });
}

function normalizeKeywordConversionRateArgs(args = {}) {
  const filters = {
    marketId: 1,
    reverseType: 'W',
    bidMatchType: 1,
    keywordMatchType: 'all',
    keywordList: ''
  };
  const unknownFilters = [];
  const warnings = [];
  const strictFilters = parseBoolean(args.strict_filters ?? args.strictFilters, true);
  const nestedFilters = parseJsonObject(args.filters);
  const aliases = new Map([
    ['station', 'station'],
    ['market', 'station'],
    ['marketId', 'marketId'],
    ['market_id', 'marketId'],
    ['reverseType', 'reverseType'],
    ['type', 'reverseType'],
    ['period', 'reverseType'],
    ['timeRange', 'reverseType'],
    ['关键词', 'keywordList'],
    ['keyword', 'keywordList'],
    ['keywords', 'keywordList'],
    ['keywordList', 'keywordList'],
    ['keyword_list', 'keywordList'],
    ['keywordMatchType', 'keywordMatchType'],
    ['keyword_match_type', 'keywordMatchType'],
    ['bidMatchType', 'bidMatchType'],
    ['bid_match_type', 'bidMatchType'],
    ['ppcMatchType', 'bidMatchType'],
    ['ppc_match_type', 'bidMatchType'],
    ['minPPC', 'minPpc'],
    ['maxPPC', 'maxPpc'],
    ['minPpc', 'minPpc'],
    ['maxPpc', 'maxPpc'],
    ['minCPA', 'minCpa'],
    ['maxCPA', 'maxCpa'],
    ['minCpa', 'minCpa'],
    ['maxCpa', 'maxCpa'],
    ['minACOS', 'minAcos'],
    ['maxACOS', 'maxAcos'],
    ['minAcos', 'minAcos'],
    ['maxAcos', 'maxAcos']
  ]);

  function apply(raw) {
    for (const [rawKey, value] of Object.entries(raw || {})) {
      const snakeCamel = String(rawKey).replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      const canonical = aliases.get(rawKey) || aliases.get(String(rawKey).trim()) || (SUPPORTED_KEYWORD_CONVERSION_RATE_FILTERS.includes(snakeCamel) ? snakeCamel : rawKey);
      if (SUPPORTED_KEYWORD_CONVERSION_RATE_FILTERS.includes(canonical) || aliases.has(rawKey)) {
        assignKeywordConversionRateFilter(filters, canonical, value, unknownFilters);
      } else if (!CONTROL_KEYS.has(rawKey)) {
        unknownFilters.push({ field: rawKey, value, source: 'argument' });
      }
    }
  }

  apply(nestedFilters);
  apply(args);

  const rawKeywords = filters.keywordList
    ? String(filters.keywordList).split(',').map(item => String(item || '').trim()).filter(Boolean)
    : [];
  const allowMultiKeywords = parseBoolean(args.allow_multi_keywords ?? args.allowMultiKeywords, false);

  if (!filters.keywordList) {
    warnings.push('缺少 keywordList/keywords。关键词转化率查询至少需要 1 个关键词，最多 1000 个。');
  }

  if (!allowMultiKeywords && rawKeywords.length > 1) {
    warnings.push('关键词转化率默认只允许单词单查。检测到多个关键词时，请拆成多次调用；只有在明确允许多词同查时才传 allow_multi_keywords=true。');
  }

  return {
    filters,
    unknown_filters: unknownFilters,
    warnings,
    strict_filters: strictFilters,
    needs_clarification: !filters.keywordList || (!allowMultiKeywords && rawKeywords.length > 1) || (strictFilters && unknownFilters.length > 0),
    keyword_count: rawKeywords.length,
    allow_multi_keywords: allowMultiKeywords,
    suggested_supported_filters: SUPPORTED_KEYWORD_CONVERSION_RATE_FILTERS
  };
}

module.exports = {
  SUPPORTED_KEYWORD_FILTERS,
  SUPPORTED_KEYWORD_CONVERSION_RATE_FILTERS,
  normalizeKeywordArgs,
  normalizeKeywordReverseArgs,
  normalizeKeywordConversionRateArgs,
  normalizeDepartments,
  normalizeStation,
  marketIdForStation
};
