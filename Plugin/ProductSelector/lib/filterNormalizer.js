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
  'include_table_details',
  'includeTableDetails',
  'include_table_links',
  'includeTableLinks',
  'table_columns',
  'tableColumns',
  'max_cell_chars',
  'maxCellChars',
  'max_detail_chars',
  'maxDetailChars',
  'max_asins',
  'maxAsins',
  'result_mode',
  'resultMode',
  'include_ordered_table',
  'includeOrderedTable',
  'include_login_result',
  'includeLoginResult',
  'include_candidates',
  'includeCandidates',
  'table_extract_timeout',
  'tableExtractTimeout',
  'debug'
]);

const SUPPORTED_FILTERS = [
  'market',
  'minPrice',
  'maxPrice',
  'minReviews',
  'maxReviews',
  'minSales',
  'maxSales',
  'minAmount',
  'maxAmount',
  'minAmzUnit',
  'maxAmzUnit',
  'sellerTypes',
  'sellerNationList',
  'putawayMonth',
  'minTotalUnitsGrowth',
  'maxTotalUnitsGrowth',
  'minRanking',
  'maxRanking',
  'minRankingCv',
  'maxRankingCv',
  'minRankingCr',
  'maxRankingCr',
  'minVariations',
  'maxVariations',
  'minQuestions',
  'maxQuestions',
  'minReviewsGrouth',
  'maxReviewsGrouth',
  'minReviewsRate',
  'maxReviewsRate',
  'minProfit',
  'maxProfit',
  'lqsFrom',
  'lqsTo',
  'minReviewRating',
  'maxReviewRating',
  'minFba',
  'maxFba',
  'minSellers',
  'maxSellers',
  'includeBrands',
  'excludeBrands',
  'includeSellers',
  'excludeSellers',
  'outOfKeywords',
  'keywords',
  'selectType',
  'productTags',
  'eligibility',
  'pkgDimensionTypeList',
  'smallAndLight',
  'page',
  'size',
  'orderField',
  'orderDesc',
  'nodeIdPaths',
  'categories',
  'lowPrice',
  'video'
];

