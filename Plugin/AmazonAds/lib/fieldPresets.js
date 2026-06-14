const fs = require('fs');
const path = require('path');

const DEFAULT_PRESETS = {
  campaign_basic: {
    level: 'campaign',
    description: 'Campaign 基础站内广告表现。当前已验证 clicks/impressions。',
    verified_fields: [
      'date.value',
      'campaign.id',
      'campaign.name',
      'metric.clicks',
      'metric.impressions'
    ],
    candidate_fields: [
      'campaign.state',
      'campaign.budget',
      'budgetCurrency.value',
      'metric.orders',
      'metric.purchases',
      'metric.sales',
      'metric.spend',
      'metric.cost',
      'metric.totalCost',
      'metric.acos',
      'metric.roas',
      'metric.cpc',
      'metric.units',
      'metric.unitsSold',
      'metric.sameSkuUnits',
      'metric.otherSkuUnits',
      'metric.sameSkuSales',
      'metric.otherSkuSales'
    ]
  },
  placement_basic: {
    level: 'placement',
    description: 'Sponsored Products 广告位 / Campaign Placement 表现。官方 Reporting API v3 使用 campaignPlacement 分组与 placementClassification 列。',
    verified_fields: [
      'date.value',
      'campaign.id',
      'campaign.name',
      'placementClassification',
      'metric.clicks',
      'metric.impressions'
    ],
    candidate_fields: [
      'budgetCurrency.value',
      'metric.orders',
      'metric.purchases',
      'metric.sales',
      'metric.spend',
      'metric.cost',
      'metric.totalCost',
      'metric.acos',
      'metric.roas',
      'metric.cpc',
      'metric.units',
      'metric.unitsSold',
      'metric.sameSkuUnits',
      'metric.otherSkuUnits',
      'metric.sameSkuSales',
      'metric.otherSkuSales'
    ]
  },
  target_basic: {
    level: 'target',
    description: 'Target/关键词/商品投放表现。字段需通过当前 MCP 服务探测后再加入 verified_fields。',
    verified_fields: [
      'date.value',
      'campaign.id',
      'metric.clicks'
    ],
    candidate_fields: [
      'target.id',
      'target.name',
      'target.value',
      'target.expression',
      'target.matchType',
      'target.bid',
      'adGroup.id',
      'adGroup.name',
      'campaign.name',
      'budgetCurrency.value',
      'metric.impressions',
      'metric.orders',
      'metric.purchases',
      'metric.sales',
      'metric.spend',
      'metric.cost',
      'metric.totalCost',
      'metric.acos',
      'metric.roas',
      'metric.cpc',
      'metric.units',
      'metric.unitsSold',
      'metric.sameSkuUnits',
      'metric.otherSkuUnits',
      'metric.sameSkuSales',
      'metric.otherSkuSales'
    ]
  },
  search_term_basic: {
    level: 'search_term',
    description: '搜索词表现。当前没有独立 search term MCP 工具，需通过报表字段探测确认字段名。',
    verified_fields: [
      'date.value',
      'campaign.id',
      'metric.clicks'
    ],
    candidate_fields: [
      'searchTerm.value',
      'searchTerm.keyword',
      'searchTerm.text',
      'query.value',
      'customerSearchTerm.value',
      'target.id',
      'target.value',
      'target.matchType',
      'campaign.name',
      'adGroup.id',
      'adGroup.name',
      'budgetCurrency.value',
      'metric.impressions',
      'metric.orders',
      'metric.purchases',
      'metric.sales',
      'metric.spend',
      'metric.cost',
      'metric.totalCost',
      'metric.acos',
      'metric.roas',
      'metric.cpc',
      'metric.units',
      'metric.unitsSold',
      'metric.sameSkuUnits',
      'metric.otherSkuUnits',
      'metric.sameSkuSales',
      'metric.otherSkuSales'
    ]
  }
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergePreset(base, override = {}) {
  return {
    ...base,
    ...override,
    verified_fields: Array.from(new Set([
      ...(base.verified_fields || []),
      ...(override.verified_fields || [])
    ])),
    candidate_fields: Array.from(new Set([
      ...(base.candidate_fields || []),
      ...(override.candidate_fields || [])
    ])),
    last_probe: override.last_probe || base.last_probe || null
  };
}

function getPresetPath(runtimeConfig) {
  return path.resolve(runtimeConfig.stateDir || path.join(__dirname, '..', 'state'), 'report-field-presets.json');
}

function loadPresets(runtimeConfig) {
  const presetPath = getPresetPath(runtimeConfig);
  const merged = deepClone(DEFAULT_PRESETS);
  if (fs.existsSync(presetPath)) {
    const userPresets = JSON.parse(fs.readFileSync(presetPath, 'utf8'));
    for (const [name, preset] of Object.entries(userPresets || {})) {
      merged[name] = mergePreset(merged[name] || {}, preset);
    }
  }
  return { presetPath, presets: merged };
}

function savePresets(runtimeConfig, presets) {
  const presetPath = getPresetPath(runtimeConfig);
  ensureDir(path.dirname(presetPath));
  const tmp = `${presetPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(presets, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, presetPath);
  return presetPath;
}

function getPreset(runtimeConfig, presetName) {
  const { presetPath, presets } = loadPresets(runtimeConfig);
  const name = presetName || 'campaign_basic';
  const preset = presets[name];
  if (!preset) {
    throw new Error(`Unknown report preset: ${name}`);
  }
  return { name, presetPath, preset, presets };
}

function updatePresetProbe(runtimeConfig, presetName, probeResult) {
  const { presets } = loadPresets(runtimeConfig);
  const current = presets[presetName] || deepClone(DEFAULT_PRESETS[presetName] || {});
  const verified = new Set(current.verified_fields || []);
  for (const field of probeResult.success_fields || []) verified.add(field);
  for (const item of probeResult.success_details || []) {
    for (const field of item.tested_fields || []) verified.add(field);
  }
  for (const item of probeResult.failed_fields || []) {
    const code = item?.error?.code;
    if (['unknown_field', 'invalid_field_format', 'missing_dependent_field'].includes(code)) {
      verified.delete(item.field);
    }
  }
  current.verified_fields = Array.from(verified);
  current.last_probe = {
    timestamp: new Date().toISOString(),
    success_fields: probeResult.success_fields || [],
    failed_fields: probeResult.failed_fields || []
  };
  presets[presetName] = current;
  return savePresets(runtimeConfig, presets);
}

module.exports = {
  DEFAULT_PRESETS,
  getPreset,
  loadPresets,
  savePresets,
  updatePresetProbe
};
