const fetchFn = globalThis.fetch || require('undici').fetch;

class McpHttpError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'McpHttpError';
    this.status = details.status;
    this.body = details.body;
    this.data = details.data;
    this.retryAfterMs = details.retryAfterMs;
  }
}

function parseJsonOrText(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseSseOrJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('event:') || trimmed.includes('\ndata:')) {
    const dataLines = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length > 0) return parseJsonOrText(dataLines.join('\n'));
  }
  return parseJsonOrText(text);
}

function sanitizeHeaders(headers = {}) {
  const sanitized = { ...headers };
  if (sanitized.Authorization) sanitized.Authorization = 'Bearer ***';
  return sanitized;
}

function isRetryableNetworkError(error) {
  const code = error?.cause?.code || error?.code || '';
  if (error?.name === 'AbortError') return false;
  if (error instanceof McpHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  return error?.name === 'TypeError'
    || ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code);
}

function shouldRetryPayload(payload) {
  if (payload?.method !== 'tools/call') return true;
  const toolName = payload?.params?.name;
  return toolName !== 'reporting-create_report';
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function compactMcpContent(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return result;
  if (content.length === 1 && content[0]?.type === 'text') {
    const text = content[0].text;
    if (typeof text === 'string') {
      const parsed = parseJsonOrText(text);
      return parsed ?? text;
    }
  }
  return result;
}

class AmazonAdsMcpClient {
  constructor({ url, headers, timeoutMs = 120000, logger = console }) {
    if (!url) throw new Error('Amazon Ads MCP url is required');
    this.url = url;
    this.baseHeaders = { ...headers };
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.sessionId = null;
    this.initialized = false;
    this.nextId = 1;
  }

  getStatus() {
    return {
      url: this.url,
      initialized: this.initialized,
      hasSession: Boolean(this.sessionId),
      headers: sanitizeHeaders(this.baseHeaders)
    };
  }

  async initialize() {
    if (this.initialized) return { already_initialized: true, sessionId: this.sessionId };
    const data = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'vcp-amazonads-plugin',
        version: '1.0.0'
      }
    }, { allowUninitialized: true });
    this.initialized = true;
    return data;
  }

  async request(method, params = {}, options = {}) {
    const id = this.nextId++;
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params: params || {}
    };
    const data = await this.postJson(payload, options);
    if (data && typeof data === 'object' && data.error) {
      throw new McpHttpError(`MCP method ${method} failed: ${data.error.message || 'unknown error'}`, {
        data,
        body: JSON.stringify(data).slice(0, 2000)
      });
    }
    return data?.result ?? data;
  }

  async notification(method, params = {}) {
    const payload = {
      jsonrpc: '2.0',
      method,
      params: params || {}
    };
    return this.postJson(payload, { allowEmpty: true });
  }

  async postJson(payload, options = {}) {
    if (!options.allowUninitialized && !this.initialized && payload.method !== 'initialize') {
      await this.initialize();
    }

    let maxAttempts = shouldRetryPayload(payload) ? 3 : 1;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.postJsonOnce(payload, options);
      } catch (error) {
        lastError = error;
        if (error.status === 429 && maxAttempts === 1) {
          maxAttempts = 3;
        }
        if (attempt >= maxAttempts || !isRetryableNetworkError(error)) throw error;
        const retryMs = error.retryAfterMs || (error.status === 429 ? 5000 * attempt : 750 * attempt);
        this.logger.warn?.(`[AmazonAds] MCP request retry ${attempt}/${maxAttempts - 1} after ${retryMs}ms: ${error.message}`);
        await delay(retryMs);
      }
    }
    throw lastError;
  }

  async postJsonOnce(payload, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = {
      ...this.baseHeaders,
      Accept: this.baseHeaders.Accept || 'application/json, text/event-stream',
      'Content-Type': 'application/json'
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    try {
      const response = await fetchFn(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const responseSessionId = response.headers.get('mcp-session-id') || response.headers.get('Mcp-Session-Id');
      if (responseSessionId) this.sessionId = responseSessionId;

      const text = await response.text();
      const data = parseSseOrJson(text);
      if (!response.ok) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        throw new McpHttpError(`HTTP ${response.status} from Amazon Ads MCP`, {
          status: response.status,
          body: text.slice(0, 2000),
          data,
          retryAfterMs
        });
      }
      if (!text && options.allowEmpty) return null;
      return data;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(`Amazon Ads MCP request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async listTools() {
    return this.request('tools/list', {});
  }

  async callTool(name, args = {}) {
    const result = await this.request('tools/call', {
      name,
      arguments: args || {}
    });
    return compactMcpContent(result);
  }

  async listPrompts() {
    return this.request('prompts/list', {});
  }

  async getPrompt(name, args = {}) {
    return this.request('prompts/get', {
      name,
      arguments: args || {}
    });
  }

  async listResources() {
    return this.request('resources/list', {});
  }
}

module.exports = {
  AmazonAdsMcpClient,
  McpHttpError,
  compactMcpContent,
  parseJsonOrText,
  parseSseOrJson,
  sanitizeHeaders
};
