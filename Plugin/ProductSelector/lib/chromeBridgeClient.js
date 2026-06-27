class ChromeBridgeClient {
  constructor(pluginManager, logger = console) {
    this.pluginManager = pluginManager;
    this.logger = logger;

    // We maintain a list of tabs opened by the bridge to be able to close them later
    this.bridgeOpenedTabs = new Set();
    this.bridgeOpenedTabTargets = new Set();
  }

  normalizeArgs(args = {}) {
    const normalized = { ...args };
    const copySelectorToTarget = suffix => {
      const selectorKey = `selector${suffix}`;
      const targetKey = `target${suffix}`;
      if (normalized[targetKey] === undefined && normalized[selectorKey] !== undefined) {
        normalized[targetKey] = normalized[selectorKey];
      }
    };

    copySelectorToTarget('');
    for (let index = 1; normalized[`command${index}`]; index++) {
      copySelectorToTarget(index);
    }
    return normalized;
  }

  async call(args) {
    if (!this.pluginManager || typeof this.pluginManager.processToolCall !== 'function') {
      throw new Error('PluginManager 不可用，无法调用 ChromeBridge。');
    }

    if (!args) args = {};
    args = this.normalizeArgs(args);

    // For wait_for_text and extract_table, we use execute_script because the new VCPChrome removed them natively.
    if (args.command === 'wait_for_text') {
      return this._waitForText(args);
    }
    if (args.command === 'wait_for_url') {
      return this._waitForUrl(args);
    }
    if (args.command === 'extract_table') {
      return this._extractTable(args);
    }
    if (args.command === 'close_tabs_opened_by_bridge') {
      return this._closeTabsOpenedByBridge();
    }
    if (args.command === 'open_url') {
      // Remember we opened a tab
      this.bridgeOpenedTabs.add('last_opened');
      // If the user's extension has monitoring OFF, wait_for_page_info will timeout.
      // We pass wait_for_page_info down, but if it times out, the user needs to turn on monitoring.
    }

    // Pass through native commands directly to ChromeBridge plugin
    // The new ChromeBridge supports command1, command2, command3 natively!
    return await this.pluginManager.processToolCall('ChromeBridge', args);
  }

  async getPageInfo(timeout = 30000) {
    return this._getPageInfo({ timeout });
  }

  async openUrl(url, timeout = 45000) {
    const result = await this.openUrlWithScript(url, Math.min(timeout, 10000));
    this.bridgeOpenedTabs.add('last_opened');
    const target = this.getTabSwitchTarget(url);
    if (target) this.bridgeOpenedTabTargets.add(target);
    if (target) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await this.switchTab(target, Math.min(timeout, 10000));
          break;
        } catch (error) {
          if (attempt === 4) break;
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
    }
    return result;
  }

  getTabSwitchTarget(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.replace(/^www\./, '');
    } catch (_) {
      return null;
    }
  }

  async openUrlWithScript(url, timeout = 10000) {
    try {
      return await this.call({
        command: 'execute_script',
        text: `
          const targetUrl = ${JSON.stringify(url)};
          const openedWindow = window.open(targetUrl, '_blank');
          if (!openedWindow) {
            window.location.href = targetUrl;
          }
          return {
            opened_new_tab: Boolean(openedWindow),
            target_url: targetUrl,
            current_url: window.location.href
          };
        `,
        timeout
      });
    } catch (error) {
      const pending = this.pluginManager.processToolCall('ChromeBridge', {
        command: 'open_url',
        url,
        timeout
      });
      pending.catch(lateError => {
        if (this.logger?.warn) {
          this.logger.warn(`[ProductSelector] Native open_url fallback finished after non-blocking path: ${lateError.message}`);
        }
      });
      await new Promise(resolve => setTimeout(resolve, 300));
      return {
        success: true,
        message: `execute_script open failed, dispatched native open_url without waiting: ${error.message}`,
        url
      };
    }
  }

  async switchTab(target, timeout = 30000) {
    return this.call({
      command: 'switch_tab',
      target,
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

  async extractTable(options = {}) {
    return this.call({
      command: 'extract_table',
      ...options,
      timeout: options.timeout || 30000
    });
  }

  // --- Polyfills for missing commands in the new VCPChrome ---

  async _closeTabsOpenedByBridge() {
    if (this.bridgeOpenedTabs.has('last_opened')) {
      try {
        let tabs = null;
        try {
          const tabsResult = await this.pluginManager.processToolCall('ChromeBridge', { command: 'list_tabs' });
          if (Array.isArray(tabsResult?.result)) tabs = tabsResult.result;
        } catch (_) {
          tabs = null;
        }

        if (Array.isArray(tabs) && this.bridgeOpenedTabTargets.size > 0) {
          const targets = Array.from(this.bridgeOpenedTabTargets);
          const targetTabs = tabs.filter(tab => targets.some(target => String(tab.url || '').includes(target)));
          if (targetTabs.length > 0) {
            for (const tab of targetTabs) {
              try {
                await this.pluginManager.processToolCall('ChromeBridge', {
                  command: 'switch_tab',
                  target: String(tab.id || tab.url || tab.title)
                });
                if (tabs.length <= 1) {
                  await this.pluginManager.processToolCall('ChromeBridge', {
                    command: 'execute_script',
                    text: "window.location.href = 'about:blank'; return { blanked: true };"
                  });
                } else {
                  await this.pluginManager.processToolCall('ChromeBridge', { command: 'close_tab' });
                }
              } catch (_) {
                // Continue trying other tracked tabs.
              }
            }
            this.bridgeOpenedTabs.clear();
            this.bridgeOpenedTabTargets.clear();
            return { success: true, message: `成功清理 ${targetTabs.length} 个桥接打开的标签页` };
          }
        }

        if (Array.isArray(tabs) && tabs.length <= 1) {
          await this.pluginManager.processToolCall('ChromeBridge', {
            command: 'execute_script',
            text: "window.location.href = 'about:blank'; return { blanked: true };"
          });
        } else {
          await this.pluginManager.processToolCall('ChromeBridge', { command: 'close_tab' });
        }
        this.bridgeOpenedTabs.clear();
        this.bridgeOpenedTabTargets.clear();
        return { success: true, message: '成功关闭桥接打开的标签页' };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    return { success: true, message: '没有需要关闭的标签页' };
  }

  async _getPageInfo(args = {}) {
    const timeout = args.timeout || 30000;
    const script = `
      function cleanText(value) {
        return String(value || '').replace(/\\s+/g, ' ').trim();
      }

      function blockText(value, maxChars) {
        const text = String(value || '')
          .replace(/\\u200b/g, '')
          .replace(/[ \\t]+/g, ' ')
          .split(/\\r?\\n/)
          .map(line => line.trim())
          .filter(Boolean)
          .join('\\n');
        return text.slice(0, maxChars || 50000);
      }

      function isVisibleElement(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0' &&
          rect.width > 0 &&
          rect.height > 0;
      }

      function describeInteractive(element) {
        const tag = element.tagName.toLowerCase();
        const role = element.getAttribute('role') || '';
        const text = cleanText(
          element.innerText ||
          element.value ||
          element.placeholder ||
          element.getAttribute('aria-label') ||
          element.title ||
          element.name ||
          element.id
        );
        if (!text && tag !== 'input' && tag !== 'textarea' && tag !== 'select') return '';
        const type = tag === 'a'
          ? '链接'
          : (tag === 'button' || role === 'button' || element.type === 'submit' ? '按钮'
            : (tag === 'select' ? '下拉选择' : '输入框'));
        return '[' + type + ': ' + (text || element.name || element.id || '无标题') + ']';
      }

      function collectInteractiveMarkdown(limit) {
        return Array.from(document.querySelectorAll('a, button, input, textarea, select, [role="button"], [role="link"], [onclick], [tabindex]'))
          .filter(isVisibleElement)
          .map(describeInteractive)
          .filter(Boolean)
          .slice(0, limit)
          .join('\\n');
      }

      const title = document.title || '';
      const url = location.href || '';
      const bodyText = blockText(document.body?.innerText || '', 50000);
      const interactive = collectInteractiveMarkdown(200);
      const markdown = '# ' + title + '\\nURL: ' + url + '\\n\\n' + bodyText + (interactive ? '\\n\\n## 可交互元素\\n' + interactive : '');
      const inputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"], [role="searchbox"]'))
        .filter(isVisibleElement)
        .slice(0, 30)
        .map((element, index) => {
          const type = (element.type || element.getAttribute('role') || element.tagName || '').toLowerCase();
          const value = element.value || element.innerText || element.textContent || '';
          return {
            label: cleanText(element.placeholder || element.getAttribute('aria-label') || element.name || element.id || 'input-' + (index + 1)),
            type,
            filled: Boolean(value),
            value_preview: type === 'password' ? (value ? '[已填写]' : '') : String(value).slice(0, 80)
          };
        });
      return {
        page_info: markdown,
        page_state: {
          title,
          url,
          readyState: document.readyState,
          visible_text_sample: bodyText.slice(0, 1200),
          is_login_like: /login|signin|登录|立即登录|密码|手机号|邮箱/i.test(title + ' ' + url + ' ' + bodyText.slice(0, 2000)),
          inputs,
          timestamp: Date.now()
        }
      };
    `;

    try {
      const result = await this.pluginManager.processToolCall('ChromeBridge', {
        command: 'execute_script',
        text: script,
        timeout
      });
      const payload = result?.result || {};
      return {
        success: true,
        message: '页面信息获取成功',
        page_info: payload.page_info || '',
        page_state: payload.page_state || null
      };
    } catch (error) {
      return {
        success: false,
        error: error.message || '页面信息获取失败',
        page_info: '',
        page_state: null
      };
    }
  }

  async _waitForText(args) {
    const text = args.text;
    const timeout = args.timeout || 30000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        // Just execute a simple script to check if text is on page
        const result = await this.pluginManager.processToolCall('ChromeBridge', {
          command: 'execute_script',
          text: `return document.body.innerText.includes(${JSON.stringify(text)});`
        });

        if (result && result.result === true) {
          return { success: true, message: `已找到文本: ${text}` };
        }
      } catch (e) {
        // Ignore errors during polling
      }
      // Wait 1 second
      await new Promise(r => setTimeout(r, 1000));
    }

    return { success: false, error: `等待文本超时: ${text}` };
  }

  async _waitForUrl(args) {
    const expectedUrl = args.text;
    const timeout = args.timeout || 30000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const result = await this.pluginManager.processToolCall('ChromeBridge', {
          command: 'execute_script',
          text: `return window.location.href;`
        });

        if (result && result.result && result.result.includes(expectedUrl)) {
          return { success: true, message: `URL 已匹配: ${expectedUrl}` };
        }
      } catch (e) {
        // Ignore
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    return { success: false, error: `等待URL超时: ${expectedUrl}` };
  }

  async _extractTable(args) {
    const options = {
      selector: args.selector || args.target || 'body',
      tableMode: args.table_mode || args.tableMode || 'auto',
      maxRows: Number(args.max_rows ?? args.maxRows ?? 100),
      rowSelector: args.row_selector || args.rowSelector || '',
      includeHtml: args.include_html ?? args.includeHtml ?? false,
      includeDetails: args.include_details ?? args.includeDetails ?? true,
      includeLinks: args.include_links ?? args.includeLinks ?? false,
      columns: args.columns || args.fields || [],
      maxCellChars: Number(args.max_cell_chars ?? args.maxCellChars ?? 220),
      maxDetailChars: Number(args.max_detail_chars ?? args.maxDetailChars ?? 260),
      maxLinks: Number(args.max_links ?? args.maxLinks ?? 20),
      maxAsins: Number(args.max_asins ?? args.maxAsins ?? 10)
    };

    const script = `
      const options = ${JSON.stringify(options)};

      function cleanText(value) {
        return String(value || '').replace(/\\u200b/g, '').replace(/\\s+/g, ' ').trim();
      }

      function truncate(value, maxChars) {
        const text = cleanText(value);
        if (!maxChars || text.length <= maxChars) return text;
        return text.slice(0, Math.max(0, maxChars - 1)) + '...';
      }

      function isVisible(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0' &&
          rect.width > 0 &&
          rect.height > 0;
      }

      function removeNoise(root) {
        root.querySelectorAll([
          'script',
          'style',
          'canvas',
          'svg',
          'input[type="hidden"]',
          '.popover',
          '.tooltip',
          '.iconfont'
        ].join(',')).forEach(node => node.remove());
      }

      function compactElementText(element, maxChars) {
        if (!element) return '';
        const clone = element.cloneNode(true);
        removeNoise(clone);
        clone.querySelectorAll('br, div, p, li, tr, h1, h2, h3, h4, h5, h6').forEach(node => {
          node.appendChild(document.createTextNode(' '));
        });
        return truncate(clone.textContent || clone.innerText || '', maxChars);
      }

      function extractAsinFromUrl(url) {
        const match = String(url || '').match(/\\/dp\\/([A-Z0-9]{10})/i);
        return match ? match[1].toUpperCase() : null;
      }

      function extractAsinsFromText(text) {
        const seen = new Set();
        const result = [];
        const matches = String(text || '').match(/\\b[A-Z0-9]{10}\\b/gi) || [];
        matches.forEach(match => {
          const asin = match.toUpperCase();
          const isValid = (/^B[A-Z0-9]{9}$/.test(asin) && /[0-9]/.test(asin)) || /^[0-9]{9}[0-9X]$/.test(asin);
          if (isValid && !seen.has(asin)) {
            seen.add(asin);
            result.push(asin);
          }
        });
        return result;
      }

      function collectLinks(row, maxLinks) {
        const links = [];
        row.querySelectorAll('a[href]').forEach(anchor => {
          if (links.length >= maxLinks) return;
          const href = anchor.href || '';
          if (!href || href.startsWith('javascript:')) return;
          links.push({
            text: cleanText(anchor.innerText || anchor.textContent || '') || null,
            href,
            asin: extractAsinFromUrl(href)
          });
        });
        return links;
      }

      function findContainer(selector) {
        let container = null;
        if (selector && selector !== 'body') {
          container = document.querySelector(selector);
          if (container) return container;
        }
        const tables = document.querySelectorAll('table');
        let maxCells = 0;
        for (const table of tables) {
          const cells = table.querySelectorAll('td').length;
          if (cells > maxCells) {
            maxCells = cells;
            container = table;
          }
        }
        if (!container && tables.length > 0) {
          for (const table of tables) {
            const cells = table.querySelectorAll('td, th').length;
            if (cells > maxCells) {
              maxCells = cells;
              container = table;
            }
          }
        }
        return container || document.body;
      }

      function getVisibleCells(row) {
        let cells = Array.from(row.querySelectorAll(':scope > th, :scope > td')).filter(isVisible);
        if (cells.length === 0) cells = Array.from(row.children || []).filter(isVisible);
        return cells;
      }

      function extractHeaders(container, rows) {
        if (container?.tagName === 'TABLE') {
          const headerRow = Array.from(container.querySelectorAll('thead tr')).find(row => getVisibleCells(row).length > 0);
          if (headerRow) {
            return getVisibleCells(headerRow).map((cell, index) => compactElementText(cell, 80) || 'column_' + (index + 1));
          }
        }
        const table = container?.querySelector('table');
        if (table) {
          const headerRow = Array.from(table.querySelectorAll('thead tr')).find(row => getVisibleCells(row).length > 0);
          if (headerRow) {
            return getVisibleCells(headerRow).map((cell, index) => compactElementText(cell, 80) || 'column_' + (index + 1));
          }
        }
        const globalHeaderRow = Array.from(document.querySelectorAll('thead tr')).find(row => getVisibleCells(row).length > 0);
        if (globalHeaderRow) {
          return getVisibleCells(globalHeaderRow).map((cell, index) => compactElementText(cell, 80) || 'column_' + (index + 1));
        }
        const first = rows.find(row => Array.from(row.querySelectorAll('th')).length > 0);
        if (first) return getVisibleCells(first).map((cell, index) => compactElementText(cell, 80) || 'column_' + (index + 1));
        return [];
      }

      function findProductRows(root) {
        const selectors = [
          'tr',
          '.el-table__row',
          '.vxe-body--row',
          '[class*="table-row"]',
          '[class*="body-row"]'
        ];
        const seen = new Set();
        const rows = [];
        root.querySelectorAll(selectors.join(',')).forEach(row => {
          if (!isVisible(row) || seen.has(row)) return;
          const text = cleanText(row.innerText || row.textContent || '');
          if (!/\\bB0[A-Z0-9]{8}\\b/i.test(text) && !row.querySelector('a[href*="/dp/"]')) return;
          seen.add(row);
          rows.push(row);
        });
        return rows;
      }

      function findExpandedProductRow(row) {
        let cursor = row?.nextElementSibling || null;
        for (let i = 0; cursor && i < 3; i++) {
          if (cursor.querySelector?.('.el-table__expanded-cell, .table-expand, .card-expand, .product-type')) {
            return cursor;
          }
          cursor = cursor.nextElementSibling;
        }
        return null;
      }

      function extractNodeIdPathFromHref(href) {
        if (!href) return '';
        try {
          const url = new URL(href, location.href);
          const direct = url.searchParams.get('nodeIdPath');
          if (direct) return cleanText(direct);
          const paths = url.searchParams.get('nodeIdPaths');
          if (!paths) return '';
          try {
            const parsed = JSON.parse(paths);
            if (Array.isArray(parsed) && parsed.length > 0) {
              return cleanText(parsed[parsed.length - 1]);
            }
          } catch (_) {
            const match = paths.match(/\\d+(?::\\d+)*/g);
            return match && match.length > 0 ? match[match.length - 1] : '';
          }
        } catch (_) {
          const direct = String(href).match(/[?&]nodeIdPath=([^&#]+)/);
          if (direct) return decodeURIComponent(direct[1]);
          const paths = String(href).match(/[?&]nodeIdPaths=([^&#]+)/);
          if (paths) {
            const decoded = decodeURIComponent(paths[1]);
            const match = decoded.match(/\\d+(?::\\d+)*/g);
            return match && match.length > 0 ? match[match.length - 1] : '';
          }
        }
        return '';
      }

      function extractCategorySegmentsFromLinks(container) {
        if (!container) return [];
        return Array.from(container.querySelectorAll('a[href*="nodeIdPaths"], a.type'))
          .map(anchor => cleanText(anchor.innerText || anchor.textContent || ''))
          .filter(text => text && !/BS榜单|新品榜|市场分析|找相似|查专利|Tiktok|1688|Alibaba/i.test(text));
      }

      function extractCnCategorySegments(container) {
        if (!container) return [];
        const text = cleanText(container.innerText || container.textContent || '')
          .replace(/^中文类目名\\s*[:：]?\\s*/i, '');
        if (!text) return [];
        return text.split(/\\s+/).map(item => item.trim()).filter(Boolean);
      }

      function extractSellerSpriteCategoryData(row) {
        const expandedRow = findExpandedProductRow(row);
        const scope = expandedRow || row;
        if (!scope) return {};

        const productType = scope.querySelector('.product-type');
        const cnType = scope.querySelector('.product-type-cn');
        const categoryLinks = Array.from(scope.querySelectorAll('a[href*="nodeIdPaths"], a[href*="nodeIdPath="]'));
        const nodeIdPath = categoryLinks
          .map(anchor => extractNodeIdPathFromHref(anchor.getAttribute('href') || anchor.href || ''))
          .filter(Boolean)
          .sort((a, b) => b.length - a.length)[0] || '';
        const enSegments = extractCategorySegmentsFromLinks(productType);
        const cnSegments = extractCnCategorySegments(cnType);
        const result = {};
        if (enSegments.length > 0) {
          result.category_path = enSegments.join(' > ');
          result.category_en_path = result.category_path;
          result.category_top = enSegments[0];
        }
        if (cnSegments.length > 0) {
          result.category_cn_path = cnSegments.join(' > ');
        }
        if (nodeIdPath) {
          result.category_node_id_path = nodeIdPath;
          result.category_top_node_id = nodeIdPath.split(':')[0] || '';
          result.category_match_source = 'dom_breadcrumb_href';
          result.category_match_confidence = 1;
        }
        return result;
      }

      function buildRow(row, index, headers) {
        const cells = getVisibleCells(row);
        const values = cells.length > 0
          ? cells.map(cell => compactElementText(cell, options.maxCellChars))
          : [compactElementText(row, options.maxCellChars)];
        const text = cleanText(row.innerText || row.textContent || values.join(' '));
        const asins = [
          ...extractAsinsFromText(text),
          ...Array.from(row.querySelectorAll('a[href*="/dp/"]')).map(anchor => extractAsinFromUrl(anchor.href)).filter(Boolean)
        ].filter((asin, i, array) => array.indexOf(asin) === i).slice(0, options.maxAsins);
        const data = {};
        if (asins.length > 0) {
          data.asins = asins;
          data.asin = asins[0];
        }

        // Extract title, brand, parent_asin, and badges for product info
        const amazonLink = row.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
        if (amazonLink) {
          data.title = cleanText(amazonLink.innerText || amazonLink.textContent);
        }
        const brandEl = row.querySelector('.brand, .brand-name, .brand-item, a[href*="/brand/"]');
        if (brandEl) {
          data.brand = cleanText(brandEl.innerText || brandEl.textContent);
        }
        if (asins.length > 1) {
          data.parent_asin = asins[1];
        }
        const imgEl = row.querySelector('img[src*="media-amazon.com"], img[src*="amazon.com"]');
        if (imgEl && imgEl.src) {
          data.image_url = imgEl.src;
        }
        const rowHtml = row.innerHTML || '';
        const badges = [];
        if (/class="[^"]*a-plus[^"]*"|A\+内容|class="[^"]*tag-a-plus[^"]*"/i.test(rowHtml) || row.querySelector('.a-plus, .tag-a-plus') || text.includes('A+')) {
          badges.push('A+');
        }
        if (/class="[^"]*video[^"]*"|class="[^"]*icon-video[^"]*"|视频/i.test(rowHtml) || row.querySelector('.video, .icon-video') || text.includes('视频') || text.includes('Video')) {
          badges.push('V');
        }
        if (/class="[^"]*best-seller[^"]*"|Best Seller|BS榜单|class="[^"]*icon-bs[^"]*"/i.test(rowHtml) || row.querySelector('.best-seller, .icon-bs, a[href*="/bestsellers/"]') || text.includes('Best Seller') || text.includes('BS榜单')) {
          badges.push('BS');
        }
        if (/class="[^"]*amazons-choice[^"]*"|Amazon\'s Choice|class="[^"]*icon-ac[^"]*"/i.test(rowHtml) || row.querySelector('.amazons-choice, .icon-ac') || text.includes("Amazon's Choice") || text.includes('AC')) {
          badges.push('AC');
        }
        if (/class="[^"]*new-release[^"]*"|New Release|新品榜|class="[^"]*icon-nr[^"]*"/i.test(rowHtml) || row.querySelector('.new-release, .icon-nr, a[href*="/new-releases/"]') || text.includes('New Release') || text.includes('新品榜')) {
          badges.push('NR');
        }
        if (badges.length > 0) {
          data.badges = badges;
        }
        const categoryData = extractSellerSpriteCategoryData(row);
        Object.assign(data, categoryData);
        row.querySelectorAll('[data-keyword], [data-asin], [data-clipboard]').forEach(element => {
          const keyword = element.getAttribute('data-keyword');
          const asin = element.getAttribute('data-asin');
          const clipboard = element.getAttribute('data-clipboard');
          if (keyword && !data.keyword) data.keyword = cleanText(keyword);
          if (asin && !data.asin) data.asin = cleanText(asin);
          if (clipboard && !data.clipboard) data.clipboard = cleanText(clipboard);
        });
        const result = {
          row_index: index + 1,
          values,
          text
        };
        if (Object.keys(data).length > 0) result.data = data;
        if (options.includeHtml) result.html = row.outerHTML || '';
        if (options.includeDetails) result.detail = truncate(text, options.maxDetailChars);
        if (options.includeLinks) result.links = collectLinks(row, options.maxLinks);
        return result;
      }

      function collectRows(container) {
        if (!container) return [];
        if (options.tableMode === 'sellersprite_product') {
          const productRows = findProductRows(container);
          if (productRows.length > 0) return productRows;
        }
        if (options.rowSelector) {
          return Array.from(container.querySelectorAll(options.rowSelector)).filter(row => isVisible(row) && !row.closest('thead'));
        } else if (container.tagName === 'TABLE') {
          let rows = Array.from(container.querySelectorAll('tbody tr')).filter(isVisible);
          if (rows.length === 0) {
            rows = Array.from(container.querySelectorAll('tr')).filter(row => isVisible(row) && !row.closest('thead'));
          }
          return rows;
        }
        let descendantRows = Array.from(container.querySelectorAll('table tbody tr')).filter(isVisible);
        if (descendantRows.length === 0) {
          descendantRows = Array.from(container.querySelectorAll('table tr')).filter(row => isVisible(row) && !row.closest('thead'));
        }
        if (descendantRows.length > 0) return descendantRows;
        return Array.from(container.children || []).filter(row => isVisible(row) && !row.closest('thead'));
      }

      function parseResultCount() {
        const text = cleanText(document.body?.innerText || '');
        const match = text.match(/(?:搜索结果数|结果数|Results?)\\s*[:：]?\\s*([0-9,]+)/i);
        return match ? match[1] : null;
      }

      function extractTable() {
        const container = findContainer(options.selector);
        const allRows = collectRows(container);
        const maxRows = Number.isFinite(options.maxRows) && options.maxRows > 0 ? options.maxRows : 100;
        const rows = allRows.slice(0, maxRows);
        const inferredHeaders = extractHeaders(container, allRows);
        const requestedColumns = Array.isArray(options.columns) ? options.columns.map(cleanText).filter(Boolean) : [];
        const headers = requestedColumns.length > 0 ? requestedColumns : inferredHeaders;
        const mappedRows = rows.map((row, index) => buildRow(row, index, headers));
        const html = options.includeHtml ? (container?.outerHTML || document.body?.outerHTML || '') : undefined;
        return {
          selector: options.selector || 'body',
          mode: options.tableMode || 'auto',
          headers,
          rows: mappedRows,
          row_count: mappedRows.length,
          result_count: parseResultCount(),
          page_state: {
            title: document.title || '',
            url: location.href || '',
            readyState: document.readyState
          },
          html,
          text: cleanText(container?.innerText || container?.textContent || '').slice(0, 50000)
        };
      }
      return extractTable();
    `;

    try {
      const result = await this.pluginManager.processToolCall('ChromeBridge', {
        command: 'execute_script',
        text: script,
        timeout: args.timeout || 30000
      });
      return {
        success: true,
        message: '提取表格成功',
        table_data: result.result,
        page_state: result.result?.page_state || null
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
}

module.exports = ChromeBridgeClient;
