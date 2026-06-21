const LOGIN_URL = 'https://www.sellersprite.com/cn/w/user/login';
const PRODUCT_RESEARCH_URL = 'https://www.sellersprite.com/v3/product-research';
const COMPETITOR_LOOKUP_URL = 'https://www.sellersprite.com/v3/competitor-lookup';
const KEYWORD_RESEARCH_URL = 'https://www.sellersprite.com/v2/keyword-research';
const KEYWORD_REVERSE_URL = 'https://www.sellersprite.com/v3/keyword-reverse';
const KEYWORD_CONVERSION_RATE_URL = 'https://www.sellersprite.com/v3/keyword-conversion-rate';

const DEFAULT_NODE_ID_PATHS = [
  '2619525011',
  '2617941011',
  '15684181',
  '165796011',
  '3760911',
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
  '165793011'
];

const DEFAULT_FILTERS = {
  market: 'US',
  page: 1,
  size: 20,
  symbolFlag: false,
  monthName: 'bsr_sales_nearly',
  selectType: 3,
  filterSub: false,
  weightUnit: 'g',
  orderField: 'total_units',
  orderDesc: true,
  productTags: [],
  nodeIdPaths: DEFAULT_NODE_ID_PATHS,
  sellerTypes: ['FBA'],
  eligibility: [],
  pkgDimensionTypeList: [],
  sellerNationList: ['CN'],
  smallAndLight: 'N',
  lowPrice: 'N',
  video: ''
};

const TOP_LEVEL_NODE_IDS = new Set([
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
]);

const DESCENDANT_NODE_TOP_IDS = new Map([
  ['166420011', '165793011'],
  ['166437011', '165793011'],
  ['1272924011', '165793011']
]);

const KEYWORD_DEPARTMENTS = [
  { slug: 'any', label: 'All Categories', aliases: ['all', 'all categories', '全部类目', '所有类目', '全类目'] },
  { slug: 'arts-crafts', label: 'Arts, Crafts & Sewing', aliases: ['arts crafts sewing', 'arts, crafts & sewing', 'arts-crafts', '艺术', '手工艺', '艺术手工艺'] },
  { slug: 'automotive', label: 'Automotive Parts & Accessories', aliases: ['automotive', 'automotive parts', '汽车', '汽车配件'] },
  { slug: 'baby-products', label: 'Baby', aliases: ['baby', 'baby products', '婴儿', '婴儿产品'] },
  { slug: 'beauty', label: 'Beauty & Personal Care', aliases: ['beauty', 'personal care', '美容', '护理', '美容与护理'] },
  { slug: 'mobile', label: 'Cell Phones & Accessories', aliases: ['mobile', 'cell phones', 'phone', '手机', '手机配件'] },
  { slug: 'fashion', label: 'Clothing, Shoes & Jewelry', aliases: ['fashion', 'clothing', 'shoes', 'jewelry', '服装', '鞋履', '珠宝'] },
  { slug: 'computers', label: 'Computers', aliases: ['computers', 'computer', '电脑', '计算机'] },
  { slug: 'electronics', label: 'Electronics', aliases: ['electronics', '电子产品', '电子'] },
  { slug: 'grocery', label: 'Grocery & Gourmet Food', aliases: ['grocery', 'food', 'gourmet food', '杂货', '美食'] },
  { slug: 'handmade', label: 'Handmade', aliases: ['handmade', '手工', '手工制品'] },
  { slug: 'hpc', label: 'Health, Household & Baby Care', aliases: ['hpc', 'health household baby care', 'health', 'household', '健康', '家居', '母婴护理'] },
  { slug: 'industrial', label: 'Industrial & Scientific', aliases: ['industrial', 'scientific', '工业', '工业类'] },
  { slug: 'mi', label: 'Musical Instruments', aliases: ['mi', 'musical instruments', '乐器'] },
  { slug: 'office-products', label: 'Office Products', aliases: ['office', 'office products', '办公', '办公产品'] },
  { slug: 'lawngarden', label: 'Patio, Lawn & Garden', aliases: ['lawngarden', 'patio', 'lawn', 'garden', '庭院', '草坪', '园艺', 'garden & outdoor'] },
  { slug: 'pets', label: 'Pet Supplies', aliases: ['pets', 'pet supplies', '宠物', '宠物用品'] },
  { slug: 'sporting', label: 'Sports & Outdoors', aliases: ['sporting', 'sports', 'outdoors', '运动', '户外'] },
  { slug: 'tools', label: 'Tools & Home Improvement', aliases: ['tools', 'home improvement', '工具', '家装'] },
  { slug: 'toys-and-games', label: 'Toys & Games', aliases: ['toys', 'games', 'toys and games', 'toys & games', '玩具', '游戏', 'toys & kitchen'] },
  { slug: 'kitchen', label: 'Home & Kitchen', aliases: ['kitchen', 'home kitchen', 'home & kitchen', '家居用品', '厨具', 'toys & kitchen'] },
  { slug: 'photo', label: 'Camera and Photo', aliases: ['photo', 'camera', 'camera and photo', '相机', '摄影'] },
  { slug: 'wireless', label: 'Wireless', aliases: ['wireless', '无线'] }
];