const USER_GROUNDED_FILTERS = new Map([
  ['minPrice', /\u552e\u4ef7|\u4ef7\u683c|\u4ef7\u4f4d|price|\$|\u7f8e\u5143|\u7f8e\u91d1/i],
  ['maxPrice', /\u552e\u4ef7|\u4ef7\u683c|\u4ef7\u4f4d|price|\$|\u7f8e\u5143|\u7f8e\u91d1/i],
  ['minReviews', /\u8bc4\u8bba\u6570|\u8bc4\u4ef7\u6570|\u8bc4\u5206\u6570|review/i],
  ['maxReviews', /\u8bc4\u8bba\u6570|\u8bc4\u4ef7\u6570|\u8bc4\u5206\u6570|review/i],
  ['minSales', /\u6708\u9500\u91cf|\u6708\u9500|\u9500\u91cf|sales/i],
  ['maxSales', /\u6708\u9500\u91cf|\u6708\u9500|\u9500\u91cf|sales/i],
  ['minAmount', /\u6708\u9500\u552e\u989d|\u9500\u552e\u989d|amount|revenue/i],
  ['maxAmount', /\u6708\u9500\u552e\u989d|\u9500\u552e\u989d|amount|revenue/i],
  ['minAmzUnit', /\u5b50\u4f53\u9500\u91cf|\u5b50\u4f53\u9500\u552e|amz\s*unit/i],
  ['maxAmzUnit', /\u5b50\u4f53\u9500\u91cf|\u5b50\u4f53\u9500\u552e|amz\s*unit/i],
  ['minReviewRating', /\u8bc4\u5206\u503c|\u8bc4\u5206(?!\u6570)|\u661f\u7ea7|rating/i],
  ['maxReviewRating', /\u8bc4\u5206\u503c|\u8bc4\u5206(?!\u6570)|\u661f\u7ea7|rating/i],
  ['minSellers', /\u5356\u5bb6\u6570|\u5356\u5bb6\u6570\u91cf|seller/i],
  ['maxSellers', /\u5356\u5bb6\u6570|\u5356\u5bb6\u6570\u91cf|seller/i],
  ['sellerTypes', /FBA|FBM|\u914d\u9001|\u7269\u6d41/i],
  ['sellerNationList', /\u4e2d\u56fd\u5356\u5bb6|\u5356\u5bb6\u6240\u5728\u5730|\u4e2d\u56fd\u53d1\u8d27|CN|China/i],
  ['categories', /\u7c7b\u76ee|\u5206\u7c7b|category/i],
  ['nodeIdPaths', /\u7c7b\u76ee|\u5206\u7c7b|nodeId|category/i],
  ['productTags', /Best\s*Seller|Amazon'?s?\s*Choice|New\s*Release|A\+/i],
  ['lowPrice', /低价商品/i],
  ['smallAndLight', /\u8f7b\u5c0f|small\s*and\s*light/i],
  ['putawayMonth', /\u4e0a\u67b6|\u4e0a\u67b6\u65f6\u95f4|\u4e0a\u67b6\u6708/i],
  ['selectType', /\u8bcd\u7ec4\u5339\u914d|\u77ed\u8bed\u5339\u914d|\u7cbe\u51c6\u5339\u914d|\u7cbe\u786e\u5339\u914d|\u6a21\u7cca\u5339\u914d|phrase|exact|fuzzy/i],
  ['size', /\u591a\u62c9\u53d6|\u591a\u9009|\u591a\u770b|\u66f4\u591a|\u5c3d\u53ef\u80fd\u591a|\u7ed3\u679c\u6570|\u6570\u91cf|size|20|60|100/i]
]);

const PRODUCT_KEYWORD_CONTEXT = /\u5173\u952e\u8bcd|\u95dc\u9375\u8a5e|\u5173\u952e\u5b57|\u5305\u542b\u8bcd|\u641c\u7d22\u8bcd|\u641c\u7d22|\u67e5\u8be2|\u67e5\u627e|search\s+term|keyword|asin|\u4ea7\u54c1|\u5546\u54c1|\u7ed3\u679c/i;
const PRODUCT_KEYWORD_STOPWORDS = new Set([
  'asin',
  'amazon',
  'sellersprite',
  'product',
  'products',
  'keyword',
  'keywords',
  'search',
  'review',
  'reviews',
  'url',
  'fba'
]);

const DIRECT_ALIASES = new Map([
  ['market', 'market'],
  ['site_market', 'market'],
  ['站点', 'market'],
  ['市场', 'market'],
  ['siteMarket', 'market'],
  ['minPrice', 'minPrice'],
  ['min_price', 'minPrice'],
  ['最低价', 'minPrice'],
  ['最低售价', 'minPrice'],
  ['maxPrice', 'maxPrice'],
  ['max_price', 'maxPrice'],
  ['最高价', 'maxPrice'],
  ['最高售价', 'maxPrice'],
  ['minReviews', 'minReviews'],
  ['min_reviews', 'minReviews'],
  ['最低评论数', 'minReviews'],
  ['maxReviews', 'maxReviews'],
  ['max_reviews', 'maxReviews'],
  ['最高评论数', 'maxReviews'],
  ['minSales', 'minSales'],
  ['min_sales', 'minSales'],
  ['最低月销量', 'minSales'],
  ['maxSales', 'maxSales'],
  ['max_sales', 'maxSales'],
  ['最高月销量', 'maxSales'],
  ['minAmount', 'minAmount'],
  ['min_amount', 'minAmount'],
  ['最低月销售额', 'minAmount'],
  ['maxAmount', 'maxAmount'],
  ['max_amount', 'maxAmount'],
  ['最高月销售额', 'maxAmount'],
  ['minAmzUnit', 'minAmzUnit'],
  ['min_amz_unit', 'minAmzUnit'],
  ['最低子体销量', 'minAmzUnit'],
  ['maxAmzUnit', 'maxAmzUnit'],
  ['max_amz_unit', 'maxAmzUnit'],
  ['最高子体销量', 'maxAmzUnit'],
  ['sellerTypes', 'sellerTypes'],
  ['seller_types', 'sellerTypes'],
  ['配送方式', 'sellerTypes'],
  ['sellerNationList', 'sellerNationList'],
  ['seller_nation_list', 'sellerNationList'],
  ['卖家所在地', 'sellerNationList'],
  ['putawayMonth', 'putawayMonth'],
  ['putaway_month', 'putawayMonth'],
  ['上架月份', 'putawayMonth'],
  ['minTotalUnitsGrowth', 'minTotalUnitsGrowth'],
  ['min_total_units_growth', 'minTotalUnitsGrowth'],
  ['月销量增长率', 'minTotalUnitsGrowth'],
  ['maxTotalUnitsGrowth', 'maxTotalUnitsGrowth'],
  ['max_total_units_growth', 'maxTotalUnitsGrowth'],
  ['最高月销量增长率', 'maxTotalUnitsGrowth'],
  ['minRanking', 'minRanking'],
  ['min_ranking', 'minRanking'],
  ['最低BSR', 'minRanking'],
  ['maxRanking', 'maxRanking'],
  ['max_ranking', 'maxRanking'],
  ['最高BSR', 'maxRanking'],
  ['minRankingCv', 'minRankingCv'],
  ['min_ranking_cv', 'minRankingCv'],
  ['最低BSR增长数', 'minRankingCv'],
  ['maxRankingCv', 'maxRankingCv'],
  ['max_ranking_cv', 'maxRankingCv'],
  ['最高BSR增长数', 'maxRankingCv'],
  ['minRankingCr', 'minRankingCr'],
  ['min_ranking_cr', 'minRankingCr'],
  ['BSR增长率', 'minRankingCr'],
  ['maxRankingCr', 'maxRankingCr'],
  ['max_ranking_cr', 'maxRankingCr'],
  ['最高BSR增长率', 'maxRankingCr'],
  ['minVariations', 'minVariations'],
  ['min_variations', 'minVariations'],
  ['最低变体数', 'minVariations'],
  ['maxVariations', 'maxVariations'],
  ['max_variations', 'maxVariations'],
  ['最高变体数', 'maxVariations'],
  ['minQuestions', 'minQuestions'],
  ['min_questions', 'minQuestions'],
  ['最低QA', 'minQuestions'],
  ['maxQuestions', 'maxQuestions'],
  ['max_questions', 'maxQuestions'],
  ['最高QA', 'maxQuestions'],
  ['minReviewsGrouth', 'minReviewsGrouth'],
  ['min_reviews_grouth', 'minReviewsGrouth'],
  ['最低月评新增', 'minReviewsGrouth'],
  ['maxReviewsGrouth', 'maxReviewsGrouth'],
  ['max_reviews_grouth', 'maxReviewsGrouth'],
  ['最高月评新增', 'maxReviewsGrouth'],
  ['minReviewsRate', 'minReviewsRate'],
  ['min_reviews_rate', 'minReviewsRate'],
  ['最低留评率', 'minReviewsRate'],
  ['maxReviewsRate', 'maxReviewsRate'],
  ['max_reviews_rate', 'maxReviewsRate'],
  ['最高留评率', 'maxReviewsRate'],
  ['minProfit', 'minProfit'],
  ['min_profit', 'minProfit'],
  ['最低毛利率', 'minProfit'],
  ['maxProfit', 'maxProfit'],
  ['max_profit', 'maxProfit'],
  ['最高毛利率', 'maxProfit'],
  ['lqsFrom', 'lqsFrom'],
  ['lqs_from', 'lqsFrom'],
  ['最低LQS', 'lqsFrom'],
  ['lqsTo', 'lqsTo'],
  ['lqs_to', 'lqsTo'],
  ['最高LQS', 'lqsTo'],
  ['minReviewRating', 'minReviewRating'],
  ['min_review_rating', 'minReviewRating'],
  ['最低评分值', 'minReviewRating'],
  ['maxReviewRating', 'maxReviewRating'],
  ['max_review_rating', 'maxReviewRating'],
  ['最高评分值', 'maxReviewRating'],
  ['minFba', 'minFba'],
  ['min_fba', 'minFba'],
  ['最低FBA费用', 'minFba'],
  ['maxFba', 'maxFba'],
  ['max_fba', 'maxFba'],
  ['最高FBA费用', 'maxFba'],
  ['minSellers', 'minSellers'],
  ['min_sellers', 'minSellers'],
  ['最低卖家数量', 'minSellers'],
  ['maxSellers', 'maxSellers'],
  ['max_sellers', 'maxSellers'],
  ['最高卖家数量', 'maxSellers'],
  ['includeBrands', 'includeBrands'],
  ['include_brands', 'includeBrands'],
  ['包含品牌', 'includeBrands'],
  ['excludeBrands', 'excludeBrands'],
  ['exclude_brands', 'excludeBrands'],
  ['排除品牌', 'excludeBrands'],
  ['includeSellers', 'includeSellers'],
  ['include_sellers', 'includeSellers'],
  ['包含卖家', 'includeSellers'],
  ['excludeSellers', 'excludeSellers'],
  ['exclude_sellers', 'excludeSellers'],
  ['排除卖家', 'excludeSellers'],
  ['outOfKeywords', 'outOfKeywords'],
  ['out_of_keywords', 'outOfKeywords'],
  ['排除关键词', 'outOfKeywords'],
  ['keywords', 'keywords'],
  ['包含关键词', 'keywords'],
  ['selectType', 'selectType'],
  ['select_type', 'selectType'],
  ['匹配模式', 'selectType'],
  ['productTags', 'productTags'],
  ['product_tags', 'productTags'],
  ['商品标识', 'productTags'],
  ['eligibility', 'eligibility'],
  ['pkgDimensionTypeList', 'pkgDimensionTypeList'],
  ['pkg_dimension_type_list', 'pkgDimensionTypeList'],
  ['包装尺寸', 'pkgDimensionTypeList'],
  ['smallAndLight', 'smallAndLight'],
  ['small_and_light', 'smallAndLight'],
  ['page', 'page'],
  ['size', 'size'],
  ['orderField', 'orderField'],
  ['orderDesc', 'orderDesc'],
  ['nodeIdPaths', 'nodeIdPaths'],
  ['node_id_paths', 'nodeIdPaths'],
  ['category', 'categories'],
  ['categories', 'categories'],
  ['类目', 'categories'],
  ['分类', 'categories'],
  ['商品类目', 'categories'],
  ['一级类目', 'categories'],
  ['lowPrice', 'lowPrice'],
  ['低价商品', 'lowPrice'],
  ['video', 'video']
]);

const UNKNOWN_FIELD_PATTERNS = [];

const PRODUCT_TAG_ALIASES = new Map([
  ['BestSeller', 'BestSeller'],
  ['best seller', 'BestSeller'],
  ['AmazonChoice', 'AmazonChoice'],
  ["Amazon's Choice", 'AmazonChoice'],
  ['Amazon Choice', 'AmazonChoice'],
  ['NewRelease', 'NewRelease'],
  ['new release', 'NewRelease'],
  ['A+', 'A+'],
  ['NonA+', 'NonA+'],
  ['不含A+', 'NonA+'],
  ['不含A加', 'NonA+']
]);

const PKG_DIMENSION_ALIASES = new Map([
  ['小号标准件', 'SS'],
  ['大号标准件', 'LS'],
  ['小号大件', 'SB'],
  ['大号大件', 'LB'],
  ['特殊大件', 'ELO'],
  ['特殊大件5磅以上', 'EL5O'],
  ['特殊大件7磅以上', 'EL7O'],
  ['特殊大件15磅以上', 'EL15O'],
  ['超大件', 'O'],
  ['SS', 'SS'],
  ['LS', 'LS'],
  ['SB', 'SB'],
  ['LB', 'LB'],
  ['ELO', 'ELO'],
  ['EL5O', 'EL5O'],
  ['EL7O', 'EL7O'],
  ['EL15O', 'EL15O'],
  ['O', 'O']
]);

const ALL_SELLERSPRITE_CATEGORY_IDS = [
  '2619525011',
  '2617941011',
  '15684181',
  '165796011',
  '3760911',
  '283155',
  '2335752011',
  '7141123011',
  '172282',
  '16310101',
  '3760901',
  '1055398',
  '706813011',
  '16310091',
  '15736321',
  '11091801',
  '1064954',
  '2972638011',
  '2619533011',
  '328182011',
  '1267449011',
  '3375251',
  '228013',
  '165793011',
  '468642'
];

function normalizeCategoryKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[()（）]/g, '')
    .replace(/\s*&\s*/g, '&')
    .replace(/\s+/g, ' ');
}

