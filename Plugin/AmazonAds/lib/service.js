const { AmazonAdsMcpClient, McpHttpError } = require('./mcpClient');
const { buildRuntimeConfig, loadMcpServerConfig, resolveAccount } = require('./config');
const {
  DEFAULT_BASE_FIELDS,
  DEFAULT_OPTIONAL_FIELDS,
  classifyReportError,
  ReportingService,
  resolveDateRange,
  summarizeRows
} = require('./reporting');
const { getPreset, loadPresets, updatePresetProbe } = require('./fieldPresets');
const {
  aggregateReportArchives: aggregateStoredReportArchives,
  buildReportJobKey,
  buildReportContext: buildStoredReportContext,
  compactJob,
  exportReportArtifact: exportStoredReportArtifact,
  findArchives: findStoredReportArchives,
  findReportJob,
  findReusableReportJob,
  listReportJobs: listStoredReportJobs,
  readReportArtifact: readStoredReportArtifact,
  sanitizeDownloads,
  upsertReportJob,
  canonicalFieldName
} = require('./reportStore');
const {
  getToolInfo,
  isReadToolAllowed,
  listCapabilities: listRegistryCapabilities,
  normalizeToolName
} = require('./toolRegistry');
const { describeTokenRefresh, refreshAmazonAdsToken } = require('./tokenRefresh');
const {
  buildCampaignBudgetPayload,
  buildEntityStatePayload,
  buildTargetBidPayload,
  isTruthy,
  normalizeChanges,
  proposeChanges,
  validateAdmin
} = require('./operations');

let runtimeConfig = null;
let logFunctions = {
  pushVcpLog: () => {},
  pushVcpInfo: () => {}
};
let lastRun = null;
let tokenRefreshTimer = null;

const PERFORMANCE_FIELD_GUIDANCE = {
  get_target_performance: {
    requiredAny: ['target.id', 'target.value', 'target.expression', 'target.name', 'target.matchType', 'adGroup.id', 'adGroup.name'],
    analysisScope: 'campaign_only_until_target_dimension_is_requested',
    warning: 'Target performance was requested without target/ad group dimension fields. Returned rows cannot be treated as keyword or target-ASIN data.',
    nextActions: [
      'First probe target fields, for example: probe_report_fields preset=target_basic candidateFields=target.value,target.matchType,adGroup.id,adGroup.name.',
      'Then call get_target_performance with explicit fields such as date.value,campaign.id,target.value,target.matchType,metric.clicks.'
    ]
  },
  get_search_term_performance: {
    requiredAny: ['searchTerm.value', 'searchTerm.keyword', 'searchTerm.text', 'query.value', 'customerSearchTerm.value'],
    analysisScope: 'campaign_only_until_search_term_dimension_is_requested',
    warning: 'Search term performance was requested without a search term dimension field. Returned rows cannot be treated as keyword/search-term data.',
    nextActions: [
      'First probe search term fields, for example: probe_report_fields preset=search_term_basic candidateFields=searchTerm.value,searchTerm.text,customerSearchTerm.value,target.value.',
      'Then call get_search_term_performance with explicit fields including the successful search term dimension.'
    ]
  }
};

const REPORT_FIELD_DEPENDENCIES = {
  'metric.sales': ['budgetCurrency.value'],
  'metric.spend': ['budgetCurrency.value'],
  'metric.cost': ['budgetCurrency.value'],
  'metric.acos': ['budgetCurrency.value'],
  'metric.roas': ['budgetCurrency.value'],
  'metric.orders': ['budgetCurrency.value'],
  'target.matchType': ['target.value'],
  'adGroup.name': ['adGroup.id']
};

function getFieldDependencies(field) {
  return REPORT_FIELD_DEPENDENCIES[String(field || '')] || REPORT_FIELD_DEPENDENCIES[String(field || '').toLowerCase()] || [];
}

function nowIso() {
  return new Date().toISOString();
}

function debugLog(...args) {
  if (runtimeConfig?.debugMode) console.log('[AmazonAds]', ...args);
}

function normalizeLimit(value, fallback = 50, max = 500) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function compactError(error) {
  if (error instanceof McpHttpError) {
    return {
      message: error.message,
      status: error.status,
      body: error.body,
      data: error.data
    };
  }
  return {
    message: error?.message || String(error),
    cause: error?.cause?.message || undefined,
    code: error?.cause?.code || error?.code || undefined
  };
}

function wantsDebugPayload(args = {}) {
  const mode = String(args.resultMode || args.result_mode || args.format || args.view || '').toLowerCase();
  return ['debug', 'full', 'raw'].includes(mode)
    || isTruthy(args.debug)
    || isTruthy(args.includeDebug)
    || isTruthy(args.include_debug)
    || isTruthy(args.includeRaw)
    || isTruthy(args.include_raw)
    || isTruthy(args.includeRawResult)
    || isTruthy(args.include_raw_result);
}

function compactReportForAgent(report = {}) {
  if (!report || typeof report !== 'object') return null;
  const period = report.periods?.[0]?.datePeriod || report.period || null;
  const queryFields = report.query?.fields || report.configuration?.query?.fields || [];
  return {
    reportId: report.reportId || null,
    status: report.status || null,
    failureCode: report.failureCode || null,
    failureReason: report.failureReason || null,
    period,
    query_fields: queryFields,
    url_available: Boolean(report.url || report.location || report.downloadUrl)
  };
}

function compactReportsForAgent(reports = []) {
  return (Array.isArray(reports) ? reports : [reports]).filter(Boolean).map(compactReportForAgent);
}

function compactDownloadsForAgent(downloads = [], includeDebug = false) {
  if (includeDebug) return sanitizeDownloads(downloads || []);
  return (downloads || []).map((download, index) => {
    const sourceRows = Array.isArray(download?.artifact_rows)
      ? download.artifact_rows
      : (Array.isArray(download?.rows) ? download.rows : []);
    const rowCount = sourceRows.length || Number(download?.row_summary?.row_count || download?.row_count || 0);
    return {
      index,
      http_status: download?.http_status,
      bytes: download?.bytes,
      truncated: Boolean(download?.truncated),
      row_count: rowCount,
      row_summary: download?.row_summary || summarizeRows(sourceRows),
      error: download?.error || null,
      error_name: download?.error_name || null
    };
  });
}

function summarizeDownloadRows(downloads = []) {
  const rows = [];
  for (const download of downloads || []) {
    const sourceRows = Array.isArray(download?.artifact_rows)
      ? download.artifact_rows
      : (Array.isArray(download?.rows) ? download.rows : []);
    rows.push(...sourceRows);
  }
  return summarizeRows(rows);
}

function exportedFileSummary(autoExport) {
  const exported = Array.isArray(autoExport?.exported) ? autoExport.exported : [];
  return exported.map(item => ({
    format: item.format,
    path: item.path,
    rows: item.rows
  }));
}

function formatMetricValue(value) {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '-';
    if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString('en-US');
    return Number(value.toFixed ? value.toFixed(4) : value).toString();
  }
  return String(value);
}

function buildTotalsLine(rowSummary = {}) {
  const totals = rowSummary.totals || {};
  const ordered = [
    ['Rows', rowSummary.row_count],
    ['Impr', totals['metric.impressions']],
    ['Clicks', totals['metric.clicks']],
    ['Spend', totals['metric.cost'] ?? totals['metric.spend']],
    ['Sales', totals['metric.sales']],
    ['Orders', totals['metric.orders']],
    ['CPC', totals['metric.cpc']],
    ['CTR', totals['calculated.ctr']],
    ['CVR', totals['calculated.cvr']],
    ['ACOS', totals['metric.acos']],
    ['ROAS', totals['metric.roas']]
  ];
  return ordered.map(([label, value]) => `${label}: ${formatMetricValue(value)}`).join(' | ');
}

function buildAgentReportSummary({
  title = 'Amazon Ads Report',
  command,
  state,
  source,
  account,
  preset,
  period,
  usedFields = [],
  job,
  reportId,
  status,
  autoExport,
  downloads = [],
  warnings = [],
  nextActions = []
} = {}) {
  const rowSummary = job?.row_summary || summarizeDownloadRows(downloads);
  const lines = [
    `# ${title}`,
    '',
    `- Command: ${command || '-'}`,
    `- State: ${state || status || '-'}`,
    `- Source: ${source || '-'}`,
    `- Account: ${account?.accountName || '-'} (${account?.marketplace || '-'})`,
    `- Period: ${period?.startDate || '-'} to ${period?.endDate || '-'}`,
    `- Preset: ${preset || '-'}`,
    `- Job ID: ${job?.jobId || '-'}`,
    `- Report ID: ${reportId || job?.reportId || '-'}`,
    '',
    `> ${buildTotalsLine(rowSummary)}`,
    '',
    `- Fields: ${(usedFields || []).join(', ') || '-'}`,
    `- Excel/CSV: ${exportedFileSummary(autoExport).map(item => `${item.format}:${item.path}`).join(' | ') || 'not exported yet'}`
  ];
  if (warnings.length) lines.push(`- Warnings: ${warnings.join('；')}`);
  if (nextActions.length) lines.push(`- Next: ${nextActions[0]}`);
  return lines.join('\n');
}

function compactReportResultForAgent(result = {}, args = {}) {
  if (wantsDebugPayload(args)) return result;
  return {
    success: result.success,
    command: result.command,
    state: result.state,
    source: result.source,
    reportKind: result.reportKind,
    reportId: result.reportId,
    jobId: result.jobId,
    status: result.status,
    period: result.period,
    used_fields: result.used_fields,
    reused_report: result.reused_report,
    archived_report: result.archived_report,
    report_job: result.report_job || result.job,
    auto_export: result.auto_export,
    downloads: compactDownloadsForAgent(result.downloads || []),
    report: compactReportForAgent(result.report),
    reports: compactReportsForAgent(result.reports || []),
    field_guidance: result.field_guidance,
    analysis_scope: result.analysis_scope,
    warnings: result.warnings,
    error: result.error,
    next_actions: result.next_actions,
    summary_markdown: result.summary_markdown
  };
}

function compactContextForAgent(contextResult = {}, args = {}) {
  if (wantsDebugPayload(args)) return contextResult;
  if (!contextResult?.context || !Array.isArray(contextResult.context.reports)) return contextResult;
  return {
    ...contextResult,
    context: {
      ...contextResult.context,
      reports: contextResult.context.reports.map(report => {
        const rows = Array.isArray(report.rows) && report.rows.length > 0 ? report.rows : undefined;
        return {
          jobId: report.jobId,
          reportId: report.reportId,
          reportKind: report.reportKind,
          command: report.command,
          preset: report.preset,
          status: report.status,
          period: report.period,
          fields: report.fields,
          row_count: report.row_count,
          row_summary: report.row_summary,
          truncated: report.truncated,
          field_mapping: report.field_mapping,
          rows
        };
      })
    },
    agent_payload_note: 'Embedded context is compact: repeated summary text and empty row arrays are omitted. Call build_report_context or read_report_artifact for more detail.'
  };
}

function markLastRun(command, success, extra = {}) {
  lastRun = {
    command,
    success,
    timestamp: nowIso(),
    ...extra
  };
}

function createClient() {
  const serverConfig = loadMcpServerConfig(runtimeConfig.mcpConfigPath, runtimeConfig.mcpServerName);
  const client = new AmazonAdsMcpClient({
    url: serverConfig.url,
    headers: serverConfig.headers,
    timeoutMs: runtimeConfig.requestTimeoutMs,
    logger: console
  });
  return { client, serverConfig };
}

async function withClient(handler) {
  const { client, serverConfig } = createClient();
  await client.initialize();
  return handler(client, serverConfig);
}

function hasFixedAccountHeaders(serverConfig) {
  const headers = serverConfig.headers || {};
  return headers['Amazon-Ads-AI-Account-Selection-Mode'] === 'FIXED'
    && Boolean(headers['Amazon-Advertising-API-Scope'] || headers['Amazon-Ads-AccountID'] || headers['Amazon-Ads-Manager-AccountID']);
}

