#!/usr/bin/env node

const path = require('path');
const fs = require('fs').promises;
const zlib = require('zlib');
require('dotenv').config({ path: path.join(__dirname, 'config.env'), override: false });

const SP_API_SAFE_PATH_PREFIXES = [
  '/sellers/',
  '/orders/',
  '/sales/',
  '/fba/inventory/',
  '/fba/inbound/',
  '/listings/',
  '/products/pricing/',
  '/products/fees/',
  '/catalog/',
  '/finances/',
  '/reports/'
];

const DEFAULT_INCLUDED_DATA = [
  'summaries',
  'attributes',
  'issues',
  'offers',
  'fulfillmentAvailability'
];

const DEFAULT_CATALOG_INCLUDED_DATA = [
  'summaries',
  'attributes',
  'images',
  'productTypes',
  'salesRanks',
  'relationships'
];

const DEFAULT_REPORT_TYPE_PRESETS = {
  open_listings: 'GET_FLAT_FILE_OPEN_LISTINGS_DATA',
  all_listings: 'GET_MERCHANT_LISTINGS_ALL_DATA',
  active_listings: 'GET_MERCHANT_LISTINGS_DATA',
  inactive_listings: 'GET_MERCHANT_LISTINGS_INACTIVE_DATA',
  canceled_listings: 'GET_MERCHANT_CANCELLED_LISTINGS_DATA',
  inventory: 'GET_AFN_INVENTORY_DATA',
  inventory_age: 'GET_FBA_INVENTORY_AGED_DATA',
  fba_manage_inventory: 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA',
  fba_received_inventory: 'GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA',
  fba_shipments: 'GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL',
  all_orders: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
  all_orders_last_update: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL',
  settlement: 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE'
};

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      input += chunk;
    });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

function env(name, fallback = '') {
  const value = process.env[name];
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return String(value).trim();
}

function envInt(name, fallback) {
  const parsed = Number.parseInt(env(name), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name, fallback = false) {
  const raw = env(name);
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function requireConfig() {
  const config = {
    clientId: env('AMAZON_SPAPI_LWA_CLIENT_ID'),
    clientSecret: env('AMAZON_SPAPI_LWA_CLIENT_SECRET'),
    refreshToken: env('AMAZON_SPAPI_REFRESH_TOKEN'),
    endpoint: env('AMAZON_SPAPI_ENDPOINT', 'https://sellingpartnerapi-na.amazon.com').replace(/\/+$/, ''),
    marketplaceIds: toArray(env('AMAZON_SPAPI_MARKETPLACE_IDS', 'ATVPDKIKX0DER')),
    sellerId: env('AMAZON_SPAPI_SELLER_ID'),
    userAgent: env('AMAZON_SPAPI_USER_AGENT', 'VCP-AmazonSPAPI/0.1'),
    timeoutMs: envInt('AMAZON_SPAPI_TIMEOUT_MS', 60000),
    maxResultBytes: envInt('AMAZON_SPAPI_MAX_RESULT_BYTES', 200000),
    maxDownloadBytes: envInt('AMAZON_SPAPI_MAX_DOWNLOAD_BYTES', 5242880),
    stateDir: env('AMAZON_SPAPI_STATE_DIR', path.join(__dirname, 'state')),
    debug: envBool('AMAZON_SPAPI_DEBUG', false)
  };

  const missing = [];
  if (!config.clientId) missing.push('AMAZON_SPAPI_LWA_CLIENT_ID');
  if (!config.clientSecret) missing.push('AMAZON_SPAPI_LWA_CLIENT_SECRET');
  if (!config.refreshToken) missing.push('AMAZON_SPAPI_REFRESH_TOKEN');
  if (missing.length) {
    throw new Error(`Missing required config: ${missing.join(', ')}. Copy config.env.example to config.env and fill these values.`);
  }

  return config;
}

function toArray(value) {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map(String).map(s => s.trim()).filter(Boolean);
      } catch (_error) {
        // Fall through to comma parsing.
      }
    }
    return trimmed.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [String(value).trim()].filter(Boolean);
}

function pickMarketplaceIds(args, config) {
  const ids = toArray(args.marketplaceIds || args.marketplaceId || args.marketplaces);
  return ids.length ? ids : config.marketplaceIds;
}

function joinList(value) {
  return toArray(value).join(',');
}

function addIfPresent(query, key, value) {
  if (value === undefined || value === null || value === '') return;
  if (Array.isArray(value)) {
    if (value.length) query[key] = value.join(',');
    return;
  }
  query[key] = value;
}

function parseObject(value, fallback = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_error) {
      return fallback;
    }
  }
  return fallback;
}

function parseArray(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch (_error) {
        return fallback;
      }
    }
  }
  return fallback;
}

function encodeQuery(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length) params.set(key, value.join(','));
      continue;
    }
    if (typeof value === 'object') {
      params.set(key, JSON.stringify(value));
      continue;
    }
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

function daysAgoIso(days) {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString();
}

function dateToIsoStart(value) {
  if (!value) return '';
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T00:00:00Z`;
  return text;
}

function dateToIsoEnd(value) {
  if (!value) return '';
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T23:59:59Z`;
  return text;
}

function isoMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function clampIsoBeforeNow(value, minutesAgo = 3) {
  const fallback = isoMinutesAgo(minutesAgo);
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const latest = new Date(Date.now() - minutesAgo * 60 * 1000);
  return parsed > latest ? latest.toISOString() : value;
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (_error) {
        body = text;
      }
    }

    if (!response.ok) {
      const message = body && typeof body === 'object'
        ? JSON.stringify(body)
        : (body || response.statusText);
      const error = new Error(`HTTP ${response.status} ${response.statusText}: ${message}`);
      error.statusCode = response.status;
      error.responseBody = body;
      throw error;
    }

    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBinary(url, options, timeoutMs, maxBytes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${text || response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > maxBytes) {
      throw new Error(`Download is ${buffer.length} bytes, exceeding AMAZON_SPAPI_MAX_DOWNLOAD_BYTES=${maxBytes}.`);
    }
    return {
      buffer,
      contentType: response.headers.get('content-type') || '',
      contentEncoding: response.headers.get('content-encoding') || ''
    };
  } finally {
    clearTimeout(timeout);
  }
}

class AmazonSPAPIClient {
  constructor(config) {
    this.config = config;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60000) {
      return this.accessToken;
    }

    const body = new URLSearchParams();
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', this.config.refreshToken);
    body.set('client_id', this.config.clientId);
    body.set('client_secret', this.config.clientSecret);

    const tokenResponse = await fetchJson('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent': this.config.userAgent
      },
      body
    }, this.config.timeoutMs);

    if (!tokenResponse || !tokenResponse.access_token) {
      throw new Error('LWA token response did not include access_token.');
    }

    this.accessToken = tokenResponse.access_token;
    this.accessTokenExpiresAt = Date.now() + (Number(tokenResponse.expires_in || 3600) * 1000);
    return this.accessToken;
  }

  async request(path, query = {}, options = {}) {
    const cleanPath = normalizePath(path);
    const accessToken = await this.getAccessToken();
    const url = `${this.config.endpoint}${cleanPath}${encodeQuery(query)}`;
    const method = options.method || 'GET';
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': this.config.userAgent,
      'x-amz-access-token': accessToken
    };
    const requestOptions = { method, headers };
    if (options.body !== undefined) {
      requestOptions.body = typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body);
    }

    return fetchJson(url, requestOptions, this.config.timeoutMs);
  }

  async downloadDocument(url, compressionAlgorithm) {
    const downloaded = await fetchBinary(url, {
      method: 'GET',
      headers: {
        Accept: '*/*',
        'User-Agent': this.config.userAgent
      }
    }, this.config.timeoutMs, this.config.maxDownloadBytes);

    let buffer = downloaded.buffer;
    if (String(compressionAlgorithm || '').toUpperCase() === 'GZIP') {
      buffer = zlib.gunzipSync(buffer);
    }

    return {
      buffer,
      contentType: downloaded.contentType,
      contentEncoding: downloaded.contentEncoding
    };
  }
}

function normalizePath(path) {
  const text = String(path || '').trim();
  if (!text) throw new Error('Missing path.');
  if (/^https?:\/\//i.test(text)) {
    const url = new URL(text);
    return url.pathname;
  }
  return text.startsWith('/') ? text : `/${text}`;
}

function assertSafeReadPath(path) {
  const cleanPath = normalizePath(path);
  if (!SP_API_SAFE_PATH_PREFIXES.some(prefix => cleanPath.startsWith(prefix))) {
    throw new Error(`raw_get path is not in the read whitelist: ${cleanPath}`);
  }
  if (/\/(buyerInfo|address|shipmentConfirmation|restrictedDataToken)\b/i.test(cleanPath)) {
    throw new Error(`raw_get path may expose PII or RDT data and is blocked: ${cleanPath}`);
  }
  return cleanPath;
}

