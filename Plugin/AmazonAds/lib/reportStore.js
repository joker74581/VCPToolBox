const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const INDEX_VERSION = 1;
const DEFAULT_LIMIT = 20;
const DEFAULT_REPORT_COMMANDS = [
  'get_campaign_performance',
  'get_placement_performance',
  'get_target_performance',
  'get_search_term_performance',
  'create_report',
  'retrieve_report'
];
const REPORT_KIND_COMMANDS = {
  campaign: ['get_campaign_performance'],
  campaigns: ['get_campaign_performance'],
  plan: ['get_campaign_performance'],
  plans: ['get_campaign_performance'],
  placement: ['get_placement_performance'],
  placements: ['get_placement_performance'],
  campaign_placement: ['get_placement_performance'],
  keyword: ['get_target_performance'],
  keywords: ['get_target_performance'],
  target: ['get_target_performance'],
  targets: ['get_target_performance'],
  asin: ['get_target_performance'],
  product: ['get_target_performance'],
  keyword_report: ['get_search_term_performance', 'get_target_performance'],
  search_term: ['get_search_term_performance'],
  search_terms: ['get_search_term_performance'],
  searchterm: ['get_search_term_performance'],
  query: ['get_search_term_performance'],
  all: DEFAULT_REPORT_COMMANDS
};
const FIELD_ALIASES = {
  'date.value': ['date.value', 'date', 'dateValue', 'reportDate', 'timePeriodDate'],
  'campaign.id': ['campaign.id', 'campaignId', 'campaign_id', 'campaignID', 'campaign.resourceId'],
  'campaign.name': ['campaign.name', 'campaignName', 'campaign_name'],
  'placementClassification': ['placementClassification', 'placement.classification', 'placement', 'campaignPlacement', 'campaignPlacement.value', 'adPlacement', 'ad_placement', '广告位', '广告位置'],
  'adGroup.id': ['adGroup.id', 'adGroupId', 'ad_group_id', 'adgroupId'],
  'adGroup.name': ['adGroup.name', 'adGroupName', 'ad_group_name', 'adgroupName'],
  'target.id': ['target.id', 'targetId', 'target_id', 'keywordId', 'keyword.id'],
  'target.value': ['target.value', 'targetValue', 'target_value', 'keywordText', 'keyword.text', 'keyword', 'asin', 'targetingExpression'],
  'target.matchType': ['target.matchType', 'matchType', 'match_type', 'keywordMatchType'],
  'searchTerm.value': ['searchTerm.value', 'searchTerm', 'search_term', 'searchTermText', 'customerSearchTerm', 'customerSearchTerm.value', 'query', 'query.value'],
  'metric.impressions': ['metric.impressions', 'impressions', 'impressionCount'],
  'metric.clicks': ['metric.clicks', 'clicks', 'clickCount'],
  'metric.cost': ['metric.cost', 'metric.spend', 'metric.totalCost', 'cost', 'spend', 'adSpend', 'totalCost'],
  'metric.spend': ['metric.spend', 'metric.cost', 'metric.totalCost', 'spend', 'cost', 'adSpend', 'totalCost'],
  'metric.sales': ['metric.sales', 'sales', 'attributedSales', 'sales14d', 'sales7d'],
  'metric.orders': ['metric.orders', 'orders', 'purchases', 'conversions', 'orderCount', 'metric.purchases'],
  'metric.acos': ['metric.acos', 'acos', 'advertisingCostOfSales'],
  'metric.roas': ['metric.roas', 'roas', 'returnOnAdSpend'],
  'calculated.ctr': ['calculated.ctr', 'ctr', 'clickThroughRate'],
  'calculated.cpc': ['calculated.cpc', 'cpc', 'costPerClick'],
  'calculated.cvr': ['calculated.cvr', 'cvr', 'conversionRate'],
  'calculated.acos': ['calculated.acos', 'acosCalculated'],
  'calculated.roas': ['calculated.roas', 'roasCalculated']
};
const ADDITIVE_METRIC_FIELDS = [
  'metric.clicks',
  'metric.impressions',
  'metric.cost',
  'metric.sales',
  'metric.orders'
];
const DERIVED_METRIC_FIELDS = [
  'metric.cpc',
  'calculated.ctr',
  'calculated.cvr',
  'metric.acos',
  'metric.roas'
];
const DEFAULT_COMPACT_ROW_FIELDS = [
  'date.value',
  'campaign.name',
  'campaign.id',
  'placementClassification',
  'adGroup.name',
  'adGroup.id',
  'target.value',
  'target.matchType',
  'searchTerm.value',
  'budgetCurrency.value',
  'metric.impressions',
  'metric.clicks',
  'metric.cost',
  'metric.sales',
  'metric.orders',
  'metric.cpc',
  'calculated.ctr',
  'calculated.cvr',
  'metric.acos',
  'metric.roas'
];
const REPORT_TYPE_INFO = {
  get_campaign_performance: { kind: 'campaign', label: 'Campaign Performance', slug: 'campaign-performance' },
  get_placement_performance: { kind: 'placement', label: 'Campaign Placement Performance', slug: 'campaign-placement-performance' },
  get_target_performance: { kind: 'target', label: 'Target / Keyword Performance', slug: 'target-keyword-performance' },
  get_search_term_performance: { kind: 'search_term', label: 'Search Term Performance', slug: 'search-term-performance' },
  create_report: { kind: 'custom', label: 'Custom Report', slug: 'custom-report' },
  retrieve_report: { kind: 'retrieved', label: 'Retrieved Report', slug: 'retrieved-report' }
};

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      if (value[key] !== undefined) acc[key] = stableValue(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function shortHash(value, length = 12) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex').slice(0, length);
}

function safeFilePart(value) {
  return String(value || 'unknown')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unknown';
}

function periodLabel(period = {}) {
  const start = period?.startDate || 'unknown';
  const end = period?.endDate || start;
  return start === end ? start : `${start}_to_${end}`;
}

function reportTypeInfo(job = {}) {
  return REPORT_TYPE_INFO[job.command] || { kind: 'unknown', label: job.command || 'Report', slug: safeFilePart(job.command || 'report') };
}

function buildReportDisplayName(job = {}) {
  const info = reportTypeInfo(job);
  const account = job.account?.accountName || job.account?.adsAccountId || 'Account';
  return `${account} - ${info.label} - ${periodLabel(job.period)} - ${job.status || 'unknown'}`;
}

function buildReportSlug(job = {}) {
  const info = reportTypeInfo(job);
  const account = safeFilePart(job.account?.accountName || job.account?.adsAccountId || 'account');
  return `${account}-${periodLabel(job.period)}-${info.slug}`;
}

function normalizeFields(fields = []) {
  if (Array.isArray(fields)) return fields.map(String).map(item => item.trim()).filter(Boolean);
  if (typeof fields === 'string') return fields.split(',').map(item => item.trim()).filter(Boolean);
  return [];
}

function normalizeFieldToken(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function canonicalFieldName(field) {
  const token = normalizeFieldToken(field);
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    if (normalizeFieldToken(canonical) === token || aliases.some(alias => normalizeFieldToken(alias) === token)) {
      return canonical;
    }
  }
  return field;
}

