const zlib = require('zlib');
const fetchFn = globalThis.fetch || require('undici').fetch;

let lastReportCreateAt = 0;

const DEFAULT_BASE_FIELDS = ['date.value', 'campaign.id', 'metric.clicks'];
const DEFAULT_OPTIONAL_FIELDS = [
  'campaign.name',
  'metric.impressions'
];

const FIELD_ERROR_PATTERNS = [
  { code: 'unknown_field', pattern: /field ([^"' ,]+) is unknown/i },
  { code: 'invalid_field_format', pattern: /field ([^"' ,]+) has invalid format/i },
  { code: 'missing_dependent_field', pattern: /field ([^"' ,]+) cannot be used without also including fields/i },
  { code: 'missing_metric', pattern: /fields must contain at least one metric/i },
  { code: 'missing_dimension', pattern: /fields must contain at least one level-of-detail dimension/i },
  { code: 'missing_time_dimension', pattern: /fields must contain exactly one time-related dimension/i }
];

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function dateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return toIsoDate(date);
}

function isIsoDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function inclusiveDateDays(startDate, endDate) {
  if (!isIsoDateString(startDate) || !isIsoDateString(endDate)) return null;
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return Math.max(1, Math.floor((end.getTime() - start.getTime()) / 86400000) + 1);
}

function resolveDateRange(args = {}) {
  const fallbackDays = Math.max(1, Math.min(Number(args.days || args.lastDays || 30) || 30, 365));
  let startDate = args.startDate || args.start_date || args.dateFrom || args.date_from || null;
  let endDate = args.endDate || args.end_date || args.dateTo || args.date_to || null;
  const singleDate = args.date || args.reportDate || args.report_date;

  if (isIsoDateString(singleDate)) {
    startDate = String(singleDate);
    endDate = String(singleDate);
  }

  const datePreset = String(args.period || args.datePreset || args.date_preset || '').toLowerCase();
  if (datePreset === 'yesterday') {
    const yesterday = dateDaysAgo(1);
    startDate = yesterday;
    endDate = yesterday;
  }

  if (!endDate) endDate = dateDaysAgo(1);
  if (!startDate) startDate = dateDaysAgo(fallbackDays);

  if (isIsoDateString(startDate) && isIsoDateString(endDate) && String(startDate) > String(endDate)) {
    throw new Error(`Invalid date range: startDate ${startDate} is after endDate ${endDate}`);
  }

  const days = inclusiveDateDays(startDate, endDate) || fallbackDays;
  return { startDate, endDate, days };
}

function normalizeFields(fields) {
  if (Array.isArray(fields)) return fields.map(String).filter(Boolean);
  if (typeof fields === 'string') {
    return fields.split(',').map(item => item.trim()).filter(Boolean);
  }
  return [];
}

function classifyReportError(error) {
  const text = JSON.stringify(error?.data || error?.body || error?.message || error || '');
  for (const item of FIELD_ERROR_PATTERNS) {
    const match = text.match(item.pattern);
    if (match) {
      return {
        code: item.code,
        field: match[1] || null,
        message: text.slice(0, 1000)
      };
    }
  }
  if (/expired|403|signature/i.test(text)) {
    return { code: 'download_url_expired', field: null, message: text.slice(0, 1000) };
  }
  if (/429|too many requests/i.test(text)) {
    return { code: 'rate_limited', field: null, message: text.slice(0, 1000) };
  }
  return { code: 'report_error', field: null, message: text.slice(0, 1000) };
}

function buildMissingReportIdWarning(data) {
  const classified = classifyReportError(data);
  if (classified.code === 'rate_limited') {
    return 'Amazon Ads MCP is rate limited. Wait before retrying; do not create parallel replacement reports.';
  }
  if (classified.code && classified.code !== 'report_error') {
    return `Amazon Ads MCP did not return a reportId because of ${classified.code}${classified.field ? `: ${classified.field}` : ''}.`;
  }
  return 'Amazon Ads MCP did not return a reportId.';
}

function mapFieldsForApi(fields) {
  const mapped = [];
  for (const field of fields || []) {
    const fLower = String(field).toLowerCase().trim();
    if (fLower === 'metric.spend' || fLower === 'metric.cost' || fLower === 'spend' || fLower === 'cost') {
      mapped.push('metric.totalCost');
    } else if (fLower === 'metric.orders' || fLower === 'orders' || fLower === 'purchases') {
      mapped.push('metric.purchases');
    } else if (fLower === 'metric.acos' || fLower === 'acos') {
      mapped.push('metric.totalCost');
      mapped.push('metric.sales');
    } else if (fLower === 'calculated.ctr' || fLower === 'ctr') {
      mapped.push('metric.clicks');
      mapped.push('metric.impressions');
    } else if (fLower === 'calculated.cpc' || fLower === 'cpc') {
      mapped.push('metric.cpc');
    } else if (fLower === 'calculated.cvr' || fLower === 'cvr') {
      mapped.push('metric.purchases');
      mapped.push('metric.clicks');
    } else if (fLower === 'calculated.acos') {
      mapped.push('metric.totalCost');
      mapped.push('metric.sales');
    } else if (fLower === 'calculated.roas') {
      mapped.push('metric.sales');
      mapped.push('metric.totalCost');
    } else {
      mapped.push(field);
    }
  }

  // Inject required date dimension and currency if metrics are queried
  const lower = mapped.map(f => f.toLowerCase());
  if (!lower.includes('date.value')) {
    mapped.push('date.value');
    lower.push('date.value');
  }
  const hasMetric = lower.some(f => f.startsWith('metric.'));
  if (hasMetric && !lower.includes('budgetcurrency.value')) {
    mapped.push('budgetCurrency.value');
  }

  return Array.from(new Set(mapped));
}

function parseUnknownFieldsFromError(errorText) {
  const fields = new Set();
  const matches1 = [...errorText.matchAll(/field ([a-zA-Z0-9._]+) is unknown/gi)];
  for (const m of matches1) {
    fields.add(m[1].trim());
  }
  const matches2 = [...errorText.matchAll(/invalid fields:\s*([a-zA-Z0-9._\s,]+)/gi)];
  for (const m of matches2) {
    const list = m[1].split(',').map(item => item.trim()).filter(Boolean);
    for (const item of list) {
      fields.add(item);
    }
  }
  return Array.from(fields);
}

function buildReportPayload({ accountId, startDate, endDate, fields, format = 'GZIP_JSON', includeAccessRequestedAccounts = true }) {
  const apiFields = mapFieldsForApi(fields);
  const body = {
    reports: [
        {
          format,
          periods: [{ datePeriod: { startDate, endDate } }],
          query: { fields: apiFields }
        }
      ]
  };
  if (includeAccessRequestedAccounts) {
    body.accessRequestedAccounts = [{ advertiserAccountId: accountId }];
  }
  return {
    body
  };
}

function extractReportId(data) {
  const success = data?.success;
  if (Array.isArray(success)) {
    for (const item of success) {
      const reportId = item?.report?.reportId;
      if (reportId) return reportId;
    }
  }
  return data?.report?.reportId || null;
}

function extractReports(data) {
  const success = data?.success;
  if (Array.isArray(success)) {
    return success.map(item => item?.report).filter(Boolean);
  }
  if (data?.report) return [data.report];
  return [];
}

function extractReportStatus(data) {
  const report = extractReports(data)[0] || null;
  return {
    status: report?.status || null,
    report
  };
}

function collectUrls(value, out = []) {
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, out);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectUrls(item, out);
  }
  return out;
}

function tryParseRows(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.rows)) return parsed.rows;
    if (Array.isArray(parsed?.data)) return parsed.data;
    return [parsed];
  } catch {
    const rows = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        return [];
      }
    }
    return rows;
  }
}

function summarizeRows(rows) {
  const firstNumber = (row, keys) => {
    for (const key of keys) {
      const value = Number(row?.[key]);
      if (Number.isFinite(value)) return value;
    }
    return null;
  };
  const roundMetric = (value, digits = 6) => {
    if (!Number.isFinite(value)) return null;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  };
  const summary = {
    row_count: rows.length,
    totals: {}
  };
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const values = {
      'metric.clicks': firstNumber(row, ['metric.clicks', 'clicks']),
      'metric.impressions': firstNumber(row, ['metric.impressions', 'impressions']),
      'metric.cost': firstNumber(row, ['metric.cost', 'metric.spend', 'metric.totalCost', 'cost', 'spend']),
      'metric.sales': firstNumber(row, ['metric.sales', 'sales']),
      'metric.orders': firstNumber(row, ['metric.orders', 'metric.purchases', 'orders', 'purchases'])
    };
    for (const [key, value] of Object.entries(values)) {
      if (value !== null) summary.totals[key] = (summary.totals[key] || 0) + value;
    }
  }
  const clicks = summary.totals['metric.clicks'];
  const impressions = summary.totals['metric.impressions'];
  const cost = summary.totals['metric.cost'];
  const sales = summary.totals['metric.sales'];
  const orders = summary.totals['metric.orders'];
  if (Number.isFinite(cost) && clicks > 0) summary.totals['metric.cpc'] = roundMetric(cost / clicks);
  if (Number.isFinite(clicks) && impressions > 0) summary.totals['calculated.ctr'] = roundMetric(clicks / impressions);
  if (Number.isFinite(orders) && clicks > 0) summary.totals['calculated.cvr'] = roundMetric(orders / clicks);
  if (Number.isFinite(cost) && sales > 0) summary.totals['metric.acos'] = roundMetric(cost / sales);
  if (Number.isFinite(sales) && cost > 0) summary.totals['metric.roas'] = roundMetric(sales / cost);
  return summary;
}