async function handleCommand(client, args, config) {
  const command = String(args.command || args.action || 'get_status').trim();

  switch (command) {
    case 'get_status':
      return {
        configured: {
          clientId: mask(config.clientId),
          refreshToken: mask(config.refreshToken),
          endpoint: config.endpoint,
          marketplaceIds: config.marketplaceIds,
          sellerId: config.sellerId ? mask(config.sellerId, 4, 4) : '',
          userAgent: config.userAgent,
          stateDir: config.stateDir,
          warnings: buildConfigWarnings(config)
        },
        commands: [
          'get_marketplace_participations',
          'get_orders',
          'get_order_metrics',
          'get_inventory_summaries',
          'search_listings_items',
          'get_listings_item',
          'get_pricing',
          'get_competitive_pricing',
          'search_catalog_items',
          'get_catalog_item',
          'get_my_fees_estimate_for_sku',
          'get_my_fees_estimate_for_asin',
          'get_my_fees_estimates',
          'list_financial_events',
          'list_financial_event_groups',
          'get_financial_events_for_order',
          'create_report',
          'get_report',
          'get_reports',
          'get_report_document',
          'download_report_document',
          'get_report_and_download',
          'list_inbound_shipments',
          'list_inbound_shipment_items',
          'get_inbound_shipment_items',
          'raw_get'
        ],
        note: 'Use validate=true to test LWA token exchange without calling a store data endpoint.',
        tokenValidation: args.validate ? await validateToken(client) : undefined
      };

    case 'get_marketplace_participations':
      return client.request('/sellers/v1/marketplaceParticipations');

    case 'get_orders':
      return getOrders(client, args, config);

    case 'get_order_metrics':
      return getOrderMetrics(client, args, config);

    case 'get_inventory_summaries':
      return getInventorySummaries(client, args, config);

    case 'search_listings_items':
      return searchListingsItems(client, args, config);

    case 'get_listings_item':
      return getListingsItem(client, args, config);

    case 'get_pricing':
      return getPricing(client, args, config, false);

    case 'get_competitive_pricing':
      return getPricing(client, args, config, true);

    case 'search_catalog_items':
      return searchCatalogItems(client, args, config);

    case 'get_catalog_item':
      return getCatalogItem(client, args, config);

    case 'get_my_fees_estimate_for_sku':
      return getMyFeesEstimateForSku(client, args, config);

    case 'get_my_fees_estimate_for_asin':
      return getMyFeesEstimateForAsin(client, args, config);

    case 'get_my_fees_estimates':
      return getMyFeesEstimates(client, args, config);

    case 'list_financial_events':
      return listFinancialEvents(client, args);

    case 'list_financial_event_groups':
      return listFinancialEventGroups(client, args);

    case 'get_financial_events_for_order':
      return getFinancialEventsForOrder(client, args);

    case 'create_report':
      return createReport(client, args, config);

    case 'get_report':
      return getReport(client, args);

    case 'get_reports':
      return getReports(client, args, config);

    case 'get_report_document':
      return getReportDocument(client, args);

    case 'download_report_document':
      return downloadReportDocument(client, args, config);

    case 'get_report_and_download':
      return getReportAndDownload(client, args, config);

    case 'list_inbound_shipments':
      return listInboundShipments(client, args, config);

    case 'list_inbound_shipment_items':
      return listInboundShipmentItems(client, args, config);

    case 'get_inbound_shipment_items':
      return getInboundShipmentItems(client, args);

    case 'raw_get':
      return rawGet(client, args);

    default:
      throw new Error(`Unsupported command: ${command}`);
  }
}

async function validateToken(client) {
  const token = await client.getAccessToken();
  return {
    ok: Boolean(token),
    accessToken: mask(token),
    expiresAt: new Date(client.accessTokenExpiresAt).toISOString()
  };
}

function getOrders(client, args, config) {
  const query = {};
  query.MarketplaceIds = pickMarketplaceIds(args, config).join(',');

  if (args.nextToken || args.NextToken) {
    query.NextToken = args.nextToken || args.NextToken;
  } else {
    addIfPresent(query, 'CreatedAfter', args.createdAfter || args.CreatedAfter || daysAgoIso(7));
    addIfPresent(query, 'CreatedBefore', args.createdBefore || args.CreatedBefore);
    addIfPresent(query, 'LastUpdatedAfter', args.lastUpdatedAfter || args.LastUpdatedAfter);
    addIfPresent(query, 'LastUpdatedBefore', args.lastUpdatedBefore || args.LastUpdatedBefore);
    addIfPresent(query, 'OrderStatuses', joinList(args.orderStatuses || args.OrderStatuses));
    addIfPresent(query, 'FulfillmentChannels', joinList(args.fulfillmentChannels || args.FulfillmentChannels));
    addIfPresent(query, 'PaymentMethods', joinList(args.paymentMethods || args.PaymentMethods));
    addIfPresent(query, 'BuyerEmail', args.buyerEmail || args.BuyerEmail);
    addIfPresent(query, 'SellerOrderId', args.sellerOrderId || args.SellerOrderId);
    addIfPresent(query, 'EasyShipShipmentStatuses', joinList(args.easyShipShipmentStatuses || args.EasyShipShipmentStatuses));
    addIfPresent(query, 'ElectronicInvoiceStatuses', joinList(args.electronicInvoiceStatuses || args.ElectronicInvoiceStatuses));
    addIfPresent(query, 'AmazonOrderIds', joinList(args.amazonOrderIds || args.AmazonOrderIds));
    addIfPresent(query, 'ActualFulfillmentSupplySourceId', args.actualFulfillmentSupplySourceId || args.ActualFulfillmentSupplySourceId);
  }

  const maxResults = Number.parseInt(args.maxResults || args.MaxResultsPerPage, 10);
  if (Number.isFinite(maxResults)) {
    query.MaxResultsPerPage = Math.max(1, Math.min(100, maxResults));
  }

  return client.request('/orders/v0/orders', query);
}