function fieldAliasCandidates(field) {
  const canonical = canonicalFieldName(field);
  return Array.from(new Set([field, canonical, ...(FIELD_ALIASES[canonical] || [])])).filter(Boolean);
}

function resolveRowField(row, requestedField) {
  if (!row || typeof row !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(row, requestedField)) return requestedField;
  const keys = Object.keys(row);
  const byToken = new Map(keys.map(key => [normalizeFieldToken(key), key]));
  for (const candidate of fieldAliasCandidates(requestedField)) {
    const matched = byToken.get(normalizeFieldToken(candidate));
    if (matched) return matched;
  }
  return null;
}

function getRowValue(row, requestedField) {
  const resolved = resolveRowField(row, requestedField);
  return resolved ? row[resolved] : undefined;
}

function resolveFieldMap(rows = [], requestedFields = []) {
  const map = {};
  for (const field of requestedFields) {
    map[field] = null;
    for (const row of rows) {
      const resolved = resolveRowField(row, field);
      if (resolved) {
        map[field] = resolved;
        break;
      }
    }
  }
  return map;
}

function uniqueSortedFields(fields = []) {
  return Array.from(new Set(normalizeFields(fields))).sort((a, b) => a.localeCompare(b));
}

function getIndexPath(runtimeConfig) {
  return path.join(runtimeConfig.stateDir, 'report-jobs.json');
}

function getReportsRoot(runtimeConfig) {
  return path.join(runtimeConfig.stateDir, 'reports');
}

function loadIndex(runtimeConfig) {
  const indexPath = getIndexPath(runtimeConfig);
  const loaded = readJson(indexPath, null);
  if (loaded && Array.isArray(loaded.jobs)) return loaded;
  return {
    version: INDEX_VERSION,
    updatedAt: null,
    jobs: []
  };
}

function saveIndex(runtimeConfig, index) {
  const indexPath = getIndexPath(runtimeConfig);
  ensureDir(path.dirname(indexPath));
  const normalized = {
    version: INDEX_VERSION,
    updatedAt: nowIso(),
    jobs: Array.isArray(index.jobs) ? index.jobs : []
  };
  const tmpPath = `${indexPath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, indexPath);
  writeReportIndexes(runtimeConfig, normalized.jobs);
  return indexPath;
}

function writeReportIndexes(runtimeConfig, jobs = []) {
  const reportsRoot = getReportsRoot(runtimeConfig);
  ensureDir(reportsRoot);
  const sorted = [...jobs].sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  const lines = [
    '# Amazon Ads Report Index',
    '',
    '| Updated | Display Name | Type | Period | Status | Rows | Job ID | Directory |',
    '| --- | --- | --- | --- | --- | ---: | --- | --- |',
    ...sorted.map(job => [
      job.updatedAt || job.createdAt || '',
      buildReportDisplayName(job),
      reportTypeInfo(job).label,
      `${job.period?.startDate || ''} to ${job.period?.endDate || ''}`,
      job.status || '',
      job.row_count || 0,
      job.jobId || '',
      job.artifactDir || ''
    ].map(value => String(value).replace(/\|/g, '\\|')).join(' | ')).map(row => `| ${row} |`)
  ];
  fs.writeFileSync(path.join(reportsRoot, 'INDEX.md'), `${lines.join('\n')}\n`, 'utf8');

  const byMonth = new Map();
  for (const job of sorted) {
    if (!job.artifactDir) continue;
    const monthDir = path.dirname(job.artifactDir);
    if (!byMonth.has(monthDir)) byMonth.set(monthDir, []);
    byMonth.get(monthDir).push(job);
  }
  for (const [monthDir, monthJobs] of byMonth.entries()) {
    ensureDir(monthDir);
    const monthLines = [
      '# Amazon Ads Monthly Report Index',
      '',
      '| Updated | Display Name | Type | Period | Status | Rows | Job ID | Directory |',
      '| --- | --- | --- | --- | --- | ---: | --- | --- |',
      ...monthJobs.map(job => [
        job.updatedAt || job.createdAt || '',
        buildReportDisplayName(job),
        reportTypeInfo(job).label,
        `${job.period?.startDate || ''} to ${job.period?.endDate || ''}`,
        job.status || '',
        job.row_count || 0,
        job.jobId || '',
        job.artifactDir || ''
      ].map(value => String(value).replace(/\|/g, '\\|')).join(' | ')).map(row => `| ${row} |`)
    ];
    fs.writeFileSync(path.join(monthDir, 'INDEX.md'), `${monthLines.join('\n')}\n`, 'utf8');
  }
}

function buildReportJobKey({ command, account, preset, period, fields }) {
  return shortHash({
    command,
    preset,
    account: {
      adsAccountId: account?.adsAccountId || account?.accountId || null,
      marketplace: account?.marketplace || null
    },
    period: {
      startDate: period?.startDate || null,
      endDate: period?.endDate || null
    },
    fields: uniqueSortedFields(fields)
  }, 24);
}

function buildJobId(createdAt, seed) {
  const stamp = String(createdAt || nowIso()).replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${stamp}-${shortHash(seed || createdAt, 10)}`;
}

function buildArtifactDir(runtimeConfig, job) {
  const created = new Date(job.createdAt || nowIso());
  const year = String(created.getUTCFullYear());
  const month = String(created.getUTCMonth() + 1).padStart(2, '0');
  return path.join(getReportsRoot(runtimeConfig), year, month, `${job.jobId}-${buildReportSlug(job)}`);
}

function sanitizeDownload(download = {}) {
  const copy = { ...download };
  if (Array.isArray(copy.rows)) {
    copy.rows = copy.rows.map(enrichCalculatedMetrics);
    copy.row_summary = summarizeRows(copy.rows);
  } else if (Array.isArray(copy.rows_preview) && copy.row_summary) {
    copy.rows_preview = copy.rows_preview.map(enrichCalculatedMetrics);
  }
  delete copy.artifact_rows;
  delete copy.artifact_text;
  return copy;
}

function sanitizeDownloads(downloads = []) {
  return (downloads || []).map(sanitizeDownload);
}