const ALL_CATEGORIES = [
  { nodeId: '2619525011', zh: '家用电器', en: 'Appliances', kw: ['家电'] },
  { nodeId: '2617941011', zh: '艺术、手工艺', en: 'Arts, Crafts & Sewing', kw: ['艺术', '手工艺', 'crafts', 'arts', 'arts crafts sewing', 'arts crafts & sewing'] },
  { nodeId: '15684181',   zh: '汽车', en: 'Automotive', kw: ['汽车', 'automotive'] },
  { nodeId: '165796011',  zh: '婴儿产品', en: 'Baby Products', kw: ['婴儿', 'baby'] },
  { nodeId: '3760911',    zh: '美容与护理', en: 'Beauty & Personal Care', kw: ['美容', '护理', 'beauty', 'personal care'] },
  { nodeId: '283155',     zh: '图书', en: 'Books', kw: ['图书', 'books'] },
  { nodeId: '2335752011', zh: '手机及配件', en: 'Cell Phones & Accessories', kw: ['手机', '手机配件', 'cell phones', 'phone'] },
  { nodeId: '7141123011', zh: '服装、鞋履和珠宝', en: 'Clothing, Shoes & Jewelry', kw: ['服装', '鞋', '珠宝', 'clothing', 'shoes', 'jewelry', 'clothing shoes jewelry', 'clothing shoes & jewelry'] },
  { nodeId: '172282',     zh: '电子产品', en: 'Electronics', kw: ['电子产品', 'electronics', '电子'] },
  { nodeId: '16310101',   zh: '杂货美食', en: 'Grocery & Gourmet Food', kw: ['杂货', '美食', 'grocery', 'food'] },
  { nodeId: '3760901',    zh: '健康与家居', en: 'Health & Household', kw: ['健康', 'health'] },
  { nodeId: '1055398',    zh: '家居用品', en: 'Home & Kitchen', kw: ['家居', '家居用品', 'kitchen', 'home'] },
  { nodeId: '706813011',  zh: '狩猎与渔具', en: 'Hunting & Fishing', kw: ['狩猎', '渔具', 'hunting', 'fishing'] },
  { nodeId: '16310091',   zh: '工业类', en: 'Industrial & Scientific', kw: ['工业', 'industrial', 'scientific'] },
  { nodeId: '15736321',   zh: '灯具及配件', en: 'Lights, Bulbs & Indicators', kw: ['灯具', '配件', 'lights', 'bulbs', 'indicators', 'lights bulbs indicators', 'lights bulbs & indicators'] },
  { nodeId: '11091801',   zh: '乐器', en: 'Musical Instruments', kw: ['乐器', 'musical instruments'] },
  { nodeId: '1064954',    zh: '办公产品', en: 'Office Products', kw: ['办公', 'office'] },
  { nodeId: '2972638011', zh: '庭院、草坪和园艺', en: 'Patio, Lawn & Garden', kw: ['庭院', '草坪', '园艺', 'patio', 'lawn', 'garden', 'patio lawn garden', 'patio lawn & garden'] },
  { nodeId: '2619533011', zh: '宠物用品', en: 'Pet Supplies', kw: ['宠物', 'pet'] },
  { nodeId: '328182011',  zh: '电动和手动工具', en: 'Power & Hand Tools', kw: ['电动工具', '手动工具', 'power tools', 'hand tools'] },
  { nodeId: '1267449011', zh: '小家电配件', en: 'Small Appliance Parts & Accessories', kw: ['小家电配件', 'small appliance'] },
  { nodeId: '3375251',    zh: '运动与户外', en: 'Sports & Outdoors', kw: ['运动', '户外', 'sports', 'outdoors'] },
  { nodeId: '228013',     zh: '工具', en: 'Tools & Home Improvement', kw: ['工具', 'tools'] },
  { nodeId: '165793011',  zh: '玩具', en: 'Toys & Games', kw: ['玩具', 'toys', 'toys games', 'toys & games'] },
  { nodeId: '468642',     zh: '视频游戏', en: 'Video Games', kw: ['视频游戏', 'video games'] }
];