function getOrderMetrics(client, args, config) {
  const query = {};
  query.marketplaceIds = pickMarketplaceIds(args, config).join(',');

  if (args.interval) {
    query.interval = args.interval;
  } else {
    const from = dateToIsoStart(args.dateFrom || args.from || daysAgoDate(30));
    const to = dateToIsoEnd(args.dateTo || args.to || todayDate());
    query.interval = `${from}--${to}`;
  }

  query.granularity = args.granularity || 'Day';
  addIfPresent(query, 'granularityTimeZone', args.granularityTimeZone || 'UTC');
  addIfPresent(query, 'buyerType', args.buyerType || 'All');
  addIfPresent(query, 'fulfillmentNetwork', args.fulfillmentNetwork);
  addIfPresent(query, 'firstDayOfWeek', args.firstDayOfWeek);
  addIfPresent(query, 'asin', args.asin);
  addIfPresent(query, 'sku', args.sku);

  return client.request('/sales/v1/orderMetrics', query);
}

function getInventorySummaries(client, args, config) {
  const marketplaceIds = pickMarketplaceIds(args, config);
  const query = {
    details: String(args.details !== undefined ? args.details : true),
    granularityType: args.granularityType || 'Marketplace',
    granularityId: args.granularityId || marketplaceIds[0],
    marketplaceIds: marketplaceIds.join(',')
  };

  addIfPresent(query, 'nextToken', args.nextToken);
  addIfPresent(query, 'startDateTime', args.startDateTime);
  addIfPresent(query, 'sellerSkus', joinList(args.sellerSkus || args.skus));

  return client.request('/fba/inventory/v1/summaries', query);
}

function searchListingsItems(client, args, config) {
  const sellerId = args.sellerId || config.sellerId;
  if (!sellerId) throw new Error('search_listings_items requires sellerId or AMAZON_SPAPI_SELLER_ID.');
  assertLikelySellerId(sellerId);

  const query = {
    marketplaceIds: pickMarketplaceIds(args, config).join(','),
    includedData: joinList(args.includedData || DEFAULT_INCLUDED_DATA),
    pageSize: String(Math.max(1, Math.min(20, Number.parseInt(args.pageSize || args.maxResults || 20, 10) || 20)))
  };

  addIfPresent(query, 'pageToken', args.pageToken || args.nextToken);
  addIfPresent(query, 'skuPrefix', args.skuPrefix);
  addIfPresent(query, 'issueLocale', args.issueLocale);
  addIfPresent(query, 'sortBy', args.sortBy || 'lastUpdatedDate');
  addIfPresent(query, 'sortOrder', args.sortOrder || 'DESC');
  addIfPresent(query, 'identifiers', joinList(args.identifiers));
  addIfPresent(query, 'identifiersType', args.identifiersType);
  addIfPresent(query, 'variationParentSku', args.variationParentSku);
  addIfPresent(query, 'packageHierarchySku', args.packageHierarchySku);
  addIfPresent(query, 'createdAfter', args.createdAfter);
  addIfPresent(query, 'createdBefore', args.createdBefore);
  addIfPresent(query, 'lastUpdatedAfter', args.lastUpdatedAfter);
  addIfPresent(query, 'lastUpdatedBefore', args.lastUpdatedBefore);
  addIfPresent(query, 'withIssueSeverity', joinList(args.withIssueSeverity));
  addIfPresent(query, 'withStatus', joinList(args.withStatus));
  addIfPresent(query, 'withoutStatus', joinList(args.withoutStatus));

  return client.request(`/listings/2021-08-01/items/${encodeURIComponent(sellerId)}`, query);
}

function getListingsItem(client, args, config) {
  const sellerId = args.sellerId || config.sellerId;
  const sku = args.sku || args.SellerSKU;
  if (!sellerId) throw new Error('get_listings_item requires sellerId or AMAZON_SPAPI_SELLER_ID.');
  assertLikelySellerId(sellerId);
  if (!sku) throw new Error('get_listings_item requires sku.');

  const query = {
    marketplaceIds: pickMarketplaceIds(args, config).join(','),
    includedData: joinList(args.includedData || DEFAULT_INCLUDED_DATA)
  };
  addIfPresent(query, 'issueLocale', args.issueLocale);

  return client.request(`/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`, query);
}

function getPricing(client, args, config, competitive) {
  const marketplaceIds = pickMarketplaceIds(args, config);
  const query = {
    MarketplaceId: args.MarketplaceId || args.marketplaceId || marketplaceIds[0],
    ItemType: args.itemType || args.ItemType || (args.skus || args.Skus ? 'Sku' : 'Asin')
  };

  addIfPresent(query, 'Asins', joinList(args.asins || args.Asins));
  addIfPresent(query, 'Skus', joinList(args.skus || args.Skus));
  addIfPresent(query, 'CustomerType', args.customerType || args.CustomerType);

  if (!query.Asins && !query.Skus) {
    throw new Error(`${competitive ? 'get_competitive_pricing' : 'get_pricing'} requires asins or skus.`);
  }

  const path = competitive
    ? '/products/pricing/v0/competitivePrice'
    : '/products/pricing/v0/price';
  return client.request(path, query);
}

