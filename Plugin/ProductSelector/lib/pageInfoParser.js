function cleanLine(line) {
  return String(line || '').replace(/\s+/g, ' ').trim();
}

function parseInteger(value) {
  if (!value) return null;
  const normalized = String(value).replace(/[,，]/g, '');
  const parsed = parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOptionalLimit(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function applyOptionalLimit(items = [], limit) {
  return limit ? items.slice(0, limit) : items;
}

function hasReachedOptionalLimit(items = [], limit) {
  return Boolean(limit) && items.length >= limit;
}

function extractResultCount(pageInfo) {
  const text = String(pageInfo || '');
  if (detectNoResults(pageInfo)) return 0;

  const explicit = text.match(/搜索结果数[^\d]{0,10}([\d,，]+)/);
  if (explicit) return parseInteger(explicit[1]);

  const pagination = text.match(/(?:^|\s)(\d+)\s*[-~—]\s*(\d+)\s*\/\s*([\d,，]+)/m);
  if (pagination) return parseInteger(pagination[3]);

  const total = text.match(/共\s*([\d,，]+)\s*(?:个|条|件)?/);
  if (total) return parseInteger(total[1]);

  return null;
}

function detectNoResults(pageInfo) {
  const text = String(pageInfo || '');
  return /很抱歉[，,]?\s*暂无结果|暂无结果|暂无数据|没有找到相关结果|No results found/i.test(text);
}

function extractPagination(pageInfo) {
  const text = String(pageInfo || '');
  const pagination = text.match(/(\d+)\s*[-~—]\s*(\d+)\s*\/\s*([\d,，]+)/);
  if (!pagination) return null;

  return {
    from: parseInteger(pagination[1]),
    to: parseInteger(pagination[2]),
    total: parseInteger(pagination[3])
  };
}

function extractCandidates(pageInfo, limit) {
  const text = String(pageInfo || '');
  const lines = text.split(/\r?\n/).map(cleanLine).filter(Boolean);
  const asinRegex = /\b(B0[A-Z0-9]{8})\b/g;
  const seen = new Set();
  const candidates = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const matches = [...line.matchAll(asinRegex)];
    if (matches.length === 0) continue;

    for (const match of matches) {
      const asin = match[1];
      if (seen.has(asin)) continue;
      seen.add(asin);

      const contextLines = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4));
      const inlineTitle = cleanLine(line.replace(asin, '')).replace(/[-|｜:：]+$/g, '').trim();
      const titleLine = inlineTitle.length >= 8
        ? inlineTitle
        : contextLines.find(item =>
        item !== line &&
        !/vcp-id-|https?:\/\//i.test(item) &&
        item.length >= 8 &&
        !/标题|分页|搜索结果数|导出|复制ASIN|下一页|上一页/.test(item)
      );

      candidates.push({
        asin,
        title: titleLine || null,
        evidence: contextLines.join(' | ').slice(0, 500)
      });

      if (hasReachedOptionalLimit(candidates, limit)) return candidates;
    }
  }

  return candidates;
}

function parsePageInfo(pageInfo, options = {}) {
  const maxCandidates = normalizeOptionalLimit(options.maxCandidates);
  const noResults = detectNoResults(pageInfo);
  const resultCount = extractResultCount(pageInfo);
  const pagination = extractPagination(pageInfo);
  const candidates = noResults ? [] : extractCandidates(pageInfo, maxCandidates);
  const rawText = String(pageInfo || '');

  return {
    result_count: resultCount,
    pagination,
    candidates,
    no_results: noResults,
    empty_result: noResults,
    raw_page_info_excerpt: rawText.slice(0, 3000)
  };
}

