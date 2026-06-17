const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(process.cwd(), 'Plugin', 'AmazonAds', 'mcp-config', 'mcp-config.json');
const DEFAULT_SERVER_NAME = 'amazon_ads';
const DEFAULT_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

const DEFAULT_ACCOUNT = {
  accountName: '',
  adsAccountId: '',
  profileId: '',
  entityId: '',
  marketplace: 'US'
};

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function maskHeaders(headers = {}) {
  const masked = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/authorization/i.test(key)) {
      masked[key] = value ? 'Bearer ***' : '';
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

function loadMcpServerConfig(configPath, serverName) {
  const resolvedPath = path.resolve(configPath);
  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const config = JSON.parse(raw);
  const server = config?.mcpServers?.[serverName];
  if (!server || typeof server !== 'object') {
    throw new Error(`MCP server "${serverName}" not found in ${resolvedPath}`);
  }
  if (!server.url || typeof server.url !== 'string') {
    throw new Error(`MCP server "${serverName}" has no valid url`);
  }
  const headers = server.headers && typeof server.headers === 'object' ? server.headers : {};
  if (!headers.Authorization || !headers['Amazon-Ads-ClientId']) {
    throw new Error(`MCP server "${serverName}" is missing Authorization or Amazon-Ads-ClientId header`);
  }
  return {
    configPath: resolvedPath,
    serverName,
    url: server.url,
    timeout: parseNumber(server.timeout, 60000),
    headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)])),
    maskedHeaders: maskHeaders(headers)
  };
}

function buildRuntimeConfig(pluginConfig = {}) {
  const mcpConfigPath = pluginConfig.AMAZON_ADS_MCP_CONFIG_PATH || pluginConfig.MCP_CONFIG_PATH || DEFAULT_CONFIG_PATH;
  const mcpServerName = pluginConfig.AMAZON_ADS_MCP_SERVER_NAME || DEFAULT_SERVER_NAME;
  const stateDir = pluginConfig.AMAZON_ADS_STATE_DIR || path.join(__dirname, '..', 'state');
  return {
    mcpConfigPath,
    mcpServerName,
    stateDir,
    safeMode: parseBoolean(pluginConfig.AMAZON_ADS_SAFE_MODE, true),
    debugMode: parseBoolean(pluginConfig.DebugMode, false),
    operationPassword: pluginConfig.AMAZON_ADS_OPERATION_PASSWORD || null,
    tokenRefresh: {
      enabled: parseBoolean(pluginConfig.AMAZON_ADS_ENABLE_TOKEN_REFRESH, false),
      autoRefresh: parseBoolean(pluginConfig.AMAZON_ADS_AUTO_REFRESH_TOKEN, false),
      intervalSeconds: parseNumber(pluginConfig.AMAZON_ADS_TOKEN_REFRESH_INTERVAL_SECONDS, 3000),
      tokenUrl: pluginConfig.AMAZON_ADS_TOKEN_URL || DEFAULT_TOKEN_URL,
      clientId: pluginConfig.AMAZON_CLIENT_ID || pluginConfig.AMAZON_ADS_CLIENT_ID || null,
      clientSecret: pluginConfig.AMAZON_CLIENT_SECRET || pluginConfig.AMAZON_ADS_CLIENT_SECRET || null,
      refreshToken: pluginConfig.AMAZON_REFRESH_TOKEN || pluginConfig.AMAZON_ADS_REFRESH_TOKEN || null,
      password: pluginConfig.AMAZON_ADS_TOKEN_REFRESH_PASSWORD || null,
      contextMode: String(pluginConfig.AMAZON_ADS_CONTEXT_MODE || 'FIXED').toUpperCase(),
      managerAccountId: pluginConfig.AMAZON_ADS_MANAGER_ACCOUNT_ID || null
    },
    requestTimeoutMs: parseNumber(pluginConfig.AMAZON_ADS_REQUEST_TIMEOUT_MS, 120000),
    pollIntervalMs: parseNumber(pluginConfig.AMAZON_ADS_REPORT_POLL_INTERVAL_MS, 30000),
    maxPollMs: parseNumber(pluginConfig.AMAZON_ADS_REPORT_MAX_POLL_MS, 600000),
    reportCreateMinIntervalMs: parseNumber(pluginConfig.AMAZON_ADS_REPORT_CREATE_MIN_INTERVAL_MS, 3000),
    probeMaxCandidateFields: parseNumber(pluginConfig.AMAZON_ADS_PROBE_MAX_CANDIDATE_FIELDS, 4),
    maxDownloadBytes: parseNumber(pluginConfig.AMAZON_ADS_MAX_DOWNLOAD_BYTES, 5 * 1024 * 1024),
    defaultAccount: {
      accountName: pluginConfig.AMAZON_ADS_DEFAULT_ACCOUNT_NAME || DEFAULT_ACCOUNT.accountName,
      adsAccountId: pluginConfig.AMAZON_ADS_DEFAULT_ACCOUNT_ID || DEFAULT_ACCOUNT.adsAccountId,
      profileId: pluginConfig.AMAZON_ADS_DEFAULT_PROFILE_ID || DEFAULT_ACCOUNT.profileId,
      entityId: pluginConfig.AMAZON_ADS_DEFAULT_ENTITY_ID || DEFAULT_ACCOUNT.entityId,
      marketplace: pluginConfig.AMAZON_ADS_DEFAULT_MARKETPLACE || DEFAULT_ACCOUNT.marketplace
    }
  };
}

function resolveAccount(args = {}, runtimeConfig) {
  return {
    accountName: args.accountName || args.account_name || runtimeConfig.defaultAccount.accountName,
    adsAccountId: args.adsAccountId || args.ads_account_id || args.accountId || args.account_id || runtimeConfig.defaultAccount.adsAccountId,
    profileId: args.profileId || args.profile_id || runtimeConfig.defaultAccount.profileId,
    entityId: args.entityId || args.entity_id || runtimeConfig.defaultAccount.entityId,
    marketplace: String(args.marketplace || args.market || runtimeConfig.defaultAccount.marketplace || 'US').toUpperCase()
  };
}

module.exports = {
  DEFAULT_ACCOUNT,
  DEFAULT_CONFIG_PATH,
  buildRuntimeConfig,
  loadMcpServerConfig,
  maskHeaders,
  parseBoolean,
  parseNumber,
  resolveAccount
};