async function downloadReportUrls(report, { timeoutMs, maxBytes, includeArtifactData = false }) {
  const urls = Array.from(new Set(collectUrls(report)));
  const downloads = [];
  for (const url of urls) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(url, { signal: controller.signal });
      if (!response.ok) {
        const body = Buffer.from(await response.arrayBuffer()).toString('utf8').slice(0, 1000);
        throw new Error(`download HTTP ${response.status}${body ? `: ${body}` : ''}`);
      }
      const raw = Buffer.from(await response.arrayBuffer());
      const limitedRaw = raw.length > maxBytes ? raw.subarray(0, maxBytes) : raw;
      let decoded;
      try {
        decoded = zlib.gunzipSync(limitedRaw).toString('utf8');
      } catch {
        decoded = limitedRaw.toString('utf8');
      }
      const rows = tryParseRows(decoded);
      downloads.push({
        url: url.slice(0, 160),
        http_status: response.status,
        bytes: raw.length,
        truncated: raw.length > maxBytes,
        preview: decoded.slice(0, 4000),
        ...(includeArtifactData ? { artifact_rows: rows } : { rows }),
        row_summary: summarizeRows(rows)
      });
    } catch (error) {
      const cause = error.cause ? ` (${error.cause.code || error.cause.message || error.cause})` : '';
      downloads.push({
        url: url.slice(0, 160),
        error: error.name === 'AbortError' ? `download timed out after ${timeoutMs}ms` : `${error.message || 'fetch failed'}${cause}`,
        error_name: error.name || 'Error'
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  return downloads;
}

class ReportingService {
  constructor({ mcpClient, runtimeConfig, fixedAccountContext = false }) {
    this.mcpClient = mcpClient;
    this.runtimeConfig = runtimeConfig;
    this.fixedAccountContext = fixedAccountContext;
  }

  async createReport({ accountId, startDate, endDate, fields, format = 'GZIP_JSON' }) {
    const minIntervalMs = Number(this.runtimeConfig.reportCreateMinIntervalMs || 0);
    if (minIntervalMs > 0) {
      const elapsed = Date.now() - lastReportCreateAt;
      if (elapsed < minIntervalMs) {
        await new Promise(resolve => setTimeout(resolve, minIntervalMs - elapsed));
      }
    }
    const payload = buildReportPayload({
      accountId,
      startDate,
      endDate,
      fields,
      format,
      includeAccessRequestedAccounts: !this.fixedAccountContext
    });
    lastReportCreateAt = Date.now();
    const data = await this.mcpClient.callTool('reporting-create_report', payload);
    return {
      data,
      reportId: extractReportId(data),
      reports: extractReports(data),
      payload: {
        accountId,
        startDate,
        endDate,
        fields,
        format
      }
    };
  }

  async retrieveReport(reportIds) {
    const ids = Array.isArray(reportIds) ? reportIds : [reportIds];
    const data = await this.mcpClient.callTool('reporting-retrieve_report', {
      body: { reportIds: ids.filter(Boolean) }
    });
    return {
      data,
      reports: extractReports(data),
      ...extractReportStatus(data)
    };
  }

  async retrieveReportWithDownloads(reportIds, { download = true, includeArtifactData = false } = {}) {
    const retrieved = await this.retrieveReport(reportIds);
    const downloads = download && retrieved.report
      ? await downloadReportUrls(retrieved.report, {
          timeoutMs: this.runtimeConfig.requestTimeoutMs,
          maxBytes: this.runtimeConfig.maxDownloadBytes,
          includeArtifactData
        })
      : [];
    return {
      ...retrieved,
      downloads
    };
  }

  async pollReport(reportId, options = {}) {
    const maxPollMs = Number(options.maxPollMs || this.runtimeConfig.maxPollMs);
    const pollIntervalMs = Number(options.pollIntervalMs || this.runtimeConfig.pollIntervalMs);
    const deadline = Date.now() + maxPollMs;
    let latest = null;
    while (Date.now() <= deadline) {
      latest = await this.retrieveReport(reportId);
      if (latest.status && !['PENDING', 'PROCESSING'].includes(latest.status)) {
        return latest;
      }
      if (maxPollMs <= 0) return latest;
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    return latest || { status: null, report: null, reports: [], data: null };
  }

  async getCampaignPerformance({ accountId, startDate, endDate, fields, download = true, waitForCompletion = false, reportId = null, includeArtifactData = false }) {
    const usedFields = normalizeFields(fields);
    const finalFields = usedFields.length > 0 ? usedFields : [...DEFAULT_BASE_FIELDS, ...DEFAULT_OPTIONAL_FIELDS];
    if (reportId) {
      const retrieved = waitForCompletion
        ? await this.pollReport(reportId)
        : await this.retrieveReport(reportId);
      const downloads = download && retrieved.report
        ? await downloadReportUrls(retrieved.report, {
            timeoutMs: this.runtimeConfig.requestTimeoutMs,
            maxBytes: this.runtimeConfig.maxDownloadBytes,
            includeArtifactData
          })
        : [];
      return {
        success: true,
      reportId,
      status: retrieved.status,
      report: retrieved.report,
      downloads,
      used_fields: finalFields,
      request_payload: {
        accountId,
        startDate,
        endDate,
        fields: finalFields,
        reportId,
        reused_report: true
      },
      period: { startDate, endDate },
      reused_report: true,
        warnings: retrieved.status && ['PENDING', 'PROCESSING'].includes(retrieved.status)
          ? ['Report is still processing. Continue the same job later or call retrieve_report with the same reportId; do not create a duplicate report.']
          : []
      };
    }

    const created = await this.createReport({ accountId, startDate, endDate, fields: finalFields });
    if (!created.reportId) {
      return {
        success: false,
        report_create_result: created.data,
        used_fields: finalFields,
        error: classifyReportError(created.data),
        warnings: [buildMissingReportIdWarning(created.data)]
      };
    }
    const retrieved = waitForCompletion
      ? await this.pollReport(created.reportId)
      : {
          status: created.reports?.[0]?.status || null,
          report: created.reports?.[0] || null,
          reports: created.reports || [],
          data: created.data
        };
    const downloads = download && retrieved.report
      ? await downloadReportUrls(retrieved.report, {
          timeoutMs: this.runtimeConfig.requestTimeoutMs,
          maxBytes: this.runtimeConfig.maxDownloadBytes,
          includeArtifactData
        })
      : [];
    return {
      success: true,
      reportId: created.reportId,
      status: retrieved.status,
      report: retrieved.report,
      downloads,
      used_fields: finalFields,
      request_payload: created.payload,
      period: { startDate, endDate },
      report_create_result: created.data,
      reused_report: false,
      warnings: retrieved.status && ['PENDING', 'PROCESSING'].includes(retrieved.status)
        ? ['Report is still processing. Continue the same job later or call retrieve_report with the same reportId; do not create a duplicate report.']
        : []
    };
  }

  async getPerformance({ accountId, startDate, endDate, fields, download = true, waitForCompletion = false, reportId = null, includeArtifactData = false }) {
    return this.getCampaignPerformance({
      accountId,
      startDate,
      endDate,
      fields,
      download,
      waitForCompletion,
      reportId,
      includeArtifactData
    });
  }

  async probeFields({ accountId, startDate, endDate, baseFields, candidateFields, fieldDependencies = {} }) {
    const base = normalizeFields(baseFields);
    const baseSet = new Set(base.map(field => field.toLowerCase()));
    const candidates = Array.from(new Set(normalizeFields(candidateFields)))
      .filter(field => !baseSet.has(field.toLowerCase()));

    const successFields = [];
    const failedFields = [];
    let stoppedByRateLimit = false;

    if (candidates.length > 0) {
      let activeCandidates = [...candidates];
      let attempts = 0;
      const maxProbeAttempts = 5;

      while (activeCandidates.length > 0 && attempts < maxProbeAttempts) {
        attempts++;
        const allDependencies = [];
        for (const field of activeCandidates) {
          const deps = normalizeFields(fieldDependencies[field] || fieldDependencies[field.toLowerCase()] || []);
          allDependencies.push(...deps);
        }
        
        const fields = Array.from(new Set([...base, ...allDependencies, ...activeCandidates]));
        
        try {
          const created = await this.createReport({ accountId, startDate, endDate, fields });
          if (created.reportId) {
            for (const field of activeCandidates) {
              const deps = normalizeFields(fieldDependencies[field] || fieldDependencies[field.toLowerCase()] || []);
              successFields.push({
                field,
                tested_fields: Array.from(new Set([...base, ...deps, field])),
                dependencies: deps,
                reportId: created.reportId,
                status: created.reports?.[0]?.status || null
              });
            }
            break;
          } else {
            const errorDetail = classifyReportError(created.data);
            if (errorDetail.code === 'rate_limited') {
              stoppedByRateLimit = true;
              break;
            }
            
            const errorText = JSON.stringify(created.data || '');
            const unknownFieldMatches = parseUnknownFieldsFromError(errorText);
            
            if (unknownFieldMatches.length > 0) {
              const unknownSet = new Set(unknownFieldMatches.map(f => f.toLowerCase()));
              const pruned = [];
              const remaining = [];
              for (const field of activeCandidates) {
                const mappedForThisField = mapFieldsForApi([field]).map(f => f.toLowerCase());
                if (unknownSet.has(field.toLowerCase()) || mappedForThisField.some(f => unknownSet.has(f))) {
                  pruned.push(field);
                } else {
                  remaining.push(field);
                }
              }
              
              for (const field of pruned) {
                failedFields.push({
                  field,
                  reportId: null,
                  status: null,
                  error: { code: 'unknown_field', field, message: errorText.slice(0, 1000) },
                  message: `Field ${field} is unknown to Amazon Ads SP API.`
                });
              }
              
              activeCandidates = remaining;
            } else {
              for (const field of activeCandidates) {
                failedFields.push({
                  field,
                  reportId: null,
                  status: null,
                  error: errorDetail,
                  message: buildMissingReportIdWarning(created.data)
                });
              }
              break;
            }
          }
        } catch (error) {
          const errorDetail = classifyReportError(error);
          if (errorDetail.code === 'rate_limited') {
            stoppedByRateLimit = true;
            break;
          }
          
          const errorText = JSON.stringify(error?.data || error?.body || error?.message || error || '');
          const unknownFieldMatches = parseUnknownFieldsFromError(errorText);
          
          if (unknownFieldMatches.length > 0) {
            const unknownSet = new Set(unknownFieldMatches.map(f => f.toLowerCase()));
            const pruned = [];
            const remaining = [];
            for (const field of activeCandidates) {
              const mappedForThisField = mapFieldsForApi([field]).map(f => f.toLowerCase());
              if (unknownSet.has(field.toLowerCase()) || mappedForThisField.some(f => unknownSet.has(f))) {
                pruned.push(field);
              } else {
                remaining.push(field);
              }
            }
            
            for (const field of pruned) {
              failedFields.push({
                field,
                reportId: null,
                status: null,
                error: { code: 'unknown_field', field, message: errorText.slice(0, 1000) },
                message: `Field ${field} is unknown to Amazon Ads SP API.`
              });
            }
            
            activeCandidates = remaining;
          } else {
            for (const field of activeCandidates) {
              failedFields.push({
                field,
                error: errorDetail
              });
            }
            break;
          }
        }
        
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }

    return {
      success_fields: successFields.map(item => item.field),
      success_details: successFields,
      failed_fields: failedFields,
      skipped_fields: stoppedByRateLimit
        ? candidates.filter(c => !successFields.some(s => s.field.toLowerCase() === c.toLowerCase()) && !failedFields.some(f => f.field.toLowerCase() === c.toLowerCase()))
        : [],
      stopped_by_rate_limit: stoppedByRateLimit
    };
  }
}

module.exports = {
  DEFAULT_BASE_FIELDS,
  DEFAULT_OPTIONAL_FIELDS,
  ReportingService,
  buildReportPayload,
  classifyReportError,
  downloadReportUrls,
  extractReportId,
  extractReportStatus,
  extractReports,
  buildMissingReportIdWarning,
  resolveDateRange,
  summarizeRows,
  tryParseRows
};