const DEFAULT_KEYWORD_DEPARTMENTS = KEYWORD_DEPARTMENTS.map(item => item.slug);

function getLastCompleteMonth() {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - 1);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}${month}`;
}

const DEFAULT_KEYWORD_FILTERS = {
  station: 'US',
  orderField: 'searches',
  orderDesc: true,
  supplement: 'N',
  usestatic: 'R',
  exportGkImages: false,
  marketId: 1,
  limitUserStatic: true,
  adminDes: 'S',
  presetMode: '',
  itemImageRange: 2,
  keywordBidMatchType: 'exact',
  month: getLastCompleteMonth,
  departments: DEFAULT_KEYWORD_DEPARTMENTS,
  marketPeriod: ''
};

const DEFAULT_COMPETITOR_FILTERS = {
  market: 'US',
  monthName: 'bsr_sales_nearly',
  asins: [],
  keywords: '',
  includeSellers: '',
  includeBrands: '',
  page: 1,
  nodeIdPaths: [],
  symbolFlag: false,
  size: 60,
  orderField: 'amz_unit',
  orderDesc: true,
  lowPrice: 'N'
};

const DEFAULT_KEYWORD_CONVERSION_RATE_FILTERS = {
  marketId: 1,
  reverseType: 'W',
  bidMatchType: 1,
  keywordMatchType: 'all',
  keywordList: ''
};

function normalizeQueryValue(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return undefined;
  return String(value);
}

function appendParam(params, key, value) {
  const normalized = normalizeQueryValue(value);
  if (normalized === undefined) return;
  params.append(key, normalized);
}

function normalizeProductNodeIdPaths(value) {
  const raw = Array.isArray(value) ? value : [value];
  const values = [];
  for (const item of raw) {
    const text = String(item || '').trim();
    if (!text) continue;
    if (/^\d+(?::\d+)+$/.test(text)) {
      const topId = text.split(':')[0];
      if (TOP_LEVEL_NODE_IDS.has(topId)) {
        values.push(text);
      }
      continue;
    }
    if (TOP_LEVEL_NODE_IDS.has(text)) {
      values.push(text);
    } else if (DESCENDANT_NODE_TOP_IDS.has(text)) {
      values.push(DESCENDANT_NODE_TOP_IDS.get(text));
    } else if (text.includes(':')) {
      const topId = text.split(':')[0];
      if (DESCENDANT_NODE_TOP_IDS.has(topId)) {
        values.push(DESCENDANT_NODE_TOP_IDS.get(topId));
      }
    }
  }
  return values.length > 0 ? Array.from(new Set(values)) : undefined;
}

function normalizeProductSize(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_FILTERS.size;
  if (parsed <= 20) return 20;
  if (parsed <= 60) return 60;
  return 100;
}

function buildProductResearchUrl(filters = {}) {
  const merged = {
    ...DEFAULT_FILTERS,
    ...filters,
    size: normalizeProductSize(filters.size ?? DEFAULT_FILTERS.size),
    orderField: filters.orderField || DEFAULT_FILTERS.orderField,
    orderDesc: filters.orderDesc ?? DEFAULT_FILTERS.orderDesc,
    nodeIdPaths: normalizeProductNodeIdPaths(filters.nodeIdPaths) || DEFAULT_FILTERS.nodeIdPaths,
    sellerTypes: filters.sellerTypes || DEFAULT_FILTERS.sellerTypes,
    sellerNationList: filters.sellerNationList || DEFAULT_FILTERS.sellerNationList
  };

  const params = new URLSearchParams();
  appendParam(params, 'market', merged.market);
  appendParam(params, 'page', merged.page);
  appendParam(params, 'size', merged.size);
  appendParam(params, 'symbolFlag', merged.symbolFlag);
  appendParam(params, 'monthName', merged.monthName);
  appendParam(params, 'selectType', merged.selectType);
  appendParam(params, 'filterSub', merged.filterSub);
  appendParam(params, 'weightUnit', merged.weightUnit);
  appendParam(params, 'order[field]', merged.orderField);
  appendParam(params, 'order[desc]', merged.orderDesc);
  appendParam(params, 'productTags', merged.productTags);
  appendParam(params, 'nodeIdPaths', merged.nodeIdPaths);
  appendParam(params, 'sellerTypes', merged.sellerTypes);
  appendParam(params, 'eligibility', merged.eligibility);
  appendParam(params, 'pkgDimensionTypeList', merged.pkgDimensionTypeList);
  appendParam(params, 'sellerNationList', merged.sellerNationList);
  appendParam(params, 'smallAndLight', merged.smallAndLight);

  const optionalKeys = [
    'minSales',
    'maxSales',
    'minAmount',
    'maxAmount',
    'minAmzUnit',
    'maxAmzUnit',
    'minPrice',
    'maxPrice',
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
    'minReviews',
    'maxReviews',
    'lowPrice',
    'video'
  ];

  for (const key of optionalKeys) {
    if (Object.prototype.hasOwnProperty.call(merged, key)) {
      appendParam(params, key, merged[key]);
    }
  }

  return `${PRODUCT_RESEARCH_URL}?${params.toString()}`;
}

function buildCompetitorLookupUrl(filters = {}) {
  const merged = {
    ...DEFAULT_COMPETITOR_FILTERS,
    ...filters,
    size: normalizeProductSize(filters.size ?? DEFAULT_COMPETITOR_FILTERS.size),
    nodeIdPaths: normalizeProductNodeIdPaths(filters.nodeIdPaths) || DEFAULT_COMPETITOR_FILTERS.nodeIdPaths,
    orderField: filters.orderField || DEFAULT_COMPETITOR_FILTERS.orderField,
    orderDesc: filters.orderDesc ?? DEFAULT_COMPETITOR_FILTERS.orderDesc
  };

  const params = new URLSearchParams();
  appendParam(params, 'market', merged.market);
  appendParam(params, 'monthName', merged.monthName);
  appendParam(params, 'asins', Array.isArray(merged.asins) ? merged.asins : []);
  appendParam(params, 'keywords', merged.keywords);
  appendParam(params, 'includeSellers', merged.includeSellers);
  appendParam(params, 'includeBrands', merged.includeBrands);
  appendParam(params, 'page', merged.page);
  appendParam(params, 'nodeIdPaths', merged.nodeIdPaths);
  appendParam(params, 'symbolFlag', merged.symbolFlag);
  appendParam(params, 'size', merged.size);
  appendParam(params, 'order[field]', merged.orderField);
  appendParam(params, 'order[desc]', merged.orderDesc);
  appendParam(params, 'lowPrice', merged.lowPrice);

  const optionalKeys = [
    'excludeBrands',
    'excludeSellers',
    'outOfKeywords',
    'minPrice',
    'maxPrice',
    'minReviews',
    'maxReviews',
    'minReviewRating',
    'maxReviewRating',
    'minAmzUnit',
    'maxAmzUnit',
    'minRanking',
    'maxRanking'
  ];

  for (const key of optionalKeys) {
    if (Object.prototype.hasOwnProperty.call(merged, key)) {
      appendParam(params, key, merged[key]);
    }
  }

  return `${COMPETITOR_LOOKUP_URL}?${params.toString()}`;
}

function normalizeKeywordMonth(value) {
  if (typeof value === 'function') return value();
  return value;
}

function appendKeywordDepartments(params, departments) {
  const values = Array.isArray(departments) && departments.length > 0
    ? departments
    : DEFAULT_KEYWORD_DEPARTMENTS;
  values.forEach((department, index) => {
    appendParam(params, `departments[${index + 1}]`, department);
  });
}

function buildKeywordResearchUrl(filters = {}) {
  const merged = {
    ...DEFAULT_KEYWORD_FILTERS,
    ...filters,
    orderField: String(filters.orderField || DEFAULT_KEYWORD_FILTERS.orderField).toLowerCase(),
    orderDesc: filters.orderDesc ?? DEFAULT_KEYWORD_FILTERS.orderDesc,
    departments: filters.departments || DEFAULT_KEYWORD_FILTERS.departments,
    month: filters.month || normalizeKeywordMonth(DEFAULT_KEYWORD_FILTERS.month)
  };

  const params = new URLSearchParams();
  appendParam(params, 'station', merged.station);
  appendParam(params, 'order.field', merged.orderField);
  appendParam(params, 'order.desc', merged.orderDesc);
  appendParam(params, 'supplement', merged.supplement);
  appendParam(params, 'usestatic', merged.usestatic);
  appendParam(params, 'exportGkImages', merged.exportGkImages);
  appendParam(params, 'marketId', merged.marketId);
  appendParam(params, 'limitUserStatic', merged.limitUserStatic);
  appendParam(params, 'adminDes', merged.adminDes);
  appendParam(params, 'presetMode', merged.presetMode);
  appendParam(params, 'itemImageRange', merged.itemImageRange);
  appendParam(params, 'keywordBidMatchType', merged.keywordBidMatchType);
  appendParam(params, 'month', merged.month);
  appendKeywordDepartments(params, merged.departments);

  const optionalKeys = [
    'minSearches',
    'maxSearches',
    'minYearlyGrowth',
    'maxYearlyGrowth',
    'minGrowthTrendMin',
    'maxGrowthTrendMin',
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
    'excludeKeywords'
  ];

  for (const key of optionalKeys) {
    if (Object.prototype.hasOwnProperty.call(merged, key)) {
      appendParam(params, key, merged[key]);
    }
  }

  if (merged.withYearlyGrowth === true) {
    appendParam(params, 'withYearlyGrowth', true);
  }

  return `${KEYWORD_RESEARCH_URL}?${params.toString()}`;
}

function collectPageText(result = {}) {
  const parts = [
    result.page_info,
    result.page_state?.url,
    result.page_state?.title,
    result.message,
    result.error
  ];
  return parts.filter(Boolean).map(String).join('\n');
}

function isLoggedInPage(result = {}) {
  const text = collectPageText(result);
  if (!text) return false;
  const hasAccountSignal = /VIP会员|晚上好|工作台|用户中心|退出登录|会员中心|套餐|XS[A-Z0-9]+/i.test(text);
  const hasLoginFormSignal = /登录|请输入.*密码|input\[type="password"\]|密码/.test(text);
  const url = String(result.page_state?.url || '');
  return hasAccountSignal && (!hasLoginFormSignal || !/\/w\/user\/login/.test(url));
}

function isCaptchaOrVerificationPage(result = {}) {
  return /验证码|滑块|安全验证|人机验证|captcha/i.test(collectPageText(result));
}

function isCredentialErrorPage(result = {}) {
  return /密码错误|密码不正确|账号或密码|用户名或密码|账户名与密码|登录失败|账号不存在|用户不存在|invalid password|invalid credentials|incorrect password|wrong password/i.test(collectPageText(result));
}

function buildSellerSpriteLoginScript(username, password, timeout = 20000) {
  return `
    const username = ${JSON.stringify(username)};
    const password = ${JSON.stringify(password)};
    const timeoutMs = Math.max(3000, Math.min(Number(${JSON.stringify(timeout)}) || 20000, 30000));

    const isVisible = element => {
      if (!element || !element.isConnected) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0;
    };

    const firstVisible = selectors => {
      for (const selector of selectors) {
        const element = Array.from(document.querySelectorAll(selector)).find(isVisible);
        if (element) return element;
      }
      return null;
    };

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const pageText = () => [
      document.title || '',
      location.href || '',
      document.body?.innerText || ''
    ].join('\\n');
    const hasLoggedInSignal = () => /VIP会员|晚上好|工作台|用户中心|退出登录|会员中心|套餐|XS[A-Z0-9]+/i.test(pageText());

    const setNativeValue = (element, value) => {
      const prototype = element.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      const previousValue = element.value;
      if (valueSetter) {
        valueSetter.call(element, value);
      } else {
        element.value = value;
      }
      if (element._valueTracker) {
        element._valueTracker.setValue(previousValue);
      }
    };

    const dispatchInputEvents = element => {
      element.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: element.value || '',
        composed: true
      }));
      element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true, composed: true }));
      element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true, composed: true }));
    };

    const fillInput = (element, value) => {
      if (!element) throw new Error('login input not found');
      element.scrollIntoView({ block: 'center', inline: 'center' });
      element.focus();
      setNativeValue(element, value);
      dispatchInputEvents(element);
      if (element.value !== value) {
        setNativeValue(element, value);
        dispatchInputEvents(element);
      }
      if (element.value !== value) {
        throw new Error('login input value verification failed');
      }
    };

    const clickLikeUser = element => {
      if (!element) throw new Error('login submit button not found');
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = element.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
        buttons: 1,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      };
      element.dispatchEvent(new MouseEvent('mousedown', init));
      element.focus();
      element.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
      element.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
      if (typeof element.click === 'function') element.click();
    };

    const usernameSelectors = [
      'input[name="email"]',
      'input[name="username"]',
      'input[name="account"]',
      'input[name="phone"]',
      'input[autocomplete="username"]',
      'input[type="email"]',
      'input[type="tel"]',
      'input[placeholder*="邮箱"]',
      'input[placeholder*="账号"]',
      'input[placeholder*="账户"]',
      'input[placeholder*="用户名"]',
      'input[placeholder*="手机"]',
      'input[type="text"]'
    ];
    const passwordSelectors = [
      'input[name="password"]',
      'input[type="password"]',
      'input[placeholder*="密码"]'
    ];

    let usernameInput = null;
    let passwordInput = null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (hasLoggedInSignal()) {
        return {
          already_logged_in: true,
          submitted: false,
          url: location.href,
          title: document.title
        };
      }
      usernameInput = firstVisible(usernameSelectors);
      passwordInput = firstVisible(passwordSelectors);
      if (usernameInput && passwordInput) break;
      await sleep(100);
    }

    if (!usernameInput || !passwordInput) {
      return {
        inputs_not_found: true,
        submitted: false,
        url: location.href,
        title: document.title,
        text_sample: pageText().slice(0, 1200)
      };
    }

    fillInput(usernameInput, username);
    fillInput(passwordInput, password);

    const buttons = Array.from(document.querySelectorAll([
      'button[type="submit"]',
      'button.login-btn',
      '.login-btn',
      '.btn-login',
      '[role="button"]',
      'button',
      'input[type="submit"]'
    ].join(','))).filter(isVisible);
    const submitButton = buttons.find(button => /登录|log\\s*in|sign\\s*in/i.test(button.innerText || button.value || button.textContent || '')) || buttons[0];

    if (submitButton) {
      clickLikeUser(submitButton);
    } else {
      const form = passwordInput.closest('form') || usernameInput.closest('form');
      if (!form) throw new Error('login form submit target not found');
      form.requestSubmit ? form.requestSubmit() : form.submit();
    }

    await sleep(500);
    return {
      filled_username: Boolean(usernameInput && usernameInput.value),
      filled_password: Boolean(passwordInput && passwordInput.value),
      submitted: true,
      url: location.href,
      title: document.title
    };
  `;
}

async function login({ chromeBridgeClient, username, password, timeout = 20000 }) {
  let openResult;
  try {
    openResult = await chromeBridgeClient.openUrl(LOGIN_URL, timeout);
  } catch (error) {
    openResult = {
      success: false,
      login_url: LOGIN_URL,
      error: `Unable to open SellerSprite login page without ChromeBridge open_url: ${error.message}`
    };
  }

  // 等待页面导航完成后再切换标签
  await new Promise(resolve => setTimeout(resolve, 1000));

  if (typeof chromeBridgeClient.switchTab === 'function') {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await chromeBridgeClient.switchTab('sellersprite.com', Math.min(timeout, 10000));
        break;
      } catch (error) {
        if (attempt === 4) break;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
  }

  // 再次等待确保标签切换完成
  await new Promise(resolve => setTimeout(resolve, 500));

  const navigationResult = {
    ...openResult,
    page_state: openResult.page_state,
    page_info: openResult.page_info
  };

  if (isLoggedInPage(navigationResult)) {
    return {
      ...navigationResult,
      success: true,
      already_logged_in: true,
      login_url: LOGIN_URL,
      message: 'SellerSprite is already logged in.'
    };
  }

  if (!username || !password) {
    return {
      ...navigationResult,
      success: false,
      needs_config: true,
      error: 'SELLERSPRITE_USERNAME or SELLERSPRITE_PASSWORD is not configured.'
    };
  }

  if (navigationResult.success === false && isCaptchaOrVerificationPage(navigationResult)) {
    return {
      ...navigationResult,
      success: false,
      login_url: LOGIN_URL,
      needs_manual_action: true,
      error: 'SellerSprite login is blocked by captcha or verification.'
    };
  }

  if (isCredentialErrorPage(navigationResult)) {
    return {
      ...navigationResult,
      success: false,
      login_url: LOGIN_URL,
      credential_error: true,
      error: 'SellerSprite credential error: username or password is incorrect.'
    };
  }

  let formResult = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      formResult = await chromeBridgeClient.call({
        command: 'execute_script',
        text: buildSellerSpriteLoginScript(username, password, timeout),
        timeout
      });

      // 检查是否找到输入框
      if (formResult.success !== false && formResult.result?.inputs_not_found) {
        formResult = {
          success: false,
          error: 'Login form inputs not found on the page.',
          inputs_not_found: true,
          result: formResult.result
        };
      }

      // 如果成功或已登录，跳出重试循环
      if (formResult.success !== false || formResult.result?.already_logged_in) {
        break;
      }

      // 如果是输入框未找到，需要重试
      if (formResult.inputs_not_found && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (typeof chromeBridgeClient.switchTab === 'function') {
          try {
            await chromeBridgeClient.switchTab('sellersprite.com', Math.min(timeout, 10000));
            await new Promise(resolve => setTimeout(resolve, 500));
          } catch (_) {
            // 继续下一次尝试
          }
        }
        continue;
      }

      break;
    } catch (error) {
      formResult = {
        success: false,
        error: error.message || 'SellerSprite login form interaction failed.'
      };
      if (attempt === 2) break;

      // 重试前等待更长时间并重新切换标签
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (typeof chromeBridgeClient.switchTab === 'function') {
        try {
          await chromeBridgeClient.switchTab('sellersprite.com', Math.min(timeout, 10000));
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (_) {
          // 继续下一次尝试
        }
      }
    }
  }

  // 处理找不到输入框的情况
  if (formResult.inputs_not_found) {
    return {
      ...formResult,
      success: false,
      login_url: LOGIN_URL,
      needs_manual_action: true,
      error: 'SellerSprite login form inputs not found after multiple attempts. The page structure may have changed or requires manual verification.'
    };
  }

  if (formResult.success === false) {
    const credentialError = isCredentialErrorPage(formResult);
    return {
      ...formResult,
      success: false,
      login_url: LOGIN_URL,
      credential_error: credentialError,
      error: credentialError
        ? 'SellerSprite credential error: username or password is incorrect.'
        : (formResult.error || 'SellerSprite login form interaction failed.')
    };
  }

  if (formResult.result?.already_logged_in) {
    return {
      ...formResult,
      success: true,
      already_logged_in: true,
      login_url: LOGIN_URL,
      message: 'SellerSprite is already logged in.'
    };
  }

  if (isCredentialErrorPage(formResult)) {
    return {
      ...formResult,
      success: false,
      login_url: LOGIN_URL,
      credential_error: true,
      error: 'SellerSprite credential error: username or password is incorrect.'
    };
  }

  // 提交表单后等待页面响应
  await new Promise(resolve => setTimeout(resolve, 1500));

  const immediatePageInfoResult = await chromeBridgeClient.getPageInfo(Math.min(timeout, 5000));
  if (isLoggedInPage(immediatePageInfoResult)) {
    return {
      ...immediatePageInfoResult,
      login_url: LOGIN_URL,
      form_result: {
        success: formResult.success !== false,
        completed_steps: formResult.completed_steps,
        step_results: formResult.step_results,
        script_result: formResult.result
      },
      success: true,
      already_logged_in: false,
      message: 'SellerSprite login succeeded.'
    };
  }

  if (isCredentialErrorPage(immediatePageInfoResult)) {
    return {
      ...immediatePageInfoResult,
      success: false,
      credential_error: true,
      error: 'SellerSprite credential error: username or password is incorrect.'
    };
  }

  const waitResult = await chromeBridgeClient.call({
    command: 'wait_for_text',
    text: 'VIP',
    timeout,
    on_error: 'return_page_info'
  });

  const pageInfoResult = await chromeBridgeClient.getPageInfo(timeout);
  const finalResult = {
    ...pageInfoResult,
    login_url: LOGIN_URL,
    form_result: {
      success: formResult.success !== false,
      completed_steps: formResult.completed_steps,
      step_results: formResult.step_results
    },
    wait_result: {
      success: waitResult.success !== false,
      error: waitResult.error,
      message: waitResult.message
    }
  };

  if (isLoggedInPage(finalResult) || isLoggedInPage(waitResult) || isLoggedInPage(formResult)) {
    return {
      ...finalResult,
      success: true,
      already_logged_in: false,
      message: 'SellerSprite login succeeded.'
    };
  }

  if (isCredentialErrorPage(finalResult) || isCredentialErrorPage(waitResult)) {
    return {
      ...finalResult,
      success: false,
      credential_error: true,
      error: 'SellerSprite credential error: username or password is incorrect.'
    };
  }

  return {
    ...finalResult,
    success: false,
    needs_manual_action: isCaptchaOrVerificationPage(finalResult) || isCaptchaOrVerificationPage(waitResult),
    error: isCaptchaOrVerificationPage(finalResult) || isCaptchaOrVerificationPage(waitResult)
      ? 'SellerSprite login requires captcha or manual verification.'
      : 'SellerSprite login did not reach a recognized logged-in page.'
  };
}

function buildKeywordReverseUrl(filters = {}) {
  const merged = {
    q: filters.q || '',
    marketId: filters.marketId || 1,
    date: filters.date || '',
    badges: filters.badges !== undefined ? filters.badges : 'NATURAL_SEARCHING,AMAZON_CHOICE,EDITORIAL_RECOMMENDATIONS,FOUR_STAR,SPONSOR_BRAND,SPONSOR_VIDEO,HIGHLY_RATED,ADS'
  };

  const params = new URLSearchParams();
  appendParam(params, 'q', merged.q);
  appendParam(params, 'marketId', merged.marketId);
  appendParam(params, 'date', merged.date);
  if (merged.badges) {
    appendParam(params, 'badges', merged.badges);
  }

  return `${KEYWORD_REVERSE_URL}?${params.toString()}`;
}

function buildKeywordConversionRateUrl(filters = {}) {
  const merged = {
    ...DEFAULT_KEYWORD_CONVERSION_RATE_FILTERS,
    ...filters,
    reverseType: filters.reverseType || DEFAULT_KEYWORD_CONVERSION_RATE_FILTERS.reverseType,
    bidMatchType: filters.bidMatchType || DEFAULT_KEYWORD_CONVERSION_RATE_FILTERS.bidMatchType,
    keywordMatchType: filters.keywordMatchType || DEFAULT_KEYWORD_CONVERSION_RATE_FILTERS.keywordMatchType
  };

  const params = new URLSearchParams();
  appendParam(params, 'marketId', merged.marketId);
  appendParam(params, 'reverseType', merged.reverseType);

  const optionalKeys = [
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

  for (const key of optionalKeys) {
    if (Object.prototype.hasOwnProperty.call(merged, key)) {
      appendParam(params, key, merged[key]);
    }
  }

  appendParam(params, 'bidMatchType', merged.bidMatchType);
  appendParam(params, 'keywordMatchType', merged.keywordMatchType);
  appendParam(params, 'keywordList', merged.keywordList);

  return `${KEYWORD_CONVERSION_RATE_URL}?${params.toString()}`;
}

module.exports = {
  LOGIN_URL,
  PRODUCT_RESEARCH_URL,
  COMPETITOR_LOOKUP_URL,
  KEYWORD_RESEARCH_URL,
  KEYWORD_REVERSE_URL,
  KEYWORD_CONVERSION_RATE_URL,
  DEFAULT_NODE_ID_PATHS,
  DEFAULT_FILTERS,
  DEFAULT_COMPETITOR_FILTERS,
  DEFAULT_KEYWORD_CONVERSION_RATE_FILTERS,
  KEYWORD_DEPARTMENTS,
  DEFAULT_KEYWORD_DEPARTMENTS,
  DEFAULT_KEYWORD_FILTERS,
  buildProductResearchUrl,
  buildCompetitorLookupUrl,
  buildKeywordResearchUrl,
  buildKeywordReverseUrl,
  buildKeywordConversionRateUrl,
  login,
  isLoggedInPage,
  isCredentialErrorPage
};