function collectArtifactRows(downloads = []) {
  const rows = [];
  for (const download of downloads || []) {
    const sourceRows = Array.isArray(download.artifact_rows)
      ? download.artifact_rows
      : (Array.isArray(download.rows) ? download.rows : []);
    for (const row of sourceRows) rows.push(row);
  }
  return rows;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundMetric(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function addDerivedTotals(totals) {
  const clicks = safeNumber(totals['metric.clicks']);
  const impressions = safeNumber(totals['metric.impressions']);
  const cost = safeNumber(totals['metric.cost']);
  const sales = safeNumber(totals['metric.sales']);
  const orders = safeNumber(totals['metric.orders']);

  if (cost !== null && clicks > 0) totals['metric.cpc'] = roundMetric(cost / clicks, 6);
  if (clicks !== null && impressions > 0) totals['calculated.ctr'] = roundMetric(clicks / impressions, 6);
  if (orders !== null && clicks > 0) totals['calculated.cvr'] = roundMetric(orders / clicks, 6);
  if (cost !== null && sales > 0) totals['metric.acos'] = roundMetric(cost / sales, 6);
  if (sales !== null && cost > 0) totals['metric.roas'] = roundMetric(sales / cost, 6);

  return totals;
}

function summarizeMetricRow(row, totals) {
  for (const field of ADDITIVE_METRIC_FIELDS) {
    const value = Number(getRowValue(row, field));
    if (Number.isFinite(value)) totals[field] = (totals[field] || 0) + value;
  }
}

function enrichCalculatedMetrics(row = {}) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  
  const impressions = safeNumber(getRowValue(row, 'metric.impressions'));
  const clicks = safeNumber(getRowValue(row, 'metric.clicks'));
  let spend = safeNumber(getRowValue(row, 'metric.spend')) ?? safeNumber(getRowValue(row, 'metric.cost'));
  const sales = safeNumber(getRowValue(row, 'metric.sales'));
  const orders = safeNumber(getRowValue(row, 'metric.orders'));
  const roas = safeNumber(getRowValue(row, 'metric.roas'));
  const cpc = safeNumber(getRowValue(row, 'metric.cpc'));

  if (spend === null && sales !== null && roas > 0) {
    spend = roundMetric(sales / roas, 4);
  }

  if (spend !== null) {
    if (!Object.prototype.hasOwnProperty.call(out, 'metric.spend')) out['metric.spend'] = spend;
    if (!Object.prototype.hasOwnProperty.call(out, 'metric.cost')) out['metric.cost'] = spend;
    if (!Object.prototype.hasOwnProperty.call(out, 'metric.totalCost')) out['metric.totalCost'] = spend;
  }
  if (orders !== null) {
    if (!Object.prototype.hasOwnProperty.call(out, 'metric.orders')) out['metric.orders'] = orders;
    if (!Object.prototype.hasOwnProperty.call(out, 'metric.purchases')) out['metric.purchases'] = orders;
  }
  if (clicks !== null) {
    if (!Object.prototype.hasOwnProperty.call(out, 'metric.clicks')) out['metric.clicks'] = clicks;
  }
  if (impressions !== null) {
    if (!Object.prototype.hasOwnProperty.call(out, 'metric.impressions')) out['metric.impressions'] = impressions;
  }

  let finalCpc = cpc;
  if (finalCpc === null && clicks > 0 && spend !== null) {
    finalCpc = roundMetric(spend / clicks, 4);
  }
  if (finalCpc !== null) {
    out['metric.cpc'] = finalCpc;
    out['calculated.cpc'] = finalCpc;
  }

  if (impressions > 0 && clicks !== null) {
    out['calculated.ctr'] = roundMetric(clicks / impressions);
  }
  if (clicks > 0 && orders !== null) {
    out['calculated.cvr'] = roundMetric(orders / clicks);
  }
  
  let finalAcos = safeNumber(getRowValue(row, 'metric.acos'));
  if (finalAcos === null && sales > 0 && spend !== null) {
    finalAcos = roundMetric(spend / sales);
  }
  if (finalAcos !== null) {
    out['metric.acos'] = finalAcos;
    out['calculated.acos'] = finalAcos;
  }

  let finalRoas = roas;
  if (finalRoas === null && spend > 0 && sales !== null) {
    finalRoas = roundMetric(sales / spend, 4);
  }
  if (finalRoas !== null) {
    out['metric.roas'] = finalRoas;
    out['calculated.roas'] = finalRoas;
  }

  // Inject friendly alias keys directly at root level
  if (out['metric.spend'] !== undefined) {
    out.spend = out['metric.spend'];
    out.cost = out['metric.spend'];
  }
  if (out['metric.orders'] !== undefined) {
    out.orders = out['metric.orders'];
    out.purchases = out['metric.orders'];
  }
  if (out['metric.clicks'] !== undefined) out.clicks = out['metric.clicks'];
  if (out['metric.impressions'] !== undefined) out.impressions = out['metric.impressions'];
  if (out['metric.sales'] !== undefined) out.sales = out['metric.sales'];
  if (out['metric.cpc'] !== undefined) out.cpc = out['metric.cpc'];
  if (out['calculated.cpc'] !== undefined) out.cpc = out['calculated.cpc'];
  if (out['metric.acos'] !== undefined) out.acos = out['metric.acos'];
  if (out['calculated.acos'] !== undefined) out.acos = out['calculated.acos'];
  if (out['metric.roas'] !== undefined) out.roas = out['metric.roas'];
  if (out['calculated.roas'] !== undefined) out.roas = out['calculated.roas'];
  if (out['calculated.ctr'] !== undefined) out.ctr = out['calculated.ctr'];
  if (out['calculated.cvr'] !== undefined) out.cvr = out['calculated.cvr'];

  return out;
}

function summarizeRows(rows = []) {
  const totals = {};
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    summarizeMetricRow(row, totals);
  }
  return {
    row_count: rows.length,
    totals: addDerivedTotals(totals)
  };
}

function stringifyTotals(totals = {}) {
  const entries = Object.entries(totals);
  if (!entries.length) return '- None detected in downloaded rows';
  return entries.map(([key, value]) => `- ${key}: ${Number(value.toFixed ? value.toFixed(4) : value)}`).join('\n');
}

function buildSummaryMarkdown(job, rowSummary, artifactPaths) {
  const warnings = Array.isArray(job.warnings) && job.warnings.length
    ? job.warnings.map(item => `- ${item}`).join('\n')
    : '- None';
  const fields = (job.used_fields || []).map(field => `- ${field}`).join('\n') || '- None recorded';
  const nextActions = [
    job.status && String(job.status).toUpperCase().includes('DOWNLOAD_FAILED')
      ? `- Retry continue_report_job with jobId=${job.jobId}; the Amazon report completed but the downloadable file was not fetched.`
      : job.status && ['PENDING', 'PROCESSING'].includes(job.status)
      ? `- Later call continue_report_job with jobId=${job.jobId}; do not create a duplicate report.`
      : `- Use read_report_artifact with jobId=${job.jobId} and artifact=rows to inspect paginated rows.`,
    `- Use export_report_artifact with jobId=${job.jobId} and format=xlsx for a human-readable spreadsheet.`,
    '- Use list_report_jobs before creating a similar report in a later conversation.'
  ].join('\n');
  return [
    `# Amazon Ads Report ${job.jobId}`,
    '',
    `- Display Name: ${buildReportDisplayName(job)}`,
    `- Report Type: ${reportTypeInfo(job).label}`,
    `- Command: ${job.command || 'unknown'}`,
    `- Preset: ${job.preset || 'unknown'}`,
    `- Status: ${job.status || 'unknown'}`,
    `- Report ID: ${job.reportId || 'not created'}`,
    `- Account: ${job.account?.accountName || 'unknown'} (${job.account?.adsAccountId || 'unknown'})`,
    `- Marketplace: ${job.account?.marketplace || 'unknown'}`,
    `- Period: ${job.period?.startDate || 'unknown'} to ${job.period?.endDate || 'unknown'}`,
    `- Created At: ${job.createdAt || 'unknown'}`,
    `- Updated At: ${job.updatedAt || 'unknown'}`,
    `- Downloaded Rows Stored: ${rowSummary.row_count || 0}`,
    `- Download Truncated: ${job.truncated ? 'yes' : 'no'}`,
    '',
    '## Fields',
    fields,
    '',
    '## Totals',
    stringifyTotals(rowSummary.totals),
    '',
    '## Warnings',
    warnings,
    '',
    '## Artifacts',
    `- metadata: ${artifactPaths.metadata || 'pending'}`,
    `- request: ${artifactPaths.request || 'pending'}`,
    `- report: ${artifactPaths.report || 'pending'}`,
    `- downloads: ${artifactPaths.downloads || 'pending'}`,
    `- rows: ${artifactPaths.rows || 'pending'}`,
    `- readme: ${artifactPaths.readme || 'pending'}`,
    `- excel: ${artifactPaths.excel || 'not exported yet'}`,
    `- csv: ${artifactPaths.csv || 'not exported yet'}`,
    '',
    '## Next Actions',
    nextActions,
    ''
  ].join('\n');
}