function parseFields(value, fallback) {
  let fields;
  if (Array.isArray(value) && value.length > 0) {
    fields = value.map(String).filter(Boolean);
  } else if (typeof value === 'string' && value.trim()) {
    fields = value.split(',').map(item => item.trim()).filter(Boolean);
  } else {
    fields = fallback;
  }
  if (fields) {
    return fields.map(field => canonicalFieldName(field));
  }
  return fallback;
}

function uniqueFields(fields = []) {
  return Array.from(new Set((fields || []).map(String).map(field => field.trim()).filter(Boolean)));
}

const CALCULATED_FIELDS_LIST = [
  'calculated.ctr',
  'calculated.cpc',
  'calculated.cvr',
  'calculated.acos',
  'calculated.roas'
];

function splitAllowedFields(preset = {}) {
  return uniqueFields([
    ...(preset.verified_fields || []),
    ...(preset.candidate_fields || []),
    ...CALCULATED_FIELDS_LIST
  ]);
}

function validateFieldsAgainstPreset(fields, preset, presetName, { allowCandidateFields = false } = {}) {
  const verified = new Set((preset.verified_fields || []).map(field => String(field).toLowerCase()));
  const allowed = new Set(splitAllowedFields(preset).map(field => field.toLowerCase()));
  const unknown = [];
  const unverified = [];
  for (const field of uniqueFields(fields)) {
    const key = field.toLowerCase();
    if (key.startsWith('calculated.')) {
      continue;
    }
    if (!allowed.has(key)) {
      unknown.push(field);
    } else if (!allowCandidateFields && !verified.has(key)) {
      unverified.push(field);
    }
  }
  if (unknown.length || unverified.length) {
    return {
      ok: false,
      preset: presetName,
      unknown_fields: unknown,
      unverified_fields: unverified,
      allowed_fields: Array.from(allowed),
      verified_fields: Array.from(verified),
      message: unknown.length
        ? `Fields are not in preset ${presetName} verified/candidate list: ${unknown.join(', ')}. Do not invent report fields.`
        : `Fields are not verified for preset ${presetName}: ${unverified.join(', ')}. Run probe_report_fields first or pass allowUnverifiedFields=true only for deliberate debugging.`
    };
  }
  return { ok: true };
}

function buildPerformanceFieldGuidance(commandName, fields = []) {
  const guidance = PERFORMANCE_FIELD_GUIDANCE[commandName];
  if (!guidance) return null;
  const normalized = new Set((fields || []).map(field => String(field).toLowerCase()));
  const hasRequiredDimension = guidance.requiredAny.some(field => normalized.has(field.toLowerCase()));
  if (hasRequiredDimension) return null;
  return {
    analysis_scope: guidance.analysisScope,
    missing_any_of: guidance.requiredAny,
    warning: guidance.warning,
    next_actions: guidance.nextActions
  };
}

function mergeNextActions(fieldGuidance, defaultActions) {
  if (!fieldGuidance) return defaultActions;
  return [...fieldGuidance.next_actions, ...defaultActions];
}

function buildAccessRequestedAccount(account, args = {}) {
  const mode = String(args.accountIdentifierMode || args.account_identifier_mode || 'profile').toLowerCase();
  if (mode === 'account' || mode === 'advertiser') return { advertiserAccountId: account.adsAccountId };
  if (mode === 'entity') return { advertiserAccountId: account.entityId };
  return { profileId: account.profileId };
}

function addMarketplaceScopeFilter(body, account, args = {}) {
  const marketplace = String(args.marketplaceScope || args.marketplace_scope || account.marketplace || '').trim().toUpperCase();
  if (marketplace && marketplace !== 'ALL') {
    body.marketplaceScopeFilter = { include: [marketplace] };
  }
  return body;
}

function includeAccessRequestedAccount(serverConfig) {
  return !hasFixedAccountHeaders(serverConfig);
}

function addAccountContext(body, account, serverConfig) {
  if (includeAccessRequestedAccount(serverConfig)) {
    body.accessRequestedAccount = { advertiserAccountId: account.adsAccountId };
  }
  return body;
}

function parseList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map(item => item.trim()).filter(Boolean);
  }
  return [];
}

function parseMaybeJson(value, fallback = undefined) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function getPresetFields(args = {}, fallback = [...DEFAULT_BASE_FIELDS, ...DEFAULT_OPTIONAL_FIELDS]) {
  if (args.fields) return parseFields(args.fields, fallback);
  const presetName = args.preset || args.reportPreset || args.report_preset;
  if (!presetName) return fallback;
  const { preset } = getPreset(runtimeConfig, presetName);
  return preset.verified_fields?.length ? preset.verified_fields : fallback;
}

function wantsPreflightProbe(args = {}) {
  return isTruthy(
    args.probeBeforeUse
    || args.probe_before_use
    || args.requireProbe
    || args.require_probe
    || args.forceProbe
    || args.force_probe
  );
}

function buildStoredReportPatch({ command, account, preset, period, fields, reportId, status, jobKey, result, warnings, error }) {
  const finalStatus = status || (error ? 'FAILED' : (reportId ? 'PENDING' : null));
  return {
    jobKey,
    command,
    preset,
    account,
    period,
    used_fields: fields,
    reportId: reportId || null,
    status: finalStatus,
    warnings: warnings || [],
    error: error || null,
    result_success: result?.success !== false
  };
}

function persistReportJob({ command, account, preset, period, fields, jobKey, result, request, report, downloads, rawResult, error }) {
  const status = result?.status || report?.status || (error ? 'FAILED' : null);
  const state = classifyReportRetrievalState({ ...(result || {}), report, downloads }, status);
  const reportId = result?.reportId || report?.reportId || request?.reportId || null;
  return upsertReportJob(runtimeConfig, buildStoredReportPatch({
    command,
    account,
    preset,
    period,
    fields,
    reportId,
    status: state.status || status,
    jobKey,
    result,
    warnings: [...(result?.warnings || []), ...(state.warnings || [])],
    error: error || state.error || result?.error || null
  }), {
    request,
    report,
    downloads,
    rawResult,
    error: error || result?.error || null
  });
}

function classifyReportRetrievalState(result = {}, fallbackStatus = null) {
  const raw = result.data || result.result || result.raw_result || result;
  const code = raw?.code || raw?.error?.code || null;
  const message = raw?.message || raw?.error?.message || '';
  if (code === '404001' || /not found/i.test(message)) {
    return {
      ok: false,
      status: 'FAILED_REPORT_NOT_FOUND',
      error: { code: 'report_not_found', message: message || 'Amazon Ads reportId was not found.' },
      reusable: false
    };
  }
  const report = result.report || (Array.isArray(result.reports) ? result.reports[0] : null);
  const status = result.status || report?.status || fallbackStatus || null;
  const downloads = Array.isArray(result.downloads) ? result.downloads : null;
  const downloadErrors = downloads ? downloads.filter(download => download?.error) : [];
  const downloadedRows = downloads
    ? downloads.reduce((count, download) => count + (Array.isArray(download?.artifact_rows)
      ? download.artifact_rows.length
      : Array.isArray(download?.rows) ? download.rows.length : 0), 0)
    : 0;
  if (status === 'FAILED' || report?.failureCode || report?.failureReason) {
    return {
      ok: false,
      status: 'FAILED',
      error: {
        code: report?.failureCode || 'report_failed',
        message: report?.failureReason || message || 'Amazon Ads report failed.'
      },
      reusable: false
    };
  }
  if (status === 'COMPLETED' && downloads && downloadErrors.length > 0 && downloadedRows === 0) {
    const details = downloadErrors.map(download => download.error).filter(Boolean).join('; ');
    return {
      ok: false,
      status: 'COMPLETED_DOWNLOAD_FAILED',
      error: {
        code: 'report_download_failed',
        message: details || 'Amazon Ads report completed, but the downloadable report file could not be fetched.'
      },
      reusable: true,
      warnings: [
        'Amazon Ads marked the report as COMPLETED, but the report file download failed. Do not interpret row_count=0 as no data.',
        'Retry continue_report_job with the same jobId/reportId to fetch a fresh download URL.'
      ]
    };
  }
  if (status === 'COMPLETED' && Array.isArray(result.downloads) && result.downloads.length === 0) {
    return {
      ok: true,
      status: 'COMPLETED_EMPTY',
      error: null,
      reusable: true,
      warnings: ['Amazon Ads marked the report as COMPLETED, but no download URLs were returned. Treat this as no downloaded data, not confirmed zero performance.']
    };
  }
  return {
    ok: true,
    status: status || (result.reportId ? 'PENDING' : null),
    error: null,
    reusable: true,
    warnings: []
  };
}

function isReusableReportJob(job) {
  if (!job) return false;
  const status = String(job.status || '').toUpperCase();
  if (status.startsWith('FAILED')) return false;
  if (status.includes('DOWNLOAD_FAILED')) return false;
  if (status === 'COMPLETED' || status === 'COMPLETED_EMPTY' || status === 'COMPLETED_NO_DATA') return true;
  return ['PENDING', 'PROCESSING'].includes(status);
}

function isContinuableReportJob(job) {
  const status = String(job?.status || '').toUpperCase();
  return Boolean(job?.reportId) && (['PENDING', 'PROCESSING'].includes(status) || status.includes('DOWNLOAD_FAILED'));
}

function reportJobCoversFields(job, requiredFields = []) {
  if (!requiredFields.length) return true;
  const archivedFields = new Set((job?.used_fields || []).map(field => String(field).toLowerCase()));
  return requiredFields.every(field => archivedFields.has(String(field).toLowerCase()));
}

function hasUsableArchivedRows(job, requiredFields = []) {
  return String(job?.status || '').toUpperCase() === 'COMPLETED'
    && Number(job?.row_count || 0) > 0
    && reportJobCoversFields(job, requiredFields);
}

function buildReportArchiveInfo(job) {
  if (!job) return null;
  return {
    job: compactJob(job),
    next_actions: [
      `Use read_report_artifact with jobId=${job.jobId} artifact=summary before analyzing archived data.`,
      'Use artifact=rows with limit/offset when row-level data is needed; do not load every archived row at once.',
      `If Amazon status must be refreshed, call continue_report_job with jobId=${job.jobId}.`
    ]
  };
}

function normalizeReportJobFilters(args = {}) {
  const filters = { ...args };
  delete filters.command;
  if (args.reportCommand || args.report_command || args.commandFilter || args.command_filter) {
    filters.command = args.reportCommand || args.report_command || args.commandFilter || args.command_filter;
  }
  return filters;
}

function normalizeReportKind(value) {
  const raw = String(value || 'campaign').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (/计划|广告活动|campaign|plan/.test(raw)) return 'campaign';
  if (/广告位|广告位置|placement|campaign_placement/.test(raw)) return 'placement';
  if (/搜索词|search/.test(raw)) return 'search_term';
  if (/关键词报表|关键字报表|keyword_report/.test(raw)) return 'keyword_report';
  if (/target|asin|商品投放|目标/.test(raw)) return 'target';
  if (/关键词|关键字|keyword/.test(raw)) return 'keyword';
  return raw;
}

function reportKindWantsSearchTerm(kind, dataNeed) {
  const normalizedKind = normalizeReportKind(kind);
  const need = String(dataNeed || '').toLowerCase();
  return ['keyword', 'keyword_report', 'keywords'].includes(normalizedKind)
    && /keyword_report|keyword_full|search_term|searchterm|sales_full|complete|成交|客户搜索词|搜索词/.test(need);
}