function searchCatalogItems(client, args, config) {
  const query = {
    marketplaceIds: pickMarketplaceIds(args, config).join(','),
    includedData: joinList(args.includedData || DEFAULT_CATALOG_INCLUDED_DATA),
    pageSize: String(Math.max(1, Math.min(20, Number.parseInt(args.pageSize || args.maxResults || 10, 10) || 10)))
  };

  addIfPresent(query, 'keywords', joinList(args.keywords || args.keyword || args.query));
  addIfPresent(query, 'identifiers', joinList(args.identifiers || args.asins || args.asin));
  addIfPresent(query, 'identifiersType', args.identifiersType || (args.asins || args.asin ? 'ASIN' : ''));
  addIfPresent(query, 'brandNames', joinList(args.brandNames));
  addIfPresent(query, 'classificationIds', joinList(args.classificationIds));
  addIfPresent(query, 'pageToken', args.pageToken || args.nextToken);
  addIfPresent(query, 'keywordsLocale', args.keywordsLocale);
  addIfPresent(query, 'locale', args.locale);

  if (!query.keywords && !query.identifiers) {
    throw new Error('search_catalog_items requires keywords or identifiers/asins.');
  }

  return client.request('/catalog/2022-04-01/items', query);
}

function getCatalogItem(client, args, config) {
  const asin = args.asin || args.ASIN;
  if (!asin) throw new Error('get_catalog_item requires asin.');

  const query = {
    marketplaceIds: pickMarketplaceIds(args, config).join(','),
    includedData: joinList(args.includedData || DEFAULT_CATALOG_INCLUDED_DATA)
  };
  addIfPresent(query, 'locale', args.locale);

  return client.request(`/catalog/2022-04-01/items/${encodeURIComponent(asin)}`, query);
}

function buildFeesEstimateRequest(args, config, idValue, idType) {
  const marketplaceIds = pickMarketplaceIds(args, config);
  const listingPrice = Number(args.listingPrice ?? args.price ?? args.amount);
  if (!Number.isFinite(listingPrice)) {
    throw new Error('Fee estimate requires listingPrice/price as a number.');
  }

  const currency = args.currency || args.currencyCode || 'USD';
  const request = {
    FeesEstimateRequest: {
      MarketplaceId: args.marketplaceId || marketplaceIds[0],
      IsAmazonFulfilled: args.isAmazonFulfilled !== undefined ? Boolean(args.isAmazonFulfilled) : true,
      PriceToEstimateFees: {
        ListingPrice: {
          CurrencyCode: currency,
          Amount: listingPrice
        }
      },
      Identifier: args.identifier || `${idType}-${idValue}-${Date.now()}`
    }
  };

  const shipping = Number(args.shipping);
  if (Number.isFinite(shipping)) {
    request.FeesEstimateRequest.PriceToEstimateFees.Shipping = {
      CurrencyCode: currency,
      Amount: shipping
    };
  }
  if (args.optionalFulfillmentProgram) {
    request.FeesEstimateRequest.OptionalFulfillmentProgram = args.optionalFulfillmentProgram;
  }

  return request;
}

function getMyFeesEstimateForSku(client, args, config) {
  const sku = args.sku || args.SellerSKU;
  if (!sku) throw new Error('get_my_fees_estimate_for_sku requires sku.');
  const body = buildFeesEstimateRequest(args, config, sku, 'SKU');
  return client.request(`/products/fees/v0/listings/${encodeURIComponent(sku)}/feesEstimate`, {}, {
    method: 'POST',
    body
  });
}

function getMyFeesEstimateForAsin(client, args, config) {
  const asin = args.asin || args.ASIN;
  if (!asin) throw new Error('get_my_fees_estimate_for_asin requires asin.');
  const body = buildFeesEstimateRequest(args, config, asin, 'ASIN');
  return client.request(`/products/fees/v0/items/${encodeURIComponent(asin)}/feesEstimate`, {}, {
    method: 'POST',
    body
  });
}

function getMyFeesEstimates(client, args, config) {
  const rawItems = parseArray(args.items || args.requests, []);
  const items = rawItems.length ? rawItems : buildFeeItemsFromArgs(args);
  if (!items.length) {
    throw new Error('get_my_fees_estimates requires items, or asins/skus with listingPrice/price.');
  }
  if (items.length > 20) {
    throw new Error('get_my_fees_estimates supports up to 20 items per request.');
  }

  const marketplaceId = args.marketplaceId || pickMarketplaceIds(args, config)[0];
  const currency = args.currency || args.currencyCode || 'USD';
  const body = items.map((item, index) => {
    const idValue = item.asin || item.sku || item.idValue || item.IdValue;
    const idType = item.idType || item.IdType || (item.sku ? 'SellerSKU' : 'ASIN');
    const price = Number(item.listingPrice ?? item.price ?? item.amount ?? args.listingPrice ?? args.price);
    if (!idValue || !Number.isFinite(price)) {
      throw new Error('Each fee estimate item requires asin/sku/idValue and listingPrice/price.');
    }
    return {
      FeesEstimateRequest: {
        MarketplaceId: item.marketplaceId || marketplaceId,
        IdType: idType,
        IdValue: idValue,
        IsAmazonFulfilled: item.isAmazonFulfilled !== undefined ? Boolean(item.isAmazonFulfilled) : true,
        PriceToEstimateFees: {
          ListingPrice: {
            CurrencyCode: item.currency || currency,
            Amount: price
          }
        },
        Identifier: item.identifier || `${idType}-${idValue}-${index}`
      }
    };
  });

  return client.request('/products/fees/v0/feesEstimate', {}, {
    method: 'POST',
    body
  });
}