function buildReadmeMarkdown(job, rowSummary, artifactPaths) {
  const totals = rowSummary?.totals || {};
  return [
    `# ${buildReportDisplayName(job)}`,
    '',
    `- Job ID: ${job.jobId}`,
    `- Report ID: ${job.reportId || 'not created'}`,
    `- Type: ${reportTypeInfo(job).label}`,
    `- Account: ${job.account?.accountName || 'unknown'}`,
    `- Marketplace: ${job.account?.marketplace || 'unknown'}`,
    `- Period: ${job.period?.startDate || 'unknown'} to ${job.period?.endDate || 'unknown'}`,
    `- Status: ${job.status || 'unknown'}`,
    `- Rows: ${rowSummary?.row_count || 0}`,
    '',
    '## Totals',
    stringifyTotals(totals),
    '',
    '## How Agent Should Read This',
    `- First call read_report_artifact jobId=${job.jobId} artifact=summary.`,
    `- For row-level analysis, call read_report_artifact jobId=${job.jobId} artifact=rows.`,
    `- For totals/ranking, call aggregate_report_archives with the requested groupBy and metrics.`,
    '- Do not read downloads.json for business analysis; it is a raw/debug archive.',
    '',
    '## Files',
    `- Summary: ${artifactPaths.summary || 'pending'}`,
    `- Compact rows source: ${artifactPaths.rows || 'pending'}`,
    `- Excel export: ${artifactPaths.excel || 'run export_report_artifact'}`,
    `- CSV export: ${artifactPaths.csv || 'run export_report_artifact'}`,
    `- Raw downloads: ${artifactPaths.downloads || 'pending'}`
  ].join('\n');
}

function downloadWarnings(downloads = []) {
  const failures = (downloads || []).filter(download => download?.error);
  if (!failures.length) return [];
  return [
    `Report download failed for ${failures.length}/${downloads.length || failures.length} file part(s). Do not interpret row_count=0 as no data until a download succeeds.`,
    ...failures.slice(0, 3).map(download => `Download error: ${download.error}`)
  ];
}

function writeRowsJsonl(filePath, rows = []) {
  ensureDir(path.dirname(filePath));
  const content = rows.map(row => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, content ? `${content}\n` : '', 'utf8');
}

function writeArtifacts(runtimeConfig, job, artifacts = {}) {
  const dir = job.artifactDir || buildArtifactDir(runtimeConfig, job);
  ensureDir(dir);

  const artifactPaths = {
    metadata: path.join(dir, 'metadata.json'),
    request: path.join(dir, 'request.json'),
    report: path.join(dir, 'report.json'),
    downloads: path.join(dir, 'downloads.json'),
    rows: path.join(dir, 'rows.jsonl'),
    summary: path.join(dir, 'summary.md'),
    readme: path.join(dir, 'README.md'),
    excel: path.join(dir, `${buildReportSlug(job)}.xlsx`),
    csv: path.join(dir, `${buildReportSlug(job)}.csv`)
  };

  if (artifacts.request !== undefined) writeJson(artifactPaths.request, artifacts.request);
  if (artifacts.report !== undefined || artifacts.rawResult !== undefined) {
    writeJson(artifactPaths.report, {
      report: artifacts.report || null,
      raw_result: artifacts.rawResult || null
    });
  }
  if (artifacts.downloads !== undefined) writeJson(artifactPaths.downloads, sanitizeDownloads(artifacts.downloads));

  const rows = collectArtifactRows(artifacts.downloads || []).map(enrichCalculatedMetrics);
  if (artifacts.downloads !== undefined) writeRowsJsonl(artifactPaths.rows, rows);
  const rowSummary = rows.length > 0 ? summarizeRows(rows) : (job.row_summary || { row_count: 0, totals: {} });
  const truncated = (artifacts.downloads || []).some(download => download?.truncated);
  const warnings = Array.from(new Set([
    ...(job.warnings || []),
    ...downloadWarnings(artifacts.downloads || [])
  ]));

  const updatedJob = {
    ...job,
    artifactDir: dir,
    artifact_paths: artifactPaths,
    row_count: rowSummary.row_count,
    row_summary: rowSummary,
    download_count: artifacts.downloads ? artifacts.downloads.length : (job.download_count || 0),
    truncated: truncated || Boolean(job.truncated),
    warnings
  };

  fs.writeFileSync(artifactPaths.summary, buildSummaryMarkdown(updatedJob, rowSummary, artifactPaths), 'utf8');
  fs.writeFileSync(artifactPaths.readme, buildReadmeMarkdown(updatedJob, rowSummary, artifactPaths), 'utf8');
  writeJson(artifactPaths.metadata, {
    generatedAt: nowIso(),
    job: updatedJob,
    row_summary: rowSummary,
    truncated: updatedJob.truncated,
    error: artifacts.error || job.error || null
  });
  return updatedJob;
}

function mergeDefined(base, patch) {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value !== undefined) next[key] = value;
  }
  return next;
}

function upsertReportJob(runtimeConfig, patch = {}, artifacts = {}) {
  const index = loadIndex(runtimeConfig);
  const now = nowIso();
  let jobIndex = -1;
  if (patch.jobId) jobIndex = index.jobs.findIndex(job => job.jobId === patch.jobId);
  if (jobIndex < 0 && patch.jobKey) jobIndex = index.jobs.findIndex(job => job.jobKey === patch.jobKey);
  if (jobIndex < 0 && patch.reportId && !patch.jobKey) {
    jobIndex = index.jobs.findIndex(job => job.reportId === patch.reportId);
  }
  const existing = jobIndex >= 0 ? index.jobs[jobIndex] : null;
  const createdAt = existing?.createdAt || patch.createdAt || now;
  const seed = patch.jobKey || patch.reportId || patch.command || createdAt;
  const initial = existing || {
    jobId: patch.jobId || buildJobId(createdAt, seed),
    createdAt,
    artifactDir: null,
    artifact_paths: {}
  };
  let job = mergeDefined(initial, {
    ...patch,
    createdAt,
    updatedAt: now
  });
  job.artifactDir = job.artifactDir || buildArtifactDir(runtimeConfig, job);
  job = writeArtifacts(runtimeConfig, job, artifacts);
  if (jobIndex >= 0) index.jobs[jobIndex] = job;
  else index.jobs.push(job);
  saveIndex(runtimeConfig, index);
  return {
    job,
    indexPath: getIndexPath(runtimeConfig),
    artifactDir: job.artifactDir
  };
}