function extractKeywordCandidates(pageInfo, limit) {
  const text = String(pageInfo || '');
  const lines = text.split(/\r?\n/).map(cleanLine).filter(Boolean);
  const linkedCandidates = extractKeywordCandidatesFromLinks(text, lines, limit);
  if (linkedCandidates.length > 0) return linkedCandidates;

  const skipPattern = /^(精准|广泛|词组|月搜索量|搜索量|关键词|选择类目|导出|筛选|重置|上一页|下一页|全部类目|包含关键词|排除关键词|需供比 商品数|市场分析|操作)$/;
  const candidates = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < 2 || line.length > 120) continue;
    if (skipPattern.test(line)) continue;
    if (/https?:\/\//i.test(line) || /vcp-id-/i.test(line)) continue;
    if (/^\$?[\d,]+(?:\.\d+)?%?$/.test(line)) continue;
    if (/^SPR\s*[:：]\s*\d+/i.test(line)) continue;
    if (/^[A-Za-z &]+ \(\d+(?:\.\d+)?%\)$/.test(line)) continue;

    const context = lines.slice(i, Math.min(lines.length, i + 12));
    const numericCount = context.filter(item => /^[$]?\d[\d,]*(?:\.\d+)?%?$/.test(item) || /^[\d,]+$/.test(item)).length;
    if (numericCount < 2) continue;

    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      keyword: line,
      evidence: context.join(' | ').slice(0, 500)
    });
    if (hasReachedOptionalLimit(candidates, limit)) return candidates;
  }

  return candidates;
}

function isKeywordLinkText(value) {
  const text = cleanLine(value);
  if (!text || text.length < 2 || text.length > 120) return false;
  if (/^\$?\d[\d,]*(?:\.\d+)?%?$/.test(text)) return false;
  if (/^(精准|广泛|词组|导出|筛选|重置|市场分析|操作|详情|查看|上一页|下一页|全部类目)$/i.test(text)) return false;
  if (/^(https?:\/\/|www\.)/i.test(text)) return false;
  if (/^\.(?:jpg|jpeg|png|webp|gif)$/i.test(text)) return false;
  if (/^(png|jpg|jpeg|webp|gif|图片|image)$/i.test(text)) return false;
  return /[a-zA-Z\u4e00-\u9fa5]/.test(text);
}