function buildFeeItemsFromArgs(args) {
  const asins = toArray(args.asins || args.asin);
  const skus = toArray(args.skus || args.sku);
  return [
    ...asins.map(asin => ({ asin })),
    ...skus.map(sku => ({ sku }))
  ];
}

function listFinancialEvents(client, args) {
  const query = {};
  addIfPresent(query, 'MaxResultsPerPage', Math.max(1, Math.min(100, Number.parseInt(args.maxResults || args.MaxResultsPerPage || 100, 10) || 100)));
  addIfPresent(query, 'PostedAfter', args.postedAfter || args.PostedAfter || dateToIsoStart(args.dateFrom || args.from || daysAgoDate(30)));
  addIfPresent(query, 'PostedBefore', clampIsoBeforeNow(args.postedBefore || args.PostedBefore || dateToIsoEnd(args.dateTo || args.to)));
  addIfPresent(query, 'NextToken', args.nextToken || args.NextToken);
  return client.request('/finances/v0/financialEvents', query);
}

function listFinancialEventGroups(client, args) {
  const query = {};
  addIfPresent(query, 'MaxResultsPerPage', Math.max(1, Math.min(100, Number.parseInt(args.maxResults || args.MaxResultsPerPage || 100, 10) || 100)));
  addIfPresent(query, 'FinancialEventGroupStartedAfter', args.startedAfter || args.FinancialEventGroupStartedAfter || dateToIsoStart(args.dateFrom || args.from || daysAgoDate(30)));
  addIfPresent(query, 'FinancialEventGroupStartedBefore', clampIsoBeforeNow(args.startedBefore || args.FinancialEventGroupStartedBefore || dateToIsoEnd(args.dateTo || args.to)));
  addIfPresent(query, 'NextToken', args.nextToken || args.NextToken);
  return client.request('/finances/v0/financialEventGroups', query);
}

function getFinancialEventsForOrder(client, args) {
  const orderId = args.amazonOrderId || args.orderId || args.AmazonOrderId;
  if (!orderId) throw new Error('get_financial_events_for_order requires amazonOrderId/orderId.');
  const query = {};
  addIfPresent(query, 'MaxResultsPerPage', Math.max(1, Math.min(100, Number.parseInt(args.maxResults || args.MaxResultsPerPage || 100, 10) || 100)));
  addIfPresent(query, 'NextToken', args.nextToken || args.NextToken);
  return client.request(`/finances/v0/orders/${encodeURIComponent(orderId)}/financialEvents`, query);
}

function resolveReportType(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('reportType is required.');
  return DEFAULT_REPORT_TYPE_PRESETS[text] || text;
}

async function createReport(client, args, config) {
  const body = {
    reportType: resolveReportType(args.reportType || args.preset),
    marketplaceIds: pickMarketplaceIds(args, config)
  };
  addIfPresent(body, 'dataStartTime', dateToIsoStart(args.dataStartTime || args.dateFrom || args.from));
  addIfPresent(body, 'dataEndTime', dateToIsoEnd(args.dataEndTime || args.dateTo || args.to));
  const reportOptions = parseObject(args.reportOptions, null);
  if (reportOptions) body.reportOptions = reportOptions;

  const created = await client.request('/reports/2021-06-30/reports', {}, {
    method: 'POST',
    body
  });
  await saveReportState(config, created.reportId, { createdAt: new Date().toISOString(), request: body, createResponse: created });
  return {
    ...created,
    request: body,
    note: 'Report creation is asynchronous. Use get_report or get_report_and_download with this reportId after processing finishes.'
  };
}

function getReport(client, args) {
  const reportId = args.reportId;
  if (!reportId) throw new Error('get_report requires reportId.');
  return client.request(`/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`);
}

function getReports(client, args, config) {
  const query = {};
  const reportTypes = toArray(args.reportTypes || args.reportType).map(resolveReportType);
  if (!reportTypes.length) throw new Error('get_reports requires reportTypes/reportType, for example open_listings or GET_FLAT_FILE_OPEN_LISTINGS_DATA.');
  addIfPresent(query, 'reportTypes', reportTypes.join(','));
  addIfPresent(query, 'processingStatuses', joinList(args.processingStatuses || args.statuses));
  addIfPresent(query, 'marketplaceIds', pickMarketplaceIds(args, config).join(','));
  addIfPresent(query, 'pageSize', Math.max(1, Math.min(100, Number.parseInt(args.pageSize || args.maxResults || 10, 10) || 10)));
  addIfPresent(query, 'createdSince', args.createdSince || dateToIsoStart(args.dateFrom || args.from || daysAgoDate(30)));
  addIfPresent(query, 'createdUntil', args.createdUntil || dateToIsoEnd(args.dateTo || args.to));
  addIfPresent(query, 'nextToken', args.nextToken);
  return client.request('/reports/2021-06-30/reports', query);
}