const SUPPORTED_TOP_LEVEL_CATEGORIES = ALL_CATEGORIES.map(cat => ({
  nodeId: cat.nodeId,
  zh: cat.zh,
  en: cat.en
}));

const TOP_LEVEL_CATEGORY_IDS = new Set(ALL_CATEGORIES.map(item => item.nodeId));
const KNOWN_DESCENDANT_CATEGORY_TOP_IDS = new Map([
  ['166420011', '165793011'],
  ['166437011', '165793011'],
  ['1272924011', '165793011']
]);

function buildCategoryAliases() {
  const map = new Map([
    ['all', ALL_SELLERSPRITE_CATEGORY_IDS],
    ['all categories', ALL_SELLERSPRITE_CATEGORY_IDS],
    ['全部类目', ALL_SELLERSPRITE_CATEGORY_IDS],
    ['所有类目', ALL_SELLERSPRITE_CATEGORY_IDS],
    ['全类目', ALL_SELLERSPRITE_CATEGORY_IDS]
  ]);
  for (const cat of ALL_CATEGORIES) {
    const id = [cat.nodeId];
    map.set(normalizeCategoryKey(cat.zh), id);
    map.set(normalizeCategoryKey(cat.en), id);
    for (const k of cat.kw) {
      map.set(normalizeCategoryKey(k), id);
    }
  }
  return map;
}