function getReportKindConfig(reportKind, dataNeed) {
  const kind = normalizeReportKind(reportKind);
  const configs = {
    campaign: {
      reportKind: 'campaign',
      commandName: 'get_campaign_performance',
      presetName: 'campaign_basic',
      dimensionFields: ['date.value', 'campaign.id', 'campaign.name']
    },
    placement: {
      reportKind: 'placement',
      commandName: 'get_placement_performance',
      presetName: 'placement_basic',
      dimensionFields: ['date.value', 'campaign.id', 'campaign.name', 'placementClassification'],
      analysisScope: 'campaign_placement_performance',
      routeReason: 'Sponsored Products placement report uses campaignPlacement grouping / placementClassification.'
    },
    keyword: {
      reportKind: 'keyword',
      commandName: 'get_target_performance',
      presetName: 'target_basic',
      dimensionFields: ['date.value', 'campaign.id', 'campaign.name', 'target.value', 'adGroup.id'],
      analysisScope: 'target_performance',
      routeReason: 'reportKind=keyword defaults to target/keyword/ASIN投放表现 unless dataNeed explicitly asks for search-term/成交 report.'
    },
    keyword_report: {
      reportKind: 'search_term',
      commandName: 'get_search_term_performance',
      presetName: 'search_term_basic',
      dimensionFields: ['date.value', 'campaign.id', 'campaign.name', 'target.value', 'searchTerm.value'],
      analysisScope: 'search_term_performance',
      routeReason: 'keyword_report_full/关键词成交报表 follows the customer search term report scope.'
    },
    keyword_target: {
      reportKind: 'keyword',
      commandName: 'get_target_performance',
      presetName: 'target_basic',
      dimensionFields: ['date.value', 'campaign.id', 'campaign.name', 'target.value', 'adGroup.id'],
      analysisScope: 'target_performance',
      routeReason: 'Explicit target/keyword targeting report.'
    },
    target: {
      reportKind: 'keyword',
      commandName: 'get_target_performance',
      presetName: 'target_basic',
      dimensionFields: ['date.value', 'campaign.id', 'campaign.name', 'target.value', 'adGroup.id'],
      analysisScope: 'target_performance',
      routeReason: 'Explicit target/keyword targeting report.'
    },
    search_term: {
      reportKind: 'search_term',
      commandName: 'get_search_term_performance',
      presetName: 'search_term_basic',
      dimensionFields: ['date.value', 'campaign.id', 'campaign.name', 'target.value', 'searchTerm.value'],
      analysisScope: 'search_term_performance',
      routeReason: 'Explicit customer search term report.'
    }
  };
  const selected = reportKindWantsSearchTerm(reportKind, dataNeed)
    ? configs.keyword_report
    : (configs[kind] || configs.campaign);
  return {
    ...selected,
    requestedReportKind: kind
  };
}

function reportRoutePayload(config) {
  return {
    requested_report_kind: config.requestedReportKind,
    effective_report_kind: config.reportKind,
    report_route: {
      requested_report_kind: config.requestedReportKind,
      effective_report_kind: config.reportKind,
      command: config.commandName,
      preset: config.presetName,
      analysis_scope: config.analysisScope || config.reportKind,
      reason: config.routeReason || 'Direct reportKind route.'
    }
  };
}

function normalizeReportDataDateArgs(args = {}) {
  const out = { ...args };
  if (args.dateFrom || args.date_from) out.startDate = args.dateFrom || args.date_from;
  if (args.dateTo || args.date_to) out.endDate = args.dateTo || args.date_to;
  const date = args.date || args.reportDate || args.report_date;
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    out.startDate = String(date);
    out.endDate = String(date);
  }
  const preset = String(args.period || args.datePreset || args.date_preset || '').toLowerCase();
  if (preset === 'yesterday') {
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const value = yesterday.toISOString().slice(0, 10);
    out.startDate = value;
    out.endDate = value;
  }
  return out;
}

function inclusiveDateDays(startDate, endDate) {
  if (!startDate || !endDate) return null;
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return Math.max(1, Math.floor((end.getTime() - start.getTime()) / 86400000) + 1);
}

function resolveReportDataDateRange(args = {}) {
  const resolved = resolveDateRange(args);
  const hasExplicitRange = Boolean(args.startDate || args.start_date || args.dateFrom || args.date_from || args.endDate || args.end_date || args.dateTo || args.date_to);
  const hasSingleDate = Boolean(args.date || args.reportDate || args.report_date);
  const hasDays = Boolean(args.days || args.lastDays);
  const explicitDays = hasExplicitRange || hasSingleDate ? inclusiveDateDays(resolved.startDate, resolved.endDate) : null;
  return {
    ...resolved,
    days: explicitDays || resolved.days,
    date_resolution: {
      source: hasSingleDate ? 'single_date' : hasExplicitRange ? 'explicit_range' : hasDays ? 'days' : 'default_30_days',
      startDate: resolved.startDate,
      endDate: resolved.endDate,
      days: explicitDays || resolved.days
    }
  };
}

function buildDataNeedFields({ args, preset, config }) {
  const dataNeed = String(args.dataNeed || args.data_need || args.need || 'traffic_basic').toLowerCase();
  const verified = new Set((preset.verified_fields || []).map(field => field.toLowerCase()));
  const candidate = new Set((preset.candidate_fields || []).map(field => field.toLowerCase()));
  const rawRequested = args.fields
    ? parseFields(args.fields, [])
    : uniqueFields([
        ...config.dimensionFields,
        'metric.clicks',
        ...(dataNeed !== 'identity_basic' ? ['metric.impressions'] : []),
        ...(['sales_basic'].includes(dataNeed) ? ['budgetCurrency.value', 'metric.sales'] : []),
        ...(['keyword_report_full', 'keyword_full', 'search_term_full', 'sales_full', 'complete_keyword_report'].includes(dataNeed)
          ? ['target.matchType', 'budgetCurrency.value', 'metric.spend', 'metric.sales', 'metric.orders', 'metric.acos', 'metric.roas']
          : []),
        ...(['diagnosis_full', 'full'].includes(dataNeed) ? ['budgetCurrency.value', 'metric.sales', 'metric.spend', 'metric.orders', 'metric.acos', 'metric.roas'] : [])
      ]);
  const requested = uniqueFields(rawRequested.map(field => canonicalFieldName(field)));
  const verifiedFields = requested.filter(field => verified.has(field.toLowerCase()));
  const missingFields = requested.filter(field => !verified.has(field.toLowerCase()));
  const unknownFields = missingFields.filter(field => !candidate.has(field.toLowerCase()));
  const unverifiedCandidateFields = missingFields.filter(field => candidate.has(field.toLowerCase()));
  const allowPartial = isTruthy(args.allowPartial || args.allow_partial);
  const requiresProbe = wantsPreflightProbe(args) && unverifiedCandidateFields.length > 0 && !allowPartial;
  return {
    dataNeed,
    requestedFields: requested,
    verifiedFields,
    fields: unknownFields.length ? verifiedFields : requested,
    missingFields,
    unknownFields,
    unverifiedCandidateFields,
    usingUnverifiedCandidateFields: unverifiedCandidateFields.length > 0 && unknownFields.length === 0,
    requiresProbe,
    allowPartial
  };
}

function chunkList(items = [], size = 4) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function buildGetReportDataState(status, fallback = 'UNKNOWN') {
  const normalized = String(status || '').toUpperCase();
  if (normalized === 'COMPLETED') return 'READY';
  if (normalized === 'COMPLETED_EMPTY' || normalized === 'COMPLETED_NO_DATA') return 'NO_DATA';
  if (normalized.includes('DOWNLOAD_FAILED')) return 'DOWNLOAD_FAILED';
  if (['PENDING', 'PROCESSING'].includes(normalized)) return 'PROCESSING';
  if (normalized.startsWith('FAILED')) return 'FAILED_NOT_REUSABLE';
  return fallback;
}

async function getStatus() {
  const { client, serverConfig } = createClient();
  const status = {
    success: true,
    plugin: 'AmazonAds',
    version: '1.0.0',
    safeMode: runtimeConfig.safeMode,
    configPath: serverConfig.configPath,
    serverName: serverConfig.serverName,
    mcpUrl: serverConfig.url,
    hasAuthorization: Boolean(serverConfig.headers.Authorization),
    hasClientId: Boolean(serverConfig.headers['Amazon-Ads-ClientId']),
    fixedAccountContext: hasFixedAccountHeaders(serverConfig),
    defaultAccount: runtimeConfig.defaultAccount,
    timeoutMs: runtimeConfig.requestTimeoutMs,
    tokenRefresh: describeTokenRefresh(runtimeConfig),
    lastRun
  };

  try {
    await client.initialize();
    status.nativeMcp = {
      initialized: true,
      hasSession: Boolean(client.sessionId)
    };
  } catch (error) {
    status.success = false;
    status.nativeMcp = {
      initialized: false,
      error: compactError(error)
    };
  }

  markLastRun('get_status', status.success);
  return status;
}

async function listAccounts(args = {}) {
  const body = {};
  const maxResults = args.maxResults || args.max_results;
  if (maxResults) body.maxResults = normalizeLimit(maxResults, 100, 500);
  if (args.nextToken || args.next_token) body.nextToken = args.nextToken || args.next_token;

  const result = await withClient(client =>
    client.callTool('ads_accounts-list_ads_accounts', Object.keys(body).length ? { body } : {})
  );
  markLastRun('list_accounts', true);
  return { success: true, command: 'list_accounts', result };
}

async function listCapabilities() {
  const { presetPath, presets } = loadPresets(runtimeConfig);
  return {
    success: true,
    command: 'list_capabilities',
    ...listRegistryCapabilities(),
    token_refresh: describeTokenRefresh(runtimeConfig),
    report_presets: Object.entries(presets).map(([name, preset]) => ({
      name,
      level: preset.level,
      description: preset.description,
      verified_fields: preset.verified_fields || [],
      candidate_field_count: (preset.candidate_fields || []).length,
      last_probe: preset.last_probe || null
    })),
    preset_path: presetPath
  };
}

async function refreshToken(args = {}) {
  const result = await refreshAmazonAdsToken(runtimeConfig, args);
  markLastRun('refresh_token', true, { configPath: result.configPath, expiresIn: result.expiresIn });
  return result;
}

function clearTokenRefreshTimer() {
  if (tokenRefreshTimer) {
    clearInterval(tokenRefreshTimer);
    tokenRefreshTimer = null;
  }
}

function startTokenAutoRefresh() {
  clearTokenRefreshTimer();
  const refreshConfig = runtimeConfig?.tokenRefresh || {};
  if (!refreshConfig.enabled || !refreshConfig.autoRefresh) return;

  const intervalMs = Math.max(Number(refreshConfig.intervalSeconds || 3000), 300) * 1000;
  const runRefresh = async (reason) => {
    try {
      const result = await refreshAmazonAdsToken(runtimeConfig, { internal: true });
      markLastRun('refresh_token', true, { trigger: reason, configPath: result.configPath, expiresIn: result.expiresIn });
      console.log(`[AmazonAds] Auto token refresh succeeded (${reason}), expiresIn=${result.expiresIn || 'unknown'}s.`);
    } catch (error) {
      markLastRun('refresh_token', false, { trigger: reason, error: error.message });
      console.error(`[AmazonAds] Auto token refresh failed (${reason}):`, error.message);
      logFunctions.pushVcpLog?.({
        type: 'amazon_ads_token_refresh_error',
        error: compactError(error),
        timestamp: nowIso()
      });
    }
  };

  runRefresh('startup');
  tokenRefreshTimer = setInterval(() => runRefresh('interval'), intervalMs);
  if (typeof tokenRefreshTimer.unref === 'function') tokenRefreshTimer.unref();
}

async function getAccount(args = {}) {
  const account = resolveAccount(args, runtimeConfig);
  const result = await withClient(client =>
    client.callTool('ads_accounts-get_ads_account', {
      pathParameters: { advertisingAccountId: account.adsAccountId }
    })
  );
  markLastRun('get_account', true, { adsAccountId: account.adsAccountId });
  return { success: true, command: 'get_account', account, result };
}

async function callReadTool(args = {}) {
  const tool = normalizeToolName(args.tool || args.toolName || args.tool_name || args.rawTool || args.raw_tool);
  if (!tool) return { success: false, needs_clarification: true, error: 'Missing read tool name.' };
  if (!isReadToolAllowed(tool)) {
    return {
      success: false,
      command: 'call_read_tool',
      error: `Tool is not in AmazonAds read whitelist: ${tool}`,
      tool,
      allowed: false,
      tool_info: getToolInfo(tool)
    };
  }
  const rawPayload = args.payload !== undefined ? args.payload : (args.arguments !== undefined ? args.arguments : args.argument);
  const parsedPayload = parseMaybeJson(rawPayload, null);
  const payload = parsedPayload && typeof parsedPayload === 'object'
    ? parsedPayload
    : {
        ...(args.body ? { body: parseMaybeJson(args.body, args.body) } : {}),
        ...(args.pathParameters ? { pathParameters: parseMaybeJson(args.pathParameters, args.pathParameters) } : {}),
        ...(args.queryParameters ? { queryParameters: parseMaybeJson(args.queryParameters, args.queryParameters) } : {})
      };
  const result = await withClient(client => client.callTool(tool, payload));
  markLastRun('call_read_tool', true, { tool });
  return { success: true, command: 'call_read_tool', tool, tool_info: getToolInfo(tool), result };
}