function getReportDocument(client, args) {
  const reportDocumentId = args.reportDocumentId || args.documentId;
  if (!reportDocumentId) throw new Error('get_report_document requires reportDocumentId.');
  const query = {};
  addIfPresent(query, 'enableContentEncodingUrlHeader', args.enableContentEncodingUrlHeader);
  return client.request(`/reports/2021-06-30/documents/${encodeURIComponent(reportDocumentId)}`, query);
}

async function downloadReportDocument(client, args, config) {
  const reportDocumentId = args.reportDocumentId || args.documentId;
  if (!reportDocumentId) throw new Error('download_report_document requires reportDocumentId.');
  const document = await getReportDocument(client, args);
  const downloaded = await client.downloadDocument(document.url, document.compressionAlgorithm);
  const content = downloaded.buffer.toString(args.encoding || 'utf8');
  const parsed = parseReportContent(content, args);
  const artifact = await saveReportArtifact(config, {
    reportId: args.reportId,
    reportDocumentId,
    document,
    content,
    parsed,
    contentType: downloaded.contentType
  });

  return {
    reportId: args.reportId,
    reportDocumentId,
    compressionAlgorithm: document.compressionAlgorithm || '',
    contentType: downloaded.contentType,
    bytes: Buffer.byteLength(content, 'utf8'),
    artifact,
    parsed
  };
}

async function getReportAndDownload(client, args, config) {
  const report = await getReport(client, args);
  if (report.processingStatus !== 'DONE' || !report.reportDocumentId) {
    return {
      report,
      status: report.processingStatus,
      note: 'Report is not ready for download yet. Retry get_report_and_download later with the same reportId.'
    };
  }
  const downloaded = await downloadReportDocument(client, {
    ...args,
    reportDocumentId: report.reportDocumentId
  }, config);
  await saveReportState(config, args.reportId, { lastReport: report, lastDownload: downloaded.artifact, updatedAt: new Date().toISOString() });
  return {
    report,
    download: downloaded
  };
}

function parseReportContent(content, args) {
  const text = String(content || '');
  const maxRows = Math.max(1, Math.min(1000, Number.parseInt(args.previewRows || args.maxRows || 50, 10) || 50));
  const trimmed = text.trim();
  if (!trimmed) return { format: 'empty', rows: [] };
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const json = JSON.parse(trimmed);
      return { format: 'json', data: json };
    } catch (_error) {
      // Fall through to delimited text.
    }
  }
  const lines = text.split(/\r?\n/).filter(line => line.length > 0);
  const delimiter = args.delimiter || (lines[0] && lines[0].includes('\t') ? '\t' : ',');
  const header = splitDelimitedLine(lines[0] || '', delimiter);
  const rows = lines.slice(1, maxRows + 1).map(line => {
    const values = splitDelimitedLine(line, delimiter);
    const row = {};
    header.forEach((key, index) => {
      row[key || `field_${index + 1}`] = values[index] ?? '';
    });
    return row;
  });
  return {
    format: delimiter === '\t' ? 'tsv' : 'csv',
    totalLines: lines.length,
    header,
    previewRows: rows
  };
}