const CATEGORY_ALIASES = buildCategoryAliases();

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', '是', '开启'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', '否', '关闭'].includes(normalized)) return false;
  return defaultValue;
}

function parseNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const normalized = String(value).replace(/[,，]/g, '').trim();
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toArray(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value.map(String).map(item => item.trim()).filter(Boolean);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map(String).map(item => item.trim()).filter(Boolean);
      } catch (_) {
        // fall through to split
      }
    }
    return trimmed.split(/[,，、;；|/]/).map(item => item.trim()).filter(Boolean);
  }
  return [String(value)];
}

function normalizeMarket(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim().toUpperCase();
  if (['美国', '美国站', '美区', 'US', 'USA', 'AMAZON.COM'].includes(text)) return 'US';
  if (['英国', '英国站', 'UK', 'GB'].includes(text)) return 'UK';
  if (['德国', '德国站', 'DE'].includes(text)) return 'DE';
  if (['日本', '日本站', 'JP'].includes(text)) return 'JP';
  return text;
}

function normalizeNationList(value) {
  const arr = toArray(value);
  if (!arr) return undefined;
  return arr.map(item => {
    const upper = item.toUpperCase();
    if (['中国', '中国卖家', 'CN', 'CHINA'].includes(upper)) return 'CN';
    if (['美国', 'US', 'USA'].includes(upper)) return 'US';
    return upper;
  });
}

function normalizeProductTags(value) {
  const arr = toArray(value);
  if (!arr) return undefined;
  return arr.map(item => PRODUCT_TAG_ALIASES.get(item) || PRODUCT_TAG_ALIASES.get(item.trim()) || item.trim()).filter(Boolean);
}

function normalizePkgDimensions(value) {
  const arr = toArray(value);
  if (!arr) return undefined;
  return arr.map(item => PKG_DIMENSION_ALIASES.get(item) || item.trim()).filter(Boolean);
}