function extractKeywordCandidatesFromLinks(rawText, lines, limit) {
  const linkRegex = /\[([^:\]]{1,20}):\s*([^\]]+?)\]\(vcp-id-\d+\)/g;
  const seen = new Set();
  const candidates = [];
  let match;

  while ((match = linkRegex.exec(rawText)) !== null) {
    const label = cleanLine(match[1]);
    if (!/^(链接|link)$/i.test(label)) continue;
    const keyword = cleanLine(match[2]);
    if (!isKeywordLinkText(keyword)) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const matchOffset = match.index;
    let currentOffset = 0;
    let lineIndex = 0;
    for (; lineIndex < lines.length; lineIndex++) {
      currentOffset += lines[lineIndex].length + 1;
      if (currentOffset >= matchOffset) break;
    }

    const contextLines = lines.slice(Math.max(0, lineIndex - 3), Math.min(lines.length, lineIndex + 10));
    const translation = contextLines.find(item =>
      item !== keyword &&
      !/^\[链接:/i.test(item) &&
      !/^\[可交互元素:/i.test(item) &&
      /[\u4e00-\u9fa5]/.test(item) &&
      item.length >= 2 &&
      item.length <= 80 &&
      !/(月搜索量|搜索量|需供比|商品数|市场分析|操作|选择类目|包含关键词|排除关键词)/.test(item)
    ) || null;

    candidates.push({
      keyword,
      translation,
      evidence: contextLines.join(' | ').slice(0, 500)
    });

    if (hasReachedOptionalLimit(candidates, limit)) return candidates;
  }

  return candidates;
}

function parseKeywordPageInfo(pageInfo, options = {}) {
  const maxCandidates = normalizeOptionalLimit(options.maxCandidates);
  const noResults = detectNoResults(pageInfo);
  const resultCount = extractResultCount(pageInfo);
  const pagination = extractPagination(pageInfo);
  const candidates = noResults ? [] : extractKeywordCandidates(pageInfo, maxCandidates);
  const rawText = String(pageInfo || '');

  return {
    result_count: resultCount,
    pagination,
    candidates,
    no_results: noResults,
    empty_result: noResults,
    raw_page_info_excerpt: rawText.slice(0, 3000)
  };
}

function extractMetricTokens(value) {
  const text = cleanLine(value);
  if (!text) return [];
  return text.match(/N\/A|-?\$?\d[\d,]*(?:\.\d+)?%?/gi) || [];
}

function joinGrowthPair(tokens, startIndex = 0) {
  const first = tokens[startIndex];
  const second = tokens[startIndex + 1];
  if (!first) return null;
  if (second) return `${first} (${second})`;
  return first;
}

function splitKeywordAndTranslation(value, fallbackKeyword) {
  const text = cleanLine(value);
  const keyword = cleanLine(fallbackKeyword);
  if (keyword) {
    return {
      keyword,
      translation: cleanLine(text.replace(keyword, '')) || null
    };
  }

  const firstCjkIndex = text.search(/[\u4e00-\u9fff]/);
  if (firstCjkIndex > 0) {
    return {
      keyword: cleanLine(text.slice(0, firstCjkIndex)),
      translation: cleanLine(text.slice(firstCjkIndex)) || null
    };
  }

  return {
    keyword: text,
    translation: null
  };
}

function parseDetailField(detail, label, nextLabels = []) {
  const text = cleanLine(detail);
  if (!text) return null;
  const labelIndex = text.indexOf(label);
  if (labelIndex < 0) return null;
  let start = labelIndex + label.length;
  while (text[start] === ':' || text[start] === '：' || /\s/.test(text[start] || '')) start++;
  let end = text.length;
  nextLabels.forEach(nextLabel => {
    const nextIndex = text.indexOf(nextLabel, start);
    if (nextIndex >= 0 && nextIndex < end) end = nextIndex;
  });
  return cleanLine(text.slice(start, end)) || null;
}

function findHeaderIndex(headers, matchers, fallback, mode = 'all') {
  const index = headers.findIndex(header => {
    if (mode === 'any') return matchers.some(matcher => matcher.test(header));
    return matchers.every(matcher => matcher.test(header));
  });
  return index >= 0 ? index : fallback;
}

function normalizeKeywordTableData(tableData, options = {}) {
  const maxCandidates = normalizeOptionalLimit(options.maxCandidates);
  const rows = Array.isArray(tableData?.rows) ? tableData.rows : [];
  if (rows.length > 0 && rows[0] && !Array.isArray(rows[0]) && rows[0].keyword) {
    return applyOptionalLimit(rows, maxCandidates);
  }

  const headers = Array.isArray(tableData?.headers) ? tableData.headers.map(cleanLine) : [];
  const indexes = {
    rank: findHeaderIndex(headers, [/^#$/], 1),
    keyword: findHeaderIndex(headers, [/keyword/i, /\u5173\u952e\u8bcd/], 2, 'any'),
    monthlySearches: findHeaderIndex(headers, [/\u6708\u641c\u7d22\u91cf/], 5),
    purchase: findHeaderIndex(headers, [/\u6708\u8d2d\u4e70\u91cf/, /\u8d2d\u4e70\u7387/], 6),
    impressions: findHeaderIndex(headers, [/\u5c55\u793a\u91cf/, /\u70b9\u51fb\u91cf/], 7),
    growth: findHeaderIndex(headers, [/\u589e\u957f\u7387/], 8),
    yearlyGrowth: findHeaderIndex(headers, [/\u540c\u6bd4\u589e\u957f/, /\u8fd13\u6708\u589e\u957f/], 9),
    abaShare: findHeaderIndex(headers, [/ABA/i, /\u96c6\u4e2d\u5ea6/], 10),
    abaRank: findHeaderIndex(headers, [/ABA/i, /\u6392\u540d/], 11),
    goodsValue: findHeaderIndex(headers, [/\u8d27\u6d41\u503c/], 12),
    ppc: findHeaderIndex(headers, [/PPC/i], 13),
    supply: findHeaderIndex(headers, [/\u9700\u4f9b\u6bd4/, /\u5546\u54c1\u6570/], 14),
    market: findHeaderIndex(headers, [/\u5e02\u573a\u5206\u6790/], 15)
  };

  return applyOptionalLimit(rows, maxCandidates).map((row, index) => {
    const values = Array.isArray(row) ? row : (Array.isArray(row?.values) ? row.values : []);
    const rowData = row?.data || {};
    const keywordParts = splitKeywordAndTranslation(values[indexes.keyword], rowData.keyword || rowData.clipboard);
    if (!keywordParts.keyword) return null;

    const searchTokens = extractMetricTokens(values[indexes.monthlySearches]);
    const purchaseTokens = extractMetricTokens(values[indexes.purchase]);
    const impressionTokens = extractMetricTokens(values[indexes.impressions]);
    const yearlyTokens = extractMetricTokens(values[indexes.yearlyGrowth]);
    const abaTokens = extractMetricTokens(values[indexes.abaShare]);
    const ppcTokens = extractMetricTokens(values[indexes.ppc]);
    const supplyTokens = extractMetricTokens(values[indexes.supply]);
    const marketTokens = extractMetricTokens(values[indexes.market]);
    const detail = row?.detail || '';

    return {
      rank: extractMetricTokens(values[indexes.rank])[0] || String(index + 1),
      keyword: keywordParts.keyword,
      translation: keywordParts.translation,
      monthly_searches: searchTokens[0] || null,
      daily_searches: searchTokens[1] || null,
      monthly_purchases: purchaseTokens[0] || null,
      purchase_rate: purchaseTokens[1] || null,
      impressions: impressionTokens[0] || null,
      clicks: impressionTokens[1] || null,
      growth_rate: extractMetricTokens(values[indexes.growth])[0] || null,
      yearly_growth: joinGrowthPair(yearlyTokens, 0),
      recent_3_month_growth: joinGrowthPair(yearlyTokens, 2),
      aba_click_share: abaTokens[0] || null,
      aba_conversion_share: abaTokens[1] || null,
      aba_rank: extractMetricTokens(values[indexes.abaRank])[0] || null,
      goods_value: extractMetricTokens(values[indexes.goodsValue])[0] || null,
      ppc_bid: {
        min: ppcTokens[0] || null,
        bid: ppcTokens[1] || null,
        max: ppcTokens[2] || null
      },
      supply_demand_ratio: supplyTokens[0] || null,
      products: supplyTokens[1] || null,
      avg_price: marketTokens[0] || null,
      avg_reviews: marketTokens[1] || null,
      avg_rating: marketTokens[2] || null,
      category: parseDetailField(detail, '\u6240\u5c5e\u7c7b\u76ee', ['\u5e02\u573a\u5468\u671f', 'SPR', '\u6807\u9898\u5bc6\u5ea6']),
      market_period: parseDetailField(detail, '\u5e02\u573a\u5468\u671f', ['SPR', '\u6807\u9898\u5bc6\u5ea6']),
      spr: parseDetailField(detail, 'SPR', ['\u6807\u9898\u5bc6\u5ea6']),
      title_density: parseDetailField(detail, '\u6807\u9898\u5bc6\u5ea6'),
      top_asins: Array.isArray(rowData.asins) ? rowData.asins : []
    };
  }).filter(Boolean);
}

function normalizeKeywordReverseTableData(tableData, options = {}) {
  const maxCandidates = normalizeOptionalLimit(options.maxCandidates);
  const rows = Array.isArray(tableData?.rows) ? tableData.rows : [];

  if (rows.length > 0 && rows[0] && !Array.isArray(rows[0]) && rows[0].keyword && !rows[0].values) {
    return applyOptionalLimit(rows, maxCandidates);
  }

  const headers = Array.isArray(tableData?.headers) ? tableData.headers.map(cleanLine) : [];

  const parseDecimal = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const normalized = String(value).replace(/[^0-9.-]/g, '');
    const parsed = parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const indexes = {
    rank: findHeaderIndex(headers, [/排名|^#$/], 1),
    keyword: findHeaderIndex(headers, [/关键词/], 2),
    traffic_share: findHeaderIndex(headers, [/流量占比/], 3),
    traffic_count: findHeaderIndex(headers, [/流量数/], -1),
    traffic_type: findHeaderIndex(headers, [/流量词类型/], 4),
    traffic_distribution: findHeaderIndex(headers, [/流量分布/], 5),
    organic_share: findHeaderIndex(headers, [/自然流量占比/], -1),
    ad_share: findHeaderIndex(headers, [/广告流量占比/], -1),
    organic_rank: findHeaderIndex(headers, [/自然排名/], 6),
    ad_rank: findHeaderIndex(headers, [/广告排名/], 7),
    aba_week_rank: findHeaderIndex(headers, [/ABA周排名|ABA排名/], 9),
    monthly_searches: findHeaderIndex(headers, [/月搜索量/], 10),
    daily_searches: findHeaderIndex(headers, [/日均搜索量|日搜索量/], -1),
    spr: findHeaderIndex(headers, [/^SPR$/i], 11),
    title_density: findHeaderIndex(headers, [/标题密度|标题/], 12),
    monthly_purchases: findHeaderIndex(headers, [/月购买量|购买量/], 13),
    purchase_rate: findHeaderIndex(headers, [/购买率|转化率/], -1),
    impressions: findHeaderIndex(headers, [/展示量|点击量/], 14),
    clicks: findHeaderIndex(headers, [/点击量|点击数/], -1),
    supply: findHeaderIndex(headers, [/需供比|商品数/], 15),
    supply_demand_ratio: findHeaderIndex(headers, [/需供比|供需/], -1),
    products: findHeaderIndex(headers, [/商品数|在线商品数/], -1),
    ad_competitors: findHeaderIndex(headers, [/广告竞品数|竞品数/], 16),
    aba_share: findHeaderIndex(headers, [/ABA集中度|集中度/], 17),
    aba_click_share: findHeaderIndex(headers, [/ABA点击集中度/], -1),
    aba_conversion_share: findHeaderIndex(headers, [/ABA转化集中度|转化集中/], -1),
    ppc: findHeaderIndex(headers, [/PPC竞价|竞价|PPC/i], 18),
    ppc_low: findHeaderIndex(headers, [/PPC低竞价|低竞价/], -1),
    ppc_mid: findHeaderIndex(headers, [/PPC中竞价|中竞价/], -1),
    ppc_high: findHeaderIndex(headers, [/PPC高竞价|高竞价/], -1)
  };

  if (indexes.traffic_count === indexes.traffic_share) indexes.traffic_count = -1;
  if (indexes.organic_share === indexes.traffic_distribution) indexes.organic_share = -1;
  if (indexes.ad_share === indexes.traffic_distribution) indexes.ad_share = -1;
  if (indexes.daily_searches === indexes.monthly_searches) indexes.daily_searches = -1;
  if (indexes.purchase_rate === indexes.monthly_purchases) indexes.purchase_rate = -1;
  if (indexes.clicks === indexes.impressions) indexes.clicks = -1;
  if (indexes.supply_demand_ratio === indexes.supply) indexes.supply_demand_ratio = -1;
  if (indexes.products === indexes.supply) indexes.products = -1;
  if (indexes.aba_click_share === indexes.aba_share) indexes.aba_click_share = -1;
  if (indexes.aba_conversion_share === indexes.aba_share) indexes.aba_conversion_share = -1;
  if (indexes.ppc_low === indexes.ppc) indexes.ppc_low = -1;
  if (indexes.ppc_mid === indexes.ppc) indexes.ppc_mid = -1;
  if (indexes.ppc_high === indexes.ppc) indexes.ppc_high = -1;

  return applyOptionalLimit(rows, maxCandidates).map((row, index) => {
    const values = Array.isArray(row) ? row : (Array.isArray(row?.values) ? row.values : []);
    if (values.length === 0) return null;

    const getVal = (idx) => {
      const val = values[idx];
      return val !== undefined ? cleanLine(val) : null;
    };

    const rowData = row?.data || {};
    const keywordParts = splitKeywordAndTranslation(values[indexes.keyword], rowData.keyword || rowData.clipboard);
    if (!keywordParts.keyword) return null;

    // 1. Traffic Share & Traffic Count
    let traffic_share_col = getVal(indexes.traffic_share) || '';
    if (traffic_share_col.includes('点击:') || traffic_share_col.includes('转化:')) {
      traffic_share_col = traffic_share_col.replace(/(?:点击|转化):\s*[\d.]+%?\s*/g, '').trim();
    }
    const trafficTokens = extractMetricTokens(traffic_share_col);
    const traffic_share = trafficTokens[0] || null;
    let traffic_count = null;
    if (indexes.traffic_count !== -1) {
      traffic_count = parseInteger(getVal(indexes.traffic_count));
    } else {
      traffic_count = parseInteger(trafficTokens[1]);
    }

    // 2. Traffic Distribution (Organic & Ad Share)
    const distrib_col = getVal(indexes.traffic_distribution);
    const distributionTokens = extractMetricTokens(distrib_col);
    let organic_share = null;
    let ad_share = null;
    if (indexes.organic_share !== -1) {
      organic_share = getVal(indexes.organic_share);
    } else {
      organic_share = distributionTokens[0] || null;
    }
    if (indexes.ad_share !== -1) {
      ad_share = getVal(indexes.ad_share);
    } else {
      ad_share = distributionTokens[1] || null;
    }

    // 3. Monthly Searches & Daily Searches
    const search_col = getVal(indexes.monthly_searches);
    const searchTokens = extractMetricTokens(search_col);
    const monthly_searches = parseInteger(searchTokens[0]);
    let daily_searches = null;
    if (indexes.daily_searches !== -1) {
      daily_searches = parseInteger(getVal(indexes.daily_searches));
    } else {
      daily_searches = parseInteger(searchTokens[1]);
    }

    // 4. Monthly Purchases & Purchase Rate
    const purchase_col = getVal(indexes.monthly_purchases);
    const purchaseTokens = extractMetricTokens(purchase_col);
    const monthly_purchases = parseInteger(purchaseTokens[0]);
    let purchase_rate = null;
    if (indexes.purchase_rate !== -1) {
      purchase_rate = getVal(indexes.purchase_rate);
    } else {
      purchase_rate = purchaseTokens[1] || null;
    }

    // 5. Impressions & Clicks
    const impression_col = getVal(indexes.impressions);
    const impressionTokens = extractMetricTokens(impression_col);
    const impressions = parseInteger(impressionTokens[0]);
    let clicks = null;
    if (indexes.clicks !== -1) {
      clicks = parseInteger(getVal(indexes.clicks));
    } else {
      clicks = parseInteger(impressionTokens[1]);
    }

    // 6. Supply/Demand Ratio & Products
    const supply_col = getVal(indexes.supply);
    const supplyTokens = extractMetricTokens(supply_col);
    let supply_demand_ratio = null;
    let products = null;
    if (indexes.supply_demand_ratio !== -1) {
      supply_demand_ratio = parseDecimal(getVal(indexes.supply_demand_ratio));
    } else {
      supply_demand_ratio = parseDecimal(supplyTokens[0]);
    }
    if (indexes.products !== -1) {
      products = parseInteger(getVal(indexes.products));
    } else {
      products = parseInteger(supplyTokens[1]);
    }

    // 7. ABA Click & Conversion Share
    let aba_share_col = getVal(indexes.aba_share) || '';
    if (aba_share_col.includes('点击:') || aba_share_col.includes('转化:')) {
      aba_share_col = aba_share_col.replace(/(?:点击|转化):\s*[\d.]+%?\s*/g, '').trim();
    }
    const abaShareTokens = extractMetricTokens(aba_share_col);
    let aba_click_share = null;
    let aba_conversion_share = null;
    if (indexes.aba_click_share !== -1) {
      aba_click_share = getVal(indexes.aba_click_share);
    } else {
      aba_click_share = abaShareTokens[0] || null;
    }
    if (indexes.aba_conversion_share !== -1) {
      aba_conversion_share = getVal(indexes.aba_conversion_share);
    } else {
      aba_conversion_share = abaShareTokens[1] || null;
    }

    // 8. PPC Bid
    const ppc_col = getVal(indexes.ppc);
    const ppcTokens = extractMetricTokens(ppc_col);
    let ppc_low_val = null;
    let ppc_mid_val = null;
    let ppc_high_val = null;
    if (indexes.ppc_low !== -1) {
      ppc_low_val = getVal(indexes.ppc_low);
    } else {
      ppc_low_val = ppcTokens[0];
    }
    if (indexes.ppc_mid !== -1) {
      ppc_mid_val = getVal(indexes.ppc_mid);
    } else {
      ppc_mid_val = ppcTokens[1];
    }
    if (indexes.ppc_high !== -1) {
      ppc_high_val = getVal(indexes.ppc_high);
    } else {
      ppc_high_val = ppcTokens[2];
    }

    const organicRankTokens = extractMetricTokens(getVal(indexes.organic_rank));
    const adRankTokens = extractMetricTokens(getVal(indexes.ad_rank));
    const abaWeekTokens = extractMetricTokens(getVal(indexes.aba_week_rank));

    const rank = parseInteger(getVal(indexes.rank)) || (index + 1);
    const organic_rank = parseInteger(organicRankTokens[0]);
    const ad_rank = parseInteger(adRankTokens[0]);
    const aba_week_rank = parseInteger(abaWeekTokens[0]);
    const spr = parseInteger(getVal(indexes.spr));
    const title_density = parseInteger(getVal(indexes.title_density));
    const ad_competitors = parseInteger(getVal(indexes.ad_competitors));
    const ppc_low = parseDecimal(ppc_low_val);
    const ppc_mid = parseDecimal(ppc_mid_val);
    const ppc_high = parseDecimal(ppc_high_val);

    const parsedRow = {
      rank,
      keyword: keywordParts.keyword,
      translation: keywordParts.translation,
      traffic_share,
      traffic_count,
      traffic_type: getVal(indexes.traffic_type),
      organic_share,
      ad_share,
      organic_rank,
      ad_rank,
      aba_week_rank,
      monthly_searches,
      daily_searches,
      spr,
      title_density,
      monthly_purchases,
      purchase_rate,
      impressions,
      clicks,
      supply_demand_ratio,
      products,
      ad_competitors,
      aba_click_share,
      aba_conversion_share,
      ppc_bid: { low: ppc_low, mid: ppc_mid, high: ppc_high }
    };

    // Sanitize the raw values array so that ordered_table doesn't confuse the Agent with mixed ABA text
    if (indexes.traffic_share !== -1 && values[indexes.traffic_share]) {
      if (parsedRow.traffic_count !== null) {
        values[indexes.traffic_share] = `${parsedRow.traffic_share || '-'} ${parsedRow.traffic_count}`;
      } else {
        values[indexes.traffic_share] = `${parsedRow.traffic_share || '-'}`;
      }
    }

    if (indexes.aba_share !== -1 && values[indexes.aba_share]) {
      if (parsedRow.aba_click_share !== null && parsedRow.aba_conversion_share !== null) {
        values[indexes.aba_share] = `${parsedRow.aba_click_share} ${parsedRow.aba_conversion_share}`;
      } else if (parsedRow.aba_click_share !== null) {
        values[indexes.aba_share] = `${parsedRow.aba_click_share}`;
      } else {
        values[indexes.aba_share] = `-`;
      }
    }

    return parsedRow;
  }).filter(Boolean);
}

function parseDecimalMetric(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).replace(/[^0-9.-]/g, '');
  const parsed = parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMoneyToken(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = parseDecimalMetric(value);
  return parsed === null ? null : parsed;
}

function normalizePercentToken(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = parseDecimalMetric(value);
  return parsed === null ? null : `${parsed}%`;
}

function extractImageUrls(value) {
  const text = String(value || '');
  const urls = [];
  const regex = /https?:\/\/[^"')\s]+/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const url = match[0].replace(/&quot;?$/i, '');
    if (/m\.media-amazon\.com/i.test(url) && !/image_loading|undefined/i.test(url) && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

function buildTopClickedAsins(cellValue, rowData = {}) {
  const visibleText = cleanLine(String(cellValue || '').replace(/<[^>]+>/g, ' '));
  const tokens = extractMetricTokens(visibleText).filter(token => /%$/.test(token));
  const clickShares = [];
  const conversionShares = [];
  for (let index = 0; index < tokens.length; index += 2) {
    if (tokens[index]) clickShares.push(tokens[index]);
    if (tokens[index + 1]) conversionShares.push(tokens[index + 1]);
  }

  const asins = Array.isArray(rowData.asins) ? rowData.asins : [];
  const imageUrls = Array.isArray(rowData.image_urls) ? rowData.image_urls : extractImageUrls(cellValue);
  const maxLength = Math.max(clickShares.length, conversionShares.length, asins.length, imageUrls.length);
  const result = [];
  for (let index = 0; index < maxLength && index < 3; index++) {
    result.push({
      asin: asins[index] || null,
      image_url: imageUrls[index] || null,
      click_share: clickShares[index] || null,
      conversion_share: conversionShares[index] || null
    });
  }
  return result;
}

function normalizeKeywordConversionRateTableData(tableData, options = {}) {
  const maxCandidates = normalizeOptionalLimit(options.maxCandidates);
  const rows = Array.isArray(tableData?.rows) ? tableData.rows : [];

  if (rows.length > 0 && rows[0] && !Array.isArray(rows[0]) && rows[0].keyword && !rows[0].values) {
    return applyOptionalLimit(rows, maxCandidates);
  }

  const headers = Array.isArray(tableData?.headers) ? tableData.headers.map(cleanLine) : [];
  const indexes = {
    rank: findHeaderIndex(headers, [/^#$/], 0),
    keyword: findHeaderIndex(headers, [/关键词/], 1),
    searches: findHeaderIndex(headers, [/搜索量/], 2),
    clicks: findHeaderIndex(headers, [/点击量/], 3),
    purchases: findHeaderIndex(headers, [/购买量/], 4),
    searchConvRate: findHeaderIndex(headers, [/搜索转化率/], 5),
    clickConvRate: findHeaderIndex(headers, [/点击转化率/], 6),
    ppc: findHeaderIndex(headers, [/PPC竞价|PPC/], 7),
    cpa: findHeaderIndex(headers, [/CPA/], 8),
    productPrice: findHeaderIndex(headers, [/产品均价|产品价格/], 9),
    acos: findHeaderIndex(headers, [/ACOS/], 10),
    adBudget: findHeaderIndex(headers, [/广告预算/], 11),
    aba: findHeaderIndex(headers, [/ABA集中度|集中度/], 12),
    topAsins: findHeaderIndex(headers, [/点击前三ASIN|前三ASIN/], 13)
  };

  return applyOptionalLimit(rows, maxCandidates).map((row, index) => {
    const values = Array.isArray(row) ? row : (Array.isArray(row?.values) ? row.values : []);
    if (values.length === 0) return null;
    const rowData = row?.data || {};
    const getVal = (idx) => {
      const val = values[idx];
      return val !== undefined ? cleanLine(val) : null;
    };
    const keywordParts = splitKeywordAndTranslation(values[indexes.keyword], rowData.keyword || rowData.clipboard);
    if (!keywordParts.keyword) return null;

    const ppcTokens = extractMetricTokens(getVal(indexes.ppc));
    const cpaTokens = extractMetricTokens(getVal(indexes.cpa));
    const priceTokens = extractMetricTokens(getVal(indexes.productPrice));
    const acosTokens = extractMetricTokens(getVal(indexes.acos));
    const abaTokens = extractMetricTokens(getVal(indexes.aba));
    const topAsinCell = getVal(indexes.topAsins);

    return {
      rank: parseInteger(getVal(indexes.rank)) || (index + 1),
      keyword: keywordParts.keyword,
      translation: keywordParts.translation,
      period_searches: parseInteger(getVal(indexes.searches)),
      period_clicks: parseInteger(getVal(indexes.clicks)),
      period_purchases: parseInteger(getVal(indexes.purchases)),
      search_conversion_rate: normalizePercentToken(getVal(indexes.searchConvRate)),
      click_conversion_rate: normalizePercentToken(getVal(indexes.clickConvRate)),
      ppc_bid: {
        low: normalizeMoneyToken(ppcTokens[0]),
        mid: normalizeMoneyToken(ppcTokens[1]),
        high: normalizeMoneyToken(ppcTokens[2])
      },
      cpa: {
        low: normalizeMoneyToken(cpaTokens[0]),
        mid: normalizeMoneyToken(cpaTokens[1]),
        high: normalizeMoneyToken(cpaTokens[2])
      },
      product_price: {
        low: normalizeMoneyToken(priceTokens[0]),
        avg: normalizeMoneyToken(priceTokens[1]),
        high: normalizeMoneyToken(priceTokens[2])
      },
      acos: {
        max: normalizePercentToken(acosTokens[0]),
        avg: normalizePercentToken(acosTokens[1]),
        min: normalizePercentToken(acosTokens[2])
      },
      ad_budget: normalizeMoneyToken(getVal(indexes.adBudget)),
      aba_concentration: {
        click_share: abaTokens[0] || null,
        conversion_share: abaTokens[1] || null
      },
      top_clicked_asins: buildTopClickedAsins(topAsinCell, rowData)
    };
  }).filter(Boolean);
}

module.exports = {
  parsePageInfo,
  parseKeywordPageInfo,
  extractResultCount,
  extractPagination,
  extractCandidates,
  extractKeywordCandidates,
  extractKeywordCandidatesFromLinks,
  normalizeKeywordTableData,
  normalizeKeywordReverseTableData,
  normalizeKeywordConversionRateTableData
};