function compactJob(job) {
  const type = reportTypeInfo(job);
  return {
    jobId: job.jobId,
    display_name: buildReportDisplayName(job),
    report_type: type.kind,
    report_type_label: type.label,
    jobKey: job.jobKey,
    command: job.command,
    preset: job.preset,
    status: job.status,
    reportId: job.reportId,
    account: job.account,
    period: job.period,
    used_fields: job.used_fields,
    row_count: job.row_count || 0,
    row_summary: job.row_summary || { row_count: job.row_count || 0, totals: {} },
    download_count: job.download_count || 0,
    truncated: Boolean(job.truncated),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    artifact_paths: job.artifact_paths || {}
  };
}

function filterJobs(jobs, filters = {}) {
  const status = filters.status && String(filters.status).toUpperCase() !== 'ALL' ? String(filters.status).toUpperCase() : null;
  const command = filters.command ? String(filters.command) : null;
  const preset = filters.preset ? String(filters.preset) : null;
  const marketplace = filters.marketplace ? String(filters.marketplace).toUpperCase() : null;
  const accountName = filters.accountName || filters.account_name ? String(filters.accountName || filters.account_name).toLowerCase() : null;
  const reportId = filters.reportId || filters.report_id ? String(filters.reportId || filters.report_id) : null;
  const jobId = filters.jobId || filters.job_id ? String(filters.jobId || filters.job_id) : null;
  const jobKey = filters.jobKey || filters.job_key ? String(filters.jobKey || filters.job_key) : null;
  const startDate = filters.startDate || filters.start_date || filters.dateFrom || filters.date_from || null;
  const endDate = filters.endDate || filters.end_date || filters.dateTo || filters.date_to || null;

  return jobs.filter(job => {
    if (jobId && job.jobId !== jobId) return false;
    if (jobKey && job.jobKey !== jobKey) return false;
    if (reportId && job.reportId !== reportId) return false;
    if (status && String(job.status || '').toUpperCase() !== status) return false;
    if (command && job.command !== command) return false;
    if (preset && job.preset !== preset) return false;
    if (marketplace && String(job.account?.marketplace || '').toUpperCase() !== marketplace) return false;
    if (accountName && !String(job.account?.accountName || '').toLowerCase().includes(accountName)) return false;
    if (startDate && String(job.period?.endDate || '') < String(startDate)) return false;
    if (endDate && String(job.period?.startDate || '') > String(endDate)) return false;
    return true;
  });
}

function normalizeReportKind(value) {
  const raw = String(value || 'all').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (/计划|广告活动|campaign/.test(raw)) return 'campaign';
  if (/广告位|广告位置|placement|campaign_placement/.test(raw)) return 'placement';
  if (/搜索词|search/.test(raw)) return 'search_term';
  if (/关键词报表|关键字报表|keyword_report/.test(raw)) return 'keyword_report';
  if (/关键词|关键字|keyword/.test(raw)) return 'keyword';
  if (/target|asin|商品投放/.test(raw)) return 'keyword';
  return REPORT_KIND_COMMANDS[raw] ? raw : 'all';
}

function commandsForReportKind(reportKind) {
  return REPORT_KIND_COMMANDS[normalizeReportKind(reportKind)] || DEFAULT_REPORT_COMMANDS;
}

function parseFieldList(value, fallback = []) {
  if (Array.isArray(value)) return value.map(String).map(item => item.trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return value.split(',').map(item => item.trim()).filter(Boolean);
  return fallback;
}

function dateRangeFromArgs(args = {}) {
  return {
    startDate: args.dateFrom || args.date_from || args.startDate || args.start_date || null,
    endDate: args.dateTo || args.date_to || args.endDate || args.end_date || null
  };
}

function overlapsRequestedRange(job, args = {}) {
  const { startDate, endDate } = dateRangeFromArgs(args);
  if (startDate && String(job.period?.endDate || '') < String(startDate)) return false;
  if (endDate && String(job.period?.startDate || '') > String(endDate)) return false;
  return true;
}

function inferReportKind(job) {
  if (job.command === 'get_campaign_performance') return 'campaign';
  if (job.command === 'get_placement_performance') return 'placement';
  if (job.command === 'get_target_performance') return 'keyword';
  if (job.command === 'get_search_term_performance') return 'search_term';
  const fields = (job.used_fields || []).join(' ').toLowerCase();
  if (/placementclassification|campaignplacement|placement\./.test(fields)) return 'placement';
  if (/searchterm|customersearchterm|query\./.test(fields)) return 'search_term';
  if (/target\.|adgroup\.|keyword|asin/.test(fields)) return 'keyword';
  if (/campaign\./.test(fields)) return 'campaign';
  return 'unknown';
}

function hasRequiredFields(job, requiredFields = []) {
  if (!requiredFields.length) return true;
  const fields = new Set((job.used_fields || []).flatMap(field =>
    fieldAliasCandidates(field).map(item => normalizeFieldToken(item))
  ));
  return requiredFields.every(field =>
    fieldAliasCandidates(field).some(candidate => fields.has(normalizeFieldToken(candidate)))
  );
}

function sortJobsForArchive(a, b) {
  const statusScore = status => String(status || '').toUpperCase() === 'COMPLETED' ? 2 : 1;
  const scoreDiff = statusScore(b.status) - statusScore(a.status);
  if (scoreDiff) return scoreDiff;
  const rowDiff = Number(b.row_count || 0) - Number(a.row_count || 0);
  if (rowDiff) return rowDiff;
  return String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt));
}

