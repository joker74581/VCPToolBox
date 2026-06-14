const fs = require('fs').promises;
const path = require('path');
const ChromeBridgeClient = require('./lib/chromeBridgeClient');
const { normalizeArgs, parseBoolean, SUPPORTED_TOP_LEVEL_CATEGORIES } = require('./lib/filterNormalizer');
const { normalizeKeywordArgs, normalizeKeywordReverseArgs, normalizeKeywordConversionRateArgs } = require('./lib/keywordFilterNormalizer');
const { parsePageInfo, parseKeywordPageInfo, normalizeKeywordTableData, normalizeKeywordReverseTableData, normalizeKeywordConversionRateTableData } = require('./lib/pageInfoParser');
const { getSite, listSites } = require('./lib/siteRegistry');

let pluginConfig = {};
let debugMode = false;
let pluginManager = null;
let chromeBridgeClient = null;
let lastRun = null;
let browserTaskQueue = Promise.resolve();
let browserTaskQueueDepth = 0;
let browserTaskActiveCommand = null;
let sellerSpriteLoginState = {
  status: 'unknown',
  confirmedAt: null,
  expiresAt: null,
  failedAt: null,
  lastError: null
};
let logFunctions = {
  pushVcpLog: () => { },
  pushVcpInfo: () => { }
};

const PRODUCT_TABLE_COLUMNS = [
  '产品信息',
  '大类BSR',
  '销量(父)',
  '销售额',
  '子体销量',
  '变体数',
  '价格',
  '评分数',
  '评分',
  'FBA',
  '上架时间',
  '卖家数'
];

const PRODUCT_CANDIDATE_FIELDS = [
  'asin',
  'category_bsr',
  'parent_sales',
  'parent_sales_growth_rate',
  'revenue',
  'child_sales',
  'child_revenue',
  'variations',
  'price',
  'qa_count',
  'review_count',
  'monthly_new_reviews',
  'rating',
  'review_rate',
  'fba_fee',
  'profit_margin',
  'putaway_date',
  'seller_count',
  'category_top',
  'category_path',
  'category_node_id_path',
  'category_top_node_id'
];

function nowIso() {
  return new Date().toISOString();
}

function debugLog(...args) {
  if (debugMode) console.log('[ProductSelector]', ...args);
}

function enqueueBrowserTask(command, task) {
  if (browserTaskActiveCommand || browserTaskQueueDepth > 0) {
    return Promise.resolve({
      success: false,
      command,
      plugin_error: 'browser_busy',
      busy: true,
      active_command: browserTaskActiveCommand,
      queued: browserTaskQueueDepth,
      next_actions: [
        'Do not issue ProductSelector browser/data commands in parallel.',
        'Wait for the current command result, analyze it, then call the next single command if needed.'
      ]
    });
  }
  browserTaskQueueDepth += 1;
  const queuedAt = Date.now();
  const previous = browserTaskQueue.catch(() => undefined);
  const next = previous.then(async () => {
    browserTaskQueueDepth = Math.max(0, browserTaskQueueDepth - 1);
    browserTaskActiveCommand = command;
    debugLog(`Browser task started: ${command}, queued ${Date.now() - queuedAt}ms`);
    try {
      return await task();
    } finally {
      debugLog(`Browser task finished: ${command}`);
      browserTaskActiveCommand = null;
    }
  });
  browserTaskQueue = next.catch(() => undefined);
  return next;
}

function maskConfigState() {
  return {
    sellerSpriteUsernameConfigured: Boolean(pluginConfig.SELLERSPRITE_USERNAME),
    sellerSpritePasswordConfigured: Boolean(pluginConfig.SELLERSPRITE_PASSWORD),
    sellerSpriteLoginTtlHours: getSellerSpriteLoginTtlHours(),
    debugMode
  };
}

function getSellerSpriteLoginTtlHours(args = {}) {
  const raw = args.login_ttl_hours ?? args.loginTtlHours ?? pluginConfig.SELLERSPRITE_LOGIN_TTL_HOURS;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return 4;
}

function getSellerSpriteLoginTtlMs(args = {}) {
  return getSellerSpriteLoginTtlHours(args) * 60 * 60 * 1000;
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

function cleanLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function parseCandidateLimit(args = {}) {
  const explicit = normalizeOptionalLimit(args.maxCandidates ?? args.max_candidates);
  if (explicit) return explicit;
  const text = String(args.criteria || '');
  const digit = text.match(/(?:前|取|抓|读取|看|分析)?\s*(\d{1,3})\s*(?:个|条)?\s*(?:ASIN|asin|产品|商品|结果)/i);
  if (digit) return Math.max(Number(digit[1]), 1);
  const chineseDigits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const chinese = text.match(/前?\s*([一二两三四五六七八九十])\s*(?:个|条)?\s*(?:ASIN|asin|产品|商品|结果)/);
  if (chinese) return chineseDigits[chinese[1]];
  return undefined;
}

function isSellerSpriteLoginFresh(args = {}) {
  const ttlMs = getSellerSpriteLoginTtlMs(args);
  if (ttlMs <= 0) return false;
  if (sellerSpriteLoginState.status !== 'confirmed' || !sellerSpriteLoginState.confirmedAt) return false;
  return Date.now() - sellerSpriteLoginState.confirmedAt < ttlMs;
}

function buildCachedLoginResult(args = {}) {
  return {
    success: true,
    site: 'sellersprite',
    command: 'login_sellersprite',
    message: '复用最近一次已确认的 SellerSprite 登录状态。',
    skipped_login: true,
    login_cache_used: true,
    last_login_confirmed_at: sellerSpriteLoginState.confirmedAt ? new Date(sellerSpriteLoginState.confirmedAt).toISOString() : null,
    login_cache_expires_at: sellerSpriteLoginState.expiresAt ? new Date(sellerSpriteLoginState.expiresAt).toISOString() : null,
    login_ttl_hours: getSellerSpriteLoginTtlHours(args)
  };
}

function compactLoginStatus(loginResult = {}) {
  return {
    success: loginResult.success !== false,
    skipped_login: loginResult.skipped_login === true,
    login_cache_used: loginResult.login_cache_used === true,
    credential_error: loginResult.credential_error === true,
    last_login_confirmed_at: loginResult.last_login_confirmed_at || null,
    login_cache_expires_at: loginResult.login_cache_expires_at || null
  };
}

function updateSellerSpriteLoginState(result, args = {}) {
  const now = Date.now();
  if (result.success !== false) {
    const ttlMs = getSellerSpriteLoginTtlMs(args);
    sellerSpriteLoginState = {
      status: 'confirmed',
      confirmedAt: now,
      expiresAt: ttlMs > 0 ? now + ttlMs : null,
      failedAt: null,
      lastError: null
    };
    return;
  }

  sellerSpriteLoginState = {
    status: result.credential_error ? 'credential_error' : 'failed',
    confirmedAt: null,
    expiresAt: null,
    failedAt: now,
    lastError: result.error || result.message || 'SellerSprite login failed.'
  };
}

function invalidateSellerSpriteLoginState(reason) {
  sellerSpriteLoginState = {
    status: 'invalidated',
    confirmedAt: null,
    expiresAt: null,
    failedAt: Date.now(),
    lastError: reason || 'SellerSprite login cache invalidated.'
  };
}

function collectSellerSpriteResultText(...results) {
  const parts = [];
  const visit = (value) => {
    if (!value) return;
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }
    if (typeof value !== 'object') return;
    [
      value.page_info,
      value.message,
      value.error,
      value.page_state?.url,
      value.page_state?.title,
      value.pageState?.url,
      value.pageState?.title
    ].forEach(item => {
      if (item) parts.push(String(item));
    });
  };
  results.forEach(visit);
  return parts.join('\n');
}

function isSellerSpriteNoResultsText(text) {
  return /很抱歉[，,]?\s*暂无结果|暂无结果|暂无数据|没有找到相关结果|No results found/i.test(String(text || ''));
}

function isSellerSpriteLoginPageText(text) {
  const value = String(text || '');
  if (/\/w\/user\/login|\/user\/login|\/login(?:[?#/]|$)/i.test(value)) return true;
  return /(?:账号|账户|邮箱|用户名|手机号).{0,20}(?:密码|登录)|(?:请输入|输入).{0,10}密码|SellerSprite.*login/i.test(value);
}

function buildSellerSpriteNoResultsParsed(rawText = '') {
  return {
    result_count: 0,
    pagination: null,
    candidates: [],
    no_results: true,
    empty_result: true,
    empty_reason: 'SellerSprite 当前筛选条件暂无结果。',
    raw_page_info_excerpt: String(rawText || '').slice(0, 3000)
  };
}

async function diagnoseSellerSpritePage(existingResults = [], warnings = [], reason = 'SellerSprite 页面诊断', args = {}) {
  let pageInfoResult = null;
  try {
    pageInfoResult = await chromeBridgeClient.getPageInfo(Number(args.page_info_timeout) || 30000);
  } catch (error) {
    warnings.push(`${reason}时获取当前页面内容失败: ${error.message}`);
  }

  const rawText = collectSellerSpriteResultText(...existingResults, pageInfoResult);
  return {
    pageInfoResult,
    rawText,
    noResults: isSellerSpriteNoResultsText(rawText),
    loginPage: isSellerSpriteLoginPageText(rawText)
  };
}

async function inspectSellerSpriteWaitFailure({
  command,
  waitResult,
  openResult,
  loginResult,
  autoLogin,
  warnings,
  args,
  pageLabel
}) {
  if (waitResult?.success !== false) return { action: 'ready', diagnosis: null };

  const diagnosis = await diagnoseSellerSpritePage([openResult, waitResult], warnings, `等待${pageLabel}失败后`, args);
  if (diagnosis.noResults) {
    warnings.push(`${pageLabel}返回“暂无结果”，已按成功空结果传递给 Agent。`);
    return {
      action: 'empty',
      diagnosis,
      parsed: buildSellerSpriteNoResultsParsed(diagnosis.rawText)
    };
  }

  if (autoLogin && loginResult?.login_cache_used && diagnosis.loginPage) {
    return { action: 'retry_login', diagnosis };
  }

  if (diagnosis.loginPage) {
    return { action: 'login_required', diagnosis };
  }

  warnings.push(`未等到${pageLabel}标识文本，但当前页不像登录页；已继续尝试结构化解析，避免误触发重新登录。`);
  return { action: 'continue', diagnosis };
}

function buildClarificationResult(normalized) {
  return {
    success: false,
    needs_clarification: true,
    unknown_filters: normalized.unknown_filters,
    suggested_supported_filters: normalized.suggested_supported_filters,
    warnings: normalized.warnings,
    message: '检测到未定义的筛选字段。strict_filters=true 时已暂停运行，未打开网页。请确认字段含义或改用已支持字段。'
  };
}

function formatCompactValue(value) {
  if (value === null || value === undefined || value === '' || value === 0 || value === '0' || value === '0.00%') return '-';
  return String(value);
}

function escapeMarkdownCell(value) {
  return formatCompactValue(value).replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
}

function parseMetricNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  const match = text.match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!match) return null;
  let number = Number(match[0].replace(/,/g, ''));
  if (!Number.isFinite(number)) return null;
  if (/k\b/i.test(text)) number *= 1000;
  if (/m\b/i.test(text)) number *= 1000000;
  return number;
}

function buildProductSummaryStats(candidates = []) {
  const sales = candidates
    .map(item => parseMetricNumber(item.parent_sales))
    .filter(value => value !== null && value > 0)
    .sort((a, b) => b - a);
  const revenue = candidates
    .map(item => parseMetricNumber(item.revenue))
    .filter(value => value !== null && value > 0)
    .sort((a, b) => b - a);
  const lowReviewCount = candidates.filter(item => {
    const reviewCount = parseMetricNumber(item.review_count);
    return reviewCount !== null && reviewCount <= 100;
  }).length;
  const lowSellerCount = candidates.filter(item => {
    const sellerCount = parseMetricNumber(item.seller_count);
    return sellerCount !== null && sellerCount <= 3;
  }).length;

  return [
    `总计 ${candidates.length} 个 ASIN`,
    `父体销量Top3: ${sales.slice(0, 3).map(value => Math.round(value).toLocaleString('en-US')).join(' / ') || '-'}`,
    `销售额Top3: ${revenue.slice(0, 3).map(value => Math.round(value).toLocaleString('en-US')).join(' / ') || '-'}`,
    `评论数<=100: ${lowReviewCount} 个`,
    `卖家数<=3: ${lowSellerCount} 个`
  ].join(' | ');
}

function buildSummary({ url, parsed, normalized, warnings = [], title = '# 卖家精灵选品筛选结果' }) {
  const lines = [];
  lines.push(title);
  lines.push('');
  lines.push(`- URL: ${url}`);
  if (parsed.result_count !== null && parsed.result_count !== undefined) {
    lines.push(`- 搜索结果数: ${parsed.result_count}`);
  } else {
    lines.push('- 搜索结果数: 未能从页面文本中解析');
  }
  if (parsed.pagination) {
    lines.push(`- 分页: ${parsed.pagination.from}-${parsed.pagination.to}/${parsed.pagination.total}`);
  }
  lines.push(`- 已应用筛选: ${JSON.stringify(normalized.filters)}`);
  if (warnings.length > 0) {
    lines.push(`- 警告: ${warnings.join('；')}`);
  }
  if (parsed.candidates.length > 0) {
    lines.push('');
    lines.push(`> **摘要**: ${buildProductSummaryStats(parsed.candidates)}`);
    lines.push('');
    lines.push('## 候选 ASIN (合并表)');
    lines.push('| # | ASIN | 大类BSR | 父销量 | 父增 | 销售额 | 子销量 | 子销售额 | 变体 | 价格 | QA | 评论数 | 月增评 | 评分 | 留评率 | FBA费 | 利润率 | 上架 | 卖家 | 类目 |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    parsed.candidates.forEach((item, index) => {
      const cells = [
        index + 1,
        escapeMarkdownCell(item.asin),
        escapeMarkdownCell(item.category_bsr),
        escapeMarkdownCell(item.parent_sales),
        escapeMarkdownCell(item.parent_sales_growth_rate),
        escapeMarkdownCell(item.revenue),
        escapeMarkdownCell(item.child_sales),
        escapeMarkdownCell(item.child_revenue),
        escapeMarkdownCell(item.variations),
        escapeMarkdownCell(item.price),
        escapeMarkdownCell(item.qa_count),
        escapeMarkdownCell(item.review_count),
        escapeMarkdownCell(item.monthly_new_reviews),
        escapeMarkdownCell(item.rating),
        escapeMarkdownCell(item.review_rate),
        escapeMarkdownCell(item.fba_fee),
        escapeMarkdownCell(item.profit_margin),
        escapeMarkdownCell(item.putaway_date),
        escapeMarkdownCell(item.seller_count),
        escapeMarkdownCell(item.category_top || item.category_path)
      ];
      lines.push(`| ${cells.join(' | ')} |`);
    });
  } else if (parsed.no_results) {
    lines.push('');
    lines.push('> SellerSprite 返回暂无结果。建议放宽筛选条件、重新选择类目，或先重置条件后再查询。');
  } else {
    lines.push('');
    lines.push('> 未能提取到任何候选 ASIN 数据，可能是搜索结果为空，或页面结构不匹配。');
  }
  return lines.join('\n');
}

function buildKeywordMetricList(item) {
  const metrics = [];
  if (item.daily_searches) metrics.push(`daily_searches=${item.daily_searches}`);
  if (item.yearly_growth) metrics.push(`yearly_growth=${item.yearly_growth}`);
  if (item.recent_3_month_growth) metrics.push(`recent_3_month_growth=${item.recent_3_month_growth}`);
  if (item.aba_click_share) metrics.push(`aba_click_share=${item.aba_click_share}`);
  if (item.aba_conversion_share) metrics.push(`aba_conversion_share=${item.aba_conversion_share}`);
  if (item.aba_rank) metrics.push(`aba_rank=${item.aba_rank}`);
  if (item.goods_value) metrics.push(`goods_value=${item.goods_value}`);
  if (item.ppc_bid && (item.ppc_bid.min || item.ppc_bid.bid || item.ppc_bid.max)) {
    metrics.push(`ppc_bid=${[item.ppc_bid.min, item.ppc_bid.bid, item.ppc_bid.max].filter(Boolean).join('/')}`);
  }
  if (item.category) metrics.push(`category=${item.category}`);
  if (item.market_period) metrics.push(`market_period=${item.market_period}`);
  if (item.spr) metrics.push(`spr=${item.spr}`);
  if (item.title_density) metrics.push(`title_density=${item.title_density}`);
  if (Array.isArray(item.top_asins) && item.top_asins.length > 0) {
    metrics.push(`top_asins=${item.top_asins.slice(0, 5).join(',')}`);
  }
  return metrics;
}