async function listCampaigns(args = {}) {
  const account = resolveAccount(args, runtimeConfig);
  const adProduct = args.adProduct || args.ad_product || 'SPONSORED_PRODUCTS';
  const body = {
    adProductFilter: { include: [adProduct] },
    maxResults: normalizeLimit(args.maxResults || args.max_results, 50, 500)
  };
  if (args.nextToken || args.next_token) body.nextToken = args.nextToken || args.next_token;
  if (args.state) body.stateFilter = { include: Array.isArray(args.state) ? args.state : [String(args.state)] };
  if (args.campaignId || args.campaign_id) {
    body.campaignIdFilter = { include: [String(args.campaignId || args.campaign_id)] };
  }
  addMarketplaceScopeFilter(body, account, args);

  const result = await withClient((client, serverConfig) => {
    if (!hasFixedAccountHeaders(serverConfig)) {
      body.accessRequestedAccount = buildAccessRequestedAccount(account, args);
    }
    return client.callTool('campaign_management-query_campaign', { body });
  });
  markLastRun('list_campaigns', true, { account: account.accountName, marketplace: account.marketplace });
  return {
    success: true,
    command: 'list_campaigns',
    account,
    request: {
      adProduct,
      marketplaceScopeFilter: body.marketplaceScopeFilter,
      maxResults: body.maxResults,
      fixedAccountContext: !body.accessRequestedAccount,
      accessRequestedAccount: body.accessRequestedAccount
    },
    result
  };
}

async function queryCampaignEntity(args = {}, entity) {
  const account = resolveAccount(args, runtimeConfig);
  const adProduct = args.adProduct || args.ad_product || 'SPONSORED_PRODUCTS';
  const body = {
    adProductFilter: { include: [adProduct] },
    maxResults: normalizeLimit(args.maxResults || args.max_results, 50, 500)
  };
  if (args.nextToken || args.next_token) body.nextToken = args.nextToken || args.next_token;
  if (args.state) body.stateFilter = { include: Array.isArray(args.state) ? args.state : [String(args.state)] };
  if (args.campaignId || args.campaign_id) body.campaignIdFilter = { include: [String(args.campaignId || args.campaign_id)] };
  if (args.adGroupId || args.ad_group_id) body.adGroupIdFilter = { include: [String(args.adGroupId || args.ad_group_id)] };
  if (args.adId || args.ad_id) body.adIdFilter = { include: [String(args.adId || args.ad_id)] };
  if (args.targetId || args.target_id) body.targetIdFilter = { include: [String(args.targetId || args.target_id)] };
  if (args.keyword) body.keywordFilter = { include: parseList(args.keyword) };
  addMarketplaceScopeFilter(body, account, args);

  const toolByEntity = {
    ad_group: 'campaign_management-query_ad_group',
    ad: 'campaign_management-query_ad',
    target: 'campaign_management-query_target'
  };
  const tool = toolByEntity[entity];
  const result = await withClient((client, serverConfig) => {
    addAccountContext(body, account, serverConfig);
    return client.callTool(tool, { body });
  });
  const commandByEntity = {
    ad_group: 'list_ad_groups',
    ad: 'list_ads',
    target: 'list_targets'
  };
  const command = commandByEntity[entity];
  markLastRun(command, true, { account: account.accountName, marketplace: account.marketplace });
  return {
    success: true,
    command,
    account,
    request: {
      adProduct,
      marketplaceScopeFilter: body.marketplaceScopeFilter,
      maxResults: body.maxResults,
      fixedAccountContext: !body.accessRequestedAccount,
      filters: {
        campaignId: args.campaignId || args.campaign_id || null,
        adGroupId: args.adGroupId || args.ad_group_id || null,
        adId: args.adId || args.ad_id || null,
        targetId: args.targetId || args.target_id || null,
        state: args.state || null
      }
    },
    result
  };
}

async function listAdGroups(args = {}) {
  return queryCampaignEntity(args, 'ad_group');
}

async function listAds(args = {}) {
  return queryCampaignEntity(args, 'ad');
}

async function listTargets(args = {}) {
  return queryCampaignEntity(args, 'target');
}

async function checkProductEligibility(args = {}) {
  const account = resolveAccount(args, runtimeConfig);
  const body = {
    adProduct: args.adProduct || args.ad_product || 'SPONSORED_PRODUCTS'
  };
  const products = args.products || args.asins || args.skus || [];
  if (Array.isArray(products) && products.length) body.products = products;
  if (args.productIds || args.product_ids) body.productIds = parseList(args.productIds || args.product_ids);
  const result = await withClient((client, serverConfig) => {
    addAccountContext(body, account, serverConfig);
    return client.callTool('campaign_management-check_product_eligibility', { body });
  });
  markLastRun('check_product_eligibility', true);
  return { success: true, command: 'check_product_eligibility', account, result };
}

async function getBillingStatus(args = {}) {
  const account = resolveAccount(args, runtimeConfig);
  const body = {};
  if (args.startDate || args.start_date) body.startDate = args.startDate || args.start_date;
  if (args.endDate || args.end_date) body.endDate = args.endDate || args.end_date;
  const result = await withClient((client, serverConfig) => {
    addAccountContext(body, account, serverConfig);
    return client.callTool('billing-query_billing_notifications', { body });
  });
  markLastRun('get_billing_status', true);
  return { success: true, command: 'get_billing_status', account, result };
}

async function listAccountUsers(args = {}) {
  const account = resolveAccount(args, runtimeConfig);
  const body = {
    maxResults: normalizeLimit(args.maxResults || args.max_results, 50, 100)
  };
  if (args.nextToken || args.next_token) body.nextToken = args.nextToken || args.next_token;
  const result = await withClient((client, serverConfig) => {
    addAccountContext(body, account, serverConfig);
    return client.callTool('users-list_users', { body });
  });
  markLastRun('list_account_users', true);
  return { success: true, command: 'list_account_users', account, result };
}

async function createReport(args = {}) {
  const account = resolveAccount(args, runtimeConfig);
  const { startDate, endDate, days } = resolveDateRange(args);
  const fields = getPresetFields(args, [...DEFAULT_BASE_FIELDS, ...DEFAULT_OPTIONAL_FIELDS]);
  const presetName = args.preset || args.reportPreset || args.report_preset || 'custom';
  const period = { startDate, endDate, days };
  const jobKey = buildReportJobKey({ command: 'create_report', account, preset: presetName, period, fields });
  const cachedJob = !isTruthy(args.forceNew || args.force_new) ? findReusableReportJob(runtimeConfig, { jobKey }) : null;
  if (cachedJob?.reportId && isReusableReportJob(cachedJob)) {
    return {
      success: true,
      command: 'create_report',
      account,
      period,
      used_fields: fields,
      reportId: cachedJob.reportId,
      status: cachedJob.status,
      reused_report: true,
      archived_report: true,
      ...buildReportArchiveInfo(cachedJob)
    };
  }
  const result = await withClient(async (client, serverConfig) => {
    const reporting = new ReportingService({
      mcpClient: client,
      runtimeConfig,
      fixedAccountContext: hasFixedAccountHeaders(serverConfig)
    });
    return reporting.createReport({ accountId: account.adsAccountId, startDate, endDate, fields });
  });
  const stored = persistReportJob({
    command: 'create_report',
    account,
    preset: presetName,
    period,
    fields,
    jobKey,
    result: {
      success: Boolean(result.reportId),
      reportId: result.reportId,
      status: result.reports?.[0]?.status || (result.reportId ? 'PENDING' : null),
      error: result.reportId ? null : result.data
    },
    request: result.payload,
    report: result.reports?.[0] || null,
    rawResult: result.data,
    error: result.reportId ? null : result.data
  });
  markLastRun('create_report', Boolean(result.reportId), { reportId: result.reportId });
  const includeDebugPayload = wantsDebugPayload(args);
  return {
    success: Boolean(result.reportId),
    command: 'create_report',
    account,
    period,
    used_fields: fields,
    reportId: result.reportId,
    jobId: stored.job.jobId,
    report_job: compactJob(stored.job),
    reports: compactReportsForAgent(result.reports),
    result: includeDebugPayload ? result.data : undefined,
    summary_markdown: buildAgentReportSummary({
      title: 'Amazon Ads Report Created',
      command: 'create_report',
      state: stored.job.status,
      source: 'amazon_ads_report',
      account,
      preset: presetName,
      period,
      usedFields: fields,
      job: compactJob(stored.job),
      reportId: result.reportId,
      status: stored.job.status,
      warnings: stored.job.warnings,
      nextActions: [`Continue later with continue_report_job jobId=${stored.job.jobId}.`]
    }),
    agent_payload_note: includeDebugPayload
      ? 'Debug payload requested; raw MCP result is included.'
      : 'Agent payload is compact. Raw MCP create result is omitted; use result_mode=debug only for troubleshooting.'
  };
}

async function retrieveReport(args = {}) {
  const reportIds = args.reportIds || args.report_ids || (args.reportId || args.report_id ? [args.reportId || args.report_id] : []);
  if (!Array.isArray(reportIds) || reportIds.length === 0) {
    return { success: false, needs_clarification: true, error: 'Missing reportId or reportIds.' };
  }
  const result = await withClient(async client => {
    const reporting = new ReportingService({ mcpClient: client, runtimeConfig });
    if (args.download === true || args.download === 'true') {
      return reporting.retrieveReportWithDownloads(reportIds, { download: true, includeArtifactData: true });
    }
    return reporting.retrieveReport(reportIds);
  });
  const reportJobs = [];
  const autoExports = [];
  for (const reportId of reportIds) {
    const report = (result.reports || []).find(item => item?.reportId === reportId) || result.report || null;
    const existing = findReportJob(runtimeConfig, { reportId });
    const downloads = Array.isArray(result.downloads) && report?.reportId === result.report?.reportId
      ? result.downloads
      : undefined;
    const state = classifyReportRetrievalState({ ...result, report }, existing?.status || null);
    const stored = upsertReportJob(runtimeConfig, {
      ...(existing ? {} : { command: 'retrieve_report', preset: 'unknown' }),
      reportId,
      status: state.status || report?.status || result.status || existing?.status || null,
      account: existing?.account || {
        accountName: 'unknown',
        adsAccountId: report?.linkedAccounts?.[0]?.advertiserAccountId || 'unknown',
        marketplace: 'unknown'
      },
      period: existing?.period || {
        startDate: report?.periods?.[0]?.datePeriod?.startDate || null,
        endDate: report?.periods?.[0]?.datePeriod?.endDate || null
      },
      used_fields: existing?.used_fields || report?.query?.fields || [],
      error: state.error || existing?.error || null,
      warnings: [...(state.warnings || []), ...(existing?.warnings || [])]
    }, {
      request: existing?.request || { reportId, reportIds },
      report,
      downloads,
      rawResult: result.data
    });
    const autoExport = await autoExportCompletedReport(stored.job);
    autoExports.push({ reportId, ...compactAutoExportResult(autoExport) });
    reportJobs.push({
      ...compactJob(stored.job),
      auto_export: compactAutoExportResult(autoExport)
    });
  }
  markLastRun('retrieve_report', true, { reportIds });
  const includeDebugPayload = wantsDebugPayload(args);
  const downloadSummary = compactDownloadsForAgent(result.downloads || [], includeDebugPayload);
  return {
    success: reportJobs.every(job => !String(job.status || '').startsWith('FAILED')),
    command: 'retrieve_report',
    reportIds,
    status: result.status,
    reports: compactReportsForAgent(result.reports),
    downloads: downloadSummary,
    report_jobs: reportJobs,
    auto_exports: autoExports.filter(item => item.success || item.error),
    result: includeDebugPayload ? result.data : undefined,
    summary_markdown: buildAgentReportSummary({
      title: 'Amazon Ads Report Retrieved',
      command: 'retrieve_report',
      state: result.status,
      source: 'amazon_ads_report',
      period: reportJobs[0]?.period,
      usedFields: reportJobs[0]?.used_fields || [],
      job: reportJobs[0],
      reportId: reportIds[0],
      status: result.status,
      autoExport: autoExports.find(item => item.success),
      downloads: result.downloads || [],
      warnings: reportJobs.flatMap(job => job.warnings || []),
      nextActions: reportJobs[0]?.jobId ? [`Read summary with read_report_artifact jobId=${reportJobs[0].jobId} artifact=summary.`] : []
    }),
    agent_payload_note: includeDebugPayload
      ? 'Debug payload requested; raw MCP retrieve result is included.'
      : 'Downloads are summarized for agent analysis. Full raw result is omitted; Excel/CSV export paths remain in auto_exports/report_jobs.'
  };
}