function dedupeJobs(jobs = []) {
  const groups = new Map();
  for (const job of jobs) {
    const key = job.jobKey || `${job.command}|${job.reportId || job.jobId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  const selected = [];
  const duplicates = [];
  for (const groupJobs of groups.values()) {
    const sorted = groupJobs.slice().sort(sortJobsForArchive);
    selected.push(sorted[0]);
    duplicates.push(...sorted.slice(1));
  }
  return {
    selected: selected.sort(sortJobsForArchive),
    duplicates
  };
}

function findArchives(runtimeConfig, args = {}) {
  const reportKind = normalizeReportKind(args.reportKind || args.report_kind || args.kind || args.type);
  const commands = args.reportCommand || args.report_command || args.commandFilter || args.command_filter
    ? [String(args.reportCommand || args.report_command || args.commandFilter || args.command_filter)]
    : commandsForReportKind(reportKind);
  const rawStatus = args.status === undefined || args.status === null || args.status === '' ? 'COMPLETED' : args.status;
  const status = String(rawStatus).toUpperCase() === 'ALL' ? null : rawStatus;
  const requiredFields = parseFieldList(args.requiredFields || args.required_fields, []);
  const index = loadIndex(runtimeConfig);
  const candidates = index.jobs
    .filter(job => commands.includes(job.command))
    .filter(job => !status || String(job.status || '').toUpperCase() === String(status).toUpperCase())
    .filter(job => overlapsRequestedRange(job, args))
    .filter(job => hasRequiredFields(job, requiredFields))
    .filter(job => {
      const marketplace = args.marketplace ? String(args.marketplace).toUpperCase() : null;
      if (marketplace && String(job.account?.marketplace || '').toUpperCase() !== marketplace) return false;
      const accountName = args.accountName || args.account_name ? String(args.accountName || args.account_name).toLowerCase() : null;
      if (accountName && !String(job.account?.accountName || '').toLowerCase().includes(accountName)) return false;
      return true;
  });
  const deduped = dedupeJobs(candidates);
  const requestedLimit = args.limit;
  const hasLimit = requestedLimit !== undefined && requestedLimit !== null && requestedLimit !== '';
  const limit = hasLimit ? Math.max(Math.floor(Number(requestedLimit)) || 0, 0) : undefined;
  const selected = limit === undefined ? deduped.selected : deduped.selected.slice(0, limit);
  return {
    indexPath: getIndexPath(runtimeConfig),
    reportKind,
    requestedRange: dateRangeFromArgs(args),
    commands,
    total_candidates: candidates.length,
    duplicate_count: deduped.duplicates.length,
    count: selected.length,
    jobs: selected.map(job => ({
      ...compactJob(job),
      inferred_report_kind: inferReportKind(job)
    })),
    duplicates: deduped.duplicates.slice(0, limit).map(compactJob)
  };
}

function readSummaryText(job) {
  const filePath = job.artifact_paths?.summary;
  if (!filePath || !fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
}

function readAllRowsForJob(job, limit) {
  const filePath = job.artifact_paths?.rows;
  if (!filePath || !fs.existsSync(filePath)) return [];
  const hasLimit = limit !== undefined && limit !== null && limit !== '';
  const safeLimit = hasLimit ? Math.max(Math.floor(Number(limit)) || 0, 0) : null;
  if (hasLimit && safeLimit <= 0) return [];
  const rows = [];
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  const selectedLines = hasLimit ? lines.slice(0, safeLimit) : lines;
  for (const line of selectedLines) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      rows.push({ parse_error: true, raw: line });
    }
  }
  return rows;
}

function rowWithinRequestedRange(row, args = {}) {
  const { startDate, endDate } = dateRangeFromArgs(args);
  const rowDate = getRowValue(row, 'date.value');
  if (!rowDate) return true;
  if (startDate && String(rowDate) < String(startDate)) return false;
  if (endDate && String(rowDate) > String(endDate)) return false;
  return true;
}

function rowFingerprint(row) {
  return JSON.stringify(stableValue(row));
}

function mergeTotals(target, totals = {}) {
  for (const field of ADDITIVE_METRIC_FIELDS) {
    const value = Number(totals[field]);
    if (Number.isFinite(value)) {
      target[field] = (target[field] || 0) + value;
      continue;
    }
    for (const alias of FIELD_ALIASES[field] || []) {
      const aliasValue = Number(totals[alias]);
      if (Number.isFinite(aliasValue)) {
        target[field] = (target[field] || 0) + aliasValue;
        break;
      }
    }
  }
  return addDerivedTotals(target);
}

function selectRowFields(row, fields) {
  if (!fields.length) return row;
  const out = {};
  for (const field of fields) {
    const value = getRowValue(row, field);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

function isFalseyOption(value) {
  return value === false || /^(false|0|no|off|raw|full)$/i.test(String(value || ''));
}

function shouldCompactRows(args = {}) {
  if (Object.prototype.hasOwnProperty.call(args, 'compact') && isFalseyOption(args.compact)) return false;
  if (Object.prototype.hasOwnProperty.call(args, 'compact_rows') && isFalseyOption(args.compact_rows)) return false;
  if (args.raw === true || args.raw_rows === true || args.includeAliases === true || args.include_aliases === true) return false;
  const format = String(args.format || args.view || '').toLowerCase();
  return !['raw', 'full', 'debug'].includes(format);
}

function compactRow(row, fields = DEFAULT_COMPACT_ROW_FIELDS) {
  const out = {};
  for (const field of fields) {
    const canonical = canonicalFieldName(field);
    const value = getRowValue(row, canonical);
    if (value !== undefined) out[canonical] = value;
  }
  return out;
}

function compactRows(rows = [], fields = DEFAULT_COMPACT_ROW_FIELDS) {
  return rows.map(row => compactRow(row, fields));
}

function summarizeDownloadForArtifact(download = {}, index = 0) {
  const rowSummary = download.row_summary || summarizeRows(download.rows || []);
  return {
    index,
    http_status: download.http_status,
    bytes: download.bytes,
    truncated: Boolean(download.truncated),
    row_count: rowSummary.row_count || (Array.isArray(download.rows) ? download.rows.length : 0),
    row_summary: rowSummary
  };
}

function buildReportContext(runtimeConfig, args = {}) {
  const archives = findArchives(runtimeConfig, args);
  const requestedRowLimit = args.limitRowsPerJob ?? args.limit_rows_per_job;
  const hasRowLimit = requestedRowLimit !== undefined && requestedRowLimit !== null && requestedRowLimit !== '';
  const rowLimitPerJob = hasRowLimit ? Math.max(Math.floor(Number(requestedRowLimit)) || 0, 0) : undefined;
  const includeRows = args.includeRows === true || args.includeRows === 'true' || String(args.mode || '').includes('rows');
  const compact = shouldCompactRows(args);
  const selectFields = parseFieldList(args.selectFields || args.select_fields, compact ? DEFAULT_COMPACT_ROW_FIELDS : []);
  const totals = {};
  const reports = [];
  let rowsIncluded = 0;
  const warnings = [];

  for (const job of archives.jobs) {
    mergeTotals(totals, job.row_summary?.totals);
    const rows = includeRows
      ? readAllRowsForJob(job, rowLimitPerJob)
        .filter(row => rowWithinRequestedRange(row, args))
        .map(row => selectRowFields(row, selectFields))
      : [];
    const sourceRowsForMap = includeRows ? rows : readAllRowsForJob(job, 25);
    const requestedFieldsForMap = selectFields.length ? selectFields : job.used_fields || [];
    rowsIncluded += rows.length;
    reports.push({
      jobId: job.jobId,
      reportId: job.reportId,
      reportKind: job.inferred_report_kind,
      command: job.command,
      preset: job.preset,
      status: job.status,
      period: job.period,
      fields: job.used_fields,
      row_count: job.row_count,
      row_summary: job.row_summary,
      truncated: job.truncated,
      field_mapping: resolveFieldMap(sourceRowsForMap, requestedFieldsForMap),
      summary: readSummaryText(job).slice(0, 6000),
      rows
    });
  }

  if (archives.duplicate_count > 0) warnings.push(`${archives.duplicate_count} duplicate archived report job(s) were excluded by jobKey.`);
  if (archives.jobs.some(job => job.truncated)) warnings.push('One or more archives are truncated by AMAZON_ADS_MAX_DOWNLOAD_BYTES.');
  const requestedRange = dateRangeFromArgs(args);
  if (requestedRange.startDate || requestedRange.endDate) {
    const widerJobs = archives.jobs.filter(job =>
      (requestedRange.startDate && String(job.period?.startDate || '') < String(requestedRange.startDate))
      || (requestedRange.endDate && String(job.period?.endDate || '') > String(requestedRange.endDate))
    );
    if (widerJobs.length && !includeRows) {
      warnings.push('Some archive summaries cover a wider period than requested. Use mode=summary_with_rows or aggregate_report_archives for date-filtered row analysis.');
    }
  }
  if (archives.jobs.length === 0) warnings.push('No matching completed archives were found. Use list_report_jobs or create/continue the needed report first.');

  return {
    ...archives,
    context: {
      mode: includeRows ? 'summary_with_rows' : 'summary_only',
      row_limit_per_job: rowLimitPerJob,
      row_format: compact ? 'compact' : 'raw',
      rows_included: rowsIncluded,
      reports,
      merged_totals: totals,
      warnings
    }
  };
}

function parseMetricFields(args = {}, rows = []) {
  const requested = parseFieldList(args.metrics || args.metricFields || args.metric_fields, []).map(canonicalFieldName);
  if (requested.length) return Array.from(new Set(requested));
  const discovered = new Set();
  for (const row of rows) {
    for (const field of ADDITIVE_METRIC_FIELDS) {
      if (getRowValue(row, field) !== undefined) discovered.add(field);
    }
  }
  return Array.from(discovered).concat(DERIVED_METRIC_FIELDS.filter(field => discovered.size > 0));
}

function aggregateRows(rows, groupBy, metrics) {
  const groups = new Map();
  const additiveMetrics = metrics.filter(metric => ADDITIVE_METRIC_FIELDS.includes(metric));
  const derivedMetrics = metrics.filter(metric => DERIVED_METRIC_FIELDS.includes(metric));
  for (const row of rows) {
    const groupKey = groupBy.map(field => String(getRowValue(row, field) ?? '')).join('|');
    if (!groups.has(groupKey)) {
      const base = {};
      for (const field of groupBy) base[field] = getRowValue(row, field) ?? null;
      for (const metric of additiveMetrics) base[metric] = 0;
      base.row_count = 0;
      groups.set(groupKey, base);
    }
    const target = groups.get(groupKey);
    target.row_count += 1;
    for (const metric of additiveMetrics) {
      const value = Number(getRowValue(row, metric));
      if (Number.isFinite(value)) target[metric] += value;
    }
  }
  for (const row of groups.values()) {
    addDerivedTotals(row);
    for (const metric of derivedMetrics) {
      if (row[metric] === undefined) row[metric] = null;
    }
  }
  return Array.from(groups.values()).sort((a, b) => b.row_count - a.row_count);
}

function aggregateReportArchives(runtimeConfig, args = {}) {
  const archives = findArchives(runtimeConfig, args);
  const requestedMaxRows = args.maxRows ?? args.max_rows;
  const hasMaxRows = requestedMaxRows !== undefined && requestedMaxRows !== null && requestedMaxRows !== '';
  const maxRows = hasMaxRows ? Math.max(Math.floor(Number(requestedMaxRows)) || 0, 0) : undefined;
  const groupBy = parseFieldList(args.groupBy || args.group_by, ['campaign.id']).map(canonicalFieldName);
  const allRows = [];
  const seenRows = new Set();
  for (const job of archives.jobs) {
    const remaining = maxRows === undefined ? undefined : Math.max(maxRows - allRows.length, 0);
    const rows = readAllRowsForJob(job, remaining)
      .filter(row => rowWithinRequestedRange(row, args));
    for (const row of rows) {
      const fingerprint = rowFingerprint(row);
      if (seenRows.has(fingerprint)) continue;
      seenRows.add(fingerprint);
      allRows.push(row);
      if (maxRows !== undefined && allRows.length >= maxRows) break;
    }
    if (maxRows !== undefined && allRows.length >= maxRows) break;
  }
  const metrics = parseMetricFields(args, allRows);
  const rows = aggregateRows(allRows, groupBy, metrics);
  const fieldMapping = resolveFieldMap(allRows, [...groupBy, ...metrics]);
  const requestedLimit = args.limit;
  const hasLimit = requestedLimit !== undefined && requestedLimit !== null && requestedLimit !== '';
  const limit = hasLimit ? Math.max(Math.floor(Number(requestedLimit)) || 0, 0) : undefined;
  const warnings = [];
  if (archives.duplicate_count > 0) warnings.push(`${archives.duplicate_count} duplicate archived report job(s) were excluded by jobKey.`);
  if (maxRows !== undefined && allRows.length >= maxRows) warnings.push(`Source rows were capped at ${maxRows}; aggregation may be partial.`);
  if (archives.jobs.some(job => job.truncated)) warnings.push('One or more archives are truncated by AMAZON_ADS_MAX_DOWNLOAD_BYTES.');
  if (archives.jobs.length === 0) warnings.push('No matching completed archives were found. Use find_report_archives first or create/continue the needed report.');
  return {
    ...archives,
    aggregation: {
      groupBy,
      metrics,
      field_mapping: fieldMapping,
      source_rows_read: allRows.length,
      deduped_source_rows: seenRows.size,
      returned_groups: Math.min(rows.length, limit),
      total_groups: rows.length,
    rows: limit === undefined ? rows : rows.slice(0, limit),
      warnings
    }
  };
}

function listReportJobs(runtimeConfig, filters = {}) {
  const limit = Math.min(Math.max(Number(filters.limit || DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), 100);
  const index = loadIndex(runtimeConfig);
  const jobs = filterJobs(index.jobs, filters)
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
    .slice(0, limit)
    .map(compactJob);
  return {
    indexPath: getIndexPath(runtimeConfig),
    count: jobs.length,
    jobs
  };
}

function findReportJob(runtimeConfig, filters = {}) {
  const index = loadIndex(runtimeConfig);
  const jobs = filterJobs(index.jobs, filters)
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  return jobs[0] || null;
}

function findReusableReportJob(runtimeConfig, { jobKey }) {
  if (!jobKey) return null;
  return findReportJob(runtimeConfig, { jobKey });
}

function readRows(filePath, { offset = 0, limit, fields, compact = true } = {}) {
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const hasLimit = limit !== undefined && limit !== null && limit !== '';
  const safeLimit = hasLimit ? Math.max(Math.floor(Number(limit)) || 0, 0) : null;
  const lines = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  const selectedLines = hasLimit ? lines.slice(safeOffset, safeOffset + safeLimit) : lines.slice(safeOffset);
  const selected = selectedLines.map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return { parse_error: true, raw: line };
    }
  });
  const requestedFields = parseFieldList(fields, compact ? DEFAULT_COMPACT_ROW_FIELDS : []);
  const rows = requestedFields.length ? selected.map(row => selectRowFields(row, requestedFields)) : selected;
  return {
    offset: safeOffset,
    limit: hasLimit ? safeLimit : null,
    row_format: requestedFields.length ? 'compact' : 'raw',
    fields: requestedFields,
    returned: selected.length,
    total_known: lines.length,
    rows
  };
}

function readAllRows(filePath, maxRows = 100000) {
  const safeMax = Math.min(Math.max(Number(maxRows) || 100000, 1), 100000);
  const lines = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  const rows = [];
  for (const line of lines.slice(0, safeMax)) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      rows.push({ parse_error: true, raw: line });
    }
  }
  return rows;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(filePath, rows = [], fields = DEFAULT_COMPACT_ROW_FIELDS) {
  ensureDir(path.dirname(filePath));
  const lines = [
    fields.map(csvCell).join(','),
    ...rows.map(row => fields.map(field => csvCell(row[field])).join(','))
  ];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

async function writeExcel(filePath, { job, rowSummary, rows, fields }) {
  const ExcelJS = require('exceljs');
  ensureDir(path.dirname(filePath));
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'VCPToolBox AmazonAds';
  workbook.created = new Date();

  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ header: 'Field', key: 'field', width: 28 }, { header: 'Value', key: 'value', width: 48 }];
  const totals = rowSummary?.totals || {};
  [
    ['Display Name', buildReportDisplayName(job)],
    ['Job ID', job.jobId],
    ['Report ID', job.reportId || ''],
    ['Report Type', reportTypeInfo(job).label],
    ['Account', job.account?.accountName || ''],
    ['Marketplace', job.account?.marketplace || ''],
    ['Period', `${job.period?.startDate || ''} to ${job.period?.endDate || ''}`],
    ['Status', job.status || ''],
    ['Rows', rowSummary?.row_count || 0],
    ...Object.entries(totals).map(([key, value]) => [key, value])
  ].forEach(([field, value]) => summary.addRow({ field, value }));
  summary.getRow(1).font = { bold: true };

  const data = workbook.addWorksheet('Rows');
  data.columns = fields.map(field => ({ header: field, key: field, width: Math.min(Math.max(field.length + 2, 14), 36) }));
  for (const row of rows) data.addRow(row);
  data.getRow(1).font = { bold: true };
  data.views = [{ state: 'frozen', ySplit: 1 }];
  if (rows.length > 0) data.autoFilter = { from: 'A1', to: `${data.getColumn(fields.length).letter}1` };

  await workbook.xlsx.writeFile(filePath);
}

async function exportReportArtifact(runtimeConfig, args = {}) {
  const job = findReportJob(runtimeConfig, args);
  if (!job) return { found: false, error: 'Report job not found. Call list_report_jobs first.' };
  const paths = job.artifact_paths || {};
  const fields = parseFieldList(args.selectFields || args.select_fields || args.fields, DEFAULT_COMPACT_ROW_FIELDS).map(canonicalFieldName);
  const maxRows = Math.min(Math.max(Number(args.maxRows || args.max_rows || job.row_count || 100000) || 100000, 1), 100000);
  const rawRows = readAllRows(paths.rows, maxRows);
  const rows = rawRows.map(row => selectRowFields(row, fields));
  const rowSummary = summarizeRows(rawRows);
  const format = String(args.format || args.type || 'xlsx').toLowerCase();
  const exportPaths = {
    xlsx: paths.excel || path.join(job.artifactDir || path.dirname(paths.summary), `${buildReportSlug(job)}.xlsx`),
    csv: paths.csv || path.join(job.artifactDir || path.dirname(paths.summary), `${buildReportSlug(job)}.csv`)
  };
  const written = [];
  if (format === 'all' || format === 'xlsx' || format === 'excel') {
    await writeExcel(exportPaths.xlsx, { job, rowSummary, rows, fields });
    written.push({ format: 'xlsx', path: exportPaths.xlsx, rows: rows.length });
  }
  if (format === 'all' || format === 'csv') {
    writeCsv(exportPaths.csv, rows, fields);
    written.push({ format: 'csv', path: exportPaths.csv, rows: rows.length });
  }
  return {
    found: true,
    job: compactJob(job),
    row_format: 'compact',
    fields,
    source_rows: rawRows.length,
    exported: written,
    note: 'Excel/CSV exports use compact business fields and omit duplicate alias fields.'
  };
}

function readReportArtifact(runtimeConfig, args = {}) {
  const artifact = String(args.artifact || args.type || 'summary').toLowerCase();
  const job = findReportJob(runtimeConfig, args);
  if (!job) {
    return { found: false, error: 'Report job not found. Call list_report_jobs first.' };
  }
  const paths = job.artifact_paths || {};
  if (artifact === 'summary' || artifact === 'md' || artifact === 'markdown') {
    return {
      found: true,
      job: compactJob(job),
      artifact: 'summary',
      path: paths.summary,
      content: paths.summary && fs.existsSync(paths.summary) ? fs.readFileSync(paths.summary, 'utf8') : ''
    };
  }
  if (artifact === 'rows' || artifact === 'rows_preview' || artifact === 'data') {
    const compact = shouldCompactRows(args);
    return {
      found: true,
      job: compactJob(job),
      artifact: 'rows',
      path: paths.rows,
      ...readRows(paths.rows, {
        offset: args.offset,
        limit: args.limit,
        fields: args.selectFields || args.select_fields || args.fields,
        compact
      }),
      note: compact
        ? 'Rows are compact by default and omit duplicate alias fields. Pass compact=false or format=raw only for debugging.'
        : 'Raw rows include duplicate alias fields and are intended for debugging, not routine analysis.'
    };
  }
  if (artifact === 'downloads') {
    const includeRaw = args.raw === true || args.includeRaw === true || args.include_raw === true || ['raw', 'full', 'debug'].includes(String(args.format || '').toLowerCase());
    if (!includeRaw) {
      const downloads = readJson(paths.downloads, []);
      return {
        found: true,
        job: compactJob(job),
        artifact: 'downloads_summary',
        path: paths.downloads,
        download_count: Array.isArray(downloads) ? downloads.length : 0,
        downloads: Array.isArray(downloads) ? downloads.map(summarizeDownloadForArtifact) : [],
        note: 'downloads.json is a large raw/debug archive and is summarized by default. Use artifact=rows for paginated business rows, or artifact=downloads format=raw only for debugging.'
      };
    }
  }
  const jsonPathByArtifact = {
    metadata: paths.metadata,
    request: paths.request,
    report: paths.report,
    downloads: paths.downloads
  };
  const filePath = jsonPathByArtifact[artifact];
  if (!filePath) {
    return {
      found: true,
      job: compactJob(job),
      error: `Unsupported artifact: ${artifact}. Use summary, rows, metadata, request, report, or downloads.`
    };
  }
  return {
    found: true,
    job: compactJob(job),
    artifact,
    path: filePath,
    content: readJson(filePath, null)
  };
}

module.exports = {
  aggregateReportArchives,
  buildReportJobKey,
  buildReportContext,
  compactJob,
  exportReportArtifact,
  findArchives,
  findReportJob,
  findReusableReportJob,
  listReportJobs,
  sanitizeDownloads,
  upsertReportJob,
  readReportArtifact,
  canonicalFieldName
};
