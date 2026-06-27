const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'data', 'sellersprite-category-index.json');

const QUERY_ALIASES = new Map([
  ['浴帘套装', ['shower curtain sets']],
  ['浴帘', ['shower curtains']],
  ['咖啡机', ['coffee makers', 'coffee machines']],
  ['咖啡杯', ['coffee mugs', 'coffee cups mugs']],
  ['咖啡马克杯', ['coffee mugs']],
  ['咖啡桌', ['coffee tables']],
  ['咖啡过滤器', ['coffee filters']],
  ['咖啡滤纸', ['coffee filters', 'disposable filters']],
  ['猫砂盆', ['cat litter boxes', 'litter boxes', 'standard litter boxes']],
  ['台灯', ['desk lamps']],
  ['园艺水管', ['garden hoses']],
  ['花园水管', ['garden hoses']],
  ['狗窝', ['dog beds']],
  ['手机壳', ['cell phone cases', 'cases covers skins']],
  ['保护套', ['cases covers skins', 'cases']]
]);

let cachedIndex = null;

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(/[\u3000\s]+/g, ' ')
    .replace(/[>\/\\|,，、;；:：()[\]{}"“”‘’._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCompactText(value) {
  return normalizeText(value).replace(/\s+/g, '');
}

function splitPath(value) {
  return String(value || '')
    .split('>')
    .map(item => item.trim())
    .filter(Boolean);
}

function tokenize(value) {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  return normalized.split(/\s+/).filter(token => token.length > 1 || /[\u4e00-\u9fff]/.test(token));
}

function loadCategoryIndex() {
  if (cachedIndex) return cachedIndex;
  const raw = fs.readFileSync(INDEX_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const categories = Array.isArray(parsed.categories) ? parsed.categories : [];
  cachedIndex = {
    ...parsed,
    categories: categories.map(item => {
      const enSegments = splitPath(item.enPath);
      const cnSegments = splitPath(item.cnPath);
      const leafEn = enSegments[enSegments.length - 1] || '';
      const leafCn = cnSegments[cnSegments.length - 1] || '';
      const searchable = normalizeText([
        item.enPath,
        item.cnPath,
        leafEn,
        leafCn,
        item.nodeIdPath,
        item.nodeId
      ].join(' '));
      return {
        ...item,
        leafEn,
        leafCn,
        _normalizedEnPath: normalizeText(item.enPath),
        _normalizedCnPath: normalizeText(item.cnPath),
        _normalizedLeafEn: normalizeText(leafEn),
        _normalizedLeafCn: normalizeText(leafCn),
        _compactEnPath: normalizeCompactText(item.enPath),
        _compactCnPath: normalizeCompactText(item.cnPath),
        _searchable: searchable,
        _topSearchable: normalizeText(`${item.topEn || ''} ${item.topCn || ''} ${item.topNodeId || ''}`)
      };
    })
  };
  return cachedIndex;
}

function expandQueries(query) {
  const raw = String(query || '').trim();
  const normalized = normalizeText(raw);
  const values = [];
  if (raw) values.push(raw);
  if (normalized && normalized !== raw) values.push(normalized);

  const aliases = QUERY_ALIASES.get(raw) || QUERY_ALIASES.get(normalized);
  if (aliases) values.push(...aliases);

  return Array.from(new Set(values.map(normalizeText).filter(Boolean)));
}

function productCountBoost(productCount) {
  const count = Number(productCount);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(8, Math.log10(count + 1) * 1.6);
}

function scoreCategory(category, query) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return null;
  const tokens = tokenize(normalizedQuery);
  let score = 0;
  const reasons = [];

  if (category.nodeIdPath === query || category.nodeId === query) {
    score += 120;
    reasons.push('node_id_match');
  }

  if (category._normalizedLeafEn === normalizedQuery || category._normalizedLeafCn === normalizedQuery) {
    score += 100;
    reasons.push('leaf_exact');
  } else if (category._normalizedLeafEn.includes(normalizedQuery) || category._normalizedLeafCn.includes(normalizedQuery)) {
    score += 72;
    reasons.push('leaf_phrase');
  }

  if (category._normalizedEnPath.endsWith(normalizedQuery) || category._normalizedCnPath.endsWith(normalizedQuery)) {
    score += 64;
    reasons.push('path_suffix');
  } else if (category._normalizedEnPath.includes(normalizedQuery) || category._normalizedCnPath.includes(normalizedQuery)) {
    score += 42;
    reasons.push('path_phrase');
  }

  if (tokens.length > 0) {
    const leafMatches = tokens.filter(token => category._normalizedLeafEn.includes(token) || category._normalizedLeafCn.includes(token));
    const pathMatches = tokens.filter(token => category._searchable.includes(token));
    if (pathMatches.length === tokens.length) {
      score += 22 + pathMatches.length * 4;
      reasons.push('all_tokens');
    } else if (pathMatches.length > 0) {
      score += pathMatches.length * 6;
      reasons.push('partial_tokens');
    }
    if (leafMatches.length > 0) score += leafMatches.length * 8;
  }

  if (score <= 0) return null;
  if (category.isLeaf) score += 8;
  score += productCountBoost(category.productCount);
  return { score, reasons };
}

function matchesTopCategory(category, topCategory) {
  if (!topCategory) return true;
  const normalized = normalizeText(topCategory);
  if (!normalized) return true;
  return category._topSearchable.includes(normalized);
}

function searchSellerSpriteCategories(options = {}) {
  const query = String(options.query || options.keyword || options.keywords || '').trim();
  const maxResults = Math.min(Math.max(Number(options.maxResults || options.max_results || 8) || 8, 1), 50);
  const leafOnly = options.leafOnly !== false && options.leaf_only !== false && String(options.leafOnly ?? options.leaf_only ?? 'true') !== 'false';
  const topCategory = options.topCategory || options.top_category || options.categories || options.category;
  const index = loadCategoryIndex();
  const expandedQueries = expandQueries(query);
  const warnings = [];

  if (!query) {
    return {
      success: false,
      command: 'search_sellersprite_categories',
      error: 'Missing query. Pass a product/category phrase such as "coffee maker" or "猫砂盆".',
      categories: [],
      warnings
    };
  }

  const bestByPath = new Map();
  for (const category of index.categories) {
    if (leafOnly && !category.isLeaf) continue;
    if (!matchesTopCategory(category, topCategory)) continue;

    let best = null;
    let matchedQuery = null;
    for (const expanded of expandedQueries) {
      const scored = scoreCategory(category, expanded);
      if (scored && (!best || scored.score > best.score)) {
        best = scored;
        matchedQuery = expanded;
      }
    }
    if (!best) continue;

    const previous = bestByPath.get(category.nodeIdPath);
    if (!previous || best.score > previous.score) {
      bestByPath.set(category.nodeIdPath, { category, score: best.score, reasons: best.reasons, matchedQuery });
    }
  }

  const categories = Array.from(bestByPath.values())
    .sort((a, b) => b.score - a.score || Number(b.category.productCount || 0) - Number(a.category.productCount || 0))
    .slice(0, maxResults)
    .map((item, index) => ({
      rank: index + 1,
      score: Number(item.score.toFixed(2)),
      nodeId: item.category.nodeId,
      nodeIdPath: item.category.nodeIdPath,
      enPath: item.category.enPath,
      cnPath: item.category.cnPath,
      depth: item.category.depth,
      isLeaf: item.category.isLeaf,
      productCount: item.category.productCount,
      topCategory: {
        nodeId: item.category.topNodeId,
        en: item.category.topEn,
        cn: item.category.topCn
      },
      match: {
        query: item.matchedQuery,
        reasons: item.reasons
      }
    }));

  if (categories.length === 0) {
    warnings.push('No matching SellerSprite category was found. Use all categories or a supported top-level category as fallback.');
  }

  return {
    success: true,
    command: 'search_sellersprite_categories',
    query,
    market: 'US',
    leafOnly,
    topCategory: topCategory || undefined,
    maxResults,
    expandedQueries,
    totalIndexedCategories: index.categories.length,
    categories,
    usage: 'Pick the most relevant nodeIdPath and pass it to run_sellersprite_research/build_sellersprite_url as nodeIdPaths, together with the original product filters.',
    warnings
  };
}

function toCategoryCandidate(category, rank = 1, extra = {}) {
  return {
    rank,
    nodeId: category.nodeId,
    nodeIdPath: category.nodeIdPath,
    enPath: category.enPath,
    cnPath: category.cnPath,
    depth: category.depth,
    isLeaf: category.isLeaf,
    productCount: category.productCount,
    topCategory: {
      nodeId: category.topNodeId,
      en: category.topEn,
      cn: category.topCn
    },
    ...extra
  };
}

function resolveSellerSpriteCategoryPath(options = {}) {
  const enPath = String(options.enPath || options.en_path || '').trim();
  const cnPath = String(options.cnPath || options.cn_path || '').trim();
  const query = String(options.query || options.text || '').trim();
  const topCategory = options.topCategory || options.top_category || options.categories || options.category;
  const index = loadCategoryIndex();
  const warnings = [];

  const normalizedEn = normalizeText(enPath);
  const normalizedCn = normalizeText(cnPath);
  const compactEn = normalizeCompactText(enPath);
  const compactCn = normalizeCompactText(cnPath);
  const normalizedQuery = normalizeText(query);
  const compactQuery = normalizeCompactText(query);
  const nodeIdPath = String(options.nodeIdPath || options.node_id_path || options.categoryNodeIdPath || '').trim();

  if (!normalizedEn && !normalizedCn && !normalizedQuery && !nodeIdPath) {
    return {
      success: false,
      command: 'resolve_sellersprite_category_path',
      error: 'Missing category path text. Pass enPath/cnPath, nodeIdPath, or query.',
      warnings
    };
  }

  const candidates = [];
  for (const category of index.categories) {
    if (!matchesTopCategory(category, topCategory)) continue;
    let match = null;
    let confidence = 0;

    if (nodeIdPath && category.nodeIdPath === nodeIdPath) {
      match = 'node_id_path_exact';
      confidence = 1;
    } else if (nodeIdPath && category.nodeId === nodeIdPath) {
      match = 'node_id_exact';
      confidence = 0.98;
    } else if (normalizedEn && category._normalizedEnPath === normalizedEn) {
      match = 'en_path_exact';
      confidence = 1;
    } else if (normalizedCn && category._normalizedCnPath === normalizedCn) {
      match = 'cn_path_exact';
      confidence = 1;
    } else if (compactEn && category._compactEnPath === compactEn) {
      match = 'en_path_compact_exact';
      confidence = 0.98;
    } else if (compactCn && category._compactCnPath === compactCn) {
      match = 'cn_path_compact_exact';
      confidence = 0.98;
    } else if (normalizedQuery && (category._normalizedEnPath === normalizedQuery || category._normalizedCnPath === normalizedQuery)) {
      match = 'query_path_exact';
      confidence = 0.95;
    } else if (compactQuery && (category._compactEnPath === compactQuery || category._compactCnPath === compactQuery)) {
      match = 'query_path_compact_exact';
      confidence = 0.93;
    }

    if (!match) continue;
    candidates.push({ category, match, confidence });
  }

  candidates.sort((a, b) =>
    b.confidence - a.confidence ||
    Number(b.category.isLeaf === true) - Number(a.category.isLeaf === true) ||
    Number(b.category.productCount || 0) - Number(a.category.productCount || 0)
  );

  if (candidates.length === 0) {
    warnings.push('No exact SellerSprite category path match was found. Fall back to search_sellersprite_categories with a product-shape query.');
    return {
      success: false,
      command: 'resolve_sellersprite_category_path',
      enPath: enPath || undefined,
      cnPath: cnPath || undefined,
      nodeIdPath: nodeIdPath || undefined,
      query: query || undefined,
      topCategory: topCategory || undefined,
      category: null,
      warnings
    };
  }

  const winner = candidates[0];
  if (candidates.length > 1) {
    warnings.push(`Multiple exact category matches found (${candidates.length}); selected the strongest leaf/product-count match.`);
  }

  return {
    success: true,
    command: 'resolve_sellersprite_category_path',
    enPath: enPath || undefined,
    cnPath: cnPath || undefined,
    nodeIdPath: nodeIdPath || undefined,
    query: query || undefined,
    topCategory: topCategory || undefined,
    category: toCategoryCandidate(winner.category, 1, {
      match: {
        type: winner.match,
        confidence: winner.confidence
      }
    }),
    alternatives: candidates.slice(1, 5).map((item, index) => toCategoryCandidate(item.category, index + 2, {
      match: {
        type: item.match,
        confidence: item.confidence
      }
    })),
    warnings
  };
}

function getSellerSpriteCategoryIndexInfo() {
  const index = loadCategoryIndex();
  return {
    source: index.source,
    generatedAt: index.generatedAt,
    totalCategories: index.categories.length,
    leafCategories: index.leafCategories,
    topCategories: index.topCategories
  };
}

module.exports = {
  searchSellerSpriteCategories,
  resolveSellerSpriteCategoryPath,
  getSellerSpriteCategoryIndexInfo
};