function buildKeywordSummary({ url, parsed, normalized, warnings = [] }) {
  const lines = [];
  lines.push('# 卖家精灵关键词选品结果');
  lines.push('');
  lines.push(`- URL: ${url}`);
  if (parsed.result_count !== null && parsed.result_count !== undefined) {
    lines.push(`- 搜索结果数: ${parsed.result_count}`);
  } else {
    lines.push('- 搜索结果数: 未能从页面文本中解析');
  }
  if (parsed.pagination) {
    lines.push(`- 分页: ${parsed.pagination.from}-${parsed.pagination.to}/${parsed.pagination.total}`);
  }
  lines.push(`- 已应用筛选: ${JSON.stringify(normalized.filters)}`);
  if (warnings.length > 0) {
    lines.push(`- 警告: ${warnings.join('；')}`);
  }
  if (parsed.candidates && parsed.candidates.length > 0) {
    lines.push('');
    lines.push('## 候选关键词 (合并表)');
    lines.push('| # | 关键词 | 月搜 | 购买 | 购买率 | 均价 | 评分 | SPR | 需供比 | 商品数 | 点击 | 转化 |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    parsed.candidates.forEach((item, index) => {
      const v = (val) => (val === null || val === undefined || val === 0 || val === '0' || val === '0.00%') ? '-' : val;
      const title = item.translation ? `${item.keyword} (${item.translation})` : item.keyword;
      lines.push(`| ${index + 1} | ${title} | ${v(item.monthly_searches)} | ${v(item.monthly_purchases)} | ${v(item.purchase_rate)} | ${v(item.avg_price)} | ${v(item.avg_rating)} | ${v(item.spr)} | ${v(item.supply_demand_ratio)} | ${v(item.products)} | ${v(item.clicks)} | ${v(item.conversion_rate)} |`);
    });
  } else if (parsed.no_results) {
    lines.push('');
    lines.push('> SellerSprite 返回暂无结果。建议放宽关键词筛选条件、重新选择类目，或先重置条件后再查询。');
  } else {
    lines.push('');
    lines.push('> 未能提取到任何候选关键词数据，可能是搜索结果为空，或页面结构不匹配。');
  }
  return lines.join('\n');
}

function buildKeywordReverseSummary({ url, parsed, normalized, warnings = [] }) {
  const lines = [];
  lines.push('# 卖家精灵关键词反查结果');
  lines.push('');
  lines.push(`- URL: ${url}`);
  lines.push(`- 目标 ASIN: ${normalized.filters.q || normalized.filters.asin || normalized.filters.asins}`);
  if (parsed.result_count !== null && parsed.result_count !== undefined) {
    lines.push(`- 关键词数: ${parsed.result_count}`);
  }
  lines.push(`- 已应用筛选: ${JSON.stringify(normalized.filters)}`);
  if (warnings.length > 0) {
    lines.push(`- 警告: ${warnings.join('；')}`);
  }
  if (parsed.candidates && parsed.candidates.length > 0) {
    const c = parsed.candidates;
    const top100 = c.filter(item => {
      const r = parseInt(item.organic_rank);
      return !isNaN(r) && r > 0 && r <= 100;
    }).length;
    const searches = c.map(item => parseInt(String(item.monthly_searches || '').replace(/,/g, '')))
      .filter(v => !isNaN(v) && v > 0)
      .sort((a, b) => b - a);
    const top3searches = searches.slice(0, 3).join(' / ') || '-';
    const purchaseRates = c.map(item => parseFloat(String(item.purchase_rate || '').replace(/%/g, '')))
      .filter(v => !isNaN(v) && v > 0);
    const avgPurchaseRate = purchaseRates.length > 0 ? (purchaseRates.reduce((a, b) => a + b, 0) / purchaseRates.length).toFixed(2) + '%' : '-';
    const highSDRatio = c.filter(item => {
      const r = parseFloat(String(item.supply_demand_ratio || '').replace(/,/g, ''));
      return !isNaN(r) && r > 100;
    }).length;

    lines.push('');
    lines.push(`> **摘要**: 总计 ${c.length} 词 | 自然排名前100: ${top100} 词 | Top3搜索量: ${top3searches} | 平均购买率: ${avgPurchaseRate} | 高需供比(>100): ${highSDRatio} 词`);
    lines.push('');
    lines.push('## 候选关键词 (合并表)');
    lines.push('| # | 关键词 | 月搜 | 自然排名 | 广告排名 | 流量占比 | 月购买 | 购买率 | 需供比 | ABA点击 | ABA转化 | SPR | 商品数 |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    parsed.candidates.forEach((item, index) => {
      const v = (val) => (val === null || val === undefined || val === 0 || val === '0' || val === '0.00%') ? '-' : val;
      const title = item.translation ? `${item.keyword} (${item.translation})` : item.keyword;
      lines.push(`| ${index + 1} | ${title} | ${v(item.monthly_searches)} | ${v(item.organic_rank)} | ${v(item.ad_rank)} | ${v(item.traffic_share)} | ${v(item.monthly_purchases)} | ${v(item.purchase_rate)} | ${v(item.supply_demand_ratio)} | ${v(item.aba_click_share)} | ${v(item.aba_conversion_share)} | ${v(item.spr)} | ${v(item.products)} |`);
    });
  } else if (parsed.no_results) {
    lines.push('');
    lines.push('> SellerSprite 返回暂无结果。请确认 ASIN、站点、月份或流量来源标签是否过窄。');
  } else {
    lines.push('');
    lines.push('> 未能提取到任何候选关键词数据，可能是搜索结果为空，或页面结构不匹配。');
  }
  return lines.join('\n');
}

function buildKeywordConversionRateSummary({ url, parsed, normalized, warnings = [] }) {
  const lines = [];
  const periodLabel = normalized.filters.reverseType === '90D' ? '近90天' : '周';
  lines.push('# 卖家精灵关键词转化率结果');
  lines.push('');
  lines.push(`- URL: ${url}`);
  lines.push(`- 数据口径: 亚马逊商机探测器 ${periodLabel} 口径；数值为关键词行业平均点击/购买行为参考，不代表单一商品真实转化。`);
  if (parsed.result_count !== null && parsed.result_count !== undefined) {
    lines.push(`- 关键词数: ${parsed.result_count}`);
  }
  lines.push(`- 已应用筛选: ${JSON.stringify(normalized.filters)}`);
  if (warnings.length > 0) {
    lines.push(`- 警告: ${warnings.join('；')}`);
  }
  if (parsed.candidates && parsed.candidates.length > 0) {
    const c = parsed.candidates;
    const clickRates = c.map(item => parseMetricNumber(item.click_conversion_rate)).filter(value => value !== null && value > 0);
    const avgClickRate = clickRates.length > 0 ? `${(clickRates.reduce((a, b) => a + b, 0) / clickRates.length).toFixed(2)}%` : '-';
    const cpaMid = c.map(item => item.cpa?.mid).filter(value => value !== null && value !== undefined).sort((a, b) => a - b);
    const medianCpa = cpaMid.length > 0 ? `$${cpaMid[Math.floor(cpaMid.length / 2)].toFixed(2)}` : '-';
    const acosAvg = c.map(item => parseMetricNumber(item.acos?.avg)).filter(value => value !== null && value > 0);
    const avgAcos = acosAvg.length > 0 ? `${(acosAvg.reduce((a, b) => a + b, 0) / acosAvg.length).toFixed(2)}%` : '-';

    lines.push('');
    lines.push(`> **摘要**: 总计 ${c.length} 词 | 平均点击转化率: ${avgClickRate} | CPA中位参考: ${medianCpa} | 平均ACOS: ${avgAcos}`);
    lines.push('');
    lines.push('## 候选关键词 (合并表)');
    lines.push('| # | 关键词 | 搜索 | 点击 | 购买 | 搜索转化 | 点击转化 | PPC低/中/高 | CPA低/中/高 | 价格低/均/高 | ACOS高/均/低 | 广告预算 | ABA点击/转化 | Top3点击ASIN份额 |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    parsed.candidates.forEach((item, index) => {
      const v = (val) => formatCompactValue(val);
      const title = item.translation ? `${item.keyword} (${item.translation})` : item.keyword;
      const money3 = (obj) => [obj?.low, obj?.mid, obj?.high].map(v).join('/');
      const price3 = (obj) => [obj?.low, obj?.avg, obj?.high].map(v).join('/');
      const acos3 = (obj) => [obj?.max, obj?.avg, obj?.min].map(v).join('/');
      const aba = [item.aba_concentration?.click_share, item.aba_concentration?.conversion_share].map(v).join('/');
      const topShares = (item.top_clicked_asins || [])
        .map(asin => [asin.click_share, asin.conversion_share].map(v).join('/'))
        .join(';');
      lines.push(`| ${index + 1} | ${escapeMarkdownCell(title)} | ${v(item.period_searches)} | ${v(item.period_clicks)} | ${v(item.period_purchases)} | ${v(item.search_conversion_rate)} | ${v(item.click_conversion_rate)} | ${money3(item.ppc_bid)} | ${money3(item.cpa)} | ${price3(item.product_price)} | ${acos3(item.acos)} | ${v(item.ad_budget)} | ${aba} | ${escapeMarkdownCell(topShares)} |`);
    });
  } else if (parsed.no_results) {
    lines.push('');
    lines.push('> SellerSprite 返回暂无结果。请确认关键词在商机探测器内有数据，或放宽筛选条件。');
  } else {
    lines.push('');
    lines.push('> 未能提取到任何关键词转化率数据，可能是结果为空，或页面结构不匹配。');
  }
  return lines.join('\n');
}

function normalizeKeywordConversionRateCandidates(candidates = [], options = {}) {
  const showTag = options.showTag === true;
  const includeTranslation = options.includeTranslation === true;
  const seen = new Set();
  const result = [];

  for (const item of candidates || []) {
    if (!item || !item.keyword) continue;
    const next = { ...item };
    if (!showTag && next.keyword) {
      next.keyword = cleanLine(next.keyword).replace(/\s+(?:AC|HR|ER|NR|TR|BS|4S)$/i, '').trim();
    }
    if (!showTag && next.translation) {
      next.translation = cleanLine(next.translation).replace(/\s+(?:AC|HR|ER|NR|TR|BS|4S)$/i, '').trim() || null;
    }
    if (!includeTranslation) {
      next.translation = null;
    }

    const dedupeKey = [
      String(next.keyword || '').toLowerCase(),
      next.period_searches ?? '',
      next.period_clicks ?? '',
      next.period_purchases ?? '',
      next.search_conversion_rate ?? '',
      next.click_conversion_rate ?? ''
    ].join('|');
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    next.rank = result.length + 1;
    result.push(next);
  }

  return result;
}

function buildAmazonReviewFailure(normalized) {
  return {
    success: false,
    site: 'amazon',
    command: 'fetch_amazon_reviews',
    needs_clarification: true,
    warnings: normalized.warnings,
    error: '缺少合法 ASIN。请传 asin，或传 Amazon /dp/、/gp/product/、/product-reviews/ URL。'
  };
}

function buildAmazonProductFailure(normalized) {
  return {
    success: false,
    site: 'amazon',
    command: 'fetch_amazon_product_info',
    needs_clarification: true,
    warnings: normalized.warnings,
    error: '缺少合法 ASIN。请传 asin，或传 Amazon /dp/、/gp/product/ URL。'
  };
}

function normalizeCsvValue(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item || '').trim()).filter(Boolean).join(',');
  }
  return String(value || '').trim();
}

function extractAsinsFromValue(value) {
  const values = Array.isArray(value) ? value : [value];
  const seen = new Set();
  const asins = [];
  values.forEach(item => {
    const text = String(item || '');
    const matches = text.match(/\b[A-Z0-9]{10}\b/gi) || [];
    matches.forEach(match => {
      const asin = match.toUpperCase();
      if (!seen.has(asin)) {
        seen.add(asin);
        asins.push(asin);
      }
    });
  });
  return asins;
}

function normalizeCompetitorMonthName(value) {
  const text = String(value || '').trim();
  if (!text) return 'bsr_sales_nearly';
  if (/近?30\s*天|最近30天|30\s*days?|nearly/i.test(text)) return 'bsr_sales_nearly';
  return text;
}

function normalizeCompetitorLookupArgs(args = {}) {
  const asinValues = [
    args.asin,
    args.ASIN,
    args.asins,
    args.url,
    args.product_url,
    args.productUrl,
    args.amazon_url,
    args.amazonUrl
  ].filter(value => value !== undefined && value !== null && value !== '');
  const asins = extractAsinsFromValue(asinValues);
  const categoryInput = args.categories ?? args.category ?? args.nodeIdPaths ?? args.node_id_paths;
  const categoryNormalized = categoryInput !== undefined
    ? normalizeArgs({ categories: args.categories ?? args.category, nodeIdPaths: args.nodeIdPaths ?? args.node_id_paths, strict_filters: false })
    : { filters: {} };
  const filters = {
    market: String(args.market || args.station || 'US').trim().toUpperCase(),
    monthName: normalizeCompetitorMonthName(args.monthName || args.month_name || args.time || args.period),
    asins,
    keywords: normalizeCsvValue(args.keywords ?? args.keyword ?? args.includeKeywords ?? args.include_keywords),
    includeSellers: normalizeCsvValue(args.includeSellers ?? args.include_sellers ?? args.seller ?? args.sellers),
    includeBrands: normalizeCsvValue(args.includeBrands ?? args.include_brands ?? args.brand ?? args.brands),
    page: Number(args.page) > 0 ? Math.floor(Number(args.page)) : 1,
    nodeIdPaths: categoryNormalized.filters.nodeIdPaths || [],
    symbolFlag: parseBoolean(args.symbolFlag ?? args.symbol_flag, false),
    size: Number(args.size) || 60,
    orderField: String(args.orderField || args.order_field || 'amz_unit'),
    orderDesc: parseBoolean(args.orderDesc ?? args.order_desc, true),
    lowPrice: String(args.lowPrice || args.low_price || 'N').trim() || 'N'
  };
  const warnings = [];
  if (categoryInput !== undefined && filters.nodeIdPaths.length === 0) {
    warnings.push('类目未能匹配 SellerSprite 顶层类目白名单，已按未选择类目处理。');
  }
  const hasLookupInput = filters.asins.length > 0 || filters.keywords || filters.includeBrands || filters.includeSellers;
  if (!hasLookupInput) {
    warnings.push('Missing competitor lookup input. Pass asin/product_url, keywords, includeBrands, or includeSellers.');
  }
  return {
    filters,
    warnings,
    needs_clarification: !hasLookupInput
  };
}

function buildSellerSpriteCompetitorFailure(normalized) {
  return {
    success: false,
    site: 'sellersprite',
    command: 'run_sellersprite_competitor_lookup',
    needs_clarification: true,
    warnings: normalized.warnings,
    error: '缺少查竞品条件。请至少传 asin/product_url、keywords、includeBrands/brand 或 includeSellers/seller 之一。'
  };
}

function extractUrlFromPageInfo(pageInfo) {
  const match = String(pageInfo || '').match(/^URL:\s*(\S+)/mi);
  return match ? match[1] : '';
}

function getResultPageUrl(result) {
  return result?.page_state?.url ||
    result?.pageState?.url ||
    extractUrlFromPageInfo(result?.page_info) ||
    '';
}

function pickReusableAmazonPageInfo(results, asin) {
  for (const result of results) {
    const pageInfo = result?.page_info;
    if (!pageInfo) continue;
    const pageInfoUrl = getResultPageUrl(result) || extractUrlFromPageInfo(pageInfo);
    if (pageUrlMatchesAsin(pageInfoUrl, asin) === false) continue;
    if (/About this item|Customer reviews|out of 5|global ratings?|Add to cart|Buy Now/i.test(String(pageInfo))) {
      return {
        success: true,
        message: 'Reused page_info returned by previous ChromeBridge command',
        page_state: result.page_state || result.pageState || null,
        page_info: pageInfo
      };
    }
  }
  return null;
}

function pageUrlMatchesAsin(pageUrl, asin) {
  const normalizedUrl = String(pageUrl || '').toUpperCase();
  const normalizedAsin = String(asin || '').toUpperCase();
  if (!normalizedUrl || !normalizedAsin) return null;
  if (!/AMAZON\./i.test(normalizedUrl)) return false;
  if (/\/ERROR(?:\/|$)|\/ERRORS(?:\/|$)|\/500(?:\/|$)|\/SORRY(?:\/|$)|\/AP\/SIGNIN|\/AP\/CVF/i.test(normalizedUrl)) return false;
  if (normalizedUrl.includes(`/PRODUCT-REVIEWS/${normalizedAsin}`) ||
    normalizedUrl.includes(`/DP/${normalizedAsin}`) ||
    normalizedUrl.includes(`/GP/PRODUCT/${normalizedAsin}`) ||
    normalizedUrl.includes(normalizedAsin)) {
    return true;
  }
  return /\/(?:PRODUCT-REVIEWS|DP|GP\/PRODUCT)\/[A-Z0-9]{10}/i.test(normalizedUrl) ? false : null;
}

function buildAmazonPageMismatchParsed(pageUrl, asin) {
  return {
    average_rating: null,
    global_rating_count: null,
    total_review_count: null,
    rating_breakdown: null,
    histogram: null,
    review_count: 0,
    reviews: [],
    page_blocked: false,
    page_mismatch: true,
    warnings: [`Amazon 当前页面 URL 未匹配目标 ASIN ${asin}，已拒绝解析疑似旧页面内容: ${pageUrl || '(unknown url)'}`],
    raw_page_info_excerpt: ''
  };
}

function reviewMergeKey(review = {}) {
  return [
    review.date || '',
    String(review.body || '').slice(0, 80)
  ].join('|');
}