async function listReportJobs(args = {}) {
  const result = listStoredReportJobs(runtimeConfig, normalizeReportJobFilters(args));
  markLastRun('list_report_jobs', true, { count: result.count });
  return {
    success: true,
    command: 'list_report_jobs',
    ...result,
    guidance: [
      'This is a lightweight index only; use display_name/report_type/period to choose one jobId before reading artifacts.',
      'Use continue_report_job for PENDING/PROCESSING jobs.',
      'Use read_report_artifact artifact=summary for completed jobs, then artifact=rows for complete compact rows; pass limit/offset only when the user asks for a sample.',
      'Use export_report_artifact format=xlsx when the user wants a human-readable spreadsheet.'
    ]
  };
}

async function getReportJob(args = {}) {
  const job = findReportJob(runtimeConfig, normalizeReportJobFilters(args));
  markLastRun('get_report_job', Boolean(job), { jobId: job?.jobId });
  if (!job) {
    return {
      success: false,
      command: 'get_report_job',
      found: false,
      error: 'Report job not found. Call list_report_jobs first.'
    };
  }
  return {
    success: true,
    command: 'get_report_job',
    found: true,
    job: compactJob(job),
    next_actions: [
      `Read summary: read_report_artifact jobId=${job.jobId} artifact=summary`,
      `Read compact rows: read_report_artifact jobId=${job.jobId} artifact=rows`,
      `Export for human review: export_report_artifact jobId=${job.jobId} format=xlsx`
    ]
  };
}

async function continueReportJob(args = {}) {
  const job = findReportJob(runtimeConfig, normalizeReportJobFilters(args));
  if (!job) {
    return {
      success: false,
      command: 'continue_report_job',
      found: false,
      error: 'Report job not found. Call list_report_jobs first, then pass jobId.'
    };
  }
  if (!job.reportId) {
    return {
      success: false,
      command: 'continue_report_job',
      found: true,
      job: compactJob(job),
      error: 'This report job has no reportId, so it cannot be continued against Amazon Ads MCP.'
    };
  }
  const download = args.download !== false && args.download !== 'false';
  const result = await withClient(async client => {
    const reporting = new ReportingService({ mcpClient: client, runtimeConfig });
    return reporting.retrieveReportWithDownloads(job.reportId, { download, includeArtifactData: true });
  });
  const report = result.report || (result.reports || []).find(item => item?.reportId === job.reportId) || null;
  const state = classifyReportRetrievalState({ ...result, report }, job.status);
  const stored = upsertReportJob(runtimeConfig, {
    jobId: job.jobId,
    reportId: job.reportId,
    status: state.status || result.status || report?.status || job.status,
    command: job.command,
    preset: job.preset,
    account: job.account,
    period: job.period,
    used_fields: job.used_fields,
    jobKey: job.jobKey,
    error: state.error || job.error || null,
    warnings: state.error
      ? [...(state.warnings || []), `Report cannot be reused for analysis yet: ${state.error.message || state.error.code}.`]
      : result.status && ['PENDING', 'PROCESSING'].includes(result.status)
      ? ['Report is still processing. Continue the same job later; do not create a duplicate report.']
      : [...(state.warnings || [])]
  }, {
    request: {
      reportId: job.reportId,
      continuedFromJobId: job.jobId,
      download
    },
    report,
    downloads: result.downloads,
    rawResult: result.data
  });
  const autoExport = await autoExportCompletedReport(stored.job);
  markLastRun('continue_report_job', true, { jobId: job.jobId, reportId: job.reportId, status: stored.job.status });
  const includeDebugPayload = wantsDebugPayload(args);
  const compactStoredJob = compactJob(stored.job);
  const compactAutoExport = compactAutoExportResult(autoExport);
  const nextActions = state.ok
    ? [
        stored.job.status && ['PENDING', 'PROCESSING'].includes(stored.job.status)
          ? `Wait and call continue_report_job again with jobId=${job.jobId}; do not create a replacement report.`
          : `Read the archived summary with read_report_artifact jobId=${job.jobId} artifact=summary.`,
        `For row-level analysis, call read_report_artifact jobId=${job.jobId} artifact=rows.`
      ]
    : [
        String(stored.job.status || '').toUpperCase().includes('DOWNLOAD_FAILED')
          ? `Retry continue_report_job with jobId=${job.jobId} to request a fresh Amazon download URL.`
          : 'Do not reuse this reportId.',
        String(stored.job.status || '').toUpperCase().includes('DOWNLOAD_FAILED')
          ? 'Do not interpret row_count=0 as no data until a download succeeds.'
          : 'Create a new report with get_report_data or get_target_performance using the exact requested date range and verified fields.'
      ];
  return {
    success: state.ok,
    command: 'continue_report_job',
    jobId: job.jobId,
    reportId: job.reportId,
    status: stored.job.status,
    job: compactStoredJob,
    auto_export: compactAutoExport,
    reports: compactReportsForAgent(result.reports),
    downloads: compactDownloadsForAgent(result.downloads || [], includeDebugPayload),
    result: includeDebugPayload ? result.data : undefined,
    error: state.error,
    next_actions: nextActions,
    summary_markdown: buildAgentReportSummary({
      title: 'Amazon Ads Report Continued',
      command: 'continue_report_job',
      state: stored.job.status,
      source: 'amazon_ads_report',
      account: stored.job.account,
      preset: stored.job.preset,
      period: stored.job.period,
      usedFields: stored.job.used_fields,
      job: compactStoredJob,
      reportId: job.reportId,
      status: stored.job.status,
      autoExport: compactAutoExport,
      downloads: result.downloads || [],
      warnings: stored.job.warnings,
      nextActions
    }),
    agent_payload_note: includeDebugPayload
      ? 'Debug payload requested; raw MCP retrieve result is included.'
      : 'Agent payload is compact. Download previews/rows and raw MCP result are omitted; use read_report_artifact rows or exported Excel/CSV for details.'
  };
}

async function readReportArtifact(args = {}) {
  const result = readStoredReportArtifact(runtimeConfig, normalizeReportJobFilters(args));
  markLastRun('read_report_artifact', Boolean(result.found), { jobId: result.job?.jobId, artifact: result.artifact });
  return {
    success: Boolean(result.found && !result.error),
    command: 'read_report_artifact',
    ...result,
    safety: {
      paginated: false,
      note: 'Read summaries first. Rows return all remaining compact rows by default; pass offset/limit only when the user explicitly wants a slice. downloads.json is summarized unless format=raw/debug is explicitly requested.'
    }
  };
}

async function exportReportArtifact(args = {}) {
  const result = await exportStoredReportArtifact(runtimeConfig, normalizeReportJobFilters(args));
  markLastRun('export_report_artifact', Boolean(result.found), { jobId: result.job?.jobId, exported: result.exported?.length || 0 });
  return {
    success: Boolean(result.found && !result.error),
    command: 'export_report_artifact',
    ...result,
    guidance: [
      'Use the exported xlsx/csv for human review.',
      'For agent analysis, prefer summary, compact rows, build_report_context, or aggregate_report_archives.'
    ]
  };
}

async function autoExportCompletedReport(job) {
  if (!job || String(job.status || '').toUpperCase() !== 'COMPLETED' || Number(job.row_count || 0) <= 0) {
    return null;
  }
  try {
    return await exportStoredReportArtifact(runtimeConfig, { jobId: job.jobId, format: 'all' });
  } catch (error) {
    return {
      success: false,
      error: compactError(error)
    };
  }
}

function compactAutoExportResult(result) {
  if (!result) return null;
  return {
    success: Boolean(result.found && !result.error),
    exported: result.exported || [],
    error: result.error || null,
    note: result.note || null
  };
}

async function findReportArchives(args = {}) {
  const result = findStoredReportArchives(runtimeConfig, normalizeReportJobFilters(args));
  markLastRun('find_report_archives', true, {
    reportKind: result.reportKind,
    count: result.count
  });
  return {
    success: true,
    command: 'find_report_archives',
    ...result,
    guidance: [
      'Use build_report_context for a clean analysis package.',
      'Use aggregate_report_archives when the user asks for totals or grouped comparison.',
      'Do not read report files directly unless debugging the archive store.'
    ]
  };
}

async function buildReportContext(args = {}) {
  const result = buildStoredReportContext(runtimeConfig, normalizeReportJobFilters(args));
  markLastRun('build_report_context', true, {
    reportKind: result.reportKind,
    count: result.count
  });
  return {
    success: true,
    command: 'build_report_context',
    ...result
  };
}

async function aggregateReportArchives(args = {}) {
  const result = aggregateStoredReportArchives(runtimeConfig, normalizeReportJobFilters(args));
  markLastRun('aggregate_report_archives', true, {
    reportKind: result.reportKind,
    count: result.count
  });
  return {
    success: true,
    command: 'aggregate_report_archives',
    ...result
  };
}