function splitDelimitedLine(line, delimiter) {
  if (delimiter === '\t') return String(line).split('\t');
  const result = [];
  let current = '';
  let inQuotes = false;
  const text = String(line);
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function listInboundShipments(client, args, config) {
  const query = {
    QueryType: args.queryType || (args.nextToken ? 'NEXT_TOKEN' : ((args.lastUpdatedAfter || args.dateFrom) ? 'DATE_RANGE' : 'SHIPMENT')),
    MarketplaceId: args.marketplaceId || pickMarketplaceIds(args, config)[0]
  };
  addIfPresent(query, 'NextToken', args.nextToken);
  addIfPresent(query, 'ShipmentStatusList', joinList(args.shipmentStatuses || args.ShipmentStatusList || ['WORKING', 'READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'RECEIVING', 'CHECKED_IN']));
  addIfPresent(query, 'ShipmentIdList', joinList(args.shipmentIds || args.ShipmentIdList));
  addIfPresent(query, 'LastUpdatedAfter', dateToIsoStart(args.lastUpdatedAfter || args.dateFrom || args.from));
  addIfPresent(query, 'LastUpdatedBefore', dateToIsoEnd(args.lastUpdatedBefore || args.dateTo || args.to));
  return client.request('/fba/inbound/v0/shipments', query);
}

function listInboundShipmentItems(client, args, config) {
  const query = {
    QueryType: args.queryType || (args.nextToken ? 'NEXT_TOKEN' : ((args.shipmentId || args.shipmentIds) ? 'SHIPMENT' : 'DATE_RANGE')),
    MarketplaceId: args.marketplaceId || pickMarketplaceIds(args, config)[0]
  };
  addIfPresent(query, 'NextToken', args.nextToken);
  addIfPresent(query, 'ShipmentIdList', joinList(args.shipmentIds || args.shipmentId || args.ShipmentIdList));
  addIfPresent(query, 'LastUpdatedAfter', dateToIsoStart(args.lastUpdatedAfter || args.dateFrom || args.from || daysAgoDate(30)));
  addIfPresent(query, 'LastUpdatedBefore', dateToIsoEnd(args.lastUpdatedBefore || args.dateTo || args.to));
  return client.request('/fba/inbound/v0/shipmentItems', query);
}

function getInboundShipmentItems(client, args) {
  const shipmentId = args.shipmentId;
  if (!shipmentId) throw new Error('get_inbound_shipment_items requires shipmentId.');
  return client.request(`/fba/inbound/v0/shipments/${encodeURIComponent(shipmentId)}/items`, {});
}

async function saveReportState(config, reportId, patch) {
  if (!reportId) return null;
  const dir = path.join(config.stateDir, 'reports');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safeFileName(reportId)}.json`);
  let existing = {};
  try {
    existing = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (_error) {
    existing = {};
  }
  const next = { ...existing, ...patch };
  await fs.writeFile(file, JSON.stringify(next, null, 2));
  return file;
}

async function saveReportArtifact(config, artifact) {
  const id = artifact.reportId || artifact.reportDocumentId || `document-${Date.now()}`;
  const dir = path.join(config.stateDir, 'report-documents', safeFileName(id));
  await fs.mkdir(dir, { recursive: true });
  const contentPath = path.join(dir, 'content.txt');
  const metadataPath = path.join(dir, 'metadata.json');
  await fs.writeFile(contentPath, artifact.content);
  const metadata = {
    reportId: artifact.reportId || '',
    reportDocumentId: artifact.reportDocumentId,
    downloadedAt: new Date().toISOString(),
    contentType: artifact.contentType,
    document: {
      compressionAlgorithm: artifact.document.compressionAlgorithm || '',
      urlExpiresSoon: true
    },
    parsed: artifact.parsed
  };
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  return {
    dir,
    contentPath,
    metadataPath
  };
}

function safeFileName(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

function rawGet(client, args) {
  const path = assertSafeReadPath(args.path);
  const query = args.query && typeof args.query === 'object' ? args.query : {};
  return client.request(path, query);
}

function daysAgoDate(days) {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function mask(value, prefix = 8, suffix = 4) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= prefix + suffix) return '*'.repeat(text.length);
  return `${text.slice(0, prefix)}...${text.slice(-suffix)}`;
}

function assertLikelySellerId(sellerId) {
  const text = String(sellerId || '').trim();
  if (/^amzn1\./i.test(text)) {
    throw new Error('AMAZON_SPAPI_SELLER_ID looks like an application/solution ID. Use the Seller Central Merchant Token / Seller ID instead, usually found under Settings > Account Info > Business Information > Merchant Token.');
  }
}

function buildConfigWarnings(config) {
  const warnings = [];
  if (config.sellerId && /^amzn1\./i.test(config.sellerId)) {
    warnings.push('AMAZON_SPAPI_SELLER_ID looks like an application/solution ID. Listing APIs need the Seller Central Merchant Token / Seller ID.');
  }
  return warnings;
}

function makeOutput(status, payload, config) {
  const output = status === 'success'
    ? {
        status,
        result: payload,
        messageForAI: 'Amazon SP-API returned live data. Treat order/customer-sensitive fields carefully and avoid exposing PII.'
      }
    : { status, error: payload };

  let text = JSON.stringify(output, null, 2);
  if (status === 'success' && Buffer.byteLength(text, 'utf8') > config.maxResultBytes) {
    const compactPayload = {
      truncated: true,
      maxResultBytes: config.maxResultBytes,
      note: 'Result was too large for AI context. Narrow the date range, lower maxResults/pageSize, or use nextToken pagination.',
      preview: truncateUtf8(JSON.stringify(payload, null, 2), config.maxResultBytes - 1000)
    };
    text = JSON.stringify({
      status: 'success',
      result: compactPayload,
      messageForAI: 'The SP-API result was truncated. Ask for a narrower query or use pagination.'
    }, null, 2);
  }

  return text;
}

function truncateUtf8(text, maxBytes) {
  const buffer = Buffer.from(String(text), 'utf8');
  if (buffer.length <= maxBytes) return String(text);
  return buffer.subarray(0, Math.max(0, maxBytes)).toString('utf8');
}

async function main() {
  const rawInput = await readStdin();
  let args = {};
  if (rawInput.trim()) {
    args = JSON.parse(rawInput);
  }

  const config = requireConfig();
  const client = new AmazonSPAPIClient(config);
  const result = await handleCommand(client, args, config);
  process.stdout.write(makeOutput('success', result, config));
}

main().catch(error => {
  const fallbackConfig = {
    maxResultBytes: envInt('AMAZON_SPAPI_MAX_RESULT_BYTES', 200000),
    debug: envBool('AMAZON_SPAPI_DEBUG', false)
  };
  const payload = fallbackConfig.debug && error && error.responseBody
    ? `${error.message}\nResponse: ${JSON.stringify(error.responseBody)}`
    : (error && error.message ? error.message : String(error));
  process.stdout.write(makeOutput('error', `AmazonSPAPI Error: ${payload}`, fallbackConfig));
});