function mergeAmazonReviews(primaryReviews = [], fallbackReviews = []) {
  if (!Array.isArray(primaryReviews) || primaryReviews.length === 0) return fallbackReviews || [];
  if (!Array.isArray(fallbackReviews) || fallbackReviews.length === 0) return primaryReviews;

  const fallbackByKey = new Map(fallbackReviews.map(review => [reviewMergeKey(review), review]));
  return primaryReviews.map((review, index) => {
    const fallback = fallbackByKey.get(reviewMergeKey(review)) || fallbackReviews[index];
    if (!fallback) return review;
    return {
      ...fallback,
      ...review,
      rating: review.rating ?? fallback.rating ?? null,
      title: review.title || fallback.title || null,
      author: review.author || fallback.author || null,
      review_id: review.review_id || fallback.review_id,
      image_count: review.image_count !== undefined ? review.image_count : fallback.image_count,
      image_urls: review.image_urls || fallback.image_urls
    };
  });
}

function sanitizeAmazonReview(review = {}) {
  const next = { ...review };
  const title = String(next.title || '').trim();
  if (/^\d+(?:\.\d+)?%$/.test(title)) {
    next.title = null;
    next.rating = null;
  }
  if (next.rating != null && (Number(next.rating) < 1 || Number(next.rating) > 5 || !Number.isFinite(Number(next.rating)))) {
    next.rating = null;
  }
  if (next.review_type === 'direct_review' && /^Vine Customer Review/i.test(String(next.body || ''))) {
    next.review_type = 'vine';
  }
  return next;
}

function buildRatingBreakdownCounts(ratingBreakdown, ratingCount) {
  const count = Number(ratingCount);
  if (!ratingBreakdown || !Number.isFinite(count) || count <= 0) return null;
  const result = {};
  [5, 4, 3, 2, 1].forEach(star => {
    const key = `${star}_star`;
    if (ratingBreakdown[key] !== undefined) {
      result[key] = Math.round(count * Number(ratingBreakdown[key]) / 100);
    }
  });
  return Object.keys(result).length > 0 ? result : null;
}

function extractAsinCandidatesFromOrderedTable(tableData, maxCandidates) {
  const rows = Array.isArray(tableData?.rows) ? tableData.rows : [];
  const seen = new Set();
  const candidates = [];
  for (const row of rows) {
    const asins = Array.isArray(row?.data?.asins) ? row.data.asins : [];
    for (const asin of asins) {
      if (!asin || seen.has(asin)) continue;
      seen.add(asin);
      candidates.push({
        asin,
        title: null,
        evidence: Array.isArray(row.values) ? row.values.join(' | ').slice(0, 500) : ''
      });
      if (hasReachedOptionalLimit(candidates, maxCandidates)) return candidates;
    }
  }
  return candidates;
}

function sanitizeProductCandidates(candidates = []) {
  return (Array.isArray(candidates) ? candidates : [])
    .map(item => {
      const sanitized = {};
      PRODUCT_CANDIDATE_FIELDS.forEach(field => {
        if (item?.[field] !== undefined && item[field] !== null && item[field] !== '') {
          sanitized[field] = item[field];
        }
      });
      return sanitized.asin ? sanitized : null;
    })
    .filter(Boolean);
}

function normalizeCellText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function metricTokens(value) {
  return normalizeCellText(value).match(/N\/A|\$?-?\d+(?:\.\d+)?K\+?|\$?-?\d[\d,]*(?:\.\d+)?\+|\$?-?\d[\d,]*(?:\.\d+)?%?/gi) || [];
}

function findColumn(headers, patterns) {
  return (headers || []).findIndex(header => patterns.every(pattern => pattern.test(header)));
}

function valueAt(values, index) {
  return index >= 0 ? normalizeCellText(values[index]) : '';
}

function extractAsinFromProductText(text, data = {}) {
  if (data.asin) return data.asin;
  if (Array.isArray(data.asins) && data.asins.length > 0) return data.asins[0];
  const match = String(text || '').match(/\bB0[A-Z0-9]{8}\b/i);
  return match ? match[0].toUpperCase() : null;
}

function normalizeProductTableData(tableData, maxCandidates) {
  const headers = Array.isArray(tableData?.headers) ? tableData.headers.map(normalizeCellText) : [];
  const rows = Array.isArray(tableData?.rows) ? tableData.rows : [];
  const idx = {
    product: findColumn(headers, [/产品信息|product/i]),
    bsr: findColumn(headers, [/大类BSR|BSR/i]),
    parentSales: findColumn(headers, [/销量/, /父|parent/i]),
    revenue: findColumn(headers, [/销售额|revenue/i]),
    childSales: findColumn(headers, [/子体销量|子体销售额|child/i]),
    variations: findColumn(headers, [/变体数|variation/i]),
    price: findColumn(headers, [/价格|price/i]),
    reviews: findColumn(headers, [/评分数|评论数|review/i]),
    rating: findColumn(headers, [/评分|星级|rating/i, /留评率|rate/i]),
    fba: findColumn(headers, [/FBA/i]),
    putaway: findColumn(headers, [/上架时间|putaway|date/i]),
    sellers: findColumn(headers, [/卖家数|seller/i])
  };

  return applyOptionalLimit(rows, maxCandidates).map(row => {
    const values = Array.isArray(row?.values) ? row.values : (Array.isArray(row) ? row : []);
    const productText = valueAt(values, idx.product);
    const asin = extractAsinFromProductText(productText, row?.data || {});
    if (!asin) return null;

    const bsrTokens = metricTokens(valueAt(values, idx.bsr));
    const parentSalesTokens = metricTokens(valueAt(values, idx.parentSales));
    const childSalesTokens = metricTokens(valueAt(values, idx.childSales));
    const priceTokens = metricTokens(valueAt(values, idx.price));
    const reviewTokens = metricTokens(valueAt(values, idx.reviews));
    const ratingTokens = metricTokens(valueAt(values, idx.rating));
    const fbaTokens = metricTokens(valueAt(values, idx.fba));

    const result = {
      asin,
      category_bsr: bsrTokens[0] || null,
      parent_sales: parentSalesTokens[0] || null,
      parent_sales_growth_rate: parentSalesTokens[1] || null,
      revenue: metricTokens(valueAt(values, idx.revenue))[0] || null,
      child_sales: childSalesTokens[0] || null,
      child_revenue: childSalesTokens[1] || null,
      variations: metricTokens(valueAt(values, idx.variations))[0] || null,
      price: priceTokens[0] || null,
      qa_count: priceTokens[1] || null,
      review_count: reviewTokens[0] || null,
      monthly_new_reviews: reviewTokens[1] || null,
      rating: ratingTokens[0] || null,
      review_rate: ratingTokens[1] || null,
      fba_fee: fbaTokens[0] || null,
      profit_margin: fbaTokens[1] || null,
      putaway_date: valueAt(values, idx.putaway) || null,
      seller_count: metricTokens(valueAt(values, idx.sellers))[0] || null
    };
    if (row?.data?.category_top) result.category_top = row.data.category_top;
    if (row?.data?.category_path) result.category_path = row.data.category_path;
    if (row?.data?.category_node_id_path) result.category_node_id_path = row.data.category_node_id_path;
    if (row?.data?.category_top_node_id) result.category_top_node_id = row.data.category_top_node_id;
    return result;
  }).filter(Boolean);
}

function hasProductCandidateMetrics(candidates) {
  const metricKeys = [
    'category_bsr',
    'parent_sales',
    'revenue',
    'child_sales',
    'variations',
    'price',
    'review_count',
    'rating',
    'fba_fee',
    'putaway_date',
    'seller_count'
  ];
  return (candidates || []).some(item => metricKeys.some(key => item?.[key]));
}

async function initialize(config = {}, dependencies = {}) {
  pluginConfig = config || {};
  debugMode = pluginConfig.DebugMode === true;
  logFunctions = dependencies.vcpLogFunctions || logFunctions;

  try {
    pluginManager = require('../../Plugin.js');
    chromeBridgeClient = new ChromeBridgeClient(pluginManager, console);
  } catch (error) {
    console.error('[ProductSelector] Failed to initialize PluginManager bridge:', error.message);
  }

  console.log('[ProductSelector] Plugin initialized.');
}

async function handleBuildSellerSpriteUrl(args) {
  const normalized = normalizeArgs(args);
  if (normalized.needs_clarification) {
    return buildClarificationResult(normalized);
  }

  const site = getSite('sellersprite');
  const url = site.adapter.buildProductResearchUrl(normalized.filters);
  return {
    success: true,
    site: 'sellersprite',
    command: 'build_sellersprite_url',
    url,
    filters: normalized.filters,
    warnings: [
      ...normalized.warnings,
      ...(normalized.unknown_filters.length > 0 ? [`已忽略未知字段: ${normalized.unknown_filters.map(item => item.field || item.label).join(', ')}`] : [])
    ],
    unknown_filters: normalized.unknown_filters
  };
}

async function handleBuildSellerSpriteKeywordUrl(args) {
  const normalized = normalizeKeywordArgs(args);
  if (normalized.needs_clarification) {
    return buildClarificationResult(normalized);
  }

  const site = getSite('sellersprite');
  const url = site.adapter.buildKeywordResearchUrl(normalized.filters);
  return {
    success: true,
    site: 'sellersprite',
    command: 'build_sellersprite_keyword_url',
    url,
    filters: normalized.filters,
    warnings: [
      ...normalized.warnings,
      ...(normalized.unknown_filters.length > 0 ? [`已忽略未知字段: ${normalized.unknown_filters.map(item => item.field || item.label).join(', ')}`] : [])
    ],
    unknown_filters: normalized.unknown_filters
  };
}

async function handleBuildSellerSpriteKeywordConversionRateUrl(args) {
  const normalized = normalizeKeywordConversionRateArgs(args);
  if (normalized.needs_clarification) {
    return {
      success: false,
      site: 'sellersprite',
      command: 'build_sellersprite_keyword_conversion_rate_url',
      needs_clarification: true,
      unknown_filters: normalized.unknown_filters,
      suggested_supported_filters: normalized.suggested_supported_filters,
      warnings: normalized.warnings,
      error: normalized.warnings.find(item => item.includes('缺少')) || '关键词转化率查询缺少 keywordList/keywords，或存在未知筛选字段。'
    };
  }

  const site = getSite('sellersprite');
  const url = site.adapter.buildKeywordConversionRateUrl(normalized.filters);
  return {
    success: true,
    site: 'sellersprite',
    command: 'build_sellersprite_keyword_conversion_rate_url',
    url,
    filters: normalized.filters,
    warnings: [
      ...normalized.warnings,
      ...(normalized.unknown_filters.length > 0 ? [`已忽略未知字段: ${normalized.unknown_filters.map(item => item.field || item.label).join(', ')}`] : [])
    ],
    unknown_filters: normalized.unknown_filters
  };
}

async function handleBuildSellerSpriteCompetitorUrl(args) {
  const normalized = normalizeCompetitorLookupArgs(args);
  if (normalized.needs_clarification) {
    return {
      success: false,
      site: 'sellersprite',
      command: 'build_sellersprite_competitor_url',
      needs_clarification: true,
      warnings: normalized.warnings,
      error: '缺少查竞品条件。请至少传 asin/product_url、keywords、includeBrands/brand 或 includeSellers/seller 之一。'
    };
  }

  const site = getSite('sellersprite');
  const url = site.adapter.buildCompetitorLookupUrl(normalized.filters);
  return {
    success: true,
    site: 'sellersprite',
    command: 'build_sellersprite_competitor_url',
    url,
    filters: normalized.filters,
    warnings: normalized.warnings
  };
}

async function handleBuildAmazonReviewsUrl(args) {
  const site = getSite('amazon');
  const normalized = site.adapter.normalizeReviewArgs(args);
  if (!normalized.asin) {
    return {
      success: false,
      site: 'amazon',
      command: 'build_amazon_reviews_url',
      needs_clarification: true,
      warnings: normalized.warnings,
      error: '缺少合法 ASIN。请传 asin，或传 Amazon review/detail URL。'
    };
  }

  return {
    success: true,
    site: 'amazon',
    command: 'build_amazon_reviews_url',
    asin: normalized.asin,
    market: normalized.market,
    url: site.adapter.buildReviewUrl(normalized),
    filters: {
      page_number: normalized.pageNumber,
      sort_by: normalized.sortBy,
      filter_by_star: normalized.filterByStar,
      reviewer_type: normalized.reviewerType || undefined
    },
    warnings: normalized.warnings
  };
}

async function handleBuildAmazonProductUrl(args) {
  const site = getSite('amazon');
  const normalized = site.adapter.normalizeProductArgs(args);
  if (!normalized.asin) {
    return {
      success: false,
      site: 'amazon',
      command: 'build_amazon_product_url',
      needs_clarification: true,
      warnings: normalized.warnings,
      error: '缺少合法 ASIN。请传 asin，或传 Amazon detail URL。'
    };
  }

  return {
    success: true,
    site: 'amazon',
    command: 'build_amazon_product_url',
    asin: normalized.asin,
    market: normalized.market,
    url: site.adapter.buildProductUrl(normalized),
    filters: {
      th: normalized.th
    },
    warnings: normalized.warnings
  };
}

async function handleLoginSellerSprite(args = {}) {
  if (!chromeBridgeClient) {
    throw new Error('ChromeBridge 客户端未初始化。');
  }

  const forceLogin = parseBoolean(args.force_login ?? args.forceLogin, true);
  if (!forceLogin && isSellerSpriteLoginFresh(args)) {
    return buildCachedLoginResult(args);
  }

  const site = getSite('sellersprite');
  const timeout = Number(args.timeout) || 20000;
  const rawResult = await site.adapter.login({
    chromeBridgeClient,
    username: pluginConfig.SELLERSPRITE_USERNAME,
    password: pluginConfig.SELLERSPRITE_PASSWORD,
    timeout
  });
  updateSellerSpriteLoginState(rawResult, args);
  const result = {
    ...rawResult,
    login_cache_used: false,
    login_ttl_hours: getSellerSpriteLoginTtlHours(args),
    last_login_confirmed_at: sellerSpriteLoginState.confirmedAt ? new Date(sellerSpriteLoginState.confirmedAt).toISOString() : null,
    login_cache_expires_at: sellerSpriteLoginState.expiresAt ? new Date(sellerSpriteLoginState.expiresAt).toISOString() : null
  };

  lastRun = {
    command: 'login_sellersprite',
    site: 'sellersprite',
    timestamp: nowIso(),
    success: result.success !== false,
    message: result.message || result.error || null
  };

  return {
    success: result.success !== false,
    site: 'sellersprite',
    command: 'login_sellersprite',
    message: result.message || (result.success === false ? result.error : '登录流程已执行。'),
    page_state: result.page_state,
    page_info_excerpt: result.page_info ? String(result.page_info).slice(0, 1500) : undefined,
    needs_config: result.needs_config === true,
    needs_manual_action: result.needs_manual_action === true,
    credential_error: result.credential_error === true,
    already_logged_in: result.already_logged_in === true,
    login_cache_used: result.login_cache_used === true,
    skipped_login: result.skipped_login === true,
    last_login_confirmed_at: result.last_login_confirmed_at,
    login_cache_expires_at: result.login_cache_expires_at,
    login_ttl_hours: result.login_ttl_hours,
    error: result.error
  };
}