async function getReportData(args = {}) {
  const dateArgs = normalizeReportDataDateArgs(args);
  const account = resolveAccount(dateArgs, runtimeConfig);
  const { startDate, endDate, days, date_resolution: dateResolution } = resolveReportDataDateRange(dateArgs);
  const period = { startDate, endDate, days };
  const requestedDataNeed = dateArgs.dataNeed || dateArgs.data_need || dateArgs.need;
  const config = getReportKindConfig(dateArgs.reportKind || dateArgs.report_kind || dateArgs.kind, requestedDataNeed);
  const presetName = dateArgs.preset || dateArgs.reportPreset || dateArgs.report_preset || config.presetName;
  const { preset } = getPreset(runtimeConfig, presetName);
  const fieldPlan = buildDataNeedFields({ args: dateArgs, preset, config });

  if (fieldPlan.unknownFields.length > 0) {
    markLastRun('get_report_data', false, { state: 'UNKNOWN_FIELDS', presetName });
    return {
      success: false,
      command: 'get_report_data',
      state: 'UNKNOWN_FIELDS',
      reportKind: config.reportKind,
      ...reportRoutePayload(config),
      account,
      preset: presetName,
      period,
      date_resolution: dateResolution,
      data_need: fieldPlan.dataNeed,
      requested_fields: fieldPlan.requestedFields,
      unknown_fields: fieldPlan.unknownFields,
      verified_fields: preset.verified_fields || [],
      allowed_candidate_fields: preset.candidate_fields || [],
      warnings: ['Requested fields are not in the local AmazonAds verified/candidate field list, so no Amazon report was created.'],
      next_actions: [
        'Confirm the field names from official Amazon Ads MCP/API references before adding them to the preset.',
        'If Amazon changed the schema, update report-field-presets or plugin defaults, then retry.'
      ]
    };
  }

  if (fieldPlan.requiresProbe) {
    const verifiedForProbe = new Set(fieldPlan.verifiedFields.map(field => String(field).toLowerCase()));
    const probeCandidates = uniqueFields(fieldPlan.unverifiedCandidateFields.flatMap(field => [...getFieldDependencies(field), field]))
      .filter(field => !verifiedForProbe.has(String(field).toLowerCase()));
    const maxProbeFields = Math.max(1, Number(runtimeConfig.probeMaxCandidateFields || 4));
    const probePlanBatches = chunkList(probeCandidates, maxProbeFields);
    const recommendedProbeBatch = probePlanBatches[0] || [];
    markLastRun('get_report_data', false, { state: 'NEEDS_FIELD_PROBE', presetName });
    return {
      success: false,
      command: 'get_report_data',
      state: 'NEEDS_FIELD_PROBE',
      reportKind: config.reportKind,
      ...reportRoutePayload(config),
      account,
      preset: presetName,
      period,
      date_resolution: dateResolution,
      data_need: fieldPlan.dataNeed,
      requested_fields: fieldPlan.requestedFields,
      usable_verified_fields: fieldPlan.fields,
      missing_fields: fieldPlan.missingFields,
      unknown_fields: fieldPlan.unknownFields,
      probe_candidate_fields: recommendedProbeBatch,
      probe_plan_batches: probePlanBatches,
      probe_strategy: {
        mode: 'serial_batches',
        max_candidate_fields_per_call: maxProbeFields,
        recommended_first_batch: recommendedProbeBatch,
        rule: 'Call probe_report_fields once with the whole recommended_first_batch joined by commas. Do not split it into one call per field unless a previous batch hit 429.'
      },
      recommended_probe_request: recommendedProbeBatch.length > 0
        ? {
            command: 'probe_report_fields',
            preset: presetName,
            candidateFields: recommendedProbeBatch.join(','),
            days: 1,
            marketplace: account.marketplace
          }
        : null,
      field_dependencies: Object.fromEntries(fieldPlan.unverifiedCandidateFields.map(field => [field, getFieldDependencies(field)])),
      warnings: ['Requested data requires fields that are not verified for this preset. No report was created.'],
      next_actions: [
        'Use recommended_probe_request as-is, so one probe call tests the whole first batch.',
        'After one probe batch returns, retry get_report_data before probing any later batch unless it still returns NEEDS_FIELD_PROBE.',
        'Or retry get_report_data with dataNeed=traffic_basic / allowPartial=true to create a verified-fields report.'
      ]
    };
  }

  const jobKey = buildReportJobKey({
    command: config.commandName,
    account,
    preset: presetName,
    period,
    fields: fieldPlan.fields
  });
  const exactJob = findReusableReportJob(runtimeConfig, { jobKey });
  if (hasUsableArchivedRows(exactJob, fieldPlan.fields)) {
    const autoExport = await autoExportCompletedReport(exactJob);
    const context = buildStoredReportContext(runtimeConfig, {
      reportKind: config.reportKind,
      dateFrom: startDate,
      dateTo: endDate,
      marketplace: account.marketplace,
      mode: dateArgs.contextMode || dateArgs.context_mode || 'summary_only',
      limitRowsPerJob: dateArgs.limitRowsPerJob || dateArgs.limit_rows_per_job || 0,
      requiredFields: fieldPlan.fields.join(',')
    });
    markLastRun('get_report_data', true, { state: 'READY', jobId: exactJob.jobId });
    return {
      success: true,
      command: 'get_report_data',
      state: 'READY',
      source: 'archive',
      reportKind: config.reportKind,
      ...reportRoutePayload(config),
      account,
      preset: presetName,
      period,
      date_resolution: dateResolution,
      data_need: fieldPlan.dataNeed,
      used_fields: fieldPlan.fields,
      jobId: exactJob.jobId,
      reportId: exactJob.reportId,
      job: compactJob(exactJob),
      auto_export: compactAutoExportResult(autoExport),
      context: compactContextForAgent(context, dateArgs),
      summary_markdown: buildAgentReportSummary({
        title: 'Amazon Ads Report Data Ready',
        command: 'get_report_data',
        state: 'READY',
        source: 'archive',
        account,
        preset: presetName,
        period,
        usedFields: fieldPlan.fields,
        job: compactJob(exactJob),
        reportId: exactJob.reportId,
        status: exactJob.status,
        autoExport: compactAutoExportResult(autoExport),
        warnings: exactJob.warnings || [],
        nextActions: [`Analyze with aggregate_report_archives or read_report_artifact jobId=${exactJob.jobId} artifact=rows.`]
      })
    };
  }

  const coveringArchives = findStoredReportArchives(runtimeConfig, {
    reportKind: config.reportKind,
    dateFrom: startDate,
    dateTo: endDate,
    marketplace: account.marketplace,
    status: 'COMPLETED',
    requiredFields: fieldPlan.fields.join(',')
  });
  const coveringArchive = (coveringArchives.jobs || []).find(job =>
    (!startDate || String(job.period?.startDate || '') <= String(startDate))
      && (!endDate || String(job.period?.endDate || '') >= String(endDate))
  );
  const coveringJob = coveringArchive
    ? findReportJob(runtimeConfig, { jobId: coveringArchive.jobId })
    : null;
  if (hasUsableArchivedRows(coveringJob, fieldPlan.fields)) {
    const autoExport = await autoExportCompletedReport(coveringJob);
    const context = buildStoredReportContext(runtimeConfig, {
      reportKind: config.reportKind,
      dateFrom: startDate,
      dateTo: endDate,
      marketplace: account.marketplace,
      mode: dateArgs.contextMode || dateArgs.context_mode || 'summary_only',
      limitRowsPerJob: dateArgs.limitRowsPerJob || dateArgs.limit_rows_per_job || 0,
      requiredFields: fieldPlan.fields.join(',')
    });
    markLastRun('get_report_data', true, { state: 'READY', jobId: coveringJob.jobId });
    return {
      success: true,
      command: 'get_report_data',
      state: 'READY',
      source: 'covering_archive',
      reportKind: config.reportKind,
      ...reportRoutePayload(config),
      account,
      preset: presetName,
      period,
      date_resolution: dateResolution,
      data_need: fieldPlan.dataNeed,
      used_fields: coveringJob.used_fields || fieldPlan.fields,
      requested_fields: fieldPlan.fields,
      jobId: coveringJob.jobId,
      reportId: coveringJob.reportId,
      job: compactJob(coveringJob),
      auto_export: compactAutoExportResult(autoExport),
      context: compactContextForAgent(context, dateArgs),
      summary_markdown: buildAgentReportSummary({
        title: 'Amazon Ads Report Data Ready',
        command: 'get_report_data',
        state: 'READY',
        source: 'covering_archive',
        account,
        preset: presetName,
        period,
        usedFields: coveringJob.used_fields || fieldPlan.fields,
        job: compactJob(coveringJob),
        reportId: coveringJob.reportId,
        status: coveringJob.status,
        autoExport: compactAutoExportResult(autoExport),
        warnings: coveringJob.warnings || [],
        nextActions: [`Analyze with aggregate_report_archives or read_report_artifact jobId=${coveringJob.jobId} artifact=rows.`]
      }),
      warnings: ['Reused a completed archive whose fields cover the requested fields, so no duplicate Amazon report was created.']
    };
  }

  if (isContinuableReportJob(exactJob)) {
    const continued = await continueReportJob({ jobId: exactJob.jobId, download: true });
    if (continued.success && hasUsableArchivedRows(continued.job, fieldPlan.fields)) {
      const context = buildStoredReportContext(runtimeConfig, {
        reportKind: config.reportKind,
        dateFrom: startDate,
        dateTo: endDate,
        marketplace: account.marketplace,
        mode: dateArgs.contextMode || dateArgs.context_mode || 'summary_only',
        limitRowsPerJob: dateArgs.limitRowsPerJob || dateArgs.limit_rows_per_job || 0,
        requiredFields: fieldPlan.fields.join(',')
      });
      markLastRun('get_report_data', true, { state: 'READY', jobId: exactJob.jobId });
      return {
        success: true,
        command: 'get_report_data',
        state: 'READY',
        source: 'continued_archive',
        reportKind: config.reportKind,
        ...reportRoutePayload(config),
        account,
        preset: presetName,
        period,
        date_resolution: dateResolution,
        data_need: fieldPlan.dataNeed,
        used_fields: fieldPlan.fields,
        jobId: exactJob.jobId,
        reportId: exactJob.reportId,
        continue_result: compactReportResultForAgent(continued, dateArgs),
        context: compactContextForAgent(context, dateArgs)
      };
    }
    if (continued.success && continued.status && ['PENDING', 'PROCESSING'].includes(String(continued.status).toUpperCase())) {
      markLastRun('get_report_data', true, { state: 'PROCESSING', jobId: exactJob.jobId });
      return {
        success: true,
        command: 'get_report_data',
        state: 'PROCESSING',
        source: 'existing_report_job',
        reportKind: config.reportKind,
        ...reportRoutePayload(config),
        account,
        preset: presetName,
        period,
        date_resolution: dateResolution,
        data_need: fieldPlan.dataNeed,
        used_fields: fieldPlan.fields,
        jobId: exactJob.jobId,
        reportId: exactJob.reportId,
        continue_result: compactReportResultForAgent(continued, dateArgs),
        next_actions: [`Wait and call get_report_data or continue_report_job with jobId=${exactJob.jobId}.`]
      };
    }
    if ((dateArgs.mode || 'get_or_create') === 'archive_only') {
      return {
        success: false,
        command: 'get_report_data',
        state: buildGetReportDataState(continued.status, 'FAILED_NOT_REUSABLE'),
        source: 'existing_report_job',
        reportKind: config.reportKind,
        ...reportRoutePayload(config),
        account,
        preset: presetName,
        period,
        date_resolution: dateResolution,
        continue_result: compactReportResultForAgent(continued, dateArgs),
        next_actions: ['archive_only mode did not create a replacement report.']
      };
    }
  }

  if ((dateArgs.mode || 'get_or_create') === 'archive_only') {
    const archives = findStoredReportArchives(runtimeConfig, {
      reportKind: config.reportKind,
      dateFrom: startDate,
      dateTo: endDate,
      marketplace: account.marketplace,
      requiredFields: fieldPlan.fields.join(',')
    });
    markLastRun('get_report_data', archives.count > 0, { state: archives.count > 0 ? 'READY' : 'NO_ARCHIVE' });
    return {
      success: archives.count > 0,
      command: 'get_report_data',
      state: archives.count > 0 ? 'READY' : 'NO_ARCHIVE',
      source: 'archive_only',
      reportKind: config.reportKind,
      ...reportRoutePayload(config),
      account,
      preset: presetName,
      period,
      date_resolution: dateResolution,
      used_fields: fieldPlan.fields,
      archives,
      next_actions: archives.count > 0
        ? ['Use build_report_context or aggregate_report_archives to analyze matching archives.']
        : ['No completed archive exists. Retry with mode=get_or_create to create a new Amazon Ads report.']
    };
  }

  const created = await getPerformance({
    ...dateArgs,
    startDate,
    endDate,
    accountName: account.accountName,
    marketplace: account.marketplace,
    preset: presetName,
    fields: fieldPlan.fields.join(','),
    allowUnverifiedFields: fieldPlan.usingUnverifiedCandidateFields,
    forceNew: !isContinuableReportJob(exactJob)
  }, presetName, config.commandName);
  const state = created.success
    ? (created.reportId && created.reused_report === false && ['PENDING', 'PROCESSING'].includes(String(created.status || '').toUpperCase())
        ? 'CREATED'
        : buildGetReportDataState(created.status, created.reportId ? 'CREATED' : 'UNKNOWN'))
    : 'FAILED_NOT_REUSABLE';
  markLastRun('get_report_data', created.success, { state, jobId: created.jobId, reportId: created.reportId });
  return {
    success: created.success,
    command: 'get_report_data',
    state,
    source: 'amazon_ads_report',
    reportKind: config.reportKind,
    ...reportRoutePayload(config),
    account,
    preset: presetName,
    period,
    date_resolution: dateResolution,
    data_need: fieldPlan.dataNeed,
    requested_fields: fieldPlan.requestedFields,
    used_fields: fieldPlan.fields,
    missing_fields: fieldPlan.missingFields,
    unverified_candidate_fields_used: fieldPlan.usingUnverifiedCandidateFields ? fieldPlan.unverifiedCandidateFields : [],
    report_result: compactReportResultForAgent(created, dateArgs),
    summary_markdown: created.summary_markdown || buildAgentReportSummary({
      title: 'Amazon Ads Report Data',
      command: 'get_report_data',
      state,
      source: 'amazon_ads_report',
      account,
      preset: presetName,
      period,
      usedFields: fieldPlan.fields,
      job: created.report_job || created.job,
      reportId: created.reportId,
      status: created.status,
      autoExport: created.auto_export,
      warnings: created.warnings || [],
      nextActions: created.next_actions || []
    }),
    next_actions: created.success
      ? [
          ['CREATED', 'PROCESSING'].includes(state)
            ? `Wait and call get_report_data again with the same date/reportKind, or continue_report_job jobId=${created.jobId}.`
            : state === 'READY'
              ? `Read data with read_report_artifact jobId=${created.jobId} artifact=summary/rows.`
              : 'No analyzable rows are available yet.',
          'Do not create a duplicate report for the same date range and fields.'
        ]
      : [
          ...(created.next_actions || []),
          ...(fieldPlan.usingUnverifiedCandidateFields
            ? ['If Amazon rejected a field as unknown/invalid, retry with probeBeforeUse=true or call probe_report_fields only for the rejected fields.']
            : [])
        ]
  };
}