function toCategoryArray(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value.map(String).map(item => item.trim()).filter(Boolean);
  if (typeof value !== 'string') return [String(value)];

  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String).map(item => item.trim()).filter(Boolean);
    } catch (_) {
      // fall through to plain text handling
    }
  }

  if (CATEGORY_ALIASES.has(normalizeCategoryKey(trimmed))) return [trimmed];
  const primaryParts = trimmed.split(/[，、;；|/]/).map(item => item.trim()).filter(Boolean);
  const items = [];
  for (const part of primaryParts) {
    if (CATEGORY_ALIASES.has(normalizeCategoryKey(part)) || !part.includes(',')) {
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
        if (CATEGORY_ALIASES.has(normalizeCategoryKey(candidate))) {
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

function normalizeNodeIdPaths(value) {
  const arr = toCategoryArray(value);
  if (!arr) return { values: undefined, unknown: [] };

  const values = [];
  const unknown = [];
  for (const item of arr) {
    const trimmed = String(item).trim();
    if (!trimmed) continue;
    if (/^\d+(?::\d+)+$/.test(trimmed)) {
      const topId = trimmed.split(':')[0];
      if (TOP_LEVEL_CATEGORY_IDS.has(topId)) {
        values.push(topId);
      } else {
        unknown.push(trimmed);
      }
      continue;
    }
    if (/^\d+$/.test(trimmed)) {
      if (TOP_LEVEL_CATEGORY_IDS.has(trimmed)) {
        values.push(trimmed);
      } else if (KNOWN_DESCENDANT_CATEGORY_TOP_IDS.has(trimmed)) {
        values.push(KNOWN_DESCENDANT_CATEGORY_TOP_IDS.get(trimmed));
      } else {
        unknown.push(trimmed);
      }
      continue;
    }
    const resolved = CATEGORY_ALIASES.get(normalizeCategoryKey(trimmed));
    if (Array.isArray(resolved)) {
      values.push(...resolved);
    } else if (resolved) {
      values.push(resolved);
    } else {
      unknown.push(trimmed);
    }
  }

  return {
    values: values.length > 0 ? Array.from(new Set(values)) : undefined,
    unknown
  };
}

function normalizeSelectType(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return value;
  const text = String(value).trim().toLowerCase();
  if (['2', 'fuzzy', '模糊', '模糊匹配'].includes(text)) return 2;
  if (['3', 'phrase', '词组', '词组匹配'].includes(text)) return 3;
  if (['4', 'exact', '精准', '精确', '精准匹配', '精确匹配'].includes(text)) return 4;
  return parseNumber(value);
}

function normalizeYesNo(value) {
  if (value === true) return 'Y';
  if (value === false) return 'N';
  const text = String(value).trim().toUpperCase();
  if (['Y', 'YES', 'TRUE', '1', '是', '勾选', '包含'].includes(text)) return 'Y';
  if (['N', 'NO', 'FALSE', '0', '否', '不选', '不限'].includes(text)) return 'N';
  return String(value).trim();
}

function assignFilter(filters, key, value, unknownFilters) {
  if (value === undefined || value === null || value === '') return;
  if (key === 'market') {
    filters.market = normalizeMarket(value);
    return;
  }
  if (key === 'sellerTypes') {
    const arr = toArray(value);
    if (arr) filters.sellerTypes = arr.map(item => item.toUpperCase());
    return;
  }
  if (key === 'sellerNationList') {
    const arr = normalizeNationList(value);
    if (arr) filters.sellerNationList = arr;
    return;
  }
  if (key === 'nodeIdPaths') {
    const normalized = normalizeNodeIdPaths(value);
    if (normalized.values) filters.nodeIdPaths = normalized.values;
    if (unknownFilters && normalized.unknown.length > 0) {
      for (const item of normalized.unknown) {
        unknownFilters.push({ field: 'nodeIdPaths', value: item, source: 'argument', reason: 'unknown_category_or_node_id' });
      }
    }
    return;
  }
  if (key === 'categories') {
    const normalized = normalizeNodeIdPaths(value);
    if (normalized.values) filters.nodeIdPaths = normalized.values;
    if (unknownFilters && normalized.unknown.length > 0) {
      for (const item of normalized.unknown) {
        unknownFilters.push({ field: 'categories', value: item, source: 'argument', reason: 'unknown_category' });
      }
    }
    return;
  }
  if (key === 'productTags') {
    const arr = normalizeProductTags(value);
    if (arr) filters.productTags = arr;
    return;
  }
  if (key === 'pkgDimensionTypeList') {
    const arr = normalizePkgDimensions(value);
    if (arr) filters.pkgDimensionTypeList = arr;
    return;
  }
  if (key === 'eligibility') {
    const arr = toArray(value);
    if (arr) filters.eligibility = arr;
    return;
  }
  if (key === 'selectType') {
    const parsed = normalizeSelectType(value);
    if (parsed !== undefined) filters.selectType = parsed;
    return;
  }
  if (key === 'size') {
    const parsed = normalizeResultSize(value);
    if (parsed !== undefined) filters.size = parsed;
    return;
  }
  if (['lowPrice', 'smallAndLight'].includes(key)) {
    filters[key] = normalizeYesNo(value);
    return;
  }
  if (['orderField', 'includeBrands', 'excludeBrands', 'includeSellers', 'excludeSellers', 'outOfKeywords', 'keywords', 'putawayMonth', 'video'].includes(key)) {
    filters[key] = String(value).trim();
    return;
  }
  if (key === 'orderDesc') {
    filters.orderDesc = parseBoolean(value, true);
    return;
  }
  if (SUPPORTED_FILTERS.includes(key)) {
    const parsed = parseNumber(value);
    if (parsed !== undefined) filters[key] = parsed;
  }
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
  const regex = new RegExp(`${labelPattern}[^\\d]{0,12}(\\d+(?:\\.\\d+)?)[\\s到至~\\-—_]+(\\d+(?:\\.\\d+)?)`, 'i');
  const match = text.match(regex);
  if (!match) return null;
  return { min: Number(match[1]), max: Number(match[2]) };
}

function parseSingleBound(text, labelPattern) {
  const maxRegex = new RegExp(`${labelPattern}[^\\d]{0,12}(?:小于|少于|低于|不超过|以内|以下|内|<=|≤|max)[^\\d]{0,8}(\\d+(?:\\.\\d+)?)|${labelPattern}[^\\d]{0,12}(\\d+(?:\\.\\d+)?)[^\\d]{0,8}(?:以内|以下|内|以内的|以下的)`, 'i');
  const minRegex = new RegExp(`${labelPattern}[^\\d]{0,12}(?:大于|超过|高于|不少于|不低于|以上|起|>=|≥|min)[^\\d]{0,8}(\\d+(?:\\.\\d+)?)|${labelPattern}[^\\d]{0,12}(\\d+(?:\\.\\d+)?)[^\\d]{0,8}(?:以上|起|起步|以上的)`, 'i');
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

function cleanupKeywordCandidate(value) {
  const cleaned = String(value || '')
    .replace(/^[\s"'“”‘’`.,，。:：;；\-_/\\]+/, '')
    .replace(/[\s"'“”‘’`.,，。:：;；\-_/\\]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  if (cleaned.length < 2 || cleaned.length > 80) return null;
  if (/^(?:the|a|an)$/i.test(cleaned)) return null;
  const words = cleaned.toLowerCase().split(/\s+/);
  if (words.every(word => PRODUCT_KEYWORD_STOPWORDS.has(word))) return null;
  return cleaned;
}

function extractProductKeywordFromCriteria(criteria) {
  const text = String(criteria || '').trim();
  if (!text || !PRODUCT_KEYWORD_CONTEXT.test(text)) return null;

  const quoted = text.match(/[\u300c\u300e\u201c"']\s*([A-Za-z0-9][A-Za-z0-9 &'()+\-/.]{1,80}?)\s*[\u300d\u300f\u201d"']/);
  const quotedKeyword = cleanupKeywordCandidate(quoted?.[1]);
  if (quotedKeyword) return quotedKeyword;

  const beforeKeyword = text.match(/([A-Za-z0-9][A-Za-z0-9 &'()+\-/.]{1,80}?)\s*(?:\u8fd9\u4e2a|\u9019\u500b|\u8be5|\u9019|\u7684)?\s*(?:\u5173\u952e\u8bcd|\u95dc\u9375\u8a5e|\u5173\u952e\u5b57|\u641c\u7d22\u8bcd|keyword|search\s+term)/i);
  const beforeKeywordValue = cleanupKeywordCandidate(beforeKeyword?.[1]);
  if (beforeKeywordValue) {
    const tokens = beforeKeywordValue.split(/\s+/);
    return cleanupKeywordCandidate(tokens.slice(-Math.min(tokens.length, 6)).join(' '));
  }

  const afterVerb = text.match(/(?:\u641c\u7d22|\u67e5\u8be2|\u67e5\u627e|\u6293\u53d6|\u8bfb\u53d6|\u5206\u6790|\u770b\u4e00\u4e0b|\u6d4b\u8bd5\u4e00\u4e0b|search(?:\s+for)?|find)\s*([A-Za-z0-9][A-Za-z0-9 &'()+\-/.]{1,80}?)(?:\s*(?:\u8fd9\u4e2a|\u9019\u500b|\u8be5|\u7684)?\s*(?:\u5173\u952e\u8bcd|\u95dc\u9375\u8a5e|\u5173\u952e\u5b57|\u4ea7\u54c1|\u5546\u54c1|\u7ed3\u679c|asin|ASIN)|[,\u3001\uff0c\u3002.;\uff1b]|$)/i);
  const afterVerbValue = cleanupKeywordCandidate(afterVerb?.[1]);
  if (afterVerbValue) return afterVerbValue;

  const beforeProductCount = text.match(/([A-Za-z0-9][A-Za-z0-9 &'()+\-/.]{1,80}?)(?:\s*(?:\u8fd9\u4e2a|\u9019\u500b|\u8be5|\u7684))?\s*(?:\u4ea7\u54c1|\u5546\u54c1|\u7ed3\u679c|\u524d\s*(?:\d{1,3}|[\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341])\s*(?:\u4e2a|\u6761)?\s*(?:asin|ASIN|\u4ea7\u54c1|\u5546\u54c1|\u7ed3\u679c))/i);
  const beforeProductCountValue = cleanupKeywordCandidate(beforeProductCount?.[1]);
  if (beforeProductCountValue) {
    const tokens = beforeProductCountValue.split(/\s+/);
    return cleanupKeywordCandidate(tokens.slice(-Math.min(tokens.length, 6)).join(' '));
  }

  return null;
}

function applyProductKeywordIntent(filters, criteria) {
  const keyword = extractProductKeywordFromCriteria(criteria);
  if (!keyword) return;
  setFilterIfMissing(filters, 'keywords', keyword);
  if (filters.selectType === undefined) filters.selectType = 3;
}

function applySizeIntent(filters, criteria) {
  const text = String(criteria || '');
  if (!text) return;
  if (/\u5c3d\u53ef\u80fd\u591a|\u5927\u91cf|\u8d8a\u591a\u8d8a\u597d|\u66f4\u591a/i.test(text)) {
    filters.size = 100;
  } else if (/\u591a\u62c9\u53d6|\u591a\u9009|\u591a\u770b|\u591a\u6293|\u591a\u53d6|\u591a\u4e00\u4e9b|\u591a\u4e00\u70b9/i.test(text)) {
    filters.size = 60;
  }
}

function normalizeResultSize(value) {
  const parsed = parseNumber(value);
  if (parsed === undefined) return undefined;
  if (parsed <= 20) return 20;
  if (parsed <= 60) return 60;
  return 100;
}

function pruneUngroundedFilters(filters, criteria) {
  const text = String(criteria || '').trim();
  if (!text || !filters.keywords) return;
  for (const [key, pattern] of USER_GROUNDED_FILTERS.entries()) {
    if (filters[key] === undefined) continue;
    if (!pattern.test(text)) delete filters[key];
  }
}

function applyCriteriaText(filters, criteria, unknownFilters) {
  const text = String(criteria || '').trim();
  if (!text) return;

  if (/美国站|美国|美区|\bUS\b|\bUSA\b/i.test(text)) filters.market = 'US';
  if (/英国站|英国|\bUK\b|\bGB\b/i.test(text)) filters.market = filters.market || 'UK';
  if (/德国站|德国|\bDE\b/i.test(text)) filters.market = filters.market || 'DE';
  if (/日本站|日本|\bJP\b/i.test(text)) filters.market = filters.market || 'JP';

  if (/\bFBA\b/i.test(text)) filters.sellerTypes = ['FBA'];
  if (/中国卖家|卖家所在地.*中国|中国发货|中国/.test(text)) filters.sellerNationList = ['CN'];

  const priceRange = parseRange(text, '(?:售价|价格|价位|price)');
  if (priceRange) {
    setFilterIfMissing(filters, 'minPrice', priceRange.min);
    setFilterIfMissing(filters, 'maxPrice', priceRange.max);
  }

  const reviewRange = parseRange(text, '(?:评论数|评价数|评分数|review(?:s)?)');
  if (reviewRange) {
    setFilterIfMissing(filters, 'minReviews', reviewRange.min);
    setFilterIfMissing(filters, 'maxReviews', reviewRange.max);
  } else {
    const bound = parseSingleBound(text, '(?:评论数|评价数|评分数|review(?:s)?)');
    if (bound?.type === 'min') setFilterIfMissing(filters, 'minReviews', bound.value);
    if (bound?.type === 'max') setFilterIfMissing(filters, 'maxReviews', bound.value);
  }

  const salesRange = parseRange(text, '(?:月销量|月销|销量|sales)');
  if (salesRange) {
    setFilterIfMissing(filters, 'minSales', salesRange.min);
    setFilterIfMissing(filters, 'maxSales', salesRange.max);
  } else {
    const bound = parseSingleBound(text, '(?:月销量|月销|销量|sales)');
    if (bound?.type === 'min') setFilterIfMissing(filters, 'minSales', bound.value);
    if (bound?.type === 'max') setFilterIfMissing(filters, 'maxSales', bound.value);
  }

  const amountRange = parseRange(text, '(?:月销售额|销售额|amount)');
  if (amountRange) {
    setFilterIfMissing(filters, 'minAmount', amountRange.min);
    setFilterIfMissing(filters, 'maxAmount', amountRange.max);
  }

  const amzUnitRange = parseRange(text, '(?:子体销量|子体销售|amz\\s*unit)');
  if (amzUnitRange) {
    setFilterIfMissing(filters, 'minAmzUnit', amzUnitRange.min);
    setFilterIfMissing(filters, 'maxAmzUnit', amzUnitRange.max);
  }

  const rankingRange = parseRange(text, '(?:\\bBSR\\b|排名)');
  if (rankingRange) {
    setFilterIfMissing(filters, 'minRanking', rankingRange.min);
    setFilterIfMissing(filters, 'maxRanking', rankingRange.max);
  }

  const sellerRange = parseRange(text, '(?:卖家数量|卖家数)');
  if (sellerRange) {
    setFilterIfMissing(filters, 'minSellers', sellerRange.min);
    setFilterIfMissing(filters, 'maxSellers', sellerRange.max);
  } else {
    const bound = parseSingleBound(text, '(?:卖家数量|卖家数)');
    if (bound?.type === 'min') setFilterIfMissing(filters, 'minSellers', bound.value);
    if (bound?.type === 'max') setFilterIfMissing(filters, 'maxSellers', bound.value);
  }

  const ratingRange = parseRange(text, '(?:评分值|评分(?!数|数量)|星级)');
  if (ratingRange) {
    setFilterIfMissing(filters, 'minReviewRating', ratingRange.min);
    setFilterIfMissing(filters, 'maxReviewRating', ratingRange.max);
  }

  const fbaRange = parseRange(text, '(?:FBA运费|FBA费用|fba)');
  if (fbaRange) {
    setFilterIfMissing(filters, 'minFba', fbaRange.min);
    setFilterIfMissing(filters, 'maxFba', fbaRange.max);
  }

  if (/低价商品/.test(text)) filters.lowPrice = 'Y';
  if (/词组匹配|短语匹配/.test(text)) filters.selectType = 3;
  if (/精准匹配|精确匹配/.test(text)) filters.selectType = 4;
  if (/模糊匹配/.test(text)) filters.selectType = 2;
  applyProductKeywordIntent(filters, text);
  applySizeIntent(filters, text);

  const tags = [];
  if (/Best\s*Seller|BestSeller/i.test(text)) tags.push('BestSeller');
  if (/Amazon'?s?\s*Choice|AmazonChoice/i.test(text)) tags.push('AmazonChoice');
  if (/New\s*Release|NewRelease/i.test(text)) tags.push('NewRelease');
  if (/不含A\+|不含A加/i.test(text)) tags.push('NonA+');
  else if (/(?:^|[^不含])A\+/.test(text)) tags.push('A+');
  if (tags.length > 0) filters.productTags = Array.from(new Set([...(filters.productTags || []), ...tags]));

  const putawayYearRange = text.match(/上架时间?.*?(\d+)\s*[-到至~]\s*(\d+)\s*年/);
  if (putawayYearRange) {
    setFilterIfMissing(filters, 'putawayMonth', `${Number(putawayYearRange[1]) * 12}-${Number(putawayYearRange[2]) * 12}`);
  } else {
    const putawayMore = text.match(/上架时间?.*?(\d+)\s*年以上/);
    if (putawayMore) setFilterIfMissing(filters, 'putawayMonth', `${Number(putawayMore[1]) * 12}-`);
    const putawayMonth = text.match(/(?:上架时间|上架|近)\s*(\d+)\s*个?月/);
    if (putawayMonth) setFilterIfMissing(filters, 'putawayMonth', String(Number(putawayMonth[1])));
  }

  for (const item of UNKNOWN_FIELD_PATTERNS) {
    if (item.pattern.test(text)) {
      unknownFilters.push({ field: item.field, label: item.label, source: 'criteria', value: text });
    }
  }
}

function normalizeArgs(args = {}) {
  const filters = {};
  const unknownFilters = [];
  const warnings = [];
  const strictFilters = parseBoolean(args.strict_filters ?? args.strictFilters, true);

  const nestedFilters = parseJsonObject(args.filters);
  applyObjectFilters(filters, nestedFilters, unknownFilters);
  applyObjectFilters(filters, args, unknownFilters);
  applyCriteriaText(filters, args.criteria, unknownFilters);
  pruneUngroundedFilters(filters, args.criteria);
  applyProductKeywordIntent(filters, args.criteria);
  if (filters.size !== undefined) filters.size = normalizeResultSize(filters.size);

  return {
    filters,
    unknown_filters: unknownFilters,
    warnings,
    strict_filters: strictFilters,
    needs_clarification: strictFilters && unknownFilters.length > 0,
    suggested_supported_filters: SUPPORTED_FILTERS
  };
}

module.exports = {
  SUPPORTED_FILTERS,
  SUPPORTED_TOP_LEVEL_CATEGORIES,
  normalizeArgs,
  parseBoolean,
  parseNumber,
  toArray
};