async function cleanupBridgeTabs(warnings, reason) {
  if (!chromeBridgeClient || typeof chromeBridgeClient.closeTabsOpenedByBridge !== 'function') return null;
  try {
    const result = await chromeBridgeClient.closeTabsOpenedByBridge();
    return result;
  } catch (error) {
    warnings.push(`${reason}时清理 ChromeBridge 打开的标签页失败: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function runSellerSpriteResearch(args = {}) {
  if (!chromeBridgeClient) {
    throw new Error('ChromeBridge 客户端未初始化。');
  }

  const normalized = normalizeArgs(args);
  const autoLogin = parseBoolean(args.auto_login ?? args.autoLogin, true);
  const cleanupTabs = parseBoolean(args.cleanup_tabs ?? args.cleanupTabs, true);
  const maxCandidates = parseCandidateLimit(args);
  const resultMode = String(args.result_mode || args.resultMode || 'compact').toLowerCase();

  if (normalized.needs_clarification) {
    lastRun = {
      command: 'run_sellersprite_research',
      site: 'sellersprite',
      timestamp: nowIso(),
      success: false,
      needs_clarification: true,
      unknown_filters: normalized.unknown_filters
    };
    return buildClarificationResult(normalized);
  }

  const site = getSite('sellersprite');
  const url = site.adapter.buildProductResearchUrl(normalized.filters);
  const warnings = [...normalized.warnings];
  if (normalized.unknown_filters.length > 0) {
    warnings.push(`strict_filters=false，已忽略未知字段: ${normalized.unknown_filters.map(item => item.field || item.label).join(', ')}`);
  }

  if (cleanupTabs) {
    await cleanupBridgeTabs(warnings, '开始选品前');
  }

  let loginResult = null;
  if (autoLogin) {
    logFunctions.pushVcpInfo({
      type: 'product_selector_status',
      stage: 'login_sellersprite',
      timestamp: nowIso()
    });

    loginResult = await handleLoginSellerSprite({
      timeout: Number(args.login_timeout) || 30000,
      force_login: parseBoolean(args.force_login ?? args.forceLogin, false),
      login_ttl_hours: args.login_ttl_hours ?? args.loginTtlHours
    });
    if (loginResult.success === false) {
      lastRun = {
        command: 'run_sellersprite_research',
        site: 'sellersprite',
        timestamp: nowIso(),
        success: false,
        error: loginResult.error || loginResult.message || '自动登录失败'
      };
      return {
        success: false,
        site: 'sellersprite',
        command: 'run_sellersprite_research',
        url,
        filters: normalized.filters,
        warnings,
        login_result: loginResult,
        credential_error: loginResult.credential_error === true,
        error: loginResult.error || '自动登录失败，筛选流程已停止。'
      };
    }

    if (cleanupTabs && !loginResult.login_cache_used) {
      await cleanupBridgeTabs(warnings, '登录完成后');
    }
  }

  logFunctions.pushVcpInfo({
    type: 'product_selector_status',
    stage: 'open_sellersprite_url',
    url,
    timestamp: nowIso()
  });

  debugLog('Opening SellerSprite URL:', url);
  let openResult = await chromeBridgeClient.openUrl(url, Number(args.open_timeout) || 45000);
  let waitResult = await chromeBridgeClient.waitForText('搜索结果数', Number(args.wait_timeout) || 45000);
  let emptyResultParsed = null;
  let waitInspection = await inspectSellerSpriteWaitFailure({
    command: 'run_sellersprite_research',
    waitResult,
    openResult,
    loginResult,
    autoLogin,
    warnings,
    args,
    pageLabel: 'SellerSprite 选品结果页'
  });
  if (waitInspection.action === 'empty') {
    emptyResultParsed = waitInspection.parsed;
  }

  if (!emptyResultParsed && waitInspection.action === 'retry_login') {
    warnings.push('复用登录状态后未等到搜索结果，已失效登录缓存并强制重新登录一次。');
    invalidateSellerSpriteLoginState(waitResult.error || 'SellerSprite result page did not load after cached login.');
    loginResult = await handleLoginSellerSprite({
      timeout: Number(args.login_timeout) || 30000,
      force_login: true,
      login_ttl_hours: args.login_ttl_hours ?? args.loginTtlHours
    });
    if (loginResult.success === false) {
      lastRun = {
        command: 'run_sellersprite_research',
        site: 'sellersprite',
        timestamp: nowIso(),
        success: false,
        error: loginResult.error || loginResult.message || '自动登录失败'
      };
      return {
        success: false,
        site: 'sellersprite',
        command: 'run_sellersprite_research',
        url,
        filters: normalized.filters,
        warnings,
        login_result: loginResult,
        credential_error: loginResult.credential_error === true,
        error: loginResult.error || '自动登录失败，筛选流程已停止。'
      };
    }
    if (cleanupTabs) {
      await cleanupBridgeTabs(warnings, '强制重新登录完成后');
    }
    openResult = await chromeBridgeClient.openUrl(url, Number(args.open_timeout) || 45000);
    waitResult = await chromeBridgeClient.waitForText('搜索结果数', Number(args.wait_timeout) || 45000);
    waitInspection = await inspectSellerSpriteWaitFailure({
      command: 'run_sellersprite_research',
      waitResult,
      openResult,
      loginResult,
      autoLogin,
      warnings,
      args,
      pageLabel: 'SellerSprite 选品结果页'
    });
    if (waitInspection.action === 'empty') {
      emptyResultParsed = waitInspection.parsed;
    }
  }

  if (!emptyResultParsed && waitInspection.action === 'login_required') {
    lastRun = {
      command: 'run_sellersprite_research',
      site: 'sellersprite',
      timestamp: nowIso(),
      success: false,
      error: 'SellerSprite 当前页面是登录页'
    };
    return {
      success: false,
      site: 'sellersprite',
      command: 'run_sellersprite_research',
      url,
      filters: normalized.filters,
      warnings,
      login_result: loginResult,
      open_result: openResult,
      wait_result: waitResult,
      needs_login: true,
      error: 'SellerSprite 当前页面仍是登录页，请确认登录状态或手动处理验证码后重试。'
    };
  }

  let tableResult = null;
  if (!emptyResultParsed && parseBoolean(args.extract_table ?? args.extractTable, true) && typeof chromeBridgeClient.extractTable === 'function') {
    try {
      tableResult = await chromeBridgeClient.extractTable({
        selector: String(args.table_selector || args.tableSelector || 'body'),
        tableMode: String(args.table_mode || args.tableMode || 'sellersprite_product'),
        maxRows: maxCandidates,
        columns: args.table_columns || args.tableColumns || PRODUCT_TABLE_COLUMNS,
        includeHtml: parseBoolean(args.include_table_html ?? args.includeTableHtml, false),
        includeDetails: parseBoolean(args.include_table_details ?? args.includeTableDetails, true),
        includeLinks: parseBoolean(args.include_table_links ?? args.includeTableLinks, false),
        maxCellChars: Number(args.max_cell_chars || args.maxCellChars) || 220,
        maxDetailChars: Number(args.max_detail_chars || args.maxDetailChars) || 260,
        maxAsins: Number(args.max_asins || args.maxAsins) || 10,
        timeout: Number(args.table_extract_timeout) || 30000
      });
    } catch (error) {
      warnings.push(`结构化表格抽取失败，已回退 Markdown 页面解析: ${error.message}`);
    }
  }

  const tableData = tableResult?.table_data;
  const productCandidates = normalizeProductTableData(tableData, maxCandidates);
  let parsed = emptyResultParsed || {
    result_count: tableData?.result_count || null,
    pagination: null,
    candidates: productCandidates,
    raw_page_info_excerpt: '',
    table_data: tableData
  };
  let usedMarkdownFallback = false;

  const productMetricsAvailable = hasProductCandidateMetrics(parsed.candidates);
  if (!emptyResultParsed && (parsed.candidates.length === 0 || !productMetricsAvailable || resultMode === 'debug' || resultMode === 'full')) {
    if (parsed.candidates.length > 0 && !productMetricsAvailable) {
      warnings.push('产品 DOM 抽取只拿到 ASIN，缺少指标列，已回退页面文本解析补充字段。');
    }
    usedMarkdownFallback = true;
    const pageInfoResult = await chromeBridgeClient.getPageInfo(Number(args.page_info_timeout) || 30000);
    const pageInfo = pageInfoResult.page_info || waitResult.page_info || openResult.page_info || '';
    const markdownParsed = parsePageInfo(pageInfo, { maxCandidates });
    const keepDomCandidates = parsed.candidates.length > 0 && productMetricsAvailable;
    parsed = {
      ...markdownParsed,
      result_count: markdownParsed.result_count ?? tableData?.result_count ?? parsed.result_count,
      candidates: keepDomCandidates ? parsed.candidates : markdownParsed.candidates,
      raw_page_info_excerpt: resultMode === 'compact' ? '' : markdownParsed.raw_page_info_excerpt,
      table_data: tableData
    };
    if (parsed.candidates.length === 0) {
      const tableCandidates = extractAsinCandidatesFromOrderedTable(parsed.table_data, maxCandidates);
      if (tableCandidates.length > 0) parsed.candidates = tableCandidates;
    }
  }
  parsed.candidates = sanitizeProductCandidates(parsed.candidates);
  const summary = buildSummary({ url, parsed, normalized, warnings });
  const includeDebugPayload = resultMode === 'debug' || resultMode === 'full';
  const includeOrderedTable = includeDebugPayload || parseBoolean(args.include_ordered_table ?? args.includeOrderedTable, false);
  const includeLoginResult = includeDebugPayload || parseBoolean(args.include_login_result ?? args.includeLoginResult, false);
  const includeCandidates = includeDebugPayload || parseBoolean(args.include_candidates ?? args.includeCandidates, false);

  const result = {
    success: true,
    site: 'sellersprite',
    command: 'run_sellersprite_research',
    url,
    filters: normalized.filters,
    login_status: compactLoginStatus(loginResult),
    login_result: includeLoginResult ? loginResult : undefined,
    result_count: parsed.result_count,
    candidate_count: parsed.candidates.length,
    no_results: parsed.no_results === true,
    empty_result: parsed.empty_result === true,
    empty_reason: parsed.empty_reason,
    pagination: parsed.pagination,
    candidates: includeCandidates ? parsed.candidates : undefined,
    extraction_source: parsed.empty_result ? 'empty_result' : (parsed.table_data ? (usedMarkdownFallback ? 'dom_table+markdown' : 'dom_table') : 'markdown'),
    table_row_count: parsed.table_data?.row_count,
    ordered_table: includeOrderedTable && parsed.table_data?.headers ? {
      headers: parsed.table_data.headers,
      rows: parsed.table_data.rows,
      row_count: parsed.table_data.row_count
    } : undefined,
    field_coverage: {
      ordered_table_headers: parsed.table_data?.headers || [],
      candidate_fields: parsed.candidates[0] ? Object.keys(parsed.candidates[0]) : []
    },
    summary_markdown: summary,
    raw_page_info_excerpt: parsed.raw_page_info_excerpt,
    warnings,
    unknown_filters: normalized.unknown_filters,
    next_actions: parsed.no_results
      ? ['放宽筛选条件、重新选择类目，或先重置条件后再查询。']
      : (parsed.candidates.length > 0
        ? ['基于候选 ASIN 做人工复核或后续 Amazon 评论采样。']
        : ['若页面确实有结果但未解析候选，请使用 get_page_info 证据扩展 pageInfoParser。'])
  };

  lastRun = {
    command: 'run_sellersprite_research',
    site: 'sellersprite',
    timestamp: nowIso(),
    success: true,
    url,
    result_count: parsed.result_count,
    candidate_count: parsed.candidates.length,
    warnings
  };

  return result;
}

async function runSellerSpriteCompetitorLookup(args = {}) {
  if (!chromeBridgeClient) {
    throw new Error('ChromeBridge 客户端未初始化。');
  }

  const normalized = normalizeCompetitorLookupArgs(args);
  const autoLogin = parseBoolean(args.auto_login ?? args.autoLogin, true);
  const cleanupTabs = parseBoolean(args.cleanup_tabs ?? args.cleanupTabs, true);
  const maxCandidates = parseCandidateLimit(args);
  const resultMode = String(args.result_mode || args.resultMode || 'compact').toLowerCase();

  if (normalized.needs_clarification) {
    lastRun = {
      command: 'run_sellersprite_competitor_lookup',
      site: 'sellersprite',
      timestamp: nowIso(),
      success: false,
      needs_clarification: true,
      warnings: normalized.warnings
    };
    return buildSellerSpriteCompetitorFailure(normalized);
  }

  const site = getSite('sellersprite');
  const url = site.adapter.buildCompetitorLookupUrl(normalized.filters);
  const warnings = [...normalized.warnings];

  if (cleanupTabs) {
    await cleanupBridgeTabs(warnings, '开始 SellerSprite 查竞品前');
  }

  let loginResult = null;
  if (autoLogin) {
    logFunctions.pushVcpInfo({
      type: 'product_selector_status',
      stage: 'login_sellersprite',
      timestamp: nowIso()
    });

    loginResult = await handleLoginSellerSprite({
      timeout: Number(args.login_timeout) || 30000,
      force_login: parseBoolean(args.force_login ?? args.forceLogin, false),
      login_ttl_hours: args.login_ttl_hours ?? args.loginTtlHours
    });
    if (loginResult.success === false) {
      lastRun = {
        command: 'run_sellersprite_competitor_lookup',
        site: 'sellersprite',
        timestamp: nowIso(),
        success: false,
        error: loginResult.error || loginResult.message || '自动登录失败'
      };
      return {
        success: false,
        site: 'sellersprite',
        command: 'run_sellersprite_competitor_lookup',
        url,
        filters: normalized.filters,
        warnings,
        login_result: loginResult,
        credential_error: loginResult.credential_error === true,
        error: loginResult.error || '自动登录失败，查竞品流程已停止。'
      };
    }

    if (cleanupTabs && !loginResult.login_cache_used) {
      await cleanupBridgeTabs(warnings, '登录完成后');
    }
  }

  logFunctions.pushVcpInfo({
    type: 'product_selector_status',
    stage: 'open_sellersprite_competitor_url',
    url,
    timestamp: nowIso()
  });

  debugLog('Opening SellerSprite competitor URL:', url);
  let openResult = await chromeBridgeClient.openUrl(url, Number(args.open_timeout) || 45000);
  let waitResult = await chromeBridgeClient.waitForText(String(args.wait_text || args.waitText || '产品信息'), Number(args.wait_timeout) || 45000);
  let emptyResultParsed = null;
  let waitInspection = await inspectSellerSpriteWaitFailure({
    command: 'run_sellersprite_competitor_lookup',
    waitResult,
    openResult,
    loginResult,
    autoLogin,
    warnings,
    args,
    pageLabel: 'SellerSprite 查竞品结果页'
  });
  if (waitInspection.action === 'empty') {
    emptyResultParsed = waitInspection.parsed;
  }

  if (!emptyResultParsed && waitInspection.action === 'retry_login') {
    warnings.push('复用登录状态后未等到查竞品结果页，已失效登录缓存并强制重新登录一次。');
    invalidateSellerSpriteLoginState(waitResult.error || 'SellerSprite competitor page did not load after cached login.');
    loginResult = await handleLoginSellerSprite({
      timeout: Number(args.login_timeout) || 30000,
      force_login: true,
      login_ttl_hours: args.login_ttl_hours ?? args.loginTtlHours
    });
    if (loginResult.success === false) {
      lastRun = {
        command: 'run_sellersprite_competitor_lookup',
        site: 'sellersprite',
        timestamp: nowIso(),
        success: false,
        error: loginResult.error || loginResult.message || '自动登录失败'
      };
      return {
        success: false,
        site: 'sellersprite',
        command: 'run_sellersprite_competitor_lookup',
        url,
        filters: normalized.filters,
        warnings,
        login_result: loginResult,
        credential_error: loginResult.credential_error === true,
        error: loginResult.error || '自动登录失败，查竞品流程已停止。'
      };
    }
    if (cleanupTabs) {
      await cleanupBridgeTabs(warnings, '强制重新登录完成后');
    }
    openResult = await chromeBridgeClient.openUrl(url, Number(args.open_timeout) || 45000);
    waitResult = await chromeBridgeClient.waitForText(String(args.wait_text || args.waitText || '产品信息'), Number(args.wait_timeout) || 45000);
    waitInspection = await inspectSellerSpriteWaitFailure({
      command: 'run_sellersprite_competitor_lookup',
      waitResult,
      openResult,
      loginResult,
      autoLogin,
      warnings,
      args,
      pageLabel: 'SellerSprite 查竞品结果页'
    });
    if (waitInspection.action === 'empty') {
      emptyResultParsed = waitInspection.parsed;
    }
  }

  if (!emptyResultParsed && waitInspection.action === 'login_required') {
    lastRun = {
      command: 'run_sellersprite_competitor_lookup',
      site: 'sellersprite',
      timestamp: nowIso(),
      success: false,
      error: 'SellerSprite 当前页面是登录页'
    };
    return {
      success: false,
      site: 'sellersprite',
      command: 'run_sellersprite_competitor_lookup',
      url,
      filters: normalized.filters,
      warnings,
      login_result: loginResult,
      open_result: openResult,
      wait_result: waitResult,
      needs_login: true,
      error: 'SellerSprite 当前页面仍是登录页，请确认登录状态或手动处理验证码后重试。'
    };
  }

  let tableResult = null;
  if (!emptyResultParsed && parseBoolean(args.extract_table ?? args.extractTable, true) && typeof chromeBridgeClient.extractTable === 'function') {
    try {
      tableResult = await chromeBridgeClient.extractTable({
        selector: String(args.table_selector || args.tableSelector || 'body'),
        tableMode: String(args.table_mode || args.tableMode || 'sellersprite_product'),
        maxRows: maxCandidates,
        columns: args.table_columns || args.tableColumns || PRODUCT_TABLE_COLUMNS,
        includeHtml: parseBoolean(args.include_table_html ?? args.includeTableHtml, false),
        includeDetails: parseBoolean(args.include_table_details ?? args.includeTableDetails, true),
        includeLinks: parseBoolean(args.include_table_links ?? args.includeTableLinks, false),
        maxCellChars: Number(args.max_cell_chars || args.maxCellChars) || 220,
        maxDetailChars: Number(args.max_detail_chars || args.maxDetailChars) || 260,
        maxAsins: Number(args.max_asins || args.maxAsins) || 10,
        timeout: Number(args.table_extract_timeout) || 30000
      });
    } catch (error) {
      warnings.push(`查竞品结构化表格抽取失败，已回退 Markdown 页面解析: ${error.message}`);
    }
  }

  const tableData = tableResult?.table_data;
  const productCandidates = normalizeProductTableData(tableData, maxCandidates);
  let parsed = emptyResultParsed || {
    result_count: tableData?.result_count || null,
    pagination: null,
    candidates: productCandidates,
    raw_page_info_excerpt: '',
    table_data: tableData
  };
  let usedMarkdownFallback = false;
  const productMetricsAvailable = hasProductCandidateMetrics(parsed.candidates);

  if (!emptyResultParsed && (parsed.candidates.length === 0 || !productMetricsAvailable || resultMode === 'debug' || resultMode === 'full')) {
    if (parsed.candidates.length > 0 && !productMetricsAvailable) {
      warnings.push('查竞品 DOM 抽取只拿到 ASIN，缺少指标列，已回退页面文本解析补充字段。');
    }
    usedMarkdownFallback = true;
    const pageInfoResult = await chromeBridgeClient.getPageInfo(Number(args.page_info_timeout) || 30000);
    const pageInfo = pageInfoResult.page_info || waitResult.page_info || openResult.page_info || '';
    const markdownParsed = parsePageInfo(pageInfo, { maxCandidates });
    const keepDomCandidates = parsed.candidates.length > 0 && productMetricsAvailable;
    parsed = {
      ...markdownParsed,
      result_count: markdownParsed.result_count ?? tableData?.result_count ?? parsed.result_count,
      candidates: keepDomCandidates ? parsed.candidates : markdownParsed.candidates,
      raw_page_info_excerpt: resultMode === 'compact' ? '' : markdownParsed.raw_page_info_excerpt,
      table_data: tableData
    };
    if (parsed.candidates.length === 0) {
      const tableCandidates = extractAsinCandidatesFromOrderedTable(parsed.table_data, maxCandidates);
      if (tableCandidates.length > 0) parsed.candidates = tableCandidates;
    }
  }

  parsed.candidates = sanitizeProductCandidates(parsed.candidates);
  const includeDebugPayload = resultMode === 'debug' || resultMode === 'full';
  const includeOrderedTable = includeDebugPayload || parseBoolean(args.include_ordered_table ?? args.includeOrderedTable, false);
  const includeLoginResult = includeDebugPayload || parseBoolean(args.include_login_result ?? args.includeLoginResult, false);
  const includeCandidates = includeDebugPayload || parseBoolean(args.include_candidates ?? args.includeCandidates, false);
  const summary = buildSummary({
    url,
    parsed,
    normalized,
    warnings,
    title: '# 卖家精灵查竞品结果'
  });

  const result = {
    success: true,
    site: 'sellersprite',
    command: 'run_sellersprite_competitor_lookup',
    url,
    filters: normalized.filters,
    login_status: compactLoginStatus(loginResult),
    login_result: includeLoginResult ? loginResult : undefined,
    result_count: parsed.result_count,
    candidate_count: parsed.candidates.length,
    no_results: parsed.no_results === true,
    empty_result: parsed.empty_result === true,
    empty_reason: parsed.empty_reason,
    pagination: parsed.pagination,
    candidates: includeCandidates ? parsed.candidates : undefined,
    extraction_source: parsed.empty_result ? 'empty_result' : (parsed.table_data ? (usedMarkdownFallback ? 'dom_table+markdown' : 'dom_table') : 'markdown'),
    table_row_count: parsed.table_data?.row_count,
    ordered_table: includeOrderedTable && parsed.table_data?.headers ? {
      headers: parsed.table_data.headers,
      rows: parsed.table_data.rows,
      row_count: parsed.table_data.row_count
    } : undefined,
    field_coverage: {
      ordered_table_headers: parsed.table_data?.headers || [],
      candidate_fields: parsed.candidates[0] ? Object.keys(parsed.candidates[0]) : []
    },
    summary_markdown: summary,
    raw_page_info_excerpt: parsed.raw_page_info_excerpt,
    warnings,
    next_actions: parsed.no_results
      ? ['放宽筛选条件、重新选择类目，或先重置条件后再查询。']
      : (parsed.candidates.length > 0
        ? ['基于竞品 ASIN 基础数据继续做 Amazon Listing、评论或卖点对比。']
        : ['若页面确实有结果但未解析候选，请使用 result_mode=debug 查看表格/页面证据。'])
  };

  lastRun = {
    command: 'run_sellersprite_competitor_lookup',
    site: 'sellersprite',
    timestamp: nowIso(),
    success: true,
    url,
    result_count: parsed.result_count,
    candidate_count: parsed.candidates.length,
    warnings
  };

  return result;
}

async function runSellerSpriteKeywordResearch(args = {}) {
  if (!chromeBridgeClient) {
    throw new Error('ChromeBridge 客户端未初始化。');
  }

  const normalized = normalizeKeywordArgs(args);
  const autoLogin = parseBoolean(args.auto_login ?? args.autoLogin, true);
  const cleanupTabs = parseBoolean(args.cleanup_tabs ?? args.cleanupTabs, true);
  const maxCandidates = parseCandidateLimit(args);
  const resultMode = (args.result_mode || args.resultMode || 'compact').toLowerCase();
  const includeDebugPayload = resultMode === 'debug' || resultMode === 'full';
  const includeLoginResult = includeDebugPayload || parseBoolean(args.include_login_result ?? args.includeLoginResult, false);
  const showTag = parseBoolean(args.show_tag ?? args.showTag, false);
  const includeTranslation = parseBoolean(args.translate ?? args.include_translation ?? args.includeTranslation, false);

  if (normalized.needs_clarification) {
    lastRun = {
      command: 'run_sellersprite_keyword_research',
      site: 'sellersprite',
      timestamp: nowIso(),
      success: false,
      needs_clarification: true,
      unknown_filters: normalized.unknown_filters
    };
    return buildClarificationResult(normalized);
  }

  const site = getSite('sellersprite');
  const url = site.adapter.buildKeywordResearchUrl(normalized.filters);
  const warnings = [...normalized.warnings];
  if (normalized.unknown_filters.length > 0) {
    warnings.push(`strict_filters=false，已忽略未知字段: ${normalized.unknown_filters.map(item => item.field || item.label).join(', ')}`);
  }

  if (cleanupTabs) {
    await cleanupBridgeTabs(warnings, '开始关键词选品前');
  }

  let loginResult = null;
  if (autoLogin) {
    logFunctions.pushVcpInfo({
      type: 'product_selector_status',
      stage: 'login_sellersprite',
      timestamp: nowIso()
    });

    loginResult = await handleLoginSellerSprite({
      timeout: Number(args.login_timeout) || 30000,
      force_login: parseBoolean(args.force_login ?? args.forceLogin, false),
      login_ttl_hours: args.login_ttl_hours ?? args.loginTtlHours
    });
    if (loginResult.success === false) {
      lastRun = {
        command: 'run_sellersprite_keyword_research',
        site: 'sellersprite',
        timestamp: nowIso(),
        success: false,
        error: loginResult.error || loginResult.message || '自动登录失败'
      };
      return {
        success: false,
        site: 'sellersprite',
        command: 'run_sellersprite_keyword_research',
        url,
        filters: normalized.filters,
        warnings,
        login_result: loginResult,
        credential_error: loginResult.credential_error === true,
        error: loginResult.error || '自动登录失败，关键词选品流程已停止。'
      };
    }

    if (cleanupTabs && !loginResult.login_cache_used) {
      await cleanupBridgeTabs(warnings, '登录完成后');
    }
  }

  logFunctions.pushVcpInfo({
    type: 'product_selector_status',
    stage: 'open_sellersprite_keyword_url',
    url,
    timestamp: nowIso()
  });

  debugLog('Opening SellerSprite keyword URL:', url);
  let openResult = await chromeBridgeClient.openUrl(url, Number(args.open_timeout) || 45000);
  let waitResult = await chromeBridgeClient.waitForText(String(args.wait_text || '月搜索量'), Number(args.wait_timeout) || 45000);
  let emptyResultParsed = null;
  let waitInspection = await inspectSellerSpriteWaitFailure({
    command: 'run_sellersprite_keyword_research',
    waitResult,
    openResult,
    loginResult,
    autoLogin,
    warnings,
    args,
    pageLabel: 'SellerSprite 关键词结果页'
  });
  if (waitInspection.action === 'empty') {
    emptyResultParsed = waitInspection.parsed;
  }

  if (!emptyResultParsed && waitInspection.action === 'retry_login') {
    warnings.push('复用登录状态后未等到关键词结果页，已失效登录缓存并强制重新登录一次。');
    invalidateSellerSpriteLoginState(waitResult.error || 'SellerSprite keyword page did not load after cached login.');
    loginResult = await handleLoginSellerSprite({
      timeout: Number(args.login_timeout) || 30000,
      force_login: true,
      login_ttl_hours: args.login_ttl_hours ?? args.loginTtlHours
    });
    if (loginResult.success === false) {
      lastRun = {
        command: 'run_sellersprite_keyword_research',
        site: 'sellersprite',
        timestamp: nowIso(),
        success: false,
        error: loginResult.error || loginResult.message || '自动登录失败'
      };
      return {
        success: false,
        site: 'sellersprite',
        command: 'run_sellersprite_keyword_research',
        url,
        filters: normalized.filters,
        warnings,
        login_result: loginResult,
        credential_error: loginResult.credential_error === true,
        error: loginResult.error || '自动登录失败，关键词选品流程已停止。'
      };
    }
    if (cleanupTabs) {
      await cleanupBridgeTabs(warnings, '强制重新登录完成后');
    }
    openResult = await chromeBridgeClient.openUrl(url, Number(args.open_timeout) || 45000);
    waitResult = await chromeBridgeClient.waitForText(String(args.wait_text || '月搜索量'), Number(args.wait_timeout) || 45000);
    waitInspection = await inspectSellerSpriteWaitFailure({
      command: 'run_sellersprite_keyword_research',
      waitResult,
      openResult,
      loginResult,
      autoLogin,
      warnings,
      args,
      pageLabel: 'SellerSprite 关键词结果页'
    });
    if (waitInspection.action === 'empty') {
      emptyResultParsed = waitInspection.parsed;
    }
  }

  if (!emptyResultParsed && waitInspection.action === 'login_required') {
    lastRun = {
      command: 'run_sellersprite_keyword_research',
      site: 'sellersprite',
      timestamp: nowIso(),
      success: false,
      error: 'SellerSprite 当前页面是登录页'
    };
    return {
      success: false,
      site: 'sellersprite',
      command: 'run_sellersprite_keyword_research',
      url,
      filters: normalized.filters,
      warnings,
      login_result: loginResult,
      open_result: openResult,
      wait_result: waitResult,
      needs_login: true,
      error: 'SellerSprite 当前页面仍是登录页，请确认登录状态或手动处理验证码后重试。'
    };
  }

  let tableResult = null;
  let parsed = null;
  if (!emptyResultParsed && parseBoolean(args.extract_table ?? args.extractTable, true) && typeof chromeBridgeClient.extractTable === 'function') {
    try {
      tableResult = await chromeBridgeClient.extractTable({
        selector: String(args.table_selector || args.tableSelector || '#table-condition-search'),
        tableMode: String(args.table_mode || args.tableMode || ''),
        maxRows: maxCandidates,
        includeHtml: parseBoolean(args.include_table_html ?? args.includeTableHtml, false),
        includeDetails: parseBoolean(args.include_table_details ?? args.includeTableDetails, true),
        includeLinks: parseBoolean(args.include_table_links ?? args.includeTableLinks, false),
        maxCellChars: Number(args.max_cell_chars || args.maxCellChars) || 220,
        maxDetailChars: Number(args.max_detail_chars || args.maxDetailChars) || 260,
        maxAsins: Number(args.max_asins || args.maxAsins) || 10,
        timeout: Number(args.table_extract_timeout) || 30000
      });
    } catch (error) {
      warnings.push(`结构化表格抽取失败，已回退 Markdown 页面解析: ${error.message}`);
    }
  }
  const tableRows = tableResult?.table_data?.rows;
  if (emptyResultParsed) {
    parsed = {
      ...emptyResultParsed,
      extraction_source: 'empty_result'
    };
  } else if (Array.isArray(tableRows) && tableRows.length > 0) {
    const candidates = normalizeKeywordTableData(tableResult.table_data, { maxCandidates });
    parsed = {
      result_count: null,
      pagination: null,
      candidates,
      raw_page_info_excerpt: '',
      extraction_source: 'dom_table',
      table_data: tableResult.table_data
    };
  } else {
    const pageInfoResult = await chromeBridgeClient.getPageInfo(Number(args.page_info_timeout) || 30000);
    const pageInfo = pageInfoResult.page_info || waitResult.page_info || openResult.page_info || '';
    parsed = parseKeywordPageInfo(pageInfo, { maxCandidates });
    parsed.extraction_source = 'markdown';
  }
  if (parsed.candidates && parsed.candidates.length > 0) {
    parsed.candidates.forEach(c => {
      if (!showTag && c.keyword) {
        c.keyword = c.keyword.replace(/\s+(?:AC|HR|ER|NR|TR|BS|4S)$/i, '').trim();
      }
      if (!includeTranslation) {
        c.translation = null;
      }
    });
  }

  const summary = buildKeywordSummary({ url, parsed, normalized, warnings });

  const result = {
    success: true,
    site: 'sellersprite',
    command: 'run_sellersprite_keyword_research',
    url,
    filters: normalized.filters,
    login_status: compactLoginStatus(loginResult),
    login_result: includeLoginResult ? loginResult : undefined,
    result_count: parsed.result_count,
    candidate_count: parsed.candidates.length,
    no_results: parsed.no_results === true,
    empty_result: parsed.empty_result === true,
    empty_reason: parsed.empty_reason,
    pagination: parsed.pagination,
    candidates: includeDebugPayload ? parsed.candidates : undefined,
    extraction_source: parsed.extraction_source,
    table_row_count: parsed.table_data?.row_count,
    ordered_table: includeDebugPayload && parsed.table_data?.headers ? {
      headers: parsed.table_data.headers,
      rows: parsed.table_data.rows,
      row_count: parsed.table_data.row_count
    } : undefined,
    field_coverage: {
      ordered_table_headers: parsed.table_data?.headers || [],
      candidate_fields: parsed.candidates[0] ? Object.keys(parsed.candidates[0]) : []
    },
    summary_markdown: summary,
    raw_page_info_excerpt: parsed.raw_page_info_excerpt,
    warnings,
    unknown_filters: normalized.unknown_filters,
    next_actions: parsed.no_results
      ? ['放宽关键词筛选条件、重新选择类目，或先重置条件后再查询。']
      : (parsed.candidates.length > 0
        ? ['基于候选关键词做人工复核，或继续扩展关键词详情解析字段。']
        : ['若页面确实有结果但未解析候选关键词，请使用 get_page_info 证据扩展 keyword pageInfoParser。'])
  };

  lastRun = {
    command: 'run_sellersprite_keyword_research',
    site: 'sellersprite',
    timestamp: nowIso(),
    success: true,
    url,
    result_count: parsed.result_count,
    candidate_count: parsed.candidates.length,
    warnings
  };

  return result;
}

async function handleBuildSellerSpriteKeywordReverseUrl(args) {
  const normalized = normalizeKeywordReverseArgs(args);
  if (normalized.needs_clarification) {
    return {
      success: false,
      site: 'sellersprite',
      command: 'build_sellersprite_keyword_reverse_url',
      needs_clarification: true,
      warnings: normalized.warnings,
      error: normalized.warnings.find(item => item.includes('一次只支持 1 个 ASIN')) || '缺少竞品 ASIN。关键词反查一次只支持 1 个 ASIN，请通过 asin 或 q 传入。'
    };
  }

  const site = getSite('sellersprite');
  const url = site.adapter.buildKeywordReverseUrl(normalized.filters);
  return {
    success: true,
    site: 'sellersprite',
    command: 'build_sellersprite_keyword_reverse_url',
    url,
    filters: normalized.filters,
    warnings: normalized.warnings
  };
}

async function runSellerSpriteKeywordReverse(args = {}) {
  if (!chromeBridgeClient) {
    throw new Error('ChromeBridge 客户端未初始化。');
  }

  const normalized = normalizeKeywordReverseArgs(args);
  const autoLogin = parseBoolean(args.auto_login ?? args.autoLogin, true);
  const cleanupTabs = parseBoolean(args.cleanup_tabs ?? args.cleanupTabs, true);
  const maxCandidates = parseCandidateLimit(args);
  const resultMode = (args.result_mode || args.resultMode || 'compact').toLowerCase();
  const includeDebugPayload = resultMode === 'debug' || resultMode === 'full';
  const includeLoginResult = includeDebugPayload || parseBoolean(args.include_login_result ?? args.includeLoginResult, false);
  const showTag = parseBoolean(args.show_tag ?? args.showTag, false);
  const includeTranslation = parseBoolean(args.translate ?? args.include_translation ?? args.includeTranslation, false);

  if (normalized.needs_clarification) {
    lastRun = {
      command: 'run_sellersprite_keyword_reverse',
      site: 'sellersprite',
      timestamp: nowIso(),
      success: false,
      needs_clarification: true,
      warnings: normalized.warnings
    };
    return {
      success: false,
      site: 'sellersprite',
      command: 'run_sellersprite_keyword_reverse',
      needs_clarification: true,
      warnings: normalized.warnings,
      error: normalized.warnings.find(item => item.includes('一次只支持 1 个 ASIN')) || '缺少竞品 ASIN。关键词反查一次只支持 1 个 ASIN，请通过 asin 或 q 传入。'
    };
  }

  const site = getSite('sellersprite');
  const url = site.adapter.buildKeywordReverseUrl(normalized.filters);
  const warnings = [...normalized.warnings];

  if (cleanupTabs) {
    await cleanupBridgeTabs(warnings, '开始关键词反查前');
  }

  let loginResult = null;
  if (autoLogin) {
    logFunctions.pushVcpInfo({
      type: 'product_selector_status',
      stage: 'login_sellersprite',
      timestamp: nowIso()
    });

    loginResult = await handleLoginSellerSprite({
      timeout: Number(args.login_timeout) || 30000,
      force_login: parseBoolean(args.force_login ?? args.forceLogin, false),
      login_ttl_hours: args.login_ttl_hours ?? args.loginTtlHours
    });
    if (loginResult.success === false) {
      lastRun = {
        command: 'run_sellersprite_keyword_reverse',
        site: 'sellersprite',
        timestamp: nowIso(),
        success: false,
        error: loginResult.error || loginResult.message || '自动登录失败'
      };
      return {
        success: false,
        site: 'sellersprite',
        command: 'run_sellersprite_keyword_reverse',
        url,
        filters: normalized.filters,
        warnings,
        login_result: loginResult,
        credential_error: loginResult.credential_error === true,
        error: loginResult.error || '自动登录失败，关键词反查流程已停止。'
      };
    }

    if (cleanupTabs && !loginResult.login_cache_used) {
      await cleanupBridgeTabs(warnings, '登录完成后');
    }
  }

  logFunctions.pushVcpInfo({
    type: 'product_selector_status',
    stage: 'open_sellersprite_keyword_reverse_url',
    url,
    timestamp: nowIso()
  });

  debugLog('Opening SellerSprite keyword reverse URL:', url);
  let openResult = await chromeBridgeClient.openUrl(url, Number(args.open_timeout) || 45000);
  let waitResult = await chromeBridgeClient.waitForText(String(args.wait_text || '流量占比'), Number(args.wait_timeout) || 45000);
  let emptyResultParsed = null;
  let waitInspection = await inspectSellerSpriteWaitFailure({
    command: 'run_sellersprite_keyword_reverse',
    waitResult,
    openResult,
    loginResult,
    autoLogin,
    warnings,
    args,
    pageLabel: 'SellerSprite 关键词反查页'
  });
  if (waitInspection.action === 'empty') {
    emptyResultParsed = waitInspection.parsed;
  }

  if (!emptyResultParsed && waitInspection.action === 'retry_login') {
    warnings.push('复用登录状态后未等到关键词反查页，已失效登录缓存并强制重新登录一次。');
    invalidateSellerSpriteLoginState(waitResult.error || 'SellerSprite keyword reverse page did not load after cached login.');
    loginResult = await handleLoginSellerSprite({
      timeout: Number(args.login_timeout) || 30000,
      force_login: true,
      login_ttl_hours: args.login_ttl_hours ?? args.loginTtlHours
    });
    if (loginResult.success === false) {
      lastRun = {
        command: 'run_sellersprite_keyword_reverse',
        site: 'sellersprite',
        timestamp: nowIso(),
        success: false,
        error: loginResult.error || loginResult.message || '自动登录失败'
      };
      return {
        success: false,
        site: 'sellersprite',
        command: 'run_sellersprite_keyword_reverse',
        url,
        filters: normalized.filters,
        warnings,
        login_result: loginResult,
        credential_error: loginResult.credential_error === true,
        error: loginResult.error || '自动登录失败，关键词反查流程已停止。'
      };
    }
    if (cleanupTabs) {
      await cleanupBridgeTabs(warnings, '强制重新登录完成后');
    }
    openResult = await chromeBridgeClient.openUrl(url, Number(args.open_timeout) || 45000);
    waitResult = await chromeBridgeClient.waitForText(String(args.wait_text || '流量占比'), Number(args.wait_timeout) || 45000);
    waitInspection = await inspectSellerSpriteWaitFailure({
      command: 'run_sellersprite_keyword_reverse',
      waitResult,
      openResult,
      loginResult,
      autoLogin,
      warnings,
      args,
      pageLabel: 'SellerSprite 关键词反查页'
    });
    if (waitInspection.action === 'empty') {
      emptyResultParsed = waitInspection.parsed;
    }
  }

  if (!emptyResultParsed && waitInspection.action === 'login_required') {
    lastRun = {
      command: 'run_sellersprite_keyword_reverse',
      site: 'sellersprite',
      timestamp: nowIso(),
      success: false,
      error: 'SellerSprite 当前页面是登录页'
    };
    return {
      success: false,
      site: 'sellersprite',
      command: 'run_sellersprite_keyword_reverse',
      url,
      filters: normalized.filters,
      warnings,
      login_result: loginResult,
      open_result: openResult,
      wait_result: waitResult,
      needs_login: true,
      error: 'SellerSprite 当前页面仍是登录页，请确认登录状态或手动处理验证码后重试。'
    };
  }

  let tableResult = null;
  let parsed = null;
  if (!emptyResultParsed && parseBoolean(args.extract_table ?? args.extractTable, true) && typeof chromeBridgeClient.extractTable === 'function') {
    try {
      tableResult = await chromeBridgeClient.extractTable({
        selector: String(args.table_selector || args.tableSelector || 'body'),
        tableMode: String(args.table_mode || args.tableMode || ''),
        maxRows: maxCandidates,
        includeHtml: parseBoolean(args.include_table_html ?? args.includeTableHtml, false),
        includeDetails: parseBoolean(args.include_table_details ?? args.includeTableDetails, true),
        includeLinks: parseBoolean(args.include_table_links ?? args.includeTableLinks, false),
        maxCellChars: Number(args.max_cell_chars || args.maxCellChars) || 220,
        maxDetailChars: Number(args.max_detail_chars || args.maxDetailChars) || 260,
        maxAsins: Number(args.max_asins || args.maxAsins) || 10,
        timeout: Number(args.table_extract_timeout) || 30000
      });
    } catch (error) {
      warnings.push(`结构化表格抽取失败: ${error.message}`);
    }
  }

  const tableRows = tableResult?.table_data?.rows;
  if (emptyResultParsed) {
    parsed = {
      ...emptyResultParsed,
      extraction_source: 'empty_result'
    };
  } else if (Array.isArray(tableRows) && tableRows.length > 0) {
    const candidates = normalizeKeywordReverseTableData(tableResult.table_data, { maxCandidates });
    parsed = {
      result_count: tableResult.table_data.row_count || candidates.length,
      pagination: null,
      candidates,
      raw_page_info_excerpt: '',
      extraction_source: 'dom_table',
      table_data: tableResult.table_data
    };
  } else {
    warnings.push('无法通过 DOM 表格抽取数据，已尝试通过页面文本解析。');
    const pageInfoResult = await chromeBridgeClient.getPageInfo(Number(args.page_info_timeout) || 30000);
    const pageInfo = pageInfoResult.page_info || waitResult.page_info || openResult.page_info || '';

    if (isSellerSpriteNoResultsText(pageInfo)) {
      parsed = {
        ...buildSellerSpriteNoResultsParsed(pageInfo),
        extraction_source: 'empty_result'
      };
    } else {
      const candidates = [];
      const linkRegex = /\[(链接|link):\s*([^\]]+?)\]\(vcp-id-\d+\)/gi;
      const seen = new Set();
      let match;
      while ((match = linkRegex.exec(pageInfo)) !== null && !hasReachedOptionalLimit(candidates, maxCandidates)) {
        const keyword = cleanLine(match[2]);
        if (keyword && !seen.has(keyword.toLowerCase())) {
          seen.add(keyword.toLowerCase());
          candidates.push({ keyword, translation: null });
        }
      }

      parsed = {
        result_count: candidates.length,
        pagination: null,
        candidates,
        raw_page_info_excerpt: pageInfo.slice(0, 1000),
        extraction_source: 'markdown'
      };
    }
  }
  if (parsed.candidates && parsed.candidates.length > 0) {
    parsed.candidates.forEach(c => {
      if (!showTag && c.keyword) {
        c.keyword = c.keyword.replace(/\s+(?:AC|HR|ER|NR|TR|BS|4S)$/i, '').trim();
      }
      if (!includeTranslation) {
        c.translation = null;
      }
    });
  }

  const summary = buildKeywordReverseSummary({ url, parsed, normalized, warnings });

  const result = {
    success: true,
    site: 'sellersprite',
    command: 'run_sellersprite_keyword_reverse',
    url,
    filters: normalized.filters,
    login_status: compactLoginStatus(loginResult),
    login_result: includeLoginResult ? loginResult : undefined,
    result_count: parsed.result_count,
    candidate_count: parsed.candidates.length,
    no_results: parsed.no_results === true,
    empty_result: parsed.empty_result === true,
    empty_reason: parsed.empty_reason,
    pagination: parsed.pagination,
    candidates: includeDebugPayload ? parsed.candidates : undefined,
    extraction_source: parsed.extraction_source,
    table_row_count: parsed.table_data?.row_count,
    ordered_table: includeDebugPayload && parsed.table_data?.headers ? {
      headers: parsed.table_data.headers,
      rows: parsed.table_data.rows,
      row_count: parsed.table_data.row_count
    } : undefined,
    field_coverage: {
      ordered_table_headers: parsed.table_data?.headers || [],
      candidate_fields: parsed.candidates[0] ? Object.keys(parsed.candidates[0]) : []
    },
    summary_markdown: summary,
    raw_page_info_excerpt: parsed.raw_page_info_excerpt,
    warnings,
    unknown_filters: [],
    next_actions: parsed.no_results
      ? ['确认 ASIN、站点和月份是否正确，或放宽流量来源标签后重试。']
      : (parsed.candidates.length > 0
        ? ['已成功反查竞品关键词。基于结果做进一步分析。']
        : ['若未解析到关键词，请复核该 ASIN 在对应站点是否确实有流量词。'])
  };

  lastRun = {
    command: 'run_sellersprite_keyword_reverse',
    site: 'sellersprite',
    timestamp: nowIso(),
    success: true,
    url,
    result_count: parsed.result_count,
    candidate_count: parsed.candidates.length,
    warnings
  };

  return result;
}

async function runSellerSpriteKeywordConversionRate(args = {}) {
  if (!chromeBridgeClient) {
    throw new Error('ChromeBridge 客户端未初始化。');
  }

  const normalized = normalizeKeywordConversionRateArgs(args);
  const autoLogin = parseBoolean(args.auto_login ?? args.autoLogin, true);
  const cleanupTabs = parseBoolean(args.cleanup_tabs ?? args.cleanupTabs, true);
  const maxCandidates = parseCandidateLimit(args) || 50;
  const resultMode = (args.result_mode || args.resultMode || 'compact').toLowerCase();
  const includeDebugPayload = resultMode === 'debug' || resultMode === 'full';
  const includeLoginResult = includeDebugPayload || parseBoolean(args.include_login_result ?? args.includeLoginResult, false);
  const showTag = parseBoolean(args.show_tag ?? args.showTag, false);
  const includeTranslation = parseBoolean(args.translate ?? args.include_translation ?? args.includeTranslation, false);

  if (normalized.needs_clarification) {
    lastRun = {
      command: 'run_sellersprite_keyword_conversion_rate',
      site: 'sellersprite',
      timestamp: nowIso(),
      success: false,
      needs_clarification: true,
      unknown_filters: normalized.unknown_filters
    };
    return {
      success: false,
      site: 'sellersprite',
      command: 'run_sellersprite_keyword_conversion_rate',
      needs_clarification: true,
      unknown_filters: normalized.unknown_filters,
      keyword_count: normalized.keyword_count,
      allow_multi_keywords: normalized.allow_multi_keywords,
      suggested_supported_filters: normalized.suggested_supported_filters,
      warnings: normalized.warnings,
      error: normalized.warnings.find(item => item.includes('单词单查'))
        || normalized.warnings.find(item => item.includes('缺少'))
        || '关键词转化率查询缺少 keywordList/keywords、默认单词单查被违反，或存在未知筛选字段。'
    };
  }

  const site = getSite('sellersprite');
  const url = site.adapter.buildKeywordConversionRateUrl(normalized.filters);
  const warnings = [...normalized.warnings];
  if (normalized.unknown_filters.length > 0) {
    warnings.push(`strict_filters=false，已忽略未知字段: ${normalized.unknown_filters.map(item => item.field || item.label).join(', ')}`);
  }

  if (cleanupTabs) {
    await cleanupBridgeTabs(warnings, '开始关键词转化率查询前');
  }

  let loginResult = null;
  if (autoLogin) {
    logFunctions.pushVcpInfo({
      type: 'product_selector_status',
      stage: 'login_sellersprite',
      timestamp: nowIso()
    });

    loginResult = await handleLoginSellerSprite({
      timeout: Number(args.login_timeout) || 30000,
      force_login: parseBoolean(args.force_login ?? args.forceLogin, false),
      login_ttl_hours: args.login_ttl_hours ?? args.loginTtlHours
    });
    if (loginResult.success === false) {
      lastRun = {
        command: 'run_sellersprite_keyword_conversion_rate',
        site: 'sellersprite',
        timestamp: nowIso(),
        success: false,
        error: loginResult.error || loginResult.message || '自动登录失败'
      };
      return {
        success: false,
        site: 'sellersprite',
        command: 'run_sellersprite_keyword_conversion_rate',
        url,
        filters: normalized.filters,
        warnings,
        login_result: loginResult,
        credential_error: loginResult.credential_error === true,
        error: loginResult.error || '自动登录失败，关键词转化率流程已停止。'
      };
    }

    if (cleanupTabs && !loginResult.login_cache_used) {
      await cleanupBridgeTabs(warnings, '登录完成后');
    }
  }

  logFunctions.pushVcpInfo({
    type: 'product_selector_status',
    stage: 'open_sellersprite_keyword_conversion_rate_url',
    url,
    timestamp: nowIso()
  });

  debugLog('Opening SellerSprite keyword conversion rate URL:', url);
  let openResult = await chromeBridgeClient.openUrl(url, Number(args.open_timeout) || 45000);
  let waitResult = await chromeBridgeClient.waitForText(String(args.wait_text || '点击转化率'), Number(args.wait_timeout) || 45000);
  let emptyResultParsed = null;
  let waitInspection = await inspectSellerSpriteWaitFailure({
    command: 'run_sellersprite_keyword_conversion_rate',
    waitResult,
    openResult,
    loginResult,
    autoLogin,
    warnings,
    args,
    pageLabel: 'SellerSprite 关键词转化率页'
  });
  if (waitInspection.action === 'empty') {
    emptyResultParsed = waitInspection.parsed;
  }

  if (!emptyResultParsed && waitInspection.action === 'retry_login') {
    warnings.push('复用登录状态后未等到关键词转化率页，已失效登录缓存并强制重新登录一次。');
    invalidateSellerSpriteLoginState(waitResult.error || 'SellerSprite keyword conversion rate page did not load after cached login.');
    loginResult = await handleLoginSellerSprite({
      timeout: Number(args.login_timeout) || 30000,
      force_login: true,
      login_ttl_hours: args.login_ttl_hours ?? args.loginTtlHours
    });
    if (loginResult.success === false) {
      lastRun = {
        command: 'run_sellersprite_keyword_conversion_rate',
        site: 'sellersprite',
        timestamp: nowIso(),
        success: false,
        error: loginResult.error || loginResult.message || '自动登录失败'
      };
      return {
        success: false,
        site: 'sellersprite',
        command: 'run_sellersprite_keyword_conversion_rate',
        url,
        filters: normalized.filters,
        warnings,
        login_result: loginResult,
        credential_error: loginResult.credential_error === true,
        error: loginResult.error || '自动登录失败，关键词转化率流程已停止。'
      };
    }
    if (cleanupTabs) {
      await cleanupBridgeTabs(warnings, '强制重新登录完成后');
    }
    openResult = await chromeBridgeClient.openUrl(url, Number(args.open_timeout) || 45000);
    waitResult = await chromeBridgeClient.waitForText(String(args.wait_text || '点击转化率'), Number(args.wait_timeout) || 45000);
    waitInspection = await inspectSellerSpriteWaitFailure({
      command: 'run_sellersprite_keyword_conversion_rate',
      waitResult,
      openResult,
      loginResult,
      autoLogin,
      warnings,
      args,
      pageLabel: 'SellerSprite 关键词转化率页'
    });
    if (waitInspection.action === 'empty') {
      emptyResultParsed = waitInspection.parsed;
    }
  }

  if (!emptyResultParsed && waitInspection.action === 'login_required') {
    lastRun = {
      command: 'run_sellersprite_keyword_conversion_rate',
      site: 'sellersprite',
      timestamp: nowIso(),
      success: false,
      error: 'SellerSprite 当前页面是登录页'
    };
    return {
      success: false,
      site: 'sellersprite',
      command: 'run_sellersprite_keyword_conversion_rate',
      url,
      filters: normalized.filters,
      warnings,
      login_result: loginResult,
      open_result: openResult,
      wait_result: waitResult,
      needs_login: true,
      error: 'SellerSprite 当前页面仍是登录页，请确认登录状态或手动处理验证码后重试。'
    };
  }

  let tableResult = null;
  let parsed = null;
  if (!emptyResultParsed && parseBoolean(args.extract_table ?? args.extractTable, true) && typeof chromeBridgeClient.extractTable === 'function') {
    try {
      tableResult = await chromeBridgeClient.extractTable({
        selector: String(args.table_selector || args.tableSelector || 'body'),
        tableMode: String(args.table_mode || args.tableMode || ''),
        maxRows: maxCandidates ? maxCandidates * 2 : undefined,
        includeHtml: parseBoolean(args.include_table_html ?? args.includeTableHtml, false),
        includeDetails: parseBoolean(args.include_table_details ?? args.includeTableDetails, true),
        includeLinks: parseBoolean(args.include_table_links ?? args.includeTableLinks, false),
        maxCellChars: Number(args.max_cell_chars || args.maxCellChars) || 1200,
        maxDetailChars: Number(args.max_detail_chars || args.maxDetailChars) || 1200,
        maxAsins: Number(args.max_asins || args.maxAsins) || 3,
        timeout: Number(args.table_extract_timeout) || 30000
      });
    } catch (error) {
      warnings.push(`结构化表格抽取失败: ${error.message}`);
    }
  }

  const tableRows = tableResult?.table_data?.rows;
  if (emptyResultParsed) {
    parsed = {
      ...emptyResultParsed,
      extraction_source: 'empty_result'
    };
  } else if (Array.isArray(tableRows) && tableRows.length > 0) {
    const candidates = normalizeKeywordConversionRateCandidates(
      normalizeKeywordConversionRateTableData(tableResult.table_data, { maxCandidates: maxCandidates ? maxCandidates * 2 : undefined }),
      { showTag, includeTranslation }
    ).slice(0, maxCandidates);
    parsed = {
      result_count: candidates.length,
      pagination: null,
      candidates,
      raw_page_info_excerpt: '',
      extraction_source: 'dom_table',
      table_data: tableResult.table_data
    };
  } else {
    warnings.push('无法通过 DOM 表格抽取关键词转化率数据，已检查页面文本是否为空结果。');
    const pageInfoResult = await chromeBridgeClient.getPageInfo(Number(args.page_info_timeout) || 30000);
    const pageInfo = pageInfoResult.page_info || waitResult.page_info || openResult.page_info || '';
    if (isSellerSpriteNoResultsText(pageInfo)) {
      parsed = {
        ...buildSellerSpriteNoResultsParsed(pageInfo),
        extraction_source: 'empty_result'
      };
    } else {
      parsed = {
        result_count: 0,
        pagination: null,
        candidates: [],
        raw_page_info_excerpt: pageInfo.slice(0, 1000),
        extraction_source: 'markdown'
      };
    }
  }

  if (parsed.candidates && parsed.candidates.length > 0) {
    parsed.candidates = normalizeKeywordConversionRateCandidates(parsed.candidates, { showTag, includeTranslation }).slice(0, maxCandidates);
    parsed.result_count = parsed.candidates.length;
  }

  const summary = buildKeywordConversionRateSummary({ url, parsed, normalized, warnings });
  const metricNotes = {
    data_source: 'Amazon ABA/Opportunity Explorer via SellerSprite keyword-conversion-rate page.',
    conversion_rate_scope: '关键词行业平均点击与购买行为参考值，不直接对应单一商品真实转化表现。',
    cpa: 'CPA = Cost Per Action，平均每笔广告订单的推广成本；low/mid/high 对应 PPC 低/中/高竞价推算。',
    ppc_bid: 'low/mid/high 为当前 PPC 匹配方式下的低/中/高竞价。bidMatchType: 1=精准, 2=词组, 3=广泛。',
    product_price: 'low/avg/high 分别是最低价、平均售价、最高价。',
    acos: 'max/avg/min 分别是最大值、均值、最小值。',
    aba_concentration: 'click_share 是点击前三 ASIN 点击总占比；conversion_share 是点击前三 ASIN 转化总占比。'
  };

  const result = {
    success: true,
    site: 'sellersprite',
    command: 'run_sellersprite_keyword_conversion_rate',
    url,
    filters: normalized.filters,
    metric_notes: metricNotes,
    login_status: compactLoginStatus(loginResult),
    login_result: includeLoginResult ? loginResult : undefined,
    result_count: parsed.result_count,
    candidate_count: parsed.candidates.length,
    no_results: parsed.no_results === true,
    empty_result: parsed.empty_result === true,
    empty_reason: parsed.empty_reason,
    pagination: parsed.pagination,
    candidates: includeDebugPayload ? parsed.candidates : undefined,
    extraction_source: parsed.extraction_source,
    table_row_count: parsed.table_data?.row_count,
    ordered_table: includeDebugPayload && parsed.table_data?.headers ? {
      headers: parsed.table_data.headers,
      rows: parsed.table_data.rows,
      row_count: parsed.table_data.row_count
    } : undefined,
    field_coverage: {
      ordered_table_headers: parsed.table_data?.headers || [],
      candidate_fields: parsed.candidates[0] ? Object.keys(parsed.candidates[0]) : []
    },
    summary_markdown: summary,
    raw_page_info_excerpt: parsed.raw_page_info_excerpt,
    warnings,
    unknown_filters: normalized.unknown_filters,
    next_actions: parsed.no_results
      ? ['确认关键词在亚马逊商机探测器中有数据，或放宽转化率/PPC/CPA/ACOS/价格等筛选条件。']
      : (parsed.candidates.length > 0
        ? ['结合 PPC、CPA、ACOS 与产品均价建立利润模型，筛选点击转化率高且广告成本可控的词。']
        : ['若页面确实有结果但未解析到数据，请使用 result_mode=debug 查看表格/页面证据。'])
  };

  lastRun = {
    command: 'run_sellersprite_keyword_conversion_rate',
    site: 'sellersprite',
    timestamp: nowIso(),
    success: true,
    url,
    result_count: parsed.result_count,
    candidate_count: parsed.candidates.length,
    warnings
  };

  return result;
}

async function fetchAmazonProductInfo(args = {}) {
  if (!chromeBridgeClient) {
    throw new Error('ChromeBridge 客户端未初始化。');
  }

  const site = getSite('amazon');
  const normalized = site.adapter.normalizeProductArgs(args);
  const resultMode = String(args.result_mode || args.resultMode || 'compact').toLowerCase();
  const warnings = [...normalized.warnings];
  if (!normalized.asin) {
    lastRun = {
      command: 'fetch_amazon_product_info',
      site: 'amazon',
      timestamp: nowIso(),
      success: false,
      needs_clarification: true,
      warnings
    };
    return buildAmazonProductFailure(normalized);
  }

  const cleanupTabs = parseBoolean(args.cleanup_tabs ?? args.cleanupTabs, true);
  const cleanupTabsAfter = parseBoolean(args.cleanup_tabs_after ?? args.cleanupTabsAfter, false);
  const waitForProduct = parseBoolean(args.wait_for_product ?? args.waitForProduct, true);
  const url = site.adapter.buildProductUrl(normalized);
  const runId = `amazon-product-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fetchedAt = nowIso();

  if (cleanupTabs) {
    await cleanupBridgeTabs(warnings, '开始 Amazon 商品页抓取前');
  }

  logFunctions.pushVcpInfo({
    type: 'product_selector_status',
    stage: 'open_amazon_product_url',
    url,
    timestamp: nowIso()
  });

  debugLog('Opening Amazon product URL:', url);
  const openResult = await chromeBridgeClient.openUrl(url, Number(args.open_timeout) || 45000);
  let urlWaitResult = null;
  if (parseBoolean(args.wait_for_target_url ?? args.waitForTargetUrl, true) && typeof chromeBridgeClient.waitForUrl === 'function') {
    try {
      urlWaitResult = await chromeBridgeClient.waitForUrl(normalized.asin, Number(args.url_wait_timeout) || 15000);
    } catch (error) {
      warnings.push(`等待 Amazon 商品页目标 ASIN URL 失败，后续会校验页面身份后再解析: ${error.message}`);
    }
  }

  let waitResult = null;
  if (waitForProduct) {
    try {
      waitResult = await chromeBridgeClient.waitForText(String(args.wait_text || args.waitText || 'About this item'), Number(args.wait_timeout) || 20000);
      if (waitResult.success === false) {
        warnings.push(waitResult.error || '等待 Amazon 商品页标识文本超时，已继续使用当前页面内容解析。');
      }
    } catch (error) {
      warnings.push(`等待 Amazon 商品页标识文本失败，已继续解析当前页面: ${error.message}`);
    }
  }

  let pageUrl = getResultPageUrl(urlWaitResult) || getResultPageUrl(waitResult) || getResultPageUrl(openResult);
  let pageMismatch = pageUrlMatchesAsin(pageUrl, normalized.asin) === false;
  let productTableResult = null;
  let parsed = null;
  let domParsedForMerge = null;
  let domProductFallbackUsed = false;
  let extractionSource = 'dom_html+amazon_product_parser';
  let pageInfoResult = null;

  if (parseBoolean(args.extract_product ?? args.extractProduct, true) && typeof chromeBridgeClient.extractTable === 'function') {
    try {
      productTableResult = await chromeBridgeClient.extractTable({
        selector: String(args.product_selector || args.productSelector || 'body'),
        tableMode: String(args.product_table_mode || args.productTableMode || 'amazon_product'),
        rowSelector: String(args.product_row_selector || args.productRowSelector || '#productTitle, #acrCustomerReviewText, #feature-bullets li, #cm_cr_dp_d_rating_histogram, #localTopReviewsList [data-hook="review"], table.a-normal.a-spacing-micro tr'),
        maxRows: Number(args.max_rows || args.maxRows) || 80,
        includeHtml: true,
        includeDetails: false,
        includeLinks: false,
        maxCellChars: Number(args.max_cell_chars || args.maxCellChars) || 2000,
        maxDetailChars: Number(args.max_detail_chars || args.maxDetailChars) || 120000,
        timeout: Number(args.product_extract_timeout) || 30000
      });
      const tablePageUrl = getResultPageUrl(productTableResult);
      if (tablePageUrl) pageUrl = tablePageUrl;
      const tablePageMatches = pageUrlMatchesAsin(tablePageUrl || pageUrl, normalized.asin);
      if (tablePageMatches === false) {
        pageMismatch = true;
        warnings.push(`Amazon 商品页 DOM 来自非目标 ASIN 页面，已丢弃 DOM 结果: ${tablePageUrl || pageUrl}`);
      } else {
        if (tablePageMatches === true) pageMismatch = false;
        const tableMode = String(productTableResult.table_data?.mode || '').trim();
        if (tableMode && tableMode !== 'amazon_product') {
          warnings.push(`Amazon 商品页 DOM 抽取器返回旧模式 ${tableMode}，已触发 page_info 回退；请确认浏览器 VCPChrome 扩展已重新加载。`);
        }
        parsed = site.adapter.parseProductTableData(productTableResult.table_data, {
          maxReviews: normalized.maxReviews,
          maxBodyChars: Number(args.max_body_chars || args.maxBodyChars) || 4000,
          allowBasicInfoOnly: true
        });
        if (parsed) domParsedForMerge = parsed;
        if ((tableMode && tableMode !== 'amazon_product') ||
          (parsed && !site.adapter.hasProductCoreFields(parsed) && !parsed.page_blocked && !parsed.page_dogged)) {
          domProductFallbackUsed = true;
          parsed = null;
        }
      }
    } catch (error) {
      warnings.push(`Amazon 商品页 DOM 抽取失败: ${error.message}`);
    }
  }

  if (!parsed) {
    pageInfoResult = pickReusableAmazonPageInfo([waitResult, urlWaitResult, openResult], normalized.asin) ||
      await chromeBridgeClient.getPageInfo(Number(args.page_info_timeout) || 30000);
    const pageInfoUrl = getResultPageUrl(pageInfoResult) || extractUrlFromPageInfo(pageInfoResult.page_info);
    if (pageInfoUrl) pageUrl = pageInfoUrl;
    if (pageUrlMatchesAsin(pageInfoUrl || pageUrl, normalized.asin) === false) {
      pageMismatch = true;
      parsed = {
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
        reviews: [],
        top_review_count: 0,
        page_blocked: false,
        page_mismatch: true,
        warnings: [`Amazon 当前页面 URL 未匹配目标 ASIN ${normalized.asin}，已拒绝解析疑似旧页面内容: ${pageInfoUrl || pageUrl || '(unknown url)'}`],
        raw_page_info_excerpt: ''
      };
    } else {
      extractionSource = productTableResult ? 'dom_html_incomplete+chrome_page_info' : 'chrome_page_info';
      parsed = site.adapter.parseProductPageInfo(pageInfoResult.page_info || '', {
        maxReviews: normalized.maxReviews,
        maxBodyChars: Number(args.max_body_chars || args.maxBodyChars) || 4000
      });
      if (domParsedForMerge && !parsed.page_blocked && !parsed.page_dogged) {
        parsed.basic_info = {
          ...(parsed.basic_info || {}),
          ...(domParsedForMerge.basic_info || {})
        };
        if ((!parsed.feature_bullets || parsed.feature_bullets.length === 0) && domParsedForMerge.feature_bullets?.length > 0) {
          parsed.feature_bullets = domParsedForMerge.feature_bullets;
        }
        ['average_rating', 'global_rating_count', 'total_review_count', 'rating_breakdown', 'histogram'].forEach(field => {
          if (parsed[field] == null && domParsedForMerge[field] != null) {
            parsed[field] = domParsedForMerge[field];
          }
        });
        if (domParsedForMerge.reviews?.length > 0) {
          parsed.reviews = mergeAmazonReviews(parsed.reviews || [], domParsedForMerge.reviews);
          parsed.top_review_count = parsed.reviews.length;
        }
      }
      if (!site.adapter.hasProductCoreFields(parsed) && !parsed.page_blocked && !parsed.page_dogged) {
        warnings.push(domProductFallbackUsed
          ? 'Amazon 商品页 DOM 与 page_info 兜底解析都未得到核心字段；请用 result_mode=debug 查看 product_table.html 与 raw_page_info_excerpt。'
          : 'Amazon 商品页 page_info 兜底解析仍未得到核心字段；请用 result_mode=debug 查看 product_table.html 与 raw_page_info_excerpt。');
      }
    }
  }

  warnings.push(...(parsed.warnings || []));
  parsed.reviews = (parsed.reviews || []).map(sanitizeAmazonReview);
  if (parsed.review_count != null && (parsed.total_review_count == null || parsed.total_review_count < parsed.review_count)) {
    parsed.total_review_count = parsed.review_count;
  }
  const includeDebugPayload = resultMode === 'debug' || resultMode === 'full';
  const includeSummary = includeDebugPayload || parseBoolean(args.include_summary ?? args.includeSummary, false);
  const summary = includeSummary ? site.adapter.buildProductSummary({ asin: normalized.asin, url, parsed }) : undefined;
  const compactReviews = (parsed.reviews || []).map(r => ({
    review_id: r.review_id,
    rating: r.rating,
    title: r.title,
    body: r.body,
    date: r.date,
    review_type: r.review_type || (r.verified_purchase ? 'verified_purchase' : 'direct_review'),
    variant: r.variant,
    helpful_count: r.helpful_count,
    image_count: r.image_count !== undefined ? r.image_count : (r.image_urls ? r.image_urls.length : 0)
  }));

  const result = {
    success: parsed.page_blocked || parsed.page_mismatch || pageMismatch || parsed.page_dogged ? false : true,
    site: 'amazon',
    command: 'fetch_amazon_product_info',
    run_id: runId,
    fetched_at: fetchedAt,
    fresh_fetch: true,
    asin: normalized.asin,
    product_asin: normalized.asin,
    current_page_asin: site.adapter.normalizeAsin(pageUrl) || undefined,
    market: normalized.market,
    url,
    title: parsed.title,
    rating: parsed.rating,
    review_count: parsed.review_count,
    price: parsed.price,
    basic_info: parsed.basic_info,
    feature_bullets: parsed.feature_bullets || [],
    average_rating: parsed.average_rating,
    global_rating_count: parsed.global_rating_count,
    total_review_count: parsed.total_review_count,
    rating_breakdown: parsed.rating_breakdown || null,
    rating_breakdown_counts: buildRatingBreakdownCounts(parsed.rating_breakdown, parsed.global_rating_count || parsed.review_count),
    variations: parsed.variations || [],
    variation_count: parsed.variation_count || 0,
    top_review_count: parsed.top_review_count || compactReviews.length,
    reviews: resultMode === 'compact' ? compactReviews : (parsed.reviews || []),
    extraction_source: extractionSource,
    page_url: pageUrl || undefined,
    page_mismatch: parsed.page_mismatch === true || pageMismatch,
    page_blocked: parsed.page_blocked,
    page_dogged: parsed.page_dogged === true,
    needs_manual_action: parsed.page_blocked,
    summary_markdown: includeSummary ? summary : undefined,
    raw_page_info_excerpt: includeDebugPayload ? parsed.raw_page_info_excerpt : undefined,
    product_table: includeDebugPayload ? productTableResult?.table_data : undefined,
    open_result: includeDebugPayload ? openResult : undefined,
    url_wait_result: includeDebugPayload ? urlWaitResult : undefined,
    wait_result: includeDebugPayload ? waitResult : undefined,
    page_info_result: includeDebugPayload ? pageInfoResult : undefined,
    warnings,
    next_actions: parsed.title
      ? ['结合 SellerSprite 竞品基础数据、商品页卖点和 top reviews 做竞品拆解。']
      : ['确认 Amazon 页面已登录且未触发验证码；必要时用 result_mode=debug 查看页面文本片段。'],
    error: parsed.page_blocked
      ? 'Amazon 页面疑似触发验证码或机器人检查。请在浏览器中人工处理后重试。'
      : (parsed.page_dogged
        ? `Amazon 商品页展示 404 或变狗，ASIN ${normalized.asin} 疑似已被下架或不存在。`
        : ((parsed.page_mismatch === true || pageMismatch) ? `Amazon 当前页面未匹配目标 ASIN ${normalized.asin}，本次未返回疑似旧页面商品信息。` : undefined))
  };

  lastRun = {
    command: 'fetch_amazon_product_info',
    site: 'amazon',
    timestamp: nowIso(),
    success: result.success,
    url,
    title_found: Boolean(parsed.title),
    page_blocked: parsed.page_blocked,
    page_mismatch: parsed.page_mismatch === true || pageMismatch,
    page_dogged: parsed.page_dogged === true,
    warnings
  };

  if (cleanupTabsAfter && !result.needs_manual_action) {
    const cleanupAfterResult = await cleanupBridgeTabs(warnings, 'Amazon 商品页抓取完成后');
    result.tabs_closed_after_fetch = cleanupAfterResult?.success !== false;
    if (includeDebugPayload) result.cleanup_after_result = cleanupAfterResult;
  }

  return result;
}

async function fetchAmazonReviews(args = {}) {
  if (!chromeBridgeClient) {
    throw new Error('ChromeBridge 客户端未初始化。');
  }

  const site = getSite('amazon');
  const normalized = site.adapter.normalizeReviewArgs(args);
  const resultMode = String(args.result_mode || args.resultMode || 'compact').toLowerCase();
  const warnings = [...normalized.warnings];
  if (!normalized.asin) {
    lastRun = {
      command: 'fetch_amazon_reviews',
      site: 'amazon',
      timestamp: nowIso(),
      success: false,
      needs_clarification: true,
      warnings
    };
    return buildAmazonReviewFailure(normalized);
  }

  const cleanupTabs = parseBoolean(args.cleanup_tabs ?? args.cleanupTabs, true);
  const cleanupTabsAfter = parseBoolean(args.cleanup_tabs_after ?? args.cleanupTabsAfter, false);
  const waitForReviews = parseBoolean(args.wait_for_reviews ?? args.waitForReviews, true);
  const url = site.adapter.buildReviewUrl(normalized);
  const runId = `amazon-reviews-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fetchedAt = nowIso();

  if (cleanupTabs) {
    await cleanupBridgeTabs(warnings, '开始 Amazon 评论抓取前');
  }

  logFunctions.pushVcpInfo({
    type: 'product_selector_status',
    stage: 'open_amazon_reviews_url',
    url,
    timestamp: nowIso()
  });

  debugLog('Opening Amazon reviews URL:', url);
  const openResult = await chromeBridgeClient.openUrl(url, Number(args.open_timeout) || 45000);
  let urlWaitResult = null;
  if (parseBoolean(args.wait_for_target_url ?? args.waitForTargetUrl, true) && typeof chromeBridgeClient.waitForUrl === 'function') {
    try {
      urlWaitResult = await chromeBridgeClient.waitForUrl(normalized.asin, Number(args.url_wait_timeout) || 15000);
    } catch (error) {
      warnings.push(`等待 Amazon 目标 ASIN URL 失败，后续会校验页面身份后再解析: ${error.message}`);
    }
  }

  let waitResult = null;
  if (waitForReviews) {
    try {
      waitResult = await chromeBridgeClient.waitForText(String(args.wait_text || args.waitText || 'Customer reviews'), Number(args.wait_timeout) || 20000);
      if (waitResult.success === false) {
        warnings.push(waitResult.error || '等待 Amazon 评论页标识文本超时，已继续使用当前页面内容解析。');
      }
    } catch (error) {
      warnings.push(`等待 Amazon 评论页标识文本失败，已继续解析当前页面: ${error.message}`);
    }
  }

  let reviewTableResult = null;
  let aggregateTableResult = null;
  let parsed = null;
  let pageUrl = getResultPageUrl(urlWaitResult) || getResultPageUrl(waitResult) || getResultPageUrl(openResult);
  let pageMismatch = pageUrlMatchesAsin(pageUrl, normalized.asin) === false;
  let extractionSource = 'chrome_page_info+amazon_review_parser';
  if (parseBoolean(args.extract_reviews ?? args.extractReviews, true) && typeof chromeBridgeClient.extractTable === 'function') {
    try {
      reviewTableResult = await chromeBridgeClient.extractTable({
        selector: String(args.review_selector || args.reviewSelector || '#cm_cr-review_list'),
        rowSelector: String(args.review_row_selector || args.reviewRowSelector || 'li.review, div[data-hook="review"]'),
        maxRows: normalized.maxReviews,
        includeHtml: true,
        includeDetails: true,
        includeLinks: true,
        maxCellChars: Number(args.max_cell_chars || args.maxCellChars) || 2000,
        maxDetailChars: Number(args.max_detail_chars || args.maxDetailChars) || 2000,
        maxLinks: Number(args.max_links || args.maxLinks) || 20,
        timeout: Number(args.review_extract_timeout) || 30000
      });
      const tablePageUrl = getResultPageUrl(reviewTableResult);
      if (tablePageUrl) pageUrl = tablePageUrl;
      const tablePageMatches = pageUrlMatchesAsin(tablePageUrl || pageUrl, normalized.asin);
      if (tablePageMatches === false) {
        pageMismatch = true;
        warnings.push(`Amazon 评论 DOM 来自非目标 ASIN 页面，已丢弃 DOM 结果: ${tablePageUrl || pageUrl}`);
      } else {
        if (tablePageMatches === true) pageMismatch = false;
        parsed = site.adapter.parseReviewTableData(reviewTableResult.table_data, {
          maxReviews: normalized.maxReviews,
          maxBodyChars: Number(args.max_body_chars || args.maxBodyChars) || 4000
        });
        if (parsed?.reviews?.length > 0) {
          extractionSource = 'dom_html+amazon_review_parser';
        } else {
          parsed = null;
          warnings.push('Amazon 评论 DOM 抽取未得到有效评论，已回退页面 Markdown 解析。');
        }
      }
    } catch (error) {
      warnings.push(`Amazon 评论 DOM 抽取失败，已回退页面 Markdown 解析: ${error.message}`);
    }
  }

  if (!parsed) {
    const pageInfoResult = await chromeBridgeClient.getPageInfo(Number(args.page_info_timeout) || 30000);
    const pageInfo = pageInfoResult.page_info || waitResult?.page_info || openResult.page_info || '';
    const pageInfoUrl = getResultPageUrl(pageInfoResult) || extractUrlFromPageInfo(pageInfo);
    if (pageInfoUrl) pageUrl = pageInfoUrl;
    if (pageUrlMatchesAsin(pageInfoUrl || pageUrl, normalized.asin) === false) {
      pageMismatch = true;
      parsed = buildAmazonPageMismatchParsed(pageInfoUrl || pageUrl, normalized.asin);
    } else {
      if (pageUrlMatchesAsin(pageInfoUrl || pageUrl, normalized.asin) === true) pageMismatch = false;
      parsed = site.adapter.parseReviews(pageInfo, {
        maxReviews: normalized.maxReviews,
        maxBodyChars: Number(args.max_body_chars || args.maxBodyChars) || 4000
      });
    }
  }

  if (parsed && !parsed.page_mismatch && !parsed.page_blocked &&
    (parsed.average_rating == null || parsed.global_rating_count == null || parsed.total_review_count == null || !parsed.rating_breakdown) &&
    typeof chromeBridgeClient.extractTable === 'function') {
    try {
      aggregateTableResult = await chromeBridgeClient.extractTable({
        selector: String(args.aggregate_selector || args.aggregateSelector || '.reviewNumericalSummary, #cm_cr-product_info, #reviewsMedley, [data-hook="rating-out-of-text"], [data-hook="average-star-rating"]'),
        rowSelector: String(args.aggregate_row_selector || args.aggregateRowSelector || '[data-hook="rating-out-of-text"], [data-hook="average-star-rating"], [data-hook="total-review-count"], [data-hook="cr-filter-info-review-rating-count"], #reviews-filter-info, #filter-info-section, #histogramTable li, [aria-label*="stars represent"], [aria-label*="star represent"], .histogram-row-container'),
        maxRows: 20,
        includeHtml: true,
        includeDetails: false,
        includeLinks: false,
        maxCellChars: 500,
        maxDetailChars: 500,
        timeout: Number(args.aggregate_extract_timeout) || 20000
      });
      const aggregatePageUrl = getResultPageUrl(aggregateTableResult);
      if (aggregatePageUrl) pageUrl = aggregatePageUrl;
      if (pageUrlMatchesAsin(aggregatePageUrl || pageUrl, normalized.asin) === false) {
        warnings.push(`Amazon 评论汇总信息来自非目标 ASIN 页面，已跳过汇总字段补全: ${aggregatePageUrl || pageUrl}`);
      } else {
        const aggregateParsed = site.adapter.parseAggregateTableData(aggregateTableResult.table_data);
        ['average_rating', 'global_rating_count', 'total_review_count', 'rating_breakdown', 'histogram'].forEach(field => {
          if (parsed[field] == null && aggregateParsed[field] != null) {
            parsed[field] = aggregateParsed[field];
          }
        });
      }
    } catch (error) {
      warnings.push(`Amazon 评论汇总 DOM 定点提取失败，汇总字段保持 null，不再从整页模糊推断: ${error.message}`);
    }
  }

  warnings.push(...parsed.warnings);
  const includeDebugPayload = resultMode === 'debug' || resultMode === 'full';
  const includeSummary = includeDebugPayload || parseBoolean(args.include_summary ?? args.includeSummary, false);
  const summary = includeSummary ? site.adapter.buildSummary({ asin: normalized.asin, url, parsed }) : undefined;

  const result = {
    success: parsed.page_blocked || parsed.page_mismatch || parsed.page_dogged ? false : true,
    site: 'amazon',
    command: 'fetch_amazon_reviews',
    run_id: runId,
    fetched_at: fetchedAt,
    fresh_fetch: true,
    asin: normalized.asin,
    product_asin: normalized.asin,
    current_page_asin: site.adapter.normalizeAsin(pageUrl) || undefined,
    market: normalized.market,
    url,
    filters: {
      page_number: normalized.pageNumber,
      sort_by: normalized.sortBy,
      filter_by_star: normalized.filterByStar,
      reviewer_type: normalized.reviewerType || undefined
    },
    average_rating: parsed.average_rating,
    global_rating_count: parsed.global_rating_count,
    total_review_count: parsed.total_review_count,
    rating_breakdown: parsed.rating_breakdown || null,
    review_count: parsed.review_count,
    reviews: resultMode === 'compact' ? parsed.reviews.map(r => ({
      review_id: r.review_id,
      rating: r.rating,
      title: r.title,
      body: r.body,
      date: r.date,
      review_type: r.review_type || (r.verified_purchase ? 'verified_purchase' : 'direct_review'),
      variant: r.variant,
      helpful_count: r.helpful_count,
      image_count: r.image_count !== undefined ? r.image_count : (r.image_urls ? r.image_urls.length : 0)
    })) : parsed.reviews,
    extraction_source: extractionSource,
    page_url: pageUrl || undefined,
    page_mismatch: parsed.page_mismatch === true || pageMismatch,
    page_blocked: parsed.page_blocked,
    page_dogged: parsed.page_dogged === true,
    needs_manual_action: parsed.page_blocked,
    summary_markdown: includeSummary ? summary : undefined,
    raw_page_info_excerpt: includeDebugPayload ? parsed.raw_page_info_excerpt : undefined,
    review_table: includeDebugPayload ? reviewTableResult?.table_data : undefined,
    aggregate_table: includeDebugPayload ? aggregateTableResult?.table_data : undefined,
    open_result: includeDebugPayload ? openResult : undefined,
    url_wait_result: includeDebugPayload ? urlWaitResult : undefined,
    wait_result: includeDebugPayload ? waitResult : undefined,
    warnings,
    next_actions: parsed.reviews.length > 0
      ? ['基于 reviews 字段做差评归因、卖点提取或竞品对比。']
      : ['确认 Amazon 页面已登录且未触发验证码；必要时用 result_mode=debug 查看页面文本片段。'],
    error: parsed.page_blocked
      ? 'Amazon 页面疑似触发验证码或机器人检查。请在浏览器中人工处理后重试。'
      : (parsed.page_dogged
        ? `Amazon 评论页展示 404 或变狗，ASIN ${normalized.asin} 疑似已被下架或不存在。`
        : (parsed.page_mismatch ? `Amazon 当前页面未匹配目标 ASIN ${normalized.asin}，本次未返回疑似旧页面评论。` : undefined))
  };

  lastRun = {
    command: 'fetch_amazon_reviews',
    site: 'amazon',
    timestamp: nowIso(),
    success: result.success,
    url,
    review_count: parsed.review_count,
    page_blocked: parsed.page_blocked,
    page_mismatch: parsed.page_mismatch === true || pageMismatch,
    page_dogged: parsed.page_dogged === true,
    warnings
  };

  if (cleanupTabsAfter && !result.needs_manual_action) {
    const cleanupAfterResult = await cleanupBridgeTabs(warnings, 'Amazon 评论抓取完成后');
    result.tabs_closed_after_fetch = cleanupAfterResult?.success !== false;
    if (includeDebugPayload) result.cleanup_after_result = cleanupAfterResult;
  }

  return result;
}

function getStatus() {
  return {
    success: true,
    plugin: 'ProductSelector',
    version: '1.2.0',
    config: maskConfigState(),
    sites: listSites(),
    supported_categories: SUPPORTED_TOP_LEVEL_CATEGORIES.map(category => ({
      nodeId: category.nodeId,
      zh: category.zh,
      en: category.en
    })),
    chromeBridgeClientReady: Boolean(chromeBridgeClient),
    browserQueue: {
      queued: browserTaskQueueDepth,
      active_command: browserTaskActiveCommand
    },
    sellerSpriteLoginState: {
      status: sellerSpriteLoginState.status,
      confirmedAt: sellerSpriteLoginState.confirmedAt ? new Date(sellerSpriteLoginState.confirmedAt).toISOString() : null,
      expiresAt: sellerSpriteLoginState.expiresAt ? new Date(sellerSpriteLoginState.expiresAt).toISOString() : null,
      failedAt: sellerSpriteLoginState.failedAt ? new Date(sellerSpriteLoginState.failedAt).toISOString() : null,
      lastError: sellerSpriteLoginState.lastError,
      fresh: isSellerSpriteLoginFresh()
    },
    lastRun
  };
}

async function processToolCall(args = {}) {
  const command = String(args.command || '').trim();
  try {
    switch (command) {
      case 'run_sellersprite_research':
        return await enqueueBrowserTask(command, () => runSellerSpriteResearch(args));
      case 'build_sellersprite_url':
        return await handleBuildSellerSpriteUrl(args);
      case 'run_sellersprite_competitor_lookup':
        return await enqueueBrowserTask(command, () => runSellerSpriteCompetitorLookup(args));
      case 'build_sellersprite_competitor_url':
        return await handleBuildSellerSpriteCompetitorUrl(args);
      case 'run_sellersprite_keyword_research':
        return await enqueueBrowserTask(command, () => runSellerSpriteKeywordResearch(args));
      case 'build_sellersprite_keyword_url':
        return await handleBuildSellerSpriteKeywordUrl(args);
      case 'run_sellersprite_keyword_reverse':
        return await enqueueBrowserTask(command, () => runSellerSpriteKeywordReverse(args));
      case 'build_sellersprite_keyword_reverse_url':
        return await handleBuildSellerSpriteKeywordReverseUrl(args);
      case 'run_sellersprite_keyword_conversion_rate':
        return await enqueueBrowserTask(command, () => runSellerSpriteKeywordConversionRate(args));
      case 'build_sellersprite_keyword_conversion_rate_url':
        return await handleBuildSellerSpriteKeywordConversionRateUrl(args);
      case 'fetch_amazon_product_info':
        return await enqueueBrowserTask(command, () => fetchAmazonProductInfo(args));
      case 'build_amazon_product_url':
        return await handleBuildAmazonProductUrl(args);
      case 'fetch_amazon_reviews':
        return await enqueueBrowserTask(command, () => fetchAmazonReviews(args));
      case 'build_amazon_reviews_url':
        return await handleBuildAmazonReviewsUrl(args);
      case 'login_sellersprite':
        return await enqueueBrowserTask(command, () => handleLoginSellerSprite(args));
      case 'get_status':
        return getStatus();
      default:
        return {
          success: false,
          plugin_error: `Unknown command: ${command || '(empty)'}`,
          supported_commands: [
            'run_sellersprite_research',
            'build_sellersprite_url',
            'run_sellersprite_competitor_lookup',
            'build_sellersprite_competitor_url',
            'run_sellersprite_keyword_research',
            'build_sellersprite_keyword_url',
            'run_sellersprite_keyword_reverse',
            'build_sellersprite_keyword_reverse_url',
            'run_sellersprite_keyword_conversion_rate',
            'build_sellersprite_keyword_conversion_rate_url',
            'fetch_amazon_product_info',
            'build_amazon_product_url',
            'fetch_amazon_reviews',
            'build_amazon_reviews_url',
            'login_sellersprite',
            'get_status'
          ]
        };
    }
  } catch (error) {
    console.error(`[ProductSelector] Command failed (${command}):`, error);
    return {
      success: false,
      plugin_error: error.message || 'ProductSelector 执行失败。',
      command
    };
  }
}

function shutdown() {
  debugLog('Plugin shutdown.');
}

module.exports = {
  initialize,
  processToolCall,
  shutdown
};