async function listReportPresets() {
  const { presetPath, presets } = loadPresets(runtimeConfig);
  return {
    success: true,
    command: 'list_report_presets',
    preset_path: presetPath,
    presets: Object.entries(presets).map(([name, preset]) => ({
      name,
      level: preset.level,
      description: preset.description,
      verified_fields: preset.verified_fields || [],
      candidate_fields: preset.candidate_fields || [],
      last_probe: preset.last_probe || null
    }))
  };
}

async function probeReportFields(args = {}) {
  const account = resolveAccount(args, runtimeConfig);
  const presetName = args.preset || args.reportPreset || args.report_preset || 'campaign_basic';
  const { preset } = getPreset(runtimeConfig, presetName);
  const requestedDays = Number(args.days || args.lastDays || 1) || 1;
  const hasExplicitDateRange = Boolean(
    args.startDate || args.start_date || args.endDate || args.end_date
    || args.dateFrom || args.date_from || args.dateTo || args.date_to
    || args.date || args.reportDate || args.report_date
    || args.period || args.datePreset || args.date_preset
  );
  const probeArgs = hasExplicitDateRange ? args : { ...args, days: 1 };
  const { startDate, endDate, days } = resolveDateRange(probeArgs);
  const baseFields = parseFields(args.baseFields || args.base_fields, preset.verified_fields || DEFAULT_BASE_FIELDS);
  let candidateFields = parseFields(args.candidateFields || args.candidate_fields, preset.candidate_fields || []);
  const fieldValidation = validateFieldsAgainstPreset(candidateFields, preset, presetName, { allowCandidateFields: true });
  if (!fieldValidation.ok) {
    return {
      success: false,
      command: 'probe_report_fields',
      error: fieldValidation.message,
      field_validation: fieldValidation,
      next_actions: [
        'Use list_report_presets to inspect verified_fields and candidate_fields.',
        'Only probe fields listed in candidate_fields; do not invent Amazon Ads report fields.'
      ]
    };
  }
  const maxCandidateFields = Math.max(1, Number(runtimeConfig.probeMaxCandidateFields || 4));
  const originalCandidateCount = uniqueFields(candidateFields).length;
  candidateFields = uniqueFields(candidateFields).slice(0, maxCandidateFields);
  if (candidateFields.length === 0) {
    return { success: false, command: 'probe_report_fields', error: `Preset ${presetName} has no candidate fields.` };
  }
  const result = await withClient(async (client, serverConfig) => {
    const reporting = new ReportingService({
      mcpClient: client,
      runtimeConfig,
      fixedAccountContext: hasFixedAccountHeaders(serverConfig)
    });
    return reporting.probeFields({
      accountId: account.adsAccountId,
      startDate,
      endDate,
      baseFields,
      candidateFields,
      fieldDependencies: REPORT_FIELD_DEPENDENCIES
    });
  });
  const presetPath = updatePresetProbe(runtimeConfig, presetName, result);
  markLastRun('probe_report_fields', true, { presetName });
  const warnings = [];
  const nextActions = [];
  if (!hasExplicitDateRange && requestedDays > 1) {
    warnings.push('Field probing uses a 1-day date range to reduce report creation load and avoid rate limits.');
  }
  if (result.stopped_by_rate_limit) {
    warnings.push('Amazon Ads MCP rate limit was hit; remaining candidate fields were skipped.');
    nextActions.push('Stop creating new reports for several minutes; only retrieve existing reportIds.');
    nextActions.push('Retry probe_report_fields later with only skipped_fields, using a smaller batch if needed.');
  }
  if ((result.success_fields || []).length > 0) {
    nextActions.push('Field probe only verifies schema; it does not create the requested analysis report.');
    nextActions.push('If the user still needs data, call get_report_data again with the original reportKind/date range/dataNeed and wait for CREATED/PROCESSING/READY.');
    nextActions.push('Do not claim report data is ready from probe_report_fields alone.');
  }
  if (originalCandidateCount > candidateFields.length) {
    warnings.push(`Probe candidateFields was limited to ${candidateFields.length} fields to reduce rate-limit risk.`);
    nextActions.push('Probe remaining candidate fields in a later sequential call after current report tasks settle.');
  }
  if (candidateFields.length === 1 && !result.stopped_by_rate_limit) {
    warnings.push('Single-field probing is allowed, but batch probing is preferred. When following get_report_data, pass the whole recommended_probe_request.candidateFields instead of splitting fields one by one.');
  }
  return {
    success: true,
    command: 'probe_report_fields',
    account,
    preset: presetName,
    preset_path: presetPath,
    period: { startDate, endDate, days },
    base_fields: baseFields,
    probed_candidate_fields: candidateFields,
    warnings,
    next_actions: nextActions,
    ...result
  };
}

async function getPerformance(args = {}, defaultPreset, commandName) {
  const account = resolveAccount(args, runtimeConfig);
  const { startDate, endDate, days } = resolveDateRange(args);
  const download = args.download !== false && args.download !== 'false';
  const waitForCompletion = isTruthy(args.waitForCompletion || args.wait_for_completion || args.wait);
  const presetName = args.preset || args.reportPreset || args.report_preset || defaultPreset;
  const { preset } = getPreset(runtimeConfig, presetName);
  const fields = parseFields(args.fields, preset.verified_fields || [...DEFAULT_BASE_FIELDS, ...DEFAULT_OPTIONAL_FIELDS]);
  const hasExplicitFields = Boolean(args.fields);
  const allowUnverifiedFields = isTruthy(args.allowUnverifiedFields || args.allow_unverified_fields);
  const fieldValidation = validateFieldsAgainstPreset(fields, preset, presetName, {
    allowCandidateFields: hasExplicitFields && allowUnverifiedFields
  });
  if (!fieldValidation.ok) {
    return {
      success: false,
      command: commandName,
      account,
      preset: presetName,
      used_fields: fields,
      error: fieldValidation.message,
      field_validation: fieldValidation,
      warnings: ['Report was not created because requested fields are not verified for this preset.'],
      next_actions: [
        'Call list_report_presets to inspect valid fields.',
        'Call probe_report_fields with 2-4 candidateFields, then retry using only success_fields plus required base fields.',
        'Do not invent report fields from memory or from older Amazon Ads API names.'
      ]
    };
  }
  const explicitReportId = args.reportId || args.report_id;
  const period = { startDate, endDate, days };
  const jobKey = buildReportJobKey({ command: commandName, account, preset: presetName, period, fields });
  const forceNew = isTruthy(args.forceNew || args.force_new);
  const refreshArchived = isTruthy(args.refresh || args.refreshArchived || args.refresh_archived);
  const cachedJob = !forceNew ? findReusableReportJob(runtimeConfig, { jobKey }) : null;
  if (!explicitReportId && hasUsableArchivedRows(cachedJob, fields) && cachedJob?.artifact_paths?.summary && !refreshArchived) {
    const autoExport = await autoExportCompletedReport(cachedJob);
    markLastRun(commandName, true, {
      account: account.accountName,
      reportId: cachedJob.reportId,
      status: cachedJob.status
    });
    const fieldGuidance = buildPerformanceFieldGuidance(commandName, cachedJob.used_fields || fields);
    return {
      success: true,
      command: commandName,
      account,
      preset: presetName,
      reportId: cachedJob.reportId,
      jobId: cachedJob.jobId,
      status: cachedJob.status,
      period: cachedJob.period || period,
      used_fields: cachedJob.used_fields || fields,
      reused_report: true,
      archived_report: true,
      auto_export: compactAutoExportResult(autoExport),
      downloads: [],
      report: null,
      field_guidance: fieldGuidance,
      analysis_scope: fieldGuidance?.analysis_scope || 'requested_fields',
      warnings: [
        'A completed physical report archive already exists for the same request. It was not recreated.',
        ...(fieldGuidance ? [fieldGuidance.warning] : [])
      ],
      summary_markdown: buildAgentReportSummary({
        title: 'Amazon Ads Performance Report',
        command: commandName,
        state: cachedJob.status,
        source: 'archive',
        account,
        preset: presetName,
        period: cachedJob.period || period,
        usedFields: cachedJob.used_fields || fields,
        job: compactJob(cachedJob),
        reportId: cachedJob.reportId,
        status: cachedJob.status,
        autoExport: compactAutoExportResult(autoExport),
        warnings: [
          'A completed physical report archive already exists for the same request. It was not recreated.',
          ...(fieldGuidance ? [fieldGuidance.warning] : [])
        ],
        nextActions: [`Read compact rows with read_report_artifact jobId=${cachedJob.jobId} artifact=rows.`]
      }),
      ...buildReportArchiveInfo(cachedJob)
    };
  }
  const continuableCachedJob = isContinuableReportJob(cachedJob) ? cachedJob : null;
  const reportId = explicitReportId || continuableCachedJob?.reportId || null;
  const result = await withClient(async (client, serverConfig) => {
    const reporting = new ReportingService({
      mcpClient: client,
      runtimeConfig,
      fixedAccountContext: hasFixedAccountHeaders(serverConfig)
    });
    return reporting.getPerformance({
      accountId: account.adsAccountId,
      startDate,
      endDate,
      fields,
      download,
      waitForCompletion,
      reportId,
      includeArtifactData: true
    });
  });
  const stored = persistReportJob({
    command: commandName,
    account,
    preset: presetName,
    period,
    fields: result.used_fields || fields,
    jobKey,
    result,
    request: result.request_payload || { accountId: account.adsAccountId, startDate, endDate, fields, reportId },
    report: result.report,
    downloads: result.downloads,
    rawResult: result.report_create_result || result.raw_result || result.report,
    error: result.success === false ? result.error || result.report_create_result : null
  });
  const retrievalState = classifyReportRetrievalState({ ...result, report: result.report }, stored.job.status);
  const autoExport = await autoExportCompletedReport(stored.job);
  markLastRun(commandName, result.success !== false && retrievalState.ok, {
    account: account.accountName,
    reportId: result.reportId,
    status: stored.job.status
  });
  const usedFields = result.used_fields || fields;
  const fieldGuidance = buildPerformanceFieldGuidance(commandName, usedFields);
  const warnings = [...(result.warnings || []), ...(retrievalState.warnings || [])];
  if (fieldGuidance) warnings.unshift(fieldGuidance.warning);
  const outputStatus = stored.job.status || retrievalState.status || result.status || (result.reportId ? 'PENDING' : null);
  const includeDebugPayload = wantsDebugPayload(args);
  const compactStoredJob = compactJob(stored.job);
  const compactAutoExport = compactAutoExportResult(autoExport);
  const nextActions = mergeNextActions(fieldGuidance, [
    `If status is PENDING or PROCESSING, call continue_report_job with jobId=${stored.job.jobId}; do not create a duplicate report.`,
    `If status is COMPLETED_DOWNLOAD_FAILED, retry continue_report_job with jobId=${stored.job.jobId}; do not treat row_count=0 as no data.`,
    `Use read_report_artifact with jobId=${stored.job.jobId} artifact=summary or artifact=rows after the report is completed.`,
    'Use exported Excel/CSV for human review; use compact artifact rows or aggregate_report_archives for agent analysis.'
  ]);
  return {
    success: result.success !== false && retrievalState.ok,
    command: commandName,
    account,
    preset: presetName,
    reportId: result.reportId,
    jobId: stored.job.jobId,
    status: outputStatus,
    period: result.period || period,
    used_fields: usedFields,
    reused_report: Boolean(reportId),
    report_job: compactStoredJob,
    auto_export: compactAutoExport,
    downloads: compactDownloadsForAgent(result.downloads || [], includeDebugPayload),
    report: compactReportForAgent(result.report),
    error: retrievalState.error || result.error,
    field_guidance: fieldGuidance,
    analysis_scope: fieldGuidance?.analysis_scope || 'requested_fields',
    warnings,
    next_actions: nextActions,
    summary_markdown: buildAgentReportSummary({
      title: 'Amazon Ads Performance Report',
      command: commandName,
      state: outputStatus,
      source: reportId ? 'existing_report_job' : 'amazon_ads_report',
      account,
      preset: presetName,
      period: result.period || period,
      usedFields,
      job: compactStoredJob,
      reportId: result.reportId,
      status: outputStatus,
      autoExport: compactAutoExport,
      downloads: result.downloads || [],
      warnings,
      nextActions
    }),
    raw_result: includeDebugPayload ? result.report_create_result : undefined,
    agent_payload_note: includeDebugPayload
      ? 'Debug payload requested; raw report create result is included.'
      : 'Agent payload is compact. Download previews/raw rows are omitted; use read_report_artifact artifact=rows or exported Excel/CSV for details.'
  };
}

