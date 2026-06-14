const fs = require('fs');
const os = require('os');
const path = require('path');

const SENSITIVE_HEADER_RE = /authorization/i;

function requireValue(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`AmazonAds token refresh missing required config: ${name}`);
  return normalized;
}

function maskHeaders(headers = {}) {
  const masked = {};
  for (const [key, value] of Object.entries(headers)) {
    masked[key] = SENSITIVE_HEADER_RE.test(key) && value ? 'Bearer ***' : value;
  }
  return masked;
}

function writeJsonAtomically(filePath, data) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.mcp-config.${process.pid}.${Date.now()}.json`);
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Keep the refreshed token usable even on filesystems that reject chmod.
  }
}

async function requestAccessToken(runtimeConfig) {
  const refreshConfig = runtimeConfig.tokenRefresh || {};
  const clientId = requireValue(refreshConfig.clientId, 'AMAZON_CLIENT_ID');
  const clientSecret = requireValue(refreshConfig.clientSecret, 'AMAZON_CLIENT_SECRET');
  const refreshToken = requireValue(refreshConfig.refreshToken, 'AMAZON_REFRESH_TOKEN');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret
  });

  const response = await fetch(refreshConfig.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(runtimeConfig.requestTimeoutMs)
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`Amazon token endpoint returned non-JSON, HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }

  if (!response.ok) {
    throw new Error(`Amazon token refresh failed, HTTP ${response.status}: ${JSON.stringify(data).slice(0, 1000)}`);
  }
  if (!data.access_token) {
    throw new Error(`Amazon token refresh returned no access_token: ${JSON.stringify(data).slice(0, 1000)}`);
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    tokenType: data.token_type
  };
}

function applyAmazonAdsHeaders(headers, runtimeConfig, accessToken) {
  const refreshConfig = runtimeConfig.tokenRefresh || {};
  const account = runtimeConfig.defaultAccount || {};

  headers.Authorization = `Bearer ${accessToken}`;
  headers['Amazon-Ads-ClientId'] = refreshConfig.clientId;
  headers['Amazon-Advertising-API-ClientId'] = refreshConfig.clientId;

  if (refreshConfig.contextMode === 'FIXED') {
    headers['Amazon-Ads-AI-Account-Selection-Mode'] = 'FIXED';
    if (account.profileId) headers['Amazon-Advertising-API-Scope'] = account.profileId;
    if (account.adsAccountId) headers['Amazon-Ads-AccountID'] = account.adsAccountId;
    if (refreshConfig.managerAccountId) {
      headers['Amazon-Ads-Manager-AccountID'] = refreshConfig.managerAccountId;
    }
  } else {
    for (const key of [
      'Amazon-Ads-AI-Account-Selection-Mode',
      'Amazon-Advertising-API-Scope',
      'Amazon-Ads-AccountID',
      'Amazon-Ads-Manager-AccountID'
    ]) {
      delete headers[key];
    }
  }
}

function loadConfigFile(configPath, serverName) {
  const resolvedPath = path.resolve(configPath);
  const config = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  const server = config?.mcpServers?.[serverName];
  if (!server || typeof server !== 'object') {
    throw new Error(`MCP server "${serverName}" not found in ${resolvedPath}`);
  }
  return { resolvedPath, config, server };
}

async function refreshAmazonAdsToken(runtimeConfig, args = {}) {
  const refreshConfig = runtimeConfig.tokenRefresh || {};
  if (!refreshConfig.enabled) {
    throw new Error('AmazonAds token refresh is disabled. Set AMAZON_ADS_ENABLE_TOKEN_REFRESH=true to enable this command.');
  }

  if (refreshConfig.password && !args.internal) {
    const provided = args.refreshPassword || args.refresh_password || args.requireAdmin || args.password;
    if (provided !== refreshConfig.password) {
      throw new Error('AmazonAds token refresh password is incorrect.');
    }
  }

  const token = await requestAccessToken(runtimeConfig);
  const { resolvedPath, config, server } = loadConfigFile(runtimeConfig.mcpConfigPath, runtimeConfig.mcpServerName);
  const headers = server.headers && typeof server.headers === 'object' ? server.headers : {};
  server.headers = headers;
  applyAmazonAdsHeaders(headers, runtimeConfig, token.accessToken);
  writeJsonAtomically(resolvedPath, config);

  return {
    success: true,
    command: 'refresh_token',
    configPath: resolvedPath,
    serverName: runtimeConfig.mcpServerName,
    expiresIn: token.expiresIn || null,
    tokenType: token.tokenType || null,
    contextMode: refreshConfig.contextMode,
    maskedHeaders: maskHeaders(headers),
    refreshedAt: new Date().toISOString(),
    trigger: args.internal ? 'auto' : 'manual',
    host: os.hostname()
  };
}

function describeTokenRefresh(runtimeConfig) {
  const refreshConfig = runtimeConfig.tokenRefresh || {};
  return {
    enabled: Boolean(refreshConfig.enabled),
    autoRefresh: Boolean(refreshConfig.autoRefresh),
    intervalSeconds: Number(refreshConfig.intervalSeconds || 0) || null,
    hasClientId: Boolean(refreshConfig.clientId),
    hasClientSecret: Boolean(refreshConfig.clientSecret),
    hasRefreshToken: Boolean(refreshConfig.refreshToken),
    passwordRequired: Boolean(refreshConfig.password),
    contextMode: refreshConfig.contextMode || 'FIXED'
  };
}

module.exports = {
  describeTokenRefresh,
  refreshAmazonAdsToken
};
