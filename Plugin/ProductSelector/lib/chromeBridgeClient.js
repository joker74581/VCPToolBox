class ChromeBridgeClient {
  constructor(pluginManager, logger = console) {
    this.pluginManager = pluginManager;
    this.logger = logger;
  }

  async call(args) {
    if (!this.pluginManager || typeof this.pluginManager.processToolCall !== 'function') {
      throw new Error('PluginManager 不可用，无法调用 ChromeBridge。');
    }

    const result = await this.pluginManager.processToolCall('ChromeBridge', args || {});
    return result;
  }

  async getPageInfo(timeout = 30000) {
    return this.call({
      command: 'get_page_info',
      timeout
    });
  }

  async openUrl(url, timeout = 45000) {
    return this.call({
      command: 'open_url',
      url,
      timeout
    });
  }

  async closeTabsOpenedByBridge(timeout = 30000) {
    return this.call({
      command: 'close_tabs_opened_by_bridge',
      timeout
    });
  }

  async closeTab(timeout = 30000) {
    return this.call({
      command: 'close_tab',
      timeout
    });
  }

  async waitForText(text, timeout = 45000) {
    return this.call({
      command: 'wait_for_text',
      text,
      timeout
    });
  }

  async waitForUrl(text, timeout = 45000) {
    return this.call({
      command: 'wait_for_url',
      text,
      timeout
    });
  }

  async extractTable({
    selector,
    tableMode,
    maxRows,
    includeHtml = false,
    includeDetails = true,
    includeLinks = false,
    columns,
    fields,
    rowSelector,
    maxCellChars,
    maxDetailChars,
    maxLinks,
    maxAsins,
    timeout = 30000
  } = {}) {
    const request = {
      command: 'extract_table',
      selector,
      table_mode: tableMode,
      include_html: includeHtml,
      include_details: includeDetails,
      include_links: includeLinks,
      columns,
      fields,
      row_selector: rowSelector,
      max_cell_chars: maxCellChars,
      max_detail_chars: maxDetailChars,
      max_links: maxLinks,
      max_asins: maxAsins,
      timeout
    };
    if (Number.isFinite(Number(maxRows)) && Number(maxRows) > 0) {
      request.max_rows = Math.floor(Number(maxRows));
    }
    return this.call(request);
  }
}

module.exports = ChromeBridgeClient;