async function getCampaignPerformance(args = {}) {
  return getPerformance(args, 'campaign_basic', 'get_campaign_performance');
}

async function getPlacementPerformance(args = {}) {
  return getPerformance(args, 'placement_basic', 'get_placement_performance');
}

async function getTargetPerformance(args = {}) {
  return getPerformance(args, 'target_basic', 'get_target_performance');
}

async function getSearchTermPerformance(args = {}) {
  return getPerformance(args, 'search_term_basic', 'get_search_term_performance');
}

function promptListFromResult(data) {
  if (Array.isArray(data?.prompts)) return data.prompts;
  if (Array.isArray(data)) return data;
  return [];
}

async function listOfficialMcpGuides() {
  try {
    const data = await withClient(client => client.listPrompts());
    const prompts = promptListFromResult(data).map(prompt => ({
      name: prompt.name,
      title: prompt.title || prompt.name,
      description: prompt.description || '',
      arguments: prompt.arguments || []
    }));
    markLastRun('list_official_mcp_guides', true, { count: prompts.length });
    return { success: true, command: 'list_official_mcp_guides', supported: true, prompts };
  } catch (error) {
    markLastRun('list_official_mcp_guides', false);
    return {
      success: false,
      command: 'list_official_mcp_guides',
      supported: false,
      not_supported: true,
      error: compactError(error),
      message: 'Amazon Ads MCP did not return prompts/list through this client session. Tool calls may still work.'
    };
  }
}

async function getOfficialMcpGuide(args = {}) {
  const name = args.name || args.promptName || args.prompt_name || args.guide || args.guideName;
  if (!name) {
    return {
      success: false,
      needs_clarification: true,
      error: 'Missing prompt/guide name. Call list_official_mcp_guides first.'
    };
  }
  try {
    const result = await withClient(client => client.getPrompt(name, args.arguments || {}));
    markLastRun('get_official_mcp_guide', true, { name });
    return { success: true, command: 'get_official_mcp_guide', name, result };
  } catch (error) {
    markLastRun('get_official_mcp_guide', false, { name });
    return { success: false, command: 'get_official_mcp_guide', name, error: compactError(error) };
  }
}

async function proposeBidChanges(args = {}) {
  return proposeChanges('bid_changes', args);
}

async function proposeStateChanges(args = {}) {
  return proposeChanges('state_changes', args);
}

async function proposeBudgetChanges(args = {}) {
  return proposeChanges('budget_changes', args);
}

async function applyTargetBidChanges(args = {}) {
  const account = resolveAccount(args, runtimeConfig);
  const changes = normalizeChanges(args.changes);
  if (changes.length === 0) return { success: false, command: 'apply_target_bid_changes', error: 'Missing changes array.' };
  const admin = validateAdmin(args, runtimeConfig);
  const dryRunPayload = buildTargetBidPayload(changes, account, true);
  if (admin.dryRun) {
    return {
      success: true,
      command: 'apply_target_bid_changes',
      dryRun: true,
      account,
      change_count: changes.length,
      planned_tool: 'campaign_management-update_target_bid',
      planned_payload: dryRunPayload
    };
  }
  const result = await withClient((client, serverConfig) => {
    const payload = buildTargetBidPayload(changes, account, includeAccessRequestedAccount(serverConfig));
    return client.callTool('campaign_management-update_target_bid', payload);
  });
  markLastRun('apply_target_bid_changes', true, { count: changes.length });
  return { success: true, command: 'apply_target_bid_changes', dryRun: false, account, result };
}

async function applyEntityStateChanges(args = {}) {
  const account = resolveAccount(args, runtimeConfig);
  const changes = normalizeChanges(args.changes);
  if (changes.length === 0) return { success: false, command: 'apply_entity_state_changes', error: 'Missing changes array.' };
  const admin = validateAdmin(args, runtimeConfig, { requireDoubleConfirm: true });
  const dryRunPlan = buildEntityStatePayload(changes, account, true);
  if (admin.dryRun) {
    return {
      success: true,
      command: 'apply_entity_state_changes',
      dryRun: true,
      account,
      change_count: changes.length,
      planned_tool: dryRunPlan.tool,
      planned_payload: dryRunPlan.payload
    };
  }
  const result = await withClient((client, serverConfig) => {
    const plan = buildEntityStatePayload(changes, account, includeAccessRequestedAccount(serverConfig));
    return client.callTool(plan.tool, plan.payload);
  });
  markLastRun('apply_entity_state_changes', true, { count: changes.length });
  return { success: true, command: 'apply_entity_state_changes', dryRun: false, account, result };
}

async function applyCampaignBudgetChanges(args = {}) {
  const account = resolveAccount(args, runtimeConfig);
  const changes = normalizeChanges(args.changes);
  if (changes.length === 0) return { success: false, command: 'apply_campaign_budget_changes', error: 'Missing changes array.' };
  const admin = validateAdmin(args, runtimeConfig, { requireDoubleConfirm: true });
  const dryRunPayload = buildCampaignBudgetPayload(changes, account, true);
  if (admin.dryRun) {
    return {
      success: true,
      command: 'apply_campaign_budget_changes',
      dryRun: true,
      account,
      change_count: changes.length,
      planned_tool: 'campaign_management-update_campaign_budget',
      planned_payload: dryRunPayload
    };
  }
  const result = await withClient((client, serverConfig) => {
    const payload = buildCampaignBudgetPayload(changes, account, includeAccessRequestedAccount(serverConfig));
    return client.callTool('campaign_management-update_campaign_budget', payload);
  });
  markLastRun('apply_campaign_budget_changes', true, { count: changes.length });
  return { success: true, command: 'apply_campaign_budget_changes', dryRun: false, account, result };
}

async function initialize(config = {}, dependencies = {}) {
  runtimeConfig = buildRuntimeConfig(config);
  logFunctions = dependencies.vcpLogFunctions || logFunctions;
  startTokenAutoRefresh();
  console.log('[AmazonAds] Plugin initialized.');
}

async function processToolCall(args = {}) {
  const command = String(args.command || '').trim();
  try {
    debugLog('command', command);
    switch (command) {
      case 'get_status':
        return await getStatus();
      case 'refresh_token':
        return await refreshToken(args);
      case 'list_capabilities':
        return await listCapabilities();
      case 'list_accounts':
        return await listAccounts(args);
      case 'get_account':
        return await getAccount(args);
      case 'call_read_tool':
        return await callReadTool(args);
      case 'list_campaigns':
        return await listCampaigns(args);
      case 'list_ad_groups':
        return await listAdGroups(args);
      case 'list_ads':
        return await listAds(args);
      case 'list_targets':
        return await listTargets(args);
      case 'check_product_eligibility':
        return await checkProductEligibility(args);
      case 'get_billing_status':
        return await getBillingStatus(args);
      case 'list_account_users':
        return await listAccountUsers(args);
      case 'create_report':
        return await createReport(args);
      case 'retrieve_report':
        return await retrieveReport(args);
      case 'get_report_status':
        return await retrieveReport(args);
      case 'download_report':
        return await retrieveReport({ ...args, download: true });
      case 'list_report_jobs':
        return await listReportJobs(args);
      case 'get_report_job':
        return await getReportJob(args);
      case 'continue_report_job':
        return await continueReportJob(args);
      case 'read_report_artifact':
        return await readReportArtifact(args);
      case 'export_report_artifact':
      case 'export_report':
        return await exportReportArtifact(args);
      case 'get_report_data':
        return await getReportData(args);
      case 'find_report_archives':
        return await findReportArchives(args);
      case 'build_report_context':
        return await buildReportContext(args);
      case 'aggregate_report_archives':
        return await aggregateReportArchives(args);
      case 'list_report_presets':
        return await listReportPresets(args);
      case 'probe_report_fields':
        return await probeReportFields(args);
      case 'get_campaign_performance':
        return await getCampaignPerformance(args);
      case 'get_placement_performance':
        return await getPlacementPerformance(args);
      case 'get_target_performance':
        return await getTargetPerformance(args);
      case 'get_search_term_performance':
        return await getSearchTermPerformance(args);
      case 'propose_bid_changes':
        return await proposeBidChanges(args);
      case 'propose_state_changes':
        return await proposeStateChanges(args);
      case 'propose_budget_changes':
        return await proposeBudgetChanges(args);
      case 'apply_target_bid_changes':
        return await applyTargetBidChanges(args);
      case 'apply_entity_state_changes':
        return await applyEntityStateChanges(args);
      case 'apply_campaign_budget_changes':
        return await applyCampaignBudgetChanges(args);
      case 'list_official_mcp_guides':
        return await listOfficialMcpGuides(args);
      case 'get_official_mcp_guide':
        return await getOfficialMcpGuide(args);
      default:
        return {
          success: false,
          plugin_error: `Unknown command: ${command || '(empty)'}`,
          supported_commands: [
            'get_status',
            'refresh_token',
            'list_capabilities',
            'list_accounts',
            'get_account',
            'call_read_tool',
            'list_campaigns',
            'list_ad_groups',
            'list_ads',
            'list_targets',
            'check_product_eligibility',
            'get_billing_status',
            'list_account_users',
            'create_report',
            'retrieve_report',
            'get_report_status',
            'download_report',
            'list_report_jobs',
            'get_report_job',
            'continue_report_job',
            'read_report_artifact',
            'export_report_artifact',
            'get_report_data',
            'find_report_archives',
            'build_report_context',
            'aggregate_report_archives',
            'list_report_presets',
            'probe_report_fields',
            'get_campaign_performance',
            'get_placement_performance',
            'get_target_performance',
            'get_search_term_performance',
            'propose_bid_changes',
            'propose_state_changes',
            'propose_budget_changes',
            'apply_target_bid_changes',
            'apply_entity_state_changes',
            'apply_campaign_budget_changes',
            'list_official_mcp_guides',
            'get_official_mcp_guide'
          ]
        };
    }
  } catch (error) {
    console.error(`[AmazonAds] Command failed (${command}):`, error);
    logFunctions.pushVcpLog?.({
      type: 'amazon_ads_error',
      command,
      error: compactError(error),
      timestamp: nowIso()
    });
    markLastRun(command, false);
    return {
      success: false,
      command,
      plugin_error: error.message || 'AmazonAds command failed.',
      error: compactError(error)
    };
  }
}

function shutdown() {
  clearTokenRefreshTimer();
  debugLog('Plugin shutdown.');
}

module.exports = {
  initialize,
  processToolCall,
  shutdown
};
