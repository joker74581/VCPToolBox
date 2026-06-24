const fs = require('fs').promises;
const path = require('path');

let debugMode = false;

const VCP_ROOT_DIR = path.resolve(__dirname, '..', '..');
const AUTO_SELECTION_RUNS_DIR = path.join(__dirname, 'runs');
const AUTO_SELECTION_STRATEGY_PROFILE_PATH = path.join(__dirname, 'AutoSelectionStrategyProfile.md');
const AGENT_TASK_DIR = path.join(VCP_ROOT_DIR, 'file', 'document', 'AgentTask');
const AUTO_SELECTION_STAGES = new Set(['brief', 'raw', 'scored', 'archived', 'failed', 'locks']);
// Staging area for intermediate eliminated directions within one trigger lifecycle.
// NOT part of AUTO_SELECTION_STAGES on purpose: it keeps multiple files per run with
// their original brief/raw/scored suffixes, so it must not flow through the single-
// suffix resolveAutoSelectionFile machinery. Managed via dedicated helpers below.
const AUTO_SELECTION_DROPPED_DIR = path.join(AUTO_SELECTION_RUNS_DIR, 'dropped');
let AUTO_SELECTION_SCOUT_AGENT_NAME = process.env.AUTO_SELECTION_SCOUT_AGENT_NAME || 'ProductSelectionScout';
let AUTO_SELECTION_REVIEWER_AGENT_NAME = process.env.AUTO_SELECTION_REVIEWER_AGENT_NAME || 'ProductSelectionReviewer';
let AUTO_SELECTION_SCOUT_TASK_PREFIXES = parsePrefixList(process.env.AUTO_SELECTION_SCOUT_TASK_PREFIXES || `APS_SCOUT_,${AUTO_SELECTION_SCOUT_AGENT_NAME}_`);
let AUTO_SELECTION_REVIEWER_TASK_PREFIXES = parsePrefixList(process.env.AUTO_SELECTION_REVIEWER_TASK_PREFIXES || `APS_REVIEWER_,${AUTO_SELECTION_REVIEWER_AGENT_NAME}_`);

const AUTO_SELECTION_FILE_SUFFIX = {
  brief: 'brief.md',
  raw: 'raw.md',
  scored: 'scored.md',
  archived: 'final.md',
  failed: 'failed.md',
  locks: 'lock'
};

function nowIso() {
  return new Date().toISOString();
}

function debugLog(...args) {
  if (debugMode) console.log('[AutoProductSelection]', ...args);
}

function logWorkflowEvent(message, isError = false) {
  const time = nowIso();
  const formatted = `[${time}] ${message}`;

  if (isError) {
    console.error(`[AutoProductSelection] ${message}`);
  } else if (debugMode) {
    console.log(`[AutoProductSelection] ${message}`);
  }

  const historyPath = path.join(AUTO_SELECTION_RUNS_DIR, 'workflow_history.log');
  try {
    const fsSync = require('fs');
    const dir = path.dirname(historyPath);
    if (!fsSync.existsSync(dir)) {
      fsSync.mkdirSync(dir, { recursive: true });
    }

    let content = '';
    if (fsSync.existsSync(historyPath)) {
      content = fsSync.readFileSync(historyPath, 'utf8');
    }
    const lines = content.split('\n').filter(Boolean);
    lines.push(formatted);
    if (lines.length > 500) {
      lines.splice(0, lines.length - 500);
    }
    fsSync.writeFileSync(historyPath, lines.join('\n') + '\n', 'utf8');
  } catch (err) {
    console.error('[AutoProductSelection] Failed to write workflow history log:', err.message);
  }
}


function parsePrefixList(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

// --- v3 Scoring Engine config (every constant overridable via config.env) ---
// The scoring engine is fully data-driven so different sellers can retune it for
// their own edge without touching code. Each key maps to an env var APS_SCORE_<KEY>.
// Opportunity is a WEIGHTED GEOMETRIC MEAN of pillars (not the old fully-
// multiplicative chain), so several "good enough" pillars no longer collapse a
// direction to an un-publishable score, while a near-dead pillar still drags hard.
const SCORING_DEFAULTS = {
  // Pillar weights (relative; normalized at use).
  w_demand: 0.25,
  w_competition: 0.20,
  w_profit: 0.25,
  w_differentiation: 0.18,
  w_execution: 0.12,
  // Per-pillar input trust (0-1). High for DOM-scraped fields (search volume, BSR,
  // review_count, price); low for 商机探测器-derived CVR/CPA/ACOS on cold keywords,
  // which the seller has flagged as frequently distorted.
  trust_demand: 0.90,
  trust_competition: 0.85,
  trust_profit: 0.55,
  trust_differentiation: 0.70,
  trust_execution: 0.75,
  // Listing leverage = how much the BUY decision is scene/emotion/presentation driven
  // (decor/toys/gifts -> high) vs raw-spec driven (tools/replacement parts -> low).
  // seller_listing_skill is the seller's fixed structural edge in presentation.
  // The differentiation pillar is boosted by leverage*skill, so the seller's listing
  // edge pays off on 代入感 products and barely moves on purely functional ones.
  seller_listing_skill: 0.8,
  listing_leverage_default: 0.5,
  listing_leverage_gain: 0.5,
  // Geometric-mean pillar floor (avoid log(0); a truly dead pillar still bottoms out).
  pillar_floor: 0.05,
  // Interval decision thresholds on the 0-100 point estimate.
  recommend_floor: 62, // P - U >= this -> strong enough to publish as-is (RECOMMEND)
  drop_ceiling: 42,    // P + U <  this -> even the optimistic estimate fails -> DROP
  uncertainty_min: 5,  // band half-width at full trust
  uncertainty_max: 22, // band half-width at zero trust
  // Compliance soft multiplier floor for the non-gate range (>=9 is a hard gate).
  compliance_mult_floor: 0.55
};
let SCORING_CONFIG = { ...SCORING_DEFAULTS };

function loadScoringConfig(config = {}) {
  const next = { ...SCORING_DEFAULTS };
  for (const key of Object.keys(SCORING_DEFAULTS)) {
    const envKey = `APS_SCORE_${key.toUpperCase()}`;
    const raw = config[envKey] ?? process.env[envKey];
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
      const num = Number(raw);
      if (Number.isFinite(num)) next[key] = num;
    }
  }
  SCORING_CONFIG = next;
  return SCORING_CONFIG;
}

function configureAutoSelectionRuntime(config = {}) {
  loadScoringConfig(config);
  loadWorkflowBudgetConfig(config);
  AUTO_SELECTION_SCOUT_AGENT_NAME = String(
    config.AUTO_SELECTION_SCOUT_AGENT_NAME ||
    process.env.AUTO_SELECTION_SCOUT_AGENT_NAME ||
    AUTO_SELECTION_SCOUT_AGENT_NAME ||
    'ProductSelectionScout'
  ).trim();
  AUTO_SELECTION_REVIEWER_AGENT_NAME = String(
    config.AUTO_SELECTION_REVIEWER_AGENT_NAME ||
    process.env.AUTO_SELECTION_REVIEWER_AGENT_NAME ||
    AUTO_SELECTION_REVIEWER_AGENT_NAME ||
    'ProductSelectionReviewer'
  ).trim();

  const scoutPrefixes = parsePrefixList(
    config.AUTO_SELECTION_SCOUT_TASK_PREFIXES ||
    process.env.AUTO_SELECTION_SCOUT_TASK_PREFIXES ||
    `APS_SCOUT_,${AUTO_SELECTION_SCOUT_AGENT_NAME}_`
  );
  const reviewerPrefixes = parsePrefixList(
    config.AUTO_SELECTION_REVIEWER_TASK_PREFIXES ||
    process.env.AUTO_SELECTION_REVIEWER_TASK_PREFIXES ||
    `APS_REVIEWER_,${AUTO_SELECTION_REVIEWER_AGENT_NAME}_`
  );
  const scoutAgentPrefix = `${AUTO_SELECTION_SCOUT_AGENT_NAME}_`;
  const reviewerAgentPrefix = `${AUTO_SELECTION_REVIEWER_AGENT_NAME}_`;
  AUTO_SELECTION_SCOUT_TASK_PREFIXES = scoutPrefixes.includes(scoutAgentPrefix) ? scoutPrefixes : [...scoutPrefixes, scoutAgentPrefix];
  AUTO_SELECTION_REVIEWER_TASK_PREFIXES = reviewerPrefixes.includes(reviewerAgentPrefix) ? reviewerPrefixes : [...reviewerPrefixes, reviewerAgentPrefix];
}

function referencesStrategyProfile(value) {
  return /AutoSelectionStrategyProfile(?:\.md)?/i.test(String(value || ''));
}

function strategyProfileMisuseResponse(command) {
  return {
    success: false,
    command,
    error: 'strategy_file_is_not_run_file',
    message: 'AutoSelectionStrategyProfile.md is a plugin-root strategy file, not a runs handoff file. Read it with ServerFileOperator.ReadFile instead of AutoProductSelection.',
    correct_tool_call: {
      tool_name: 'ServerFileOperator',
      command: 'ReadFile',
      filePath: AUTO_SELECTION_STRATEGY_PROFILE_PATH
    }
  };
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function sanitizeRunId(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('run_id is required.');
  const safe = raw.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/-+/g, '-').slice(0, 120);
  if (!safe) throw new Error('run_id is invalid after sanitization.');
  return safe;
}

function normalizeAutoSelectionRunId(value) {
  let raw = String(value || '').trim();
  raw = raw.replace(/['"「」始末]/g, '').trim();
  let safe = sanitizeRunId(raw);
  let changed = true;
  while (changed) {
    changed = false;
    const before = safe;
    safe = safe
      .replace(/\.md$/i, '')
      .replace(/\.lock$/i, '')
      .replace(/-(brief|raw|scored|final|failed|hawkeye|forge|lock)$/i, '');
    changed = safe !== before;
  }
  if (!safe) throw new Error('run_id is invalid after auto-selection normalization.');
  return safe;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function buildTimestampRunPrefix(date = new Date()) {
  return [
    'APS',
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`,
    `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  ].join('-');
}

function slugFromBriefContent(content) {
  const text = String(content || '');
  const firstUsefulLine = text
    .split(/\r?\n/)
    .map(line => line.replace(/^#+\s*/, '').trim())
    .find(line => line && !/^selection\s+brief\s*:?$/i.test(line));
  const source = firstUsefulLine || text.slice(0, 80) || 'reselect';
  const slug = source
    .toLowerCase()
    .replace(/selection\s+brief\s*:?\s*/gi, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36)
    .replace(/-+$/g, '');
  return slug || 'reselect';
}

function buildAutoSelectionRunIdFromBrief(content) {
  return normalizeAutoSelectionRunId(`${buildTimestampRunPrefix()}-${slugFromBriefContent(content)}`);
}

function normalizeAutoSelectionStage(stage) {
  let value = String(stage || '').trim();
  value = value.replace(/['"「」始末]/g, '').trim();
  if (!AUTO_SELECTION_STAGES.has(value)) {
    throw new Error(`Invalid auto selection stage: ${value || '(empty)'}`);
  }
  return value;
}

function resolveAutoSelectionFile(stage, runId, lockName = '') {
  const normalizedStage = normalizeAutoSelectionStage(stage);
  const safeRunId = normalizeAutoSelectionRunId(runId);
  let filename;
  if (normalizedStage === 'locks') {
    const safeLockName = String(lockName || '').trim().replace(/[^A-Za-z0-9_.-]/g, '-').replace(/-+/g, '-');
    const lockSuffix = safeLockName ? `${safeLockName}.lock` : AUTO_SELECTION_FILE_SUFFIX.locks;
    filename = `${safeRunId}-${lockSuffix}`;
  } else {
    filename = `${safeRunId}-${AUTO_SELECTION_FILE_SUFFIX[normalizedStage]}`;
  }
  return path.join(AUTO_SELECTION_RUNS_DIR, normalizedStage, filename);
}

function inferAutoSelectionRunIdFromFilename(stage, filename) {
  const normalizedStage = normalizeAutoSelectionStage(stage);
  const name = String(filename || '').trim();
  if (!name || name === '.gitkeep' || name === 'README.md') return '';
  if (normalizedStage === 'locks') {
    return normalizeAutoSelectionRunId(name);
  }
  const suffix = AUTO_SELECTION_FILE_SUFFIX[normalizedStage];
  if (suffix && name.endsWith(`-${suffix}`)) {
    return normalizeAutoSelectionRunId(name.slice(0, -1 * (`-${suffix}`).length));
  }
  return normalizeAutoSelectionRunId(name);
}

function inferAutoSelectionLockName(filename) {
  const safe = String(filename || '').trim();
  const match = safe.match(/-(hawkeye|forge)\.lock$/i);
  return match ? match[1].toLowerCase() : '';
}

function parseAutoSelectionLockContent(content = '') {
  const text = String(content || '');
  const metadata = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || !line.includes(':')) continue;
    const idx = line.indexOf(':');
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    metadata[key] = value;
  }
  const retryCount = Number(metadata.retry_count ?? metadata.retryCount ?? '0');
  return {
    raw: text,
    metadata,
    retry_count: Number.isFinite(retryCount) && retryCount >= 0 ? Math.floor(retryCount) : 0,
    delegation_id: metadata.delegation_id || '',
    dispatch_reason: metadata.dispatch_reason || metadata.reason || 'initial'
  };
}

function normalizeWorkerRole(value) {
  const worker = String(value || '').trim().toLowerCase();
  if (['hawkeye', 'scout', 'researcher', 'collector'].includes(worker)) return 'hawkeye';
  if (['forge', 'reviewer', 'judge', 'evaluator'].includes(worker)) return 'forge';
  return worker;
}

function publicWorkerRole(worker) {
  return worker === 'forge' ? 'reviewer' : 'scout';
}

function classifyMissingWorkerOutput(completedTask = {}) {
  const combined = [
    completedTask?.report_excerpt,
    completedTask?.async_result?.message_excerpt,
    completedTask?.async_result?.status,
    completedTask?.status
  ].filter(Boolean).join('\n').toLowerCase();

  if (!combined) {
    return {
      classification: 'unknown_missing_output',
      safe_to_retry_once: false,
      reason: 'No diagnostic report excerpt available.'
    };
  }

  if (
    combined.includes('达到最大轮数限制') ||
    combined.includes('任务尚未自动上报完成') ||
    combined.includes('max round') ||
    combined.includes('maximum round')
  ) {
    return {
      classification: 'worker_max_rounds_no_handoff',
      safe_to_retry_once: true,
      reason: 'Worker exhausted AgentAssistant rounds without writing raw/scored/failed; retry once with the stricter bounded worker prompt.'
    };
  }

  if (
    combined.includes('连续 2 轮返回空内容') ||
    combined.includes('连续 2 轮返回空回复') ||
    combined.includes('empty_response_circuit_break') ||
    combined.includes('empty response')
  ) {
    return {
      classification: 'worker_empty_response_no_handoff',
      safe_to_retry_once: true,
      reason: 'Worker returned empty content twice without writing handoff; retry once after the model/provider recovers.'
    };
  }

  if (
    combined.includes('未被工具循环处理的 tool_request') ||
    combined.includes('工具请求格式无法被解析器识别') ||
    combined.includes('unprocessed_tool_request')
  ) {
    return {
      classification: 'worker_unprocessed_tool_request_no_handoff',
      safe_to_retry_once: true,
      reason: 'Worker emitted a TOOL_REQUEST that the VCP loop did not process; retry once with the bounded worker prompt.'
    };
  }

  if (
    combined.includes('未找到名为') ||
    combined.includes('tool_name:「始\\"productselector\\"末」') ||
    combined.includes('tool_name:「始"productselector"末」') ||
    combined.includes('command:「始\\"auto_selection_') ||
    combined.includes('command:「始"auto_selection_')
  ) {
    return {
      classification: 'tool_format_error',
      safe_to_retry_once: true,
      reason: 'Worker likely malformed a tool request.'
    };
  }

  if (combined.includes('unknown command:') || combined.includes('plugin_error')) {
    return {
      classification: 'tool_protocol_error',
      safe_to_retry_once: true,
      reason: 'Worker likely issued an invalid command or malformed protocol.'
    };
  }

  if (
    combined.includes('委托任务执行超时') ||
    combined.includes('status code 408') ||
    combined.includes('status code 500') ||
    combined.includes('status code 502') ||
    combined.includes('status code 503') ||
    combined.includes('status code 504')
  ) {
    return {
      classification: 'delegation_transport_error',
      safe_to_retry_once: true,
      reason: 'Delegation transport failed or timed out; allow a single safe retry.'
    };
  }

  return {
    classification: 'unknown_missing_output',
    safe_to_retry_once: false,
    reason: 'Missing output cause is not confidently retryable.'
  };
}

async function findCompletedWorkerWithoutOutput(lockFile) {
  try {
    const lockName = inferAutoSelectionLockName(lockFile.name);
    const workerPrefixes = lockName === 'forge'
      ? AUTO_SELECTION_REVIEWER_TASK_PREFIXES
      : AUTO_SELECTION_SCOUT_TASK_PREFIXES;
    const entries = await fs.readdir(AGENT_TASK_DIR, { withFileTypes: true });
    const lockTime = new Date(lockFile.modified_at).getTime();
    const matches = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const hasExpectedPrefix = workerPrefixes.some(prefix => entry.name.startsWith(prefix));
      const fullPath = path.join(AGENT_TASK_DIR, entry.name);
      const stat = await fs.stat(fullPath);
      if (stat.mtime.getTime() + 5000 < lockTime) continue;
      const content = await fs.readFile(fullPath, 'utf8');
      if (!content.includes(lockFile.run_id)) continue;
      if (!hasExpectedPrefix) continue;
      if (!content.includes('任务状态:** Succeed') && !content.includes('任务状态:** Failed')) continue;
      const delegationId = (entry.name.match(/(aa-delegation-[^.]+)\.md$/) || [])[1] || '';
      const asyncResultPath = delegationId ? path.join(VCP_ROOT_DIR, 'VCPAsyncResults', `AgentAssistant-${delegationId}.json`) : '';
      let asyncResult = null;
      if (asyncResultPath) {
        try {
          asyncResult = JSON.parse(await fs.readFile(asyncResultPath, 'utf8'));
        } catch (_) {
          asyncResult = null;
        }
      }
      const finalResult = content.split('## 最终执行结果')[1]?.trim() || '';
      matches.push({
        name: entry.name,
        path: fullPath,
        modified_at: stat.mtime.toISOString(),
        status: content.includes('任务状态:** Failed') ? 'Failed' : 'Succeed',
        delegation_id: delegationId || undefined,
        report_excerpt: finalResult.slice(0, 1200) || undefined,
        async_result: asyncResult ? {
          status: asyncResult.status,
          message_excerpt: String(asyncResult.message || '').slice(0, 1200)
        } : undefined
      });
    }
    matches.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
    return matches[0] || null;
  } catch (_) {
    return null;
  }
}

async function ensureAutoSelectionRunDirs() {
  await Promise.all([...AUTO_SELECTION_STAGES].map(stage => fs.mkdir(path.join(AUTO_SELECTION_RUNS_DIR, stage), { recursive: true })));
  await fs.mkdir(AUTO_SELECTION_DROPPED_DIR, { recursive: true });
}

/**
 * Move a run's brief/raw/scored handoff files into the dropped staging area instead
 * of physically deleting them. Files keep their original suffix and are prefixed with
 * the run_id so a later sweep can attribute and summarize each eliminated direction.
 * Returns the list of moved file paths.
 */
async function stageDroppedRunFiles(runId) {
  const safeRunId = normalizeAutoSelectionRunId(runId);
  await fs.mkdir(AUTO_SELECTION_DROPPED_DIR, { recursive: true });
  const moved = [];
  for (const stage of ['scored', 'raw', 'brief']) {
    const fromPath = resolveAutoSelectionFile(stage, safeRunId);
    const toPath = path.join(AUTO_SELECTION_DROPPED_DIR, `${safeRunId}-${AUTO_SELECTION_FILE_SUFFIX[stage]}`);
    try {
      await fs.access(fromPath);
      await fs.rm(toPath, { force: true }); // overwrite any prior staged copy
      await fs.rename(fromPath, toPath);
      moved.push(toPath);
    } catch (_) {
      // File absent for this stage; skip.
    }
  }
  return moved;
}

/**
 * Extract the keywords/seed terms a scout already probed and rejected, from a raw/brief's
 * prescreen_log / elimination_log / keyword fields. Returns a compact deduped list so the
 * coordinator can diary them ("tried X/Y/Z, all weak") and future rounds skip repeats.
 */
function extractRejectedKeywords(content = '') {
  const text = String(content || '');
  const found = new Set();
  // Pull values of common keyword-bearing fields within prescreen/elimination sections.
  const keyPatterns = [
    /(?:keyword|keywords|seed_keyword|seed_keywords|target_keywords|direction_keyword)\s*:\s*([^\r\n#]+)/gi,
    /(?:probed_keywords|rejected_keywords|tried_keywords)\s*:\s*([^\r\n#]+)/gi
  ];
  for (const re of keyPatterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = m[1].replace(/^[\["']+|[\]"']+$/g, '').trim();
      for (const piece of raw.split(/[,，、;；]/)) {
        const kw = piece.replace(/^[-\s"'\[]+|[\s"'\]]+$/g, '').trim();
        if (kw && kw.length <= 60 && !/^(none|n\/a|null|-)$/i.test(kw)) found.add(kw);
      }
      if (found.size >= 24) break;
    }
  }
  return [...found].slice(0, 24);
}

/**
 * Extract deferred_candidates from a run's raw content: directions that PASSED prescreen
 * but were not deep-dived this round. These are NOT eliminations — they become priority
 * directions for a future trigger via a [待观察] diary entry. Returns a compact list.
 */
function extractDeferredCandidates(content = '') {
  const lines = String(content || '').split(/\r?\n/);
  const startIdx = lines.findIndex(l => /^\s*deferred_candidates\s*:/i.test(l));
  if (startIdx < 0) return [];
  const headerIndent = (lines[startIdx].match(/^(\s*)/) || ['', ''])[1].length;
  // Collect the block: lines after the header that are more-indented than the header (the
  // YAML list items + their nested keys). Stop at the first line indented <= header that is
  // itself a key/content line (the next sibling field) or a markdown heading.
  const blockLines = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') { blockLines.push(line); continue; }
    const indent = (line.match(/^(\s*)/) || ['', ''])[1].length;
    if (indent <= headerIndent) break;
    blockLines.push(line);
  }
  // Split into list items on lines like "  - ..." and parse each.
  const items = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const dir = String(current.direction || current.firstLine || '').replace(/^[\["']+|[\]"']+$/g, '').trim();
    if (dir && dir.length <= 120) {
      items.push({ direction: dir, keywords: String(current.keywords || '').trim(), rating: String(current.rating || '').trim() });
    }
    current = null;
  };
  for (const raw of blockLines) {
    const itemMatch = raw.match(/^\s*-\s+(.*)$/);
    if (itemMatch) {
      flush();
      current = { firstLine: '', direction: '', keywords: '', rating: '' };
      const inline = itemMatch[1];
      const kv = inline.match(/^(direction|product_direction)\s*:\s*(.+)$/i);
      if (kv) current.direction = kv[2];
      else current.firstLine = inline;
      continue;
    }
    if (!current) continue;
    const d = raw.match(/(?:direction|product_direction)\s*:\s*(.+)$/i);
    if (d) { current.direction = d[1]; continue; }
    const k = raw.match(/(?:seed_keywords|keywords|keyword)\s*:\s*(.+)$/i);
    if (k) { current.keywords = k[1].replace(/^[\["']+|[\]"']+$/g, ''); continue; }
    const r = raw.match(/(?:rating|grade|level)\s*:\s*(.+)$/i);
    if (r) { current.rating = r[1]; continue; }
  }
  flush();
  return items.slice(0, 12);
}

/**
 * Build the Markdown block instructing the coordinator to diary [待观察] deferred directions
 * so they sediment into memory and get prioritized next trigger. '' when none.
 */
function buildDeferredCandidatesPromptBlock(items) {
  if (!items || items.length === 0) return '';
  const lines = items.map(it => {
    const kw = it.keywords ? ` | 种子词: ${it.keywords}` : '';
    const rt = it.rating ? ` | 预筛评级: ${it.rating}` : '';
    return `- 方向: ${it.direction}${kw}${rt}`;
  });
  return [
    '',
    '---',
    '',
    '【本轮过线但未深挖的待观察方向】：',
    ...lines,
    '',
    '这些方向通过了 Level-1 预筛、值得后续深挖，但本轮聚焦深挖了最优方向，未对它们展开。请在写选品公共日记本时，**额外写一条 [待观察] 日记**（与主结论合并或单独一条均可，但要极简）：',
    '- 逐条列出上述待观察方向与其种子词，标注"下一轮优先深挖"。',
    '- Tag 行放在 Content 最后一行，至少含 `#待观察`，并尽量把方向核心词作为标签，便于枢纽下轮检索优先重拾。',
    '- 这是机会暂存，不是淘汰，措辞上不要写成否决。'
  ].join('\n');
}

/**
 * Scan the dropped staging area and summarize each eliminated direction. Reads the
 * scored file when present (richest), else raw, else brief. Extracts product_direction,
 * final verdict, total_score and rejected keywords so the coordinator can publish/diary
 * them in one pass.
 */
async function collectDroppedSummaries() {
  await fs.mkdir(AUTO_SELECTION_DROPPED_DIR, { recursive: true });
  let entries = [];
  try {
    entries = await fs.readdir(AUTO_SELECTION_DROPPED_DIR, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  // Group files by run_id, preferring scored > raw > brief as the summary source.
  const byRun = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === '.gitkeep' || entry.name === 'README.md') continue;
    let stage = '';
    let runId = '';
    for (const candidate of ['scored', 'raw', 'brief', 'failed']) {
      const suffix = `-${AUTO_SELECTION_FILE_SUFFIX[candidate]}`;
      if (entry.name.endsWith(suffix)) {
        stage = candidate;
        runId = entry.name.slice(0, -suffix.length);
        break;
      }
    }
    if (!stage || !runId) continue;
    const priority = { brief: 0, failed: 1, raw: 2, scored: 3 }[stage] || 0;
    const current = byRun.get(runId);
    if (!current || priority > current.priority) {
      byRun.set(runId, { runId, stage, priority, path: path.join(AUTO_SELECTION_DROPPED_DIR, entry.name) });
    }
  }
  const summaries = [];
  for (const { runId, stage, path: filePath } of byRun.values()) {
    let content = '';
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (_) {
      content = '';
    }
    const direction = extractScalarValue(content, 'product_direction') ||
      extractScalarValue(content, 'direction') ||
      slugFromBriefContent(content);
    const verdict = extractFinalVerdict(content) ||
      extractScalarValue(content, 'verdict') ||
      'DROPPED';
    const totalScore = extractScalarValue(content, 'total_score') ||
      extractScalarValue(content, 'final_score') || '';
    const reason = extractScalarValue(content, 'elimination_summary') ||
      extractScalarValue(content, 'primary_reason') || '';
    // Capture the specific keywords/directions the scout already tried and rejected, so the
    // coordinator can diary them and future rounds avoid repeating the same dead-end probes.
    const rejectedKeywords = extractRejectedKeywords(content);
    summaries.push({ run_id: runId, source_stage: stage, direction, verdict, total_score: totalScore, reason, rejected_keywords: rejectedKeywords });
  }
  summaries.sort((a, b) => a.run_id.localeCompare(b.run_id));
  return summaries;
}

/**
 * Build the Markdown block of eliminated directions to append to a coordinator prompt.
 * Returns '' when nothing has been dropped this lifecycle.
 */
function buildDroppedSummaryPromptBlock(summaries) {
  if (!summaries || summaries.length === 0) return '';
  const lines = summaries.map(item => {
    const scorePart = item.total_score ? ` | 评分: ${item.total_score}` : '';
    const reasonPart = item.reason ? ` | 原因: ${String(item.reason).slice(0, 120)}` : '';
    const kwPart = (item.rejected_keywords && item.rejected_keywords.length)
      ? ` | 已试关键词: ${item.rejected_keywords.slice(0, 12).join(', ')}`
      : '';
    return `- 选品 ID: ${item.run_id} | 方向: ${item.direction || '(未标注)'}${scorePart} | 结果: ${item.verdict}${reasonPart}${kwPart}`;
  });
  return [
    '',
    '---',
    '',
    '【本次选品闭环中已排除的淘汰方向汇总】：',
    ...lines,
    '',
    '请你在撰写最终论坛研报和写入选品公共日记本时，将上述淘汰方向一并汇总：',
    '- 论坛帖中增加一个「本轮淘汰记录」小节，逐条列出被排除方向、评分和核心原因。',
    '- 日记只写一条（本轮合并）：在本轮主结论日记里追加一个「本轮淘汰清单」段落，逐条列出被淘汰方向、核心原因，以及上面列出的「已试关键词」（让后续选品可检索避坑、不再重复探测同一批关键词）。',
    '- 该条合并日记的 Tag 行必须放在 Content 最后一行，标签需同时覆盖主结论与淘汰（至少含 `#排除`），并尽量把被淘汰的核心关键词作为标签（如 `#关键词名`）以便未来检索。',
    '- 这些淘汰方向已由后端暂存，归档时会自动清空，你无需手动删除。'
  ].join('\n');
}

/**
 * Sweep all staged dropped files into the archived directory (best-effort), clearing
 * the staging area for the next trigger. Returns the list of archived paths.
 */
async function archiveDroppedStaging() {
  await fs.mkdir(AUTO_SELECTION_DROPPED_DIR, { recursive: true });
  const archivedDir = path.join(AUTO_SELECTION_RUNS_DIR, 'archived');
  await fs.mkdir(archivedDir, { recursive: true });
  let entries = [];
  try {
    entries = await fs.readdir(AUTO_SELECTION_DROPPED_DIR, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const archived = [];
  const archivedRunIds = new Set();
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === '.gitkeep' || entry.name === 'README.md') continue;
    const fromPath = path.join(AUTO_SELECTION_DROPPED_DIR, entry.name);
    const toPath = path.join(archivedDir, `dropped-${entry.name}`);
    try {
      await fs.rm(toPath, { force: true });
      await fs.rename(fromPath, toPath);
      archived.push(toPath);
      for (const suffix of ['brief.md', 'raw.md', 'scored.md', 'failed.md']) {
        const tail = `-${suffix}`;
        if (entry.name.endsWith(tail)) {
          archivedRunIds.add(entry.name.slice(0, -tail.length));
          break;
        }
      }
    } catch (err) {
      console.error(`[AutoProductSelection] Failed to archive dropped file ${entry.name}:`, err.message);
    }
  }
  for (const runId of archivedRunIds) {
    await autoSelectionClearLocks({ run_id: runId }).catch(err =>
      console.error(`[AutoProductSelection] Failed to clear dropped locks for ${runId}:`, err.message));
  }
  return archived;
}

async function listAutoSelectionStage(stage, includeContent = false) {
  const dir = path.join(AUTO_SELECTION_RUNS_DIR, stage);
  await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === '.gitkeep' || entry.name === 'README.md') continue;
    const fullPath = path.join(dir, entry.name);
    try {
      const stat = await fs.stat(fullPath);
      const item = {
        name: entry.name,
        path: fullPath,
        run_id: inferAutoSelectionRunIdFromFilename(stage, entry.name),
        size: stat.size,
        modified_at: stat.mtime.toISOString()
      };
      if (includeContent) {
        item.content = await fs.readFile(fullPath, 'utf8');
      }
      files.push(item);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
  }
  files.sort((a, b) => a.modified_at.localeCompare(b.modified_at));
  return files;
}

async function autoSelectionQueueStatus(args = {}) {
  await ensureAutoSelectionRunDirs();
  const includeContent = parseBoolean(args.include_content ?? args.includeContent, false);
  const workerTimeoutMinutes = Math.max(5, Number(args.worker_timeout_minutes ?? args.workerTimeoutMinutes ?? 60) || 60);
  const nowMs = Date.now();
  const stages = {};
  for (const stage of ['failed', 'scored', 'raw', 'brief', 'locks', 'archived']) {
    stages[stage] = await listAutoSelectionStage(stage, includeContent && ['failed', 'scored', 'raw', 'locks'].includes(stage));
  }
  const rawValidLocks = stages.locks.filter(file => inferAutoSelectionLockName(file.name));
  const validLocks = [];
  for (const lock of rawValidLocks) {
    const lockName = inferAutoSelectionLockName(lock.name);
    const expectedStage = lockName === 'forge' ? 'scored' : 'raw';
    const hasOutput = stages[expectedStage]?.some(file => file.run_id === lock.run_id) || stages.failed?.some(file => file.run_id === lock.run_id);
    if (hasOutput) {
      try {
        await fs.unlink(lock.path);
        console.log(`[AutoProductSelection] Cleaned up lock file ${lock.name} because corresponding output exists.`);
      } catch (err) {
        console.error(`[AutoProductSelection] Failed to auto-cleanup lock file ${lock.name}:`, err.message);
      }
      stages.locks = stages.locks.filter(file => file.path !== lock.path);
    } else {
      validLocks.push(lock);
    }
  }
  // coordinator.lock has no hawkeye/forge suffix but is a legitimate managed lock,
  // not a malformed worker lock. Exclude it so it never drives cleanup_malformed_locks.
  const malformedLocks = stages.locks.filter(file => !inferAutoSelectionLockName(file.name) && file.name !== 'coordinator.lock');
  const archivedRunIds = new Set(stages.archived.map(file => file.run_id));
  const archivedResidues = ['failed', 'scored', 'raw', 'brief', 'locks']
    .flatMap(stage => (stages[stage] || [])
      .filter(file => archivedRunIds.has(file.run_id))
      .map(file => ({ ...file, stage })));
  const lockedRunIds = new Set(validLocks.map(file => file.run_id));
  const activeBriefs = stages.brief.filter(file => !archivedRunIds.has(file.run_id) && !lockedRunIds.has(file.run_id));
  const staleBriefs = stages.brief.filter(file => archivedRunIds.has(file.run_id));
  const missingOutputs = [];

  for (const lock of validLocks) {
    const lockName = inferAutoSelectionLockName(lock.name);
    const expectedStage = lockName === 'forge' ? 'scored' : 'raw';
    let lockMeta = { retry_count: 0, delegation_id: '', dispatch_reason: 'initial', metadata: {}, raw: '' };
    try {
      lockMeta = parseAutoSelectionLockContent(await fs.readFile(lock.path, 'utf8'));
    } catch (_) {
      lockMeta = { retry_count: 0, delegation_id: '', dispatch_reason: 'initial', metadata: {}, raw: '' };
    }
    const hasOutput = stages[expectedStage]?.some(file => file.run_id === lock.run_id) || stages.failed?.some(file => file.run_id === lock.run_id);
    if (hasOutput) continue;
    const completed_task = await findCompletedWorkerWithoutOutput(lock);
    if (completed_task) {
      // Grace window against a RACE: a worker reports its AgentTask done at the transport
      // layer a few seconds BEFORE its raw/scored write lands (the write is a separate tool
      // call). Without a grace period the driver declares "missing output" and force-fails a
      // run whose output arrives moments later. Only treat it as truly missing if the task
      // completed at least WORKER_OUTPUT_GRACE_MS ago; otherwise wait one more tick.
      const completedAgeMs = nowMs - new Date(completed_task.modified_at).getTime();
      if (Number.isFinite(completedAgeMs) && completedAgeMs < WORKER_OUTPUT_GRACE_MS) {
        debugLog(`Worker ${lock.run_id} task completed ${Math.round(completedAgeMs / 1000)}s ago (< grace ${WORKER_OUTPUT_GRACE_MS / 1000}s); waiting for late output write before declaring missing.`);
        continue;
      }
      const retryDiagnosis = classifyMissingWorkerOutput(completed_task);
      missingOutputs.push({
        run_id: lock.run_id,
        lock_name: lockName || 'unknown',
        lock_file: lock,
        expected_stage: expectedStage,
        completed_task,
        retry_count: lockMeta.retry_count,
        retry_guard: {
          classification: retryDiagnosis.classification,
          safe_to_retry_once: retryDiagnosis.safe_to_retry_once,
          reason: retryDiagnosis.reason,
          eligible_now: retryDiagnosis.safe_to_retry_once && lockMeta.retry_count < 1
        }
      });
      continue;
    }
    const lockAgeMinutes = (nowMs - new Date(lock.modified_at).getTime()) / 60000;
    if (Number.isFinite(lockAgeMinutes) && lockAgeMinutes > workerTimeoutMinutes) {
      missingOutputs.push({
        run_id: lock.run_id,
        lock_name: lockName || 'unknown',
        lock_file: lock,
        expected_stage: expectedStage,
        timeout_minutes: workerTimeoutMinutes,
        lock_age_minutes: Number(lockAgeMinutes.toFixed(1)),
        retry_count: lockMeta.retry_count,
        retry_guard: {
          classification: 'worker_timeout',
          safe_to_retry_once: false,
          reason: 'Worker timed out without output; do not blind redispatch.',
          eligible_now: false
        },
        completed_task: {
          status: 'Timeout',
          reason: `No ${expectedStage}/failed output after ${workerTimeoutMinutes} minutes.`
        }
      });
    }
  }

  return {
    success: true,
    command: 'auto_selection_queue_status',
    runs_dir: AUTO_SELECTION_RUNS_DIR,
    worker_timeout_minutes: workerTimeoutMinutes,
    next_action_hint: getAutoSelectionNextAction(stages, { activeBriefs, staleBriefs, missingOutputs, validLocks, malformedLocks, archivedResidues }),
    stages,
    derived: {
      active_briefs: activeBriefs,
      stale_briefs: staleBriefs,
      archived_residues: archivedResidues,
      valid_locks: validLocks,
      malformed_locks: malformedLocks,
      worker_missing_outputs: missingOutputs
    }
  };
}

function getAutoSelectionNextAction(stages, derived = {}) {
  if (derived.archivedResidues?.length) return 'cleanup_archived_residue';
  if (stages.failed?.length) return 'handle_failed';
  if (stages.scored?.length) return 'evaluate_scored';
  if (stages.raw?.length) return 'evaluate_raw';
  if (derived.missingOutputs?.some(item => item.retry_guard?.eligible_now)) return 'retry_worker_once';
  if (derived.missingOutputs?.length) return 'handle_worker_missing_output';
  if (derived.malformedLocks?.length) return 'cleanup_malformed_locks';
  if (derived.validLocks?.length) return 'wait_for_worker';
  if (derived.activeBriefs?.length) return 'send_existing_brief_to_scout';
  return 'create_brief_and_wait_briefing';
}

async function autoSelectionWriteRunFile(args = {}) {
  await ensureAutoSelectionRunDirs();
  if (referencesStrategyProfile(args.run_id ?? args.runId ?? args.filePath ?? args.path)) {
    return strategyProfileMisuseResponse('auto_selection_write_run_file');
  }
  const stage = normalizeAutoSelectionStage(args.stage);
  const runId = normalizeAutoSelectionRunId(args.run_id ?? args.runId);
  const content = String(args.content ?? '');
  if (!content && stage !== 'locks') throw new Error('content is required.');
  const lockName = stage === 'locks'
    ? normalizeWorkerRole(args.lock_name ?? args.lockName ?? '')
    : (args.lock_name ?? args.lockName ?? '');
  if (stage === 'locks' && !['hawkeye', 'forge'].includes(String(lockName || '').trim())) {
    return {
      success: false,
      command: 'auto_selection_write_run_file',
      stage,
      run_id: runId,
      error: 'lock_name_required',
      message: 'When stage=locks, lock_name must be scout/hawkeye or reviewer/forge.'
    };
  }
  const overwrite = parseBoolean(args.overwrite, false);
  const filePath = resolveAutoSelectionFile(stage, runId, lockName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  let fileContent = content;
  if (stage === 'scored') {
    try {
      const scoreResults = calculateScoringModel(content);
      const originalAction = normalizeForgeAction(args.action || extractForgeAction(content) || '');
      // Read budgets/force-decision from the authoritative state file (v4), not lock files.
      const st = await readRunState(runId);
      const writeReselectCount = Math.max(parseLoopbackCounters(content).reselect_count || 0, st?.counters?.reselect || 0);
      const isForceDecision = (st?.force_decision_mode === true) || parseBoolean(args.force_decision_mode ?? args.forceDecisionMode, false);
      const action = decideBackendAction(originalAction, scoreResults, content, writeReselectCount, isForceDecision);
      // This only ANNOTATES the scored file with the math block + computed action for the
      // report to read; the authoritative decision is re-run in advanceEvaluating.
      fileContent = updateScoredContentWithMath(content, scoreResults, action, originalAction);
    } catch (e) {
      debugLog(`Error applying math scoring model during file write: ${e.message}`);
    }
  }

  try {
    if (!overwrite) {
      await fs.writeFile(filePath, fileContent || `lock created at ${nowIso()}\n`, { encoding: 'utf8', flag: 'wx' });
    } else {
      await fs.writeFile(filePath, fileContent || `lock created at ${nowIso()}\n`, 'utf8');
    }
  } catch (err) {
    if (err.code === 'EEXIST' || err.code === 'EACCES') {
      return {
        success: false,
        command: 'auto_selection_write_run_file',
        error: 'file_exists',
        path: filePath,
        next_actions: ['Use overwrite=true only if you intentionally want to replace this handoff file.']
      };
    }
    throw err;
  }
  return {
    success: true,
    command: 'auto_selection_write_run_file',
    stage,
    run_id: runId,
    path: filePath
  };
}

async function autoSelectionReadRunFile(args = {}) {
  await ensureAutoSelectionRunDirs();
  if (referencesStrategyProfile(args.run_id ?? args.runId ?? args.filePath ?? args.path)) {
    return strategyProfileMisuseResponse('auto_selection_read_run_file');
  }
  const stage = normalizeAutoSelectionStage(args.stage);
  const runId = normalizeAutoSelectionRunId(args.run_id ?? args.runId);
  const lockName = args.lock_name ?? args.lockName ?? '';
  const filePath = resolveAutoSelectionFile(stage, runId, lockName);
  const content = await fs.readFile(filePath, 'utf8');
  return {
    success: true,
    command: 'auto_selection_read_run_file',
    stage,
    run_id: runId,
    path: filePath,
    content
  };
}

async function buildAutoSelectionWorkerPrompt(worker, runId, options = {}) {
  const safeRunId = normalizeAutoSelectionRunId(runId);
  const callRhythmInstruction = '调用节奏：每一轮回复最多只发送 1 个 TOOL_REQUEST；等待工具摘要返回后，再基于结果决定下一步，不要在同一轮连续发多个工具块。';
  const counterInstruction = '【重要】如果你读取的 brief 或 raw 文件中包含回退计数器（global_loopback_count、scout_loopback_count、reviewer_loopback_count），你必须将这些计数器原样复制到你输出的文件中。这些计数器用于防止死循环，绝对不能丢失。';
  const completionInstruction = '【任务完成标记】任务完成后，最终回复必须先输出 [[TaskComplete]]，然后在其后输出本任务要求的完整 Markdown/YAML 数据包。后端会自动从你的完成报告中提取并写入 runs 文件；你不要调用 AutoProductSelection 的读写/派发命令。';
  const extraInstruction = String(options.extra_instruction || options.extraInstruction || '').trim();
  const forceDecisionMode = options.force_decision_mode === true || options.forceDecisionMode === true;

  if (worker === 'hawkeye') {
    let briefContent = '';
    let existingRawContent = '';
    try {
      briefContent = await fs.readFile(resolveAutoSelectionFile('brief', safeRunId), 'utf8');
    } catch (err) {
      briefContent = `# AUTO_SELECTION_HANDOFF_ERROR\nrun_id: ${safeRunId}\nstage: brief\nerror: ${err.message}`;
    }
    try {
      existingRawContent = await fs.readFile(resolveAutoSelectionFile('raw', safeRunId), 'utf8');
    } catch (_) {
      existingRawContent = '';
    }

    return `你是破壁_鹰眼（ProductSelectionScout），数据侦察专家。请执行一次自动选品取证任务。

run_id: ${safeRunId}
brief_stage: brief
success_stage: raw
failure_stage: failed

${callRhythmInstruction}

## 你的任务
系统已在本 prompt 中注入 brief（如果是回环补采，也会注入旧 raw/补采要求）。请基于其指示抓取数据。如果是回环补采，请在最终 raw_data_pack 中合并旧数据。

==================================================
【后端自动加载的 brief / SelectionBrief】
${briefContent}
==================================================
${existingRawContent ? `
==================================================
【后端自动加载的旧 raw / 回环补采基线】
${existingRawContent}
==================================================
` : ''}

## 多方向廉价预筛（核心工作法）
brief 通常给你 2-3 个并列候选方向。你必须**先用最便宜的工具横向体检所有方向，本轮只深挖最有潜力的方向**，避免在弱方向上浪费昂贵抓取，也避免一轮塞太多数据稀释注意力。
1. **横向 Level 1 体检（便宜，先做）**：对每个候选方向，只用 run_sellersprite_keyword_research / run_sellersprite_competitor_lookup（必要时 keyword_conversion_rate）快速取需求、购买、价格带、需供比、评论门槛、FBA/price、头部集中度。给每个方向粗评级（强/中/弱）并写入 prescreen_log（方向、关键指标、评级、理由）。
2. **本轮只深挖最优方向（贵，后做）**：本轮最多深挖 ${MAX_DEEP_DIVE_PER_RUN} 个方向——选预筛评级最高的那个做 Level 2（关键词反查、fetch_amazon_product_info、fetch_amazon_reviews），把它的证据一次铺厚。一轮能深挖出一个"好产品/好关键词"就已经很好。
3. **深挖必拿字段（最优方向）**：必须通过 run_sellersprite_research 或 run_sellersprite_competitor_lookup 获取竞品 FBA 样本，至少输出 Top5-10 的 price / fba_fee / profit_margin / 包装或重量尺寸字段（缺失则逐 ASIN 标注）。ProductSelector 能拿到的是竞品 FBA 估算/样本，不是 Seller Central 对目标 SKU 的最终实测。
4. **BOM 口径**：BOM/落地采购成本不是 ProductSelector 可抓字段，不要把它写成工具未取得。请按材料、套装数量、重量、工艺复杂度给一个保守区间（如 bom_estimate_per_set_usd），并明确需要 1688/供应商询价验证。
5. **其它过线但未选中的方向不要淘汰**：把它们写入 raw 的 deferred_candidates（方向、种子词、预筛评级、为何值得后续重拾）。它们不是淘汰，而是**留给后续 trigger 优先深挖的方向**，由后端写入 [待观察] 日记沉淀进记忆。只有真正弱/死的方向才写 elimination_log。
6. **全部方向都弱**：直接 EARLY_REJECT，在 prescreen_log 说明依据，不要硬深挖。

## ProductSelector 清洗字段映射
- 产品选品/查竞品稳定字段：asin、parent_asin、title、image_url、price、parent_sales、child_sales、review_count、monthly_new_reviews、rating、fba_fee、profit_margin、weight_info、pkg_weight_info、putaway_date、seller_count。原样保留到 candidate_products。
- 关键词选品/反查稳定字段：monthly_searches、monthly_purchases、purchase_rate、growth_rate、yearly_growth、recent_3_month_growth、supply_demand_ratio、products、avg_price、avg_reviews、aba_click_share、aba_conversion_share、ppc_bid.low/mid/high。汇总到 keyword_market_summary，并把中位/主入口 PPC 写成 ppc_bid_mid。
- 关键词转化率稳定字段：click_conversion_rate、ppc_bid.low/mid/high、cpa.low/mid/high、product_price.low/avg/high、acos.max/avg/min、ad_budget。汇总到 conversion_rate_matrix，并在最优方向摘要中显式给 raw_click_conversion_rate、ppc_bid_mid、ppc_bid_high、cpa_mid、acos_avg。
- 不要只把评分关键字段埋在表格里；对价格、PPC、CVR、FBA、BOM、包装、头程这些会影响评分的字段，必须在 profitability_raw_estimates 或方向摘要里再给一份扁平汇总。

## 冷门/利基方向纪律（重要）
低搜索量、低成交量**本身不是 EARLY_REJECT 的理由**。无人做的冷门细分常是"先入场"机会（竞争弱、头部未垄断、评论壁垒低）。预筛时区分：
- **真死方向**（可 EARLY_REJECT）：需求几乎为零且无趋势、品类萎缩、或触红线（合规/重货/侵权/利润倒挂）。
- **冷门机会**（应保留深挖）：需求小但稳定或上升、需供比好（商品数 < 搜索量）、痛点/场景清晰、头部不集中。
判断小而美优先看需供比、增长趋势（含往年同期）、头部集中度、痛点清晰度，而不是绝对搜索量。

## 硬性约束
- ProductSelector 数据命令最多 9 次（横向体检每方向 1-2 次×最多3方向 ≈ 6 次，深挖最优方向 ≤3 次；留 1 次缓冲。不要在弱方向上超额抓取）
- 遇到 429/500、账号错误、验证码、页面阻断等系统级错误立即停止，写 failed 或 partial raw，绝不循环重试
- 普通冷门长尾词空结果不是失败结论：允许同义词/父词重试 1 次；同类数据连续 2 次为空后写入 unfetchable_gaps
- 不要死板遵循固定流程，灵活 Pivot（关键词、价格带、市场），但回环补采只能补 reviewer 指定字段

## 数据采集原则
1. **Level 1 方向体检**: 优先抓关键词选品、竞品基础表（便宜入口）。判断需求、购买、PPC、CVR、价格带、评论门槛、FBA占比、头部集中度。
2. **Level 2 候选验证**: 只有方向胜出时，再做关键词反查、Amazon 商品页、Amazon 评论；同时补齐最优方向的竞品 FBA 样本分布和包装/重量尺寸摘要。
3. **Level 3 回环补采**: 只补 brief/loopback_request 指定的 tool、keyword、asin、field；保留旧 raw，合并写回，overwrite=true。
4. **证据最小化**: raw 输出聚合摘要、样本统计、异常说明和 source_map，不塞长评论原文或超长关键词表。
5. **果断早停**: 如果低客单价高 PPC、需求低供给高、Review/ABA 高集中、FBA/price>25%、红线品类或广告明显倒挂，允许 EARLY_REJECT。

${counterInstruction}

## 交付要求
成功、部分成功或可评估的空结果，都在 [[TaskComplete]] 后输出 raw_data_pack YAML；系统阻断或完全不可执行时输出 failed_data_pack YAML 并说明原因。后端会自动写 raw/failed。raw_data_pack 必须包含：
- route_decision (EARLY_REJECT | PIVOT | DEEPEN | READY_FOR_FORGE)
- prescreen_log（每个候选方向的关键指标、强/中/弱评级、为何胜出或落选）
- deferred_candidates（过线但本轮未深挖的方向：方向、种子词、预筛评级、为何值得后续重拾；这些不是淘汰）
- data_audit_inputs.tools_called / sample_counts / unfetchable_gaps / outlier_notes
- keyword_market_summary / competitor_summary / profitability_raw_estimates / review_insight_summary
- review_insight_summary 中尽量给出 scene_vs_function_signal：评论高频词偏"好看/送礼/氛围/设计"还是偏"能用/结实/尺寸/功能"，供熔炉判定 listing_leverage
- source_map / evidence_matrix / elimination_log
- conversion_rate_matrix 与 candidate_products 旧字段仍要保留，方便兼容旧报告读取
- 每个候选 ASIN 必须带 Amazon URL、售价、月销量或销量口径、review_count、rating、FBA费用或缺失说明
- profitability_raw_estimates 必须拆分：fba_fee_samples / fba_fee_estimate_usd（来自 SellerSprite 竞品样本或基于样本估算）与 bom_estimate_per_set_usd（无法抓取，只能估算区间）。不要把 BOM 写入 unfetchable_gaps；FBA 只有在产品选品/查竞品都拿不到样本时才写入 unfetchable_gaps。

${completionInstruction}

不要调用 AutoProductSelection，不调用评审节点，不发论坛，不写 DailyNote。`;
  }

  if (worker === 'forge') {
    let rawContent = '';
    try {
      rawContent = await fs.readFile(resolveAutoSelectionFile('raw', safeRunId), 'utf8');
    } catch (err) {
      rawContent = `# AUTO_SELECTION_HANDOFF_ERROR\nrun_id: ${safeRunId}\nstage: raw\nerror: ${err.message}`;
    }

    return `你是破壁_熔炉（ProductSelectionReviewer），市场评审专家。请执行一次自动选品证据评审任务。

run_id: ${safeRunId}
raw_stage: raw
success_stage: scored
failure_stage: failed

${callRhythmInstruction}

## 你的任务
系统已在本 prompt 中注入 raw。请审计取证节点交付的证据，在 [[TaskComplete]] 后输出 scored_candidate_pack。
${forceDecisionMode ? '\n【force_decision_mode】后端已阻止继续回环。本次必须基于现有证据输出终态裁决：RECOMMEND、WATCHLIST、REJECT 或 DATA_INSUFFICIENT；post_forge_action.action 不得再写 LOOPBACK_TO_SCOUT。' : ''}
${extraInstruction ? `\n【后端补充指令】\n${extraInstruction}` : ''}

==================================================
【后端自动加载的 raw / 鹰眼取证交接数据】
${rawContent}
==================================================

## 全局判决准则
进行”全局拼图判定”：
- **DROP_AND_RESELECT**: 现有数据足以判断该批候选没潜力（利润低、易碎、合规风险高），或 Scout 明确标记 FETCHED_EMPTY（抓取后无有效数据）→ 彻底重选方向
- **LOOPBACK_TO_SCOUT**: 产品有明显潜力，但缺失关键决策数据 → 打回补采
- **PUBLISH_FINAL**: 核心证据充足，潜力明确，评分估计合格 → 放行发布

## 评审打分与数学校验原则
你必须先执行 Hard Gates，然后输出四个分数：
- OpportunityScore：产品机会分
- DataReliabilityScore：数据置信度分
- ExecutionFitScore：小卖家执行适配分
- FinalScore：最终排序分

SellerSprite click_conversion_rate 是行业参考，必须保守修正。默认按小卖家/新品：base_cvr=min(raw*0.50,0.08)，stress_cvr=min(raw*0.35,0.06)。PPC 基础用 mid，压力用 high；只有单个 ppc_bid 时用 1.15x/1.35x。

空数据不是自动失败。ProductSelector 可通过 SellerSprite 产品选品/查竞品拿到竞品 fba_fee、利润率、包装/重量尺寸样本；若 raw 完全缺少这些 FBA 样本，你可以对 fba_fee_samples 发起一次 LOOPBACK_TO_SCOUT。BOM/落地采购成本不是 ProductSelector 可抓字段，不得为 BOM 发起回环；只能要求给出材料与套装假设下的保守区间并降置信度。

## 后端 v3 字段对齐
financial_factors 请尽量输出这些后端稳定识别字段，避免同义字段造成默认值回退：
- selling_price 或 main_band_anchor_usd
- bom_estimate_per_set_usd
- shipping_cost 或 head_freight_usd
- fba_fee_estimate_usd
- packaging_estimate_usd
- referral_fee_pct
- return_reserve_pct
- storage_reserve_usd
- raw_click_conversion_rate
- ppc_bid 与 ppc_bid_stress

## Listing 场景代入杠杆（listing_leverage_score，重要）
本卖家的核心优势是 Listing 呈现能力（主图、A+、场景代入）显著强于同档竞品。但这个优势只在"购买决策由场景/情绪/呈现驱动"的产品上有效，对"纯功能/规格驱动"的产品意义不大。你必须输出 listing_leverage_score（0-1）供后端放大差异化机会分：
- 偏 1（高杠杆）：摆件、装饰、玩具、礼品、家居氛围、收纳美学等——评论高频词偏"好看/送礼/氛围/搭配/设计"，主图与场景图能强烈影响转化。
- 偏 0（低杠杆）：锤子、扳手、线缆、替换件、纯工具件——评论高频词偏"能用/结实/尺寸/兼容/功能"，listing 做得再好也难拉开差距。
- 判定依据：优先用 Scout 的 review_insight_summary.scene_vs_function_signal 与差评痛点类型；无评论样本时按品类常识保守取 0.4-0.6 并说明口径。

## 输出要求
必须包含：
- analysis_status (SUCCESS | PARTIAL | DATA_CORRUPTED)
- final_disposition (verdict: RECOMMEND | WATCHLIST | RESEARCH_GAP | REJECT | DATA_INSUFFICIENT)
- post_forge_action (action: PUBLISH_FINAL | LOOPBACK_TO_SCOUT | DROP_AND_RESELECT)
- listing_leverage_score（0-1，场景代入弹性，附一句判定理由）
- loopback_request（如回环，必须指定 missing_field/requested_tool/target_keywords/target_asins/required_fields/max_additional_tool_calls/stop_after_this_loop）
- hard_gates / scores / score_inputs / multipliers / financial_factors / data_reliability_audit
- business_analysis / product_optimization_directions / key_risks / kill_criteria / next_validation_steps / elimination_summary
- 旧字段 demand_volume、differentiation_feasibility、competition_severity、compliance_risk、complexity_severity、data_confidence、financial_factors.click_conversion_rate、financial_factors.ppc_bid 仍要保留

${completionInstruction}

不要调用 AutoProductSelection，不调用任何工具，不发论坛，不写 DailyNote。`;
  }

  throw new Error(`Invalid auto-selection worker: ${worker}`);
}

function extractForgeAction(content = '') {
  const text = String(content || '');
  const patterns = [
    /post_forge_action[\s\S]{0,600}?\baction\s*:\s*['"]?([A-Z_]+)['"]?/i,
    /post_forge_action[\s\S]{0,600}?\baction\s*=\s*['"]?([A-Z_]+)['"]?/i,
    /\baction\s*:\s*['"]?(PUBLISH_FINAL|LOOPBACK_TO_HAWKEYE|LOOPBACK_TO_SCOUT|DROP_AND_RESELECT)['"]?/i,
    /\b(PUBLISH_FINAL|LOOPBACK_TO_HAWKEYE|LOOPBACK_TO_SCOUT|DROP_AND_RESELECT)\b/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return normalizeForgeAction(match[1]);
  }
  return '';
}

function normalizeForgeAction(value) {
  const action = String(value || '').trim().toUpperCase();
  if (action === 'LOOPBACK_TO_SCOUT') return 'LOOPBACK_TO_HAWKEYE';
  return action;
}

function extractSectionExcerpt(content = '', sectionNames = []) {
  const text = String(content || '');
  const lines = text.split('\n');
  const wanted = sectionNames.map(name => String(name).toLowerCase());
  const picked = [];
  let capturing = false;
  for (const line of lines) {
    const normalized = line.toLowerCase();
    const startsWanted = wanted.some(name => normalized.includes(name));
    if (startsWanted) capturing = true;
    if (capturing) picked.push(line);
    if (capturing && picked.length >= 40) break;
  }
  return picked.join('\n').trim().slice(0, 4000);
}

function buildLoopbackBrief(runId, scoredContent) {
  const excerpt = extractSectionExcerpt(scoredContent, [
    'loopback_request',
    'evidence_gaps',
    'next_research_suggestion',
    'manual_verification',
    'post_forge_action'
  ]) || String(scoredContent || '').slice(0, 3000);
  return [
    '# SelectionBrief - Reviewer Loopback Evidence Patch',
    '',
    `run_id: ${runId}`,
    'mode: LOOPBACK_TO_SCOUT',
    '',
    '## 任务目标',
    '这是 reviewer 评审后的回环补采任务。读取并保留同 run_id 下已有 raw，只针对下方缺口做增量抓取，合并后 overwrite 写回 raw。',
    '',
    '## 补采缺口与熔炉建议',
    '',
    excerpt,
    '',
    '## 交付要求',
    '- 不要重做已有证据。',
    '- 只调用 ProductSelector 补齐 loopback_request 指定的最关键 1-3 个缺口。',
    '- 如果指定字段再次为空，写入 unfetchable_gaps，不要继续围绕同一字段重试。',
    '- 写回 raw 时保留旧 evidence_matrix、asin_source_map、elimination_log，并追加 loopback_history。'
  ].join('\n');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractCandidateProductsSection(content = '') {
  const index = content.indexOf('candidate_products:');
  if (index === -1) return '';
  const lines = content.slice(index).split(/\r?\n/);
  const resultLines = [];
  resultLines.push(lines[0]); // candidate_products:
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^  [a-z0-9_]+:/i.test(line)) {
      break;
    }
    if (/^[a-z0-9_]+:/i.test(line)) {
      break;
    }
    resultLines.push(line);
  }
  return resultLines.join('\n');
}

function extractScalarValue(content = '', key = '') {
  const pattern = new RegExp(`\\b${escapeRegExp(key)}\\s*:\\s*['"]?([^\\r\\n#'"]+)`, 'i');
  const match = String(content || '').match(pattern);
  return match ? match[1].trim().replace(/^\[|\]$/g, '').trim() : '';
}

function normalizeComparableField(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/['"`]/g, '')
    .replace(/[^a-z0-9_./ -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLoopbackRequest(content = '') {
  const text = String(content || '');
  const missingField = extractScalarValue(text, 'missing_field') ||
    extractScalarValue(text, 'field') ||
    extractScalarValue(text, 'required_field');
  const requiredFields = extractScalarValue(text, 'required_fields');
  return {
    gap_type: extractScalarValue(text, 'gap_type'),
    missing_field: missingField,
    requested_tool: extractScalarValue(text, 'requested_tool'),
    target_keywords: extractScalarValue(text, 'target_keywords'),
    target_asins: extractScalarValue(text, 'target_asins'),
    required_fields: requiredFields
  };
}

function sectionContainsField(content = '', sectionName = '', field = '') {
  const normalizedField = normalizeComparableField(field);
  if (!normalizedField) return false;
  const lower = String(content || '').toLowerCase();
  const sectionIndex = lower.indexOf(String(sectionName || '').toLowerCase());
  if (sectionIndex < 0) return false;
  return lower.slice(sectionIndex, sectionIndex + 5000).includes(normalizedField);
}

function hasPriorLoopbackForField(content = '', field = '') {
  const normalizedField = normalizeComparableField(field);
  if (!normalizedField) return false;
  const lower = String(content || '').toLowerCase();
  const loopbackIndex = Math.max(
    lower.indexOf('loopback_history'),
    lower.indexOf('previous_loopback'),
    lower.indexOf('loopback_request')
  );
  if (loopbackIndex < 0) return false;
  return lower.slice(loopbackIndex).includes(normalizedField);
}

function evaluateLoopbackGuard(scoredContent = '', rawContent = '', counters = {}) {
  const request = extractLoopbackRequest(scoredContent);
  const missingField = request.missing_field || request.required_fields || '';
  const normalizedField = normalizeComparableField(missingField);
  const gapType = String(request.gap_type || '').trim().toLowerCase();
  const hasSpecificRequest = Boolean(normalizedField || request.requested_tool || request.target_keywords || request.target_asins);

  if ((counters.global_loopback_count || 0) >= SOFT_MAX_GLOBAL_LOOPBACK) {
    return {
      allowed: false,
      reason: `普通数据回环已达到全局软上限 ${SOFT_MAX_GLOBAL_LOOPBACK}，改为强制终局裁决。`,
      request
    };
  }
  if ((counters.scout_loopback_count || 0) >= SOFT_MAX_SCOUT_LOOPBACK) {
    return {
      allowed: false,
      reason: `鹰眼补采已达到软上限 ${SOFT_MAX_SCOUT_LOOPBACK}，改为强制终局裁决。`,
      request
    };
  }
  if (!hasSpecificRequest) {
    return {
      allowed: false,
      reason: 'loopback_request 缺少具体 missing_field、requested_tool、target_keywords 或 target_asins；禁止笼统继续调研。',
      request
    };
  }
  if (gapType && !['critical', 'important'].includes(gapType)) {
    return {
      allowed: false,
      reason: `gap_type=${request.gap_type} 不允许触发 Scout 回环，只能写入报告缺口。`,
      request
    };
  }
  if (normalizedField && sectionContainsField(rawContent, 'unfetchable_gaps', normalizedField)) {
    return {
      allowed: false,
      reason: `字段 ${missingField} 已被鹰眼标记为 unfetchable_gaps，禁止重复补采。`,
      request
    };
  }
  if (normalizedField && hasPriorLoopbackForField(rawContent, normalizedField)) {
    return {
      allowed: false,
      reason: `字段 ${missingField} 已有补采记录，禁止同一缺口重复回环。`,
      request
    };
  }

  return {
    allowed: true,
    reason: 'loopback_request 具体且未触发重复补采守卫。',
    request
  };
}

async function autoSelectionPrepareDispatch(args = {}) {
  await ensureAutoSelectionRunDirs();
  if (referencesStrategyProfile(args.run_id ?? args.runId)) {
    return strategyProfileMisuseResponse('auto_selection_prepare_dispatch');
  }
  const worker = normalizeWorkerRole(args.worker || args.lock_name || args.lockName || '');
  if (!['hawkeye', 'forge'].includes(worker)) {
    throw new Error('worker is required and must be scout/hawkeye or reviewer/forge.');
  }
  const runId = normalizeAutoSelectionRunId(args.run_id ?? args.runId);
  const overwriteBrief = parseBoolean(args.overwrite_brief ?? args.overwriteBrief, false);
  const overwriteLock = parseBoolean(args.overwrite_lock ?? args.overwriteLock, false);
  const briefContent = args.brief_content ?? args.briefContent ?? args.content;
  const retryCount = Math.max(0, Number(args.retry_count ?? args.retryCount ?? 0) || 0);
  const delegationId = String(args.delegation_id ?? args.delegationId ?? '').trim();
  const dispatchReason = String(args.dispatch_reason ?? args.dispatchReason ?? (retryCount > 0 ? 'retry' : 'initial')).trim() || 'initial';
  const forceDecisionMode = parseBoolean(args.force_decision_mode ?? args.forceDecisionMode, false);
  const extraInstruction = String(args.extra_instruction ?? args.extraInstruction ?? args.reviewer_instruction ?? args.reviewerInstruction ?? '').trim();

  if (worker === 'hawkeye') {
    const briefPath = resolveAutoSelectionFile('brief', runId);
    if (briefContent != null && String(briefContent).trim()) {
      const existing = await autoSelectionWriteRunFile({
        stage: 'brief',
        run_id: runId,
        content: String(briefContent),
        overwrite: overwriteBrief
      });
      if (existing.success === false) return existing;
    } else {
      await fs.access(briefPath);
    }
  } else {
    await fs.access(resolveAutoSelectionFile('raw', runId));
  }

  const lockResult = await autoSelectionWriteRunFile({
    stage: 'locks',
    run_id: runId,
    lock_name: worker,
    content: [
      `worker: ${worker}`,
      `run_id: ${runId}`,
      `dispatched_at: ${nowIso()}`,
      `retry_count: ${retryCount}`,
      `dispatch_reason: ${dispatchReason}`,
      forceDecisionMode ? 'force_decision_mode: true' : '',
      extraInstruction ? `extra_instruction: ${extraInstruction.replace(/\r?\n/g, ' ').slice(0, 1000)}` : '',
      delegationId ? `delegation_id: ${delegationId}` : ''
    ].filter(Boolean).join('\n') + '\n',
    overwrite: overwriteLock
  });
  if (lockResult.success === false) return lockResult;

  return {
    success: true,
    command: 'auto_selection_prepare_dispatch',
    worker,
    public_worker: publicWorkerRole(worker),
    run_id: runId,
    lock_path: lockResult.path,
    agent_assistant_request: {
      agent_name: worker === 'hawkeye' ? AUTO_SELECTION_SCOUT_AGENT_NAME : AUTO_SELECTION_REVIEWER_AGENT_NAME,
      prompt: await buildAutoSelectionWorkerPrompt(worker, runId, {
        force_decision_mode: forceDecisionMode,
        extra_instruction: extraInstruction
      }),
      temporary_contact: true,
      task_delegation: true,
      inject_tools: worker === 'hawkeye' ? 'ProductSelector' : ''
    },
    next_actions: [
      'Call AgentAssistant with the returned agent_assistant_request fields.',
      'Do not add VCP_ASYNC_RESULT placeholders to handoff files.',
      'End this tick after submitting AgentAssistant.'
    ]
  };
}

async function autoSelectionMoveRunFile(args = {}) {
  await ensureAutoSelectionRunDirs();
  if (referencesStrategyProfile(args.run_id ?? args.runId)) {
    return strategyProfileMisuseResponse('auto_selection_move_run_file');
  }
  const fromStage = normalizeAutoSelectionStage(args.from_stage ?? args.fromStage ?? args.stage);
  const toStage = normalizeAutoSelectionStage(args.to_stage ?? args.toStage ?? (args.stage ? 'archived' : ''));
  const runId = normalizeAutoSelectionRunId(args.run_id ?? args.runId);
  const fromLockName = args.from_lock_name ?? args.fromLockName ?? '';
  const toLockName = args.to_lock_name ?? args.toLockName ?? '';
  const fromPath = resolveAutoSelectionFile(fromStage, runId, fromLockName);
  const toPath = resolveAutoSelectionFile(toStage, runId, toLockName);
  await fs.mkdir(path.dirname(toPath), { recursive: true });
  const cleanup = [];
  let archivedAlready = false;
  if (toStage === 'archived') {
    try {
      await fs.access(toPath);
      archivedAlready = true;
    } catch (_) {
      archivedAlready = false;
    }
    if (archivedAlready) {
      await fs.rm(fromPath, { force: true });
    } else {
      await fs.rename(fromPath, toPath);
    }
    cleanup.push(...await cleanupAutoSelectionRunResidue(runId));
  } else {
    await fs.rename(fromPath, toPath);
  }
  return {
    success: true,
    command: 'auto_selection_move_run_file',
    run_id: runId,
    from_stage: fromStage,
    to_stage: toStage,
    from_path: fromPath,
    to_path: toPath,
    archived_already: toStage === 'archived' ? archivedAlready : undefined,
    cleanup
  };
}

async function autoSelectionArchiveRun(args = {}) {
  await ensureAutoSelectionRunDirs();
  if (referencesStrategyProfile(args.run_id ?? args.runId)) {
    return strategyProfileMisuseResponse('auto_selection_archive_run');
  }
  const runId = normalizeAutoSelectionRunId(args.run_id ?? args.runId);
  const requestedStage = args.from_stage ?? args.fromStage ?? args.stage ?? '';
  let fromStage = requestedStage ? normalizeAutoSelectionStage(requestedStage) : '';
  const findFirstExistingStage = async (candidates) => {
    for (const stage of candidates) {
      try {
        await fs.access(resolveAutoSelectionFile(stage, runId));
        return stage;
      } catch (_) {
        // Try the next stage.
      }
    }
    return '';
  };
  if (!fromStage) {
    fromStage = await findFirstExistingStage(['failed', 'scored', 'raw', 'brief']);
  } else if (!['archived', 'locks'].includes(fromStage)) {
    try {
      await fs.access(resolveAutoSelectionFile(fromStage, runId));
    } catch (_) {
      const fallbackStage = await findFirstExistingStage(['failed', 'scored', 'raw', 'brief'].filter(stage => stage !== fromStage));
      if (fallbackStage) fromStage = fallbackStage;
    }
  }
  if (!fromStage || fromStage === 'archived' || fromStage === 'locks') {
    return {
      success: false,
      command: 'auto_selection_archive_run',
      run_id: runId,
      error: 'archive_source_not_found',
      message: 'No archivable failed/scored/raw/brief file was found. Do not use cleanup_run as a substitute for final archive.'
    };
  }
  const moveResult = await autoSelectionMoveRunFile({
    run_id: runId,
    from_stage: fromStage,
    to_stage: 'archived'
  });
  // Final archive of the main run also sweeps the dropped staging area into archived,
  // clearing it so the next trigger starts a fresh exploration.
  const archivedDropped = await archiveDroppedStaging();
  if (moveResult && moveResult.success) {
    moveResult.archived_dropped = archivedDropped;
  }
  return moveResult;
}

async function autoSelectionApplyForgeDecision(args = {}, commandName = 'auto_selection_apply_reviewer_decision') {
  await ensureAutoSelectionRunDirs();
  if (referencesStrategyProfile(args.run_id ?? args.runId)) {
    return strategyProfileMisuseResponse(commandName);
  }
  const runId = normalizeAutoSelectionRunId(args.run_id ?? args.runId);
  const scoredPath = resolveAutoSelectionFile('scored', runId);
  let scoredContent;
  if (args.scored_content ?? args.scoredContent) {
    scoredContent = String(args.scored_content ?? args.scoredContent);
  } else {
    try {
      scoredContent = await fs.readFile(scoredPath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') {
        const archivedPath = resolveAutoSelectionFile('archived', runId);
        try {
          await fs.access(archivedPath);
          return {
            success: true,
            command: commandName,
            run_id: runId,
            action: 'ALREADY_ARCHIVED',
            message: '该任务已被归档完成，无需重复处理。'
          };
        } catch (_) {
          return {
            success: false,
            command: commandName,
            run_id: runId,
            error: 'scored_file_not_found',
            message: '未找到该任务的 scored 状态文件且无归档记录，无法应用决策。'
          };
        }
      }
      throw e;
    }
  }

  // Calculate math model and override action if needed
  const scoreResults = calculateScoringModel(scoredContent);
  const originalAction = normalizeForgeAction(args.action || extractForgeAction(scoredContent) || '');
  // Persisted cross-direction reselect budget (survives DROP/run_id change/restart).
  // Fall back to the in-memory counter if the file has no persisted value yet.
  const persistedCounters = parseLoopbackCounters(scoredContent);
  const effectiveReselectCount = Math.max(persistedCounters.reselect_count || 0, reselectCountThisTrigger || 0);
  const isForceDecision = await isForgeLockInForceDecisionMode(runId) || parseBoolean(args.force_decision_mode ?? args.forceDecisionMode, false);
  const action = decideBackendAction(originalAction, scoreResults, scoredContent, effectiveReselectCount, isForceDecision);

  // Update scored file content with calculated score on disk
  const updatedScoredContent = updateScoredContentWithMath(scoredContent, scoreResults, action, originalAction);
  if (updatedScoredContent !== scoredContent) {
    try {
      await fs.writeFile(scoredPath, updatedScoredContent, 'utf8');
    } catch (e) {
      debugLog(`Failed to write updated score back to ${scoredPath}: ${e.message}`);
    }
  }

  if (!['PUBLISH_FINAL', 'LOOPBACK_TO_HAWKEYE', 'DROP_AND_RESELECT'].includes(action)) {
    return {
      success: false,
      command: commandName,
      run_id: runId,
      error: 'unknown_forge_action',
      detected_action: action || null,
      next_actions: ['Read scored and inspect post_forge_action.action before proceeding.']
    };
  }

  if (action === 'DROP_AND_RESELECT' || action === 'PUBLISH_FINAL') {
    try {
      const rawPath = resolveAutoSelectionFile('raw', runId);
      const rawContent = await fs.readFile(rawPath, 'utf8');
      const hasStatusEmptyOrSuccess = /(run_)?status:\s*['"]?(EMPTY|SUCCESS|PARTIAL|PARTIAL_SUCCESS|FETCHED_EMPTY|FETCHED)['"]?/i.test(rawContent);
      const hasToolsCalled = /(data_tools_called|tools_called):[\s\S]{1,160}-/.test(rawContent);
      const hasRawDataPack = /raw_data_pack\s*:/i.test(rawContent);
      if (!hasStatusEmptyOrSuccess && !hasToolsCalled && !hasRawDataPack) {
        return {
          success: false,
          command: commandName,
          run_id: runId,
          error: 'scout_lazy_validation_error',
          detected_action: action,
          message: 'Validation Error: Cannot drop or publish. Scout Worker has not actually attempted to fetch data (No FETCHED_EMPTY or SUCCESS records found in raw). Please LOOPBACK_TO_SCOUT to force fetching.',
          next_actions: ['Re-evaluate using LOOPBACK_TO_SCOUT to force Scout Worker to fetch data.']
        };
      }
    } catch (e) { }
  }

  if (action === 'LOOPBACK_TO_HAWKEYE') {
    const rawPath = resolveAutoSelectionFile('raw', runId);
    const rawContent = await fs.readFile(rawPath, 'utf8');

    // Parse and increment loopback counters
    const currentCounters = parseLoopbackCounters(scoredContent);
    const loopbackGuard = evaluateLoopbackGuard(scoredContent, rawContent, currentCounters);

    if (!loopbackGuard.allowed) {
      const newCounters = incrementLoopbackCounters(currentCounters, 'REVIEWER_LOOPBACK');
      try {
        const updatedRawContent = injectLoopbackCounters(rawContent, newCounters);
        await fs.writeFile(rawPath, updatedRawContent, 'utf8');
      } catch (e) {
        debugLog(`Failed to update loopback counters in raw file: ${e.message}`);
      }

      const removedScored = await autoSelectionDeleteRunFile({ stage: 'scored', run_id: runId });
      const lockCleanup = await autoSelectionClearLocks({ run_id: runId });
      const reviewerInstruction = [
        '后端已拒绝继续 LOOPBACK_TO_SCOUT。',
        `拒绝原因: ${loopbackGuard.reason}`,
        '请进入 force_decision_mode，读取 raw 后基于现有证据输出终态裁决。',
        '允许的 verdict: RECOMMEND, WATCHLIST, REJECT, DATA_INSUFFICIENT。',
        'post_forge_action.action 不得再写 LOOPBACK_TO_SCOUT。',
        loopbackGuard.request?.missing_field ? `被拒绝补采字段: ${loopbackGuard.request.missing_field}` : ''
      ].filter(Boolean).join('\n');
      const dispatch = await autoSelectionPrepareDispatch({
        worker: 'reviewer',
        run_id: runId,
        overwrite_lock: true,
        dispatch_reason: 'loopback_denied_force_decision',
        force_decision_mode: true,
        reviewer_instruction: reviewerInstruction
      });
      if (dispatch.success && dispatch.agent_assistant_request) {
        // Fire-and-forget: this runs INSIDE the coordinator's delegated task. Awaiting a
        // long worker dispatch here would block the coordinator past DELEGATION_TIMEOUT and
        // trap the workflow in a re-delegate-on-timeout loop. Dispatch async; the worker's
        // raw/scored write re-drives the workflow via triggerImmediateWorkflowTick.
        callAgentAssistant(dispatch.agent_assistant_request).catch(err =>
          logWorkflowEvent(`[Worker Dispatch Failed] force-decision reviewer dispatch error: ${err.message}`, true));
      }
      return {
        success: true,
        command: commandName,
        run_id: runId,
        action: 'FORCE_DECISION_REVIEW',
        original_action: action,
        state_transition: 'loopback_denied_force_review_dispatched_automatically',
        denied_loopback_reason: loopbackGuard.reason,
        loopback_request: loopbackGuard.request,
        removed_scored: removedScored.removed,
        lock_cleanup: lockCleanup.removed || [],
        message: '后端已自动向评审人员（Reviewer）派发强制决策命令，请输出 [[TaskComplete]] 结束当前轮次。',
        next_actions: [
          'Output [[TaskComplete]] immediately to end your turn.',
          'Do not call prepare_dispatch or AgentAssistant manually.'
        ]
      };
    }

    const newCounters = incrementLoopbackCounters(currentCounters, 'LOOPBACK_TO_SCOUT');

    const removedScored = await autoSelectionDeleteRunFile({ stage: 'scored', run_id: runId });
    const lockCleanup = await autoSelectionClearLocks({ run_id: runId });

    // Build loopback brief with injected counters
    const baseBrief = String(args.brief_content ?? args.briefContent ?? buildLoopbackBrief(runId, scoredContent));
    const briefWithCounters = injectLoopbackCounters(baseBrief, newCounters);

    const dispatch = await autoSelectionPrepareDispatch({
      worker: 'hawkeye',
      run_id: runId,
      brief_content: briefWithCounters,
      overwrite_brief: true,
      overwrite_lock: true,
      dispatch_reason: 'forge_loopback'
    });
    if (dispatch.success && dispatch.agent_assistant_request) {
      // Fire-and-forget (see force-decision branch above): never block the coordinator's
      // delegated task on a long worker dispatch, or it times out and re-delegates forever.
      callAgentAssistant(dispatch.agent_assistant_request).catch(err =>
        logWorkflowEvent(`[Worker Dispatch Failed] loopback scout dispatch error: ${err.message}`, true));
    }
    return {
      success: true,
      command: commandName,
      run_id: runId,
      action,
      state_transition: 'loopback_dispatched_automatically',
      removed_scored: removedScored.removed,
      lock_cleanup: lockCleanup.removed || [],
      loopback_counters: newCounters,
      message: '后端已自动向鹰眼（Scout）派发回环补采任务，请输出 [[TaskComplete]] 结束当前轮次。',
      next_actions: [
        'Output [[TaskComplete]] immediately to end your turn.',
        'Do not call prepare_dispatch or AgentAssistant manually.'
      ]
    };
  }

  if (action === 'DROP_AND_RESELECT') {
    // Cross-direction reselect budget guard. DROP_AND_RESELECT resets loopback
    // counters and re-dispatches a brand-new direction, so per-run circuit
    // breakers never see the cumulative cost. The budget is persisted in the
    // counter block (reselect_count) so it survives the run_id change and process
    // restarts; the in-memory counter is only a fallback.
    const priorReselect = Math.max(effectiveReselectCount || 0, reselectCountThisTrigger || 0);
    const newReselectCount = priorReselect + 1;
    reselectCountThisTrigger = newReselectCount; // keep in-memory fallback in sync
    if (newReselectCount > MAX_RESELECT_PER_TRIGGER) {
      // Stage the current direction's files instead of deleting, so the final
      // coordinator report can summarize it alongside other eliminated directions.
      const stagedOnBudget = await stageDroppedRunFiles(runId);
      const budgetFailedContent = [
        '---',
        'failure_type: reselect_budget_exhausted',
        `run_id: ${runId}`,
        `detected_at: ${nowIso()}`,
        `reselect_count: ${newReselectCount - 1}`,
        `max_reselect_per_trigger: ${MAX_RESELECT_PER_TRIGGER}`,
        '---',
        '',
        '# 自动选品跨方向重选预算耗尽',
        '',
        `run_id: ${runId}`,
        '',
        `[重选预算] 本次 trigger 闭环已连续 DROP_AND_RESELECT ${MAX_RESELECT_PER_TRIGGER} 次仍未选出可发布方向，强制收尾以防止无界换方向烧 Token。`,
        '',
        '本轮探索的方向均未达到发布门槛。建议人工审视策略文件方向区间，或下次 trigger 重新探索。'
      ].join('\n');
      const budgetWrite = await autoSelectionWriteRunFile({
        stage: 'failed',
        run_id: runId,
        content: budgetFailedContent,
        overwrite: true
      });
      const budgetLockCleanup = await autoSelectionClearLocks({ run_id: runId });
      return {
        success: true,
        command: commandName,
        run_id: runId,
        old_run_id: runId,
        action: 'RESELECT_BUDGET_EXHAUSTED',
        original_action: action,
        state_transition: 'reselect_budget_exhausted_marked_failed',
        reselect_count: newReselectCount - 1,
        max_reselect_per_trigger: MAX_RESELECT_PER_TRIGGER,
        staged_dropped: stagedOnBudget,
        failed_path: budgetWrite.path,
        lock_cleanup: budgetLockCleanup.removed || [],
        next_actions: [
          'Reselect budget exhausted for this trigger. The run is marked failed.',
          'The workflow driver will publish the blocking report and self-terminate.'
        ]
      };
    }

    const replacementBrief = args.brief_content ?? args.briefContent;
    const requestedNewRunId = args.new_run_id ?? args.newRunId ?? args.next_run_id ?? args.nextRunId;
    const nextRunId = replacementBrief != null && String(replacementBrief).trim()
      ? normalizeAutoSelectionRunId(requestedNewRunId || buildAutoSelectionRunIdFromBrief(replacementBrief))
      : runId;

    // DROP_AND_RESELECT: reset loopback counters for the fresh direction, but
    // CARRY the cross-direction reselect budget forward so it is never lost.
    const newCounters = {
      global_loopback_count: 0,
      scout_loopback_count: 0,
      reviewer_loopback_count: 0,
      reselect_count: newReselectCount
    };

    // Stage the eliminated direction's brief/raw/scored instead of deleting, so the
    // final coordinator report can summarize and diary it. Any stray failed file is
    // still removed (it is not a "dropped direction" to summarize).
    const staged = await stageDroppedRunFiles(runId);
    const removed = [];
    const failedDelete = await autoSelectionDeleteRunFile({ stage: 'failed', run_id: runId });
    if (failedDelete.removed) removed.push(failedDelete.removed);
    const lockCleanup = await autoSelectionClearLocks({ run_id: runId });
    if (replacementBrief != null && String(replacementBrief).trim()) {
      // Inject reset counters into new brief
      const briefWithCounters = injectLoopbackCounters(String(replacementBrief), newCounters);

      const dispatch = await autoSelectionPrepareDispatch({
        worker: 'hawkeye',
        run_id: nextRunId,
        brief_content: briefWithCounters,
        overwrite_brief: true,
        overwrite_lock: true,
        dispatch_reason: 'forge_drop_and_reselect'
      });
      return {
        success: true,
        command: commandName,
        run_id: runId,
        old_run_id: runId,
        new_run_id: nextRunId,
        action,
        state_transition: 'raw_scored_deleted_new_scout_dispatch_prepared',
        removed,
        staged_dropped: staged,
        lock_cleanup: lockCleanup.removed || [],
        loopback_counters: newCounters,
        brief_written: true,
        cleanup_done: true,
        agent_assistant_request: dispatch.agent_assistant_request,
        message: 'DROP_AND_RESELECT complete. Old direction staged to dropped/ (kept for final summary). New brief written with RESET counters (全新方向，计数器归零). Ready to dispatch new scout with the provided agent_assistant_request.'
      };
    }
    return {
      success: true,
      command: commandName,
      run_id: runId,
      old_run_id: runId,
      action,
      state_transition: 'raw_scored_deleted_waiting_for_new_brief',
      removed,
      staged_dropped: staged,
      lock_cleanup: lockCleanup.removed || [],
      loopback_counters: newCounters,
      next_actions: ['Create a new brief with a new_run_id, then dispatch scout. Do not archive or post yet.']
    };
  }

  return {
    success: true,
    command: commandName,
    run_id: runId,
    action,
    state_transition: 'ready_for_final_publication',
    next_actions: [
      'Publish forum and DailyNote first.',
      'Then call auto_selection_archive_run with stage=scored.',
      'After archive succeeds, output [[TaskComplete]].'
    ]
  };
}

async function autoSelectionDeleteRunFile(args = {}) {
  await ensureAutoSelectionRunDirs();
  const stage = normalizeAutoSelectionStage(args.stage);
  if (stage === 'locks') throw new Error('Use auto_selection_clear_locks for lock cleanup.');
  if (referencesStrategyProfile(args.run_id ?? args.runId)) {
    return strategyProfileMisuseResponse('auto_selection_delete_run_file');
  }
  const runId = normalizeAutoSelectionRunId(args.run_id ?? args.runId);
  const filePath = resolveAutoSelectionFile(stage, runId);
  await fs.rm(filePath, { force: true });
  return {
    success: true,
    command: 'auto_selection_delete_run_file',
    stage,
    run_id: runId,
    removed: filePath
  };
}

async function autoSelectionCleanupRun(args = {}) {
  await ensureAutoSelectionRunDirs();
  if (referencesStrategyProfile(args.run_id ?? args.runId)) {
    return strategyProfileMisuseResponse('auto_selection_cleanup_run');
  }
  const runId = normalizeAutoSelectionRunId(args.run_id ?? args.runId);
  const removed = await cleanupAutoSelectionRunResidue(runId);
  return {
    success: true,
    command: 'auto_selection_cleanup_run',
    run_id: runId,
    removed
  };
}

async function autoSelectionMarkWorkerMissingOutput(args = {}) {
  await ensureAutoSelectionRunDirs();
  if (referencesStrategyProfile(args.run_id ?? args.runId)) {
    return strategyProfileMisuseResponse('auto_selection_mark_worker_missing_output');
  }
  const requestedRunId = args.run_id ?? args.runId ? normalizeAutoSelectionRunId(args.run_id ?? args.runId) : '';
  if (requestedRunId) {
    for (const stage of ['failed', 'scored', 'raw']) {
      try {
        const existingPath = resolveAutoSelectionFile(stage, requestedRunId);
        await fs.access(existingPath);
        return {
          success: false,
          command: 'auto_selection_mark_worker_missing_output',
          error: 'expected_output_already_exists',
          run_id: requestedRunId,
          existing_stage: stage,
          existing_path: existingPath,
          message: 'A handoff file already exists. Do not mark worker missing output; follow queue_status next_action instead.'
        };
      } catch (_) {
        // No handoff at this stage.
      }
    }
  }
  const queue = await autoSelectionQueueStatus({
    include_content: false,
    worker_timeout_minutes: args.worker_timeout_minutes ?? args.workerTimeoutMinutes
  });
  const missing = (queue.derived.worker_missing_outputs || []).find(item => !requestedRunId || item.run_id === requestedRunId);
  if (!missing) {
    return {
      success: false,
      command: 'auto_selection_mark_worker_missing_output',
      error: 'missing_worker_output_not_found',
      run_id: requestedRunId || undefined,
      next_action_hint: queue.next_action_hint
    };
  }

  const runId = missing.run_id;
  const content = [
    '---',
    `failure_type: worker_missing_output`,
    `run_id: ${runId}`,
    `worker: ${missing.lock_name || 'unknown'}`,
    `expected_stage: ${missing.expected_stage || 'unknown'}`,
    `detected_at: ${nowIso()}`,
    `classification: ${missing.retry_guard?.classification || 'unknown'}`,
    `retry_count: ${missing.retry_count ?? 0}`,
    `safe_to_retry_once: ${missing.retry_guard?.safe_to_retry_once === true}`,
    `eligible_now: ${missing.retry_guard?.eligible_now === true}`,
    missing.lock_age_minutes != null ? `lock_age_minutes: ${missing.lock_age_minutes}` : '',
    missing.timeout_minutes != null ? `timeout_minutes: ${missing.timeout_minutes}` : '',
    '---',
    '',
    '# 自动选品 worker 缺交付失败',
    '',
    `run_id: ${runId}`,
    `worker: ${missing.lock_name || 'unknown'}`,
    `expected_stage: ${missing.expected_stage || 'unknown'}`,
    '',
    `诊断: ${missing.retry_guard?.reason || missing.completed_task?.reason || 'Worker finished or timed out without required handoff file.'}`,
    '',
    '该 run 没有产生预期 raw/scored 文件，也没有 failed 文件。AutoProductSelection 已将其标准化写入 failed，供枢纽发阻断报告并归档。',
    '',
    '## completed_task',
    '',
    '```json',
    JSON.stringify(missing.completed_task || {}, null, 2),
    '```'
  ].filter(line => line !== '').join('\n');

  const writeResult = await autoSelectionWriteRunFile({
    stage: 'failed',
    run_id: runId,
    content,
    overwrite: parseBoolean(args.overwrite, false)
  });
  if (writeResult.success === false) return writeResult;
  const lockCleanup = await autoSelectionClearLocks({ run_id: runId });

  return {
    success: true,
    command: 'auto_selection_mark_worker_missing_output',
    run_id: runId,
    failed_path: writeResult.path,
    lock_cleanup: lockCleanup.removed || [],
    diagnosis: {
      worker: missing.lock_name,
      expected_stage: missing.expected_stage,
      classification: missing.retry_guard?.classification,
      reason: missing.retry_guard?.reason,
      retry_count: missing.retry_count
    }
  };
}

async function cleanupAutoSelectionRunResidue(runId) {
  const safeRunId = normalizeAutoSelectionRunId(runId);
  const removed = [];
  for (const stage of ['brief', 'raw', 'scored', 'failed']) {
    const filePath = resolveAutoSelectionFile(stage, safeRunId);
    try {
      await fs.access(filePath);
      await fs.rm(filePath, { force: true });
      removed.push(filePath);
    } catch (_) {
      // Best-effort cleanup.
    }
  }
  const lockResult = await autoSelectionClearLocks({ run_id: safeRunId });
  removed.push(...(lockResult.removed || []));
  return removed;
}

async function autoSelectionClearLocks(args = {}) {
  await ensureAutoSelectionRunDirs();
  if (referencesStrategyProfile(args.run_id ?? args.runId)) {
    return strategyProfileMisuseResponse('auto_selection_clear_locks');
  }
  const runId = normalizeAutoSelectionRunId(args.run_id ?? args.runId);
  const locks = await listAutoSelectionStage('locks', false);
  const matched = locks.filter(file => file.name.startsWith(`${runId}-`));
  const removed = [];
  for (const file of matched) {
    await fs.unlink(file.path);
    removed.push(file.path);
  }
  return {
    success: true,
    command: 'auto_selection_clear_locks',
    run_id: runId,
    removed
  };
}

function getStatus() {
  return {
    success: true,
    plugin: 'AutoProductSelection',
    version: '1.0.0',
    runs_dir: AUTO_SELECTION_RUNS_DIR,
    scout_agent_name: AUTO_SELECTION_SCOUT_AGENT_NAME,
    reviewer_agent_name: AUTO_SELECTION_REVIEWER_AGENT_NAME,
    scout_task_prefixes: AUTO_SELECTION_SCOUT_TASK_PREFIXES,
    reviewer_task_prefixes: AUTO_SELECTION_REVIEWER_TASK_PREFIXES,
    debugMode
  };
}

async function autoSelectionTriggerRun(args = {}) {
  // The coordinator (破壁_枢纽) calls this as the VCPTaskAssistant "switch" to start a round.
  if (isWorkflowRunning) {
    return {
      success: false,
      command: 'auto_selection_trigger_run',
      error: 'workflow_already_running',
      message: '工作流已在运行中。后端状态机正在自动推进，你（破壁_枢纽）当前无需任何行动，请直接输出 [[TaskComplete]]。',
      next_actions: ['Output [[TaskComplete]] immediately to end this activation.']
    };
  }

  await ensureAutoSelectionRunDirs();
  const states = await listRunStates();
  const active = states.filter(s => s && s.status !== APS_STATE.DONE);

  if (active.length > 0) {
    // Resume: a prior round left non-terminal runs (e.g. after a restart). The state machine
    // picks up exactly where each run's status says, no inference needed.
    isWorkflowRunning = true;
    startWorkflowDriver();
    logWorkflowEvent(`Workflow triggered. Resuming ${active.length} active run(s) from state files.`);
    return {
      success: true,
      command: 'auto_selection_trigger_run',
      mode: 'resume',
      active_runs: active.length,
      message: `工作流已启动，接管 ${active.length} 个未完成 run（依据 state.json 续跑）。`
    };
  }

  // New round: create one fresh run in PENDING_BRIEF BEFORE starting the driver, so the
  // driver's first tick sees a non-empty active set (otherwise it self-terminates immediately).
  const runId = normalizeAutoSelectionRunId(`${buildTimestampRunPrefix()}-new`);
  await writeRunState(freshRunState(runId));
  isWorkflowRunning = true;
  startWorkflowDriver();
  logWorkflowEvent(`Workflow triggered. Created new run ${runId} (PENDING_BRIEF).`);
  return {
    success: true,
    command: 'auto_selection_trigger_run',
    mode: 'new',
    run_id: runId,
    message: '工作流已启动，将创建新的选品任务。'
  };
}

async function processToolCall(args = {}) {
  const command = String(args.command || '').trim();
  try {
    switch (command) {
      case 'auto_selection_trigger_run':
        return await autoSelectionTriggerRun(args);
      case 'auto_selection_debug_status':
        return await autoSelectionDebugStatus(args);
      case 'auto_selection_toggle_debug':
        return await autoSelectionToggleDebug(args);
      case 'auto_selection_pause_workflow':
        return await autoSelectionPauseWorkflow(args);
      case 'auto_selection_abort_workflow':
        return await autoSelectionAbortWorkflow(args);
      case 'auto_selection_queue_status':
        return await autoSelectionQueueStatus(args);
      case 'auto_selection_write_run_file': {
        const result = await autoSelectionWriteRunFile(args);
        if (result && result.success !== false) {
          const stage = args.stage;
          const runId = args.run_id || args.runId;
          triggerImmediateWorkflowTick(`agent_${stage}_write_file`, { runId, stage });
        }
        return result;
      }
      case 'auto_selection_read_run_file':
        return await autoSelectionReadRunFile(args);
      case 'auto_selection_prepare_dispatch': {
        const result = await autoSelectionPrepareDispatch(args);
        return result;
      }
      case 'auto_selection_apply_forge_decision':
      case 'auto_selection_apply_reviewer_decision': {
        // Compat shim: in the v4 state machine the BACKEND decides (advanceEvaluating), so the
        // coordinator no longer needs to call this. Kept functional for manual/legacy use; it
        // just triggers a tick so the state machine re-derives the next step.
        const result = await autoSelectionApplyForgeDecision(args, command);
        if (result && result.success !== false) {
          const runId = args.run_id || args.runId;
          triggerImmediateWorkflowTick('coordinator_decision_applied', { runId, action: result.action });
        }
        return result;
      }
      case 'auto_selection_archive_run': {
        const result = await autoSelectionArchiveRun(args);
        if (result && result.success !== false) {
          const runId = args.run_id || args.runId;
          triggerImmediateWorkflowTick('coordinator_archive_completed', { runId });
        }
        return result;
      }
      case 'auto_selection_move_run_file':
        return await autoSelectionMoveRunFile(args);
      case 'auto_selection_delete_run_file':
        return await autoSelectionDeleteRunFile(args);
      case 'auto_selection_cleanup_run':
        return await autoSelectionCleanupRun(args);
      case 'auto_selection_mark_worker_missing_output':
        return await autoSelectionMarkWorkerMissingOutput(args);
      case 'auto_selection_clear_locks':
        return await autoSelectionClearLocks(args);
      case 'get_status':
        return getStatus();
      default:
        return {
          success: false,
          plugin_error: `Unknown command: ${command || '(empty)'}`,
          supported_commands: [
            'auto_selection_trigger_run',
            'auto_selection_debug_status',
            'auto_selection_toggle_debug',
            'auto_selection_queue_status',
            'auto_selection_write_run_file',
            'auto_selection_read_run_file',
            'auto_selection_prepare_dispatch',
            'auto_selection_apply_forge_decision',
            'auto_selection_apply_reviewer_decision',
            'auto_selection_archive_run',
            'auto_selection_move_run_file',
            'auto_selection_delete_run_file',
            'auto_selection_cleanup_run',
            'auto_selection_mark_worker_missing_output',
            'auto_selection_clear_locks',
            'get_status'
          ]
        };
    }
  } catch (error) {
    console.error(`[AutoProductSelection] Command failed (${command}):`, error);
    return {
      success: false,
      plugin_error: error.message || 'AutoProductSelection 执行失败。',
      command
    };
  }
}

// --- Workflow Driver State ---
let isWorkflowRunning = false;        // 内存运行状态锁
let isDriverExecuting = false;        // 并发互斥标志
let workflowState = 'IDLE';           // 工作流生命周期状态: 'IDLE' | 'INIT' | 'ACTIVE'
let workflowInterval = null;          // 定时器引用
let consecutiveErrorCount = 0;        // 连续异常计数器
const MAX_CONSECUTIVE_ERRORS = 5;     // 最大连续异常允许次数
let AgentAssistantPlugin = null;
let pluginManagerInstance = null;

function resolveAgentAssistant() {
  if (!AgentAssistantPlugin && pluginManagerInstance && typeof pluginManagerInstance.getServiceModule === 'function') {
    AgentAssistantPlugin = pluginManagerInstance.getServiceModule('AgentAssistant');
    if (AgentAssistantPlugin) {
      debugLog('AgentAssistant plugin dynamically resolved.');
    }
  }
  return AgentAssistantPlugin;
}
let TOOLBOX_CONTENT = '';             // API字典内容缓存
let lastWorkflowError = null;         // 最近一次工作流异常信息

// Backstop against an infinite handle_failed loop: if the coordinator keeps failing
// to archive a given failed run (e.g. a tool error mid-task), the backend must not
// re-delegate forever. After MAX_FAILED_DELEGATIONS attempts the backend force-
// archives the failed file itself so the queue drains and the driver self-terminates.
const failedDelegationAttempts = new Map();
const scoredDelegationAttempts = new Map();
const MAX_FAILED_DELEGATIONS = 3;

// Backstop against an infinite COORDINATOR-FAILURE loop. When a delegated coordinator
// task fails (e.g. persistent HTTP 500 from the model provider, or repeated tool errors),
// the driver removes the lock and re-delegates the same task next tick. With no ceiling a
// persistent 500 re-delegates forever every ~30s. We track consecutive coordinator
// failures per run_id; after MAX_COORDINATOR_FAILURES the run is force-failed/terminated
// so the round stops burning tokens on an unrecoverable transport/system error.
const coordinatorFailureAttempts = new Map();
const MAX_COORDINATOR_FAILURES = 3;

// Structural backstop against an unbounded create_brief loop: even if a coordinator
// misbehaves (e.g. publishes then re-triggers, or keeps reselecting outside the
// scored path), the driver must not keep launching brand-new briefs forever within
// one trigger lifecycle. Counts how many fresh briefs this trigger has driven.
let createBriefCountThisTrigger = 0;

// --- Loopback Counter Limits ---
const MAX_SCOUT_LOOPBACK = 3;         // 鹰眼单阶段最大回退次数
const MAX_REVIEWER_LOOPBACK = 3;      // 熔炉单阶段最大回退次数
const MAX_GLOBAL_LOOPBACK = 6;        // 全局最大回退次数
const SOFT_MAX_SCOUT_LOOPBACK = 2;    // 普通数据缺口最多回环补采次数
const SOFT_MAX_GLOBAL_LOOPBACK = 3;   // 普通数据缺口全局回环上限；达到后改为强制裁决

// --- Reselect (cross-direction) Budget ---
// DROP_AND_RESELECT 会换一个全新方向并重置 loopback 计数器，因此 per-run 的
// shouldTriggerCircuitBreaker 永远看不到跨方向的累计。reselect_count 跨方向累加，
// 用于给单次 trigger 闭环一个硬预算，防止"评分不够好就一直换方向"无界烧 Token。
//
// 两套独立预算，成本量级不同，故分开计：
//   · MAX_RESELECT_PER_TRIGGER  —— 昂贵的 post-forge DROP_AND_RESELECT（鹰眼完整深挖 +
//     熔炉评审一整轮后才否决），保守取小。
//   · MAX_EARLY_REJECT_PER_TRIGGER —— 廉价的 EARLY_REJECT（鹰眼仅 Level-1 横向体检即否决
//     全部候选，没深挖、没评审），成本低，预算给得更宽松，多给探索空间。
// 两者都可经 config.env 覆盖（APS_MAX_RESELECT_PER_TRIGGER / APS_MAX_EARLY_REJECT_PER_TRIGGER）。
let MAX_RESELECT_PER_TRIGGER = 4;       // 昂贵深挖后换方向上限
let MAX_EARLY_REJECT_PER_TRIGGER = 8;   // 廉价预筛换方向上限（独立、更宽松）
let reselectCountThisTrigger = 0;       // 当前 trigger 内累计的昂贵 post-forge 重选次数
let earlyRejectCountThisTrigger = 0;    // 当前 trigger 内累计的廉价 EARLY_REJECT 换方向次数

// Grace window (ms) before a worker whose AgentTask reports done — but whose raw/scored
// file has not yet appeared — is declared "missing output". Guards the RACE where the
// transport-level task completes a few seconds before the actual file write lands. Must
// comfortably exceed the gap between task-completion and file-write (observed ~4s).
let WORKER_OUTPUT_GRACE_MS = 90 * 1000;

// How many directions the scout may DEEP-DIVE (Level-2) in a single run. The scout focuses
// the round on the single best direction; other prescreen-passing directions are NOT
// rejected — they are recorded as deferred_candidates and become priority directions for a
// later trigger (via the [待观察] diary). Keeps each round focused and token-bounded while
// avoiding the "force-pick-1, drop-2" mis-elimination of genuinely good directions.
let MAX_DEEP_DIVE_PER_RUN = 1;

function loadWorkflowBudgetConfig(config = {}) {
  const read = (key, fallback) => {
    const raw = config[key] ?? process.env[key];
    const num = Number(raw);
    return (raw !== undefined && raw !== null && String(raw).trim() !== '' && Number.isFinite(num)) ? num : fallback;
  };
  MAX_RESELECT_PER_TRIGGER = read('APS_MAX_RESELECT_PER_TRIGGER', 4);
  MAX_EARLY_REJECT_PER_TRIGGER = read('APS_MAX_EARLY_REJECT_PER_TRIGGER', 8);
  WORKER_OUTPUT_GRACE_MS = read('APS_WORKER_OUTPUT_GRACE_SECONDS', 90) * 1000;
  MAX_DEEP_DIVE_PER_RUN = Math.max(1, read('APS_MAX_DEEP_DIVE_PER_RUN', 1));
}

// --- Workflow Driver Tick Interval ---
// Watchdog now ONLY does timeout sweeps (normal progression is callback-driven via
// triggerImmediateWorkflowTick). 30s keeps timeout detection responsive without polling work.
const WORKFLOW_TICK_INTERVAL_MS = 30 * 1000;

// ===========================================================================
//  v4 EXPLICIT STATE MACHINE — single source of truth per run
// ===========================================================================
// Each run owns ONE authoritative file: runs/state/<run_id>.state.json. The driver
// reads `status` to decide the next action; nothing is inferred from file existence,
// mtimes, lock files, or AgentTask markdown anymore. This removes the entire class of
// double-action races (duplicate posts/diaries, orphan raws, re-delegation storms).
//
// Lifecycle:
//   PENDING_BRIEF -> BRIEFING -> SCOUTING -> SCORING -> EVALUATING -> PUBLISHING -> DONE
//   any step may branch to FAILED (then publish blocking report -> DONE)
//   EVALUATING may branch back to SCOUTING (loopback) or spawn a fresh PENDING_BRIEF (reselect)
const APS_STATE = {
  PENDING_BRIEF: 'PENDING_BRIEF',
  BRIEFING: 'BRIEFING',
  SCOUTING: 'SCOUTING',
  SCORING: 'SCORING',
  EVALUATING: 'EVALUATING',
  PUBLISHING: 'PUBLISHING',
  DONE: 'DONE',
  FAILED: 'FAILED'
};

// Per-status timeout (ms): if a run sits in this status longer than the limit with no
// progress, the watchdog records a (non-system) failure against it. Dispatch-bearing
// states (waiting on an async agent) get the worker grace; instantaneous backend states
// get a short ceiling.
function statusTimeoutMs(status) {
  switch (status) {
    case APS_STATE.SCOUTING:
    case APS_STATE.SCORING:
      return Math.max(WORKER_OUTPUT_GRACE_MS, 15 * 60 * 1000); // worker is running an agent
    case APS_STATE.BRIEFING:
    case APS_STATE.PENDING_BRIEF:
    case APS_STATE.PUBLISHING:
    case APS_STATE.FAILED:
      return 10 * 60 * 1000; // coordinator content task
    case APS_STATE.EVALUATING:
      return 5 * 60 * 1000;  // pure backend decision, should be near-instant
    default:
      return 15 * 60 * 1000;
  }
}

const APS_SYSTEM_ERROR_CAP = 2;     // 403/429/500/凭证/页面阻断：连续 2 次直接阻断
const APS_NONSYSTEM_ERROR_CAP = 3;  // 超时/无明确原因失败：连续 3 次阻断

function stateFilePath(runId) {
  const safe = normalizeAutoSelectionRunId(runId);
  return path.join(AUTO_SELECTION_RUNS_DIR, 'state', `${safe}.state.json`);
}

function freshRunState(runId, overrides = {}) {
  return {
    run_id: normalizeAutoSelectionRunId(runId),
    status: APS_STATE.PENDING_BRIEF,
    claimed_by: null,
    claimed_at: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    last_action: 'created',
    last_action_result: '',
    // Persisted budgets/counters (survive restarts; authoritative copy).
    counters: {
      global_loopback: 0,
      scout_loopback: 0,
      reviewer_loopback: 0,
      reselect: 0,
      early_reject: 0
    },
    failure_tracking: { system_error_count: 0, nonsystem_error_count: 0, last_error: '' },
    // Idempotency flags for the multi-step terminal publish (root-fix for duplicate diaries).
    publish_flags: { post_published: false, diary_written: false, archived: false },
    force_decision_mode: false,
    history: [],
    ...overrides
  };
}

async function readRunState(runId) {
  try {
    const content = await fs.readFile(stateFilePath(runId), 'utf8');
    return JSON.parse(content);
  } catch (_) {
    return null;
  }
}

// Atomic write: temp file + rename, so a crash mid-write never leaves a half-JSON state.
async function writeRunState(state) {
  const dir = path.join(AUTO_SELECTION_RUNS_DIR, 'state');
  await fs.mkdir(dir, { recursive: true });
  state.updated_at = nowIso();
  const finalPath = stateFilePath(state.run_id);
  const tmpPath = `${finalPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmpPath, finalPath);
  return finalPath;
}

async function listRunStates() {
  const dir = path.join(AUTO_SELECTION_RUNS_DIR, 'state');
  await fs.mkdir(dir, { recursive: true });
  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch (_) {
    return [];
  }
  const states = [];
  for (const name of entries) {
    if (!name.endsWith('.state.json')) continue;
    try {
      states.push(JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')));
    } catch (_) { /* skip corrupt/partial */ }
  }
  return states;
}

// Atomic claim: only one tick may hold a run. Returns the claimed state, or null if it is
// already claimed and not yet timed out. This is the structural guard against double-action.
async function claimRun(runId, role) {
  const state = await readRunState(runId);
  if (!state) return null;
  if (state.claimed_by) {
    const age = Date.now() - new Date(state.claimed_at || 0).getTime();
    if (Number.isFinite(age) && age < statusTimeoutMs(state.status)) {
      return null; // genuinely in-flight; another tick owns it
    }
    // else: stale claim (worker died / crash) — reclaim it.
  }
  state.claimed_by = role;
  state.claimed_at = nowIso();
  await writeRunState(state);
  return state;
}

async function commitTransition(state, nextStatus, note = '') {
  const from = state.status;
  state.history = (state.history || []).slice(-40);
  state.history.push({ at: nowIso(), from, to: nextStatus, note: String(note).slice(0, 200) });
  state.status = nextStatus;
  state.last_action_result = note;
  state.claimed_by = null;
  state.claimed_at = null;
  // Track dispatch time for worker-waiting states so the watchdog can time out a worker that
  // dies WITHOUT writing its handoff file (e.g. a 500 inside ProductSelector). SCOUTING/SCORING
  // are entered right before dispatching scout/forge. Clear it elsewhere.
  if (nextStatus === APS_STATE.BRIEFING || nextStatus === APS_STATE.SCOUTING || nextStatus === APS_STATE.SCORING) {
    state.dispatched_at = nowIso();
  } else {
    state.dispatched_at = null;
  }
  // A successful transition clears the consecutive-failure streak.
  if (nextStatus !== APS_STATE.FAILED) {
    state.failure_tracking.system_error_count = 0;
    state.failure_tracking.nonsystem_error_count = 0;
  }
  await writeRunState(state);
  logWorkflowEvent(`[StateMachine] ${state.run_id}: ${from} -> ${nextStatus}${note ? ' (' + note + ')' : ''}`);
}

// Record a failure against a run with the user-chosen caps:
//   system error (403/429/500/credential/page-block) -> cap 2
//   non-system (timeout / unknown) -> cap 3
// Returns true if the run was force-failed (cap reached).
async function recordRunFailure(state, errType, reason = '') {
  const isSystem = errType === 'system';
  state.failure_tracking.last_error = String(reason).slice(0, 300);
  if (isSystem) state.failure_tracking.system_error_count += 1;
  else state.failure_tracking.nonsystem_error_count += 1;
  const sys = state.failure_tracking.system_error_count;
  const non = state.failure_tracking.nonsystem_error_count;
  state.claimed_by = null;
  state.claimed_at = null;
  const capped = (isSystem && sys >= APS_SYSTEM_ERROR_CAP) || (!isSystem && non >= APS_NONSYSTEM_ERROR_CAP);
  if (capped) {
    logWorkflowEvent(`[StateMachine] ${state.run_id}: 失败上限触发 (system ${sys}/${APS_SYSTEM_ERROR_CAP}, nonsystem ${non}/${APS_NONSYSTEM_ERROR_CAP})，转入 FAILED。原因: ${reason}`, true);
    await commitTransition(state, APS_STATE.FAILED, `failure cap: ${reason}`.slice(0, 180));
    return true;
  }
  logWorkflowEvent(`[StateMachine] ${state.run_id}: 记录失败 (system ${sys}/${APS_SYSTEM_ERROR_CAP}, nonsystem ${non}/${APS_NONSYSTEM_ERROR_CAP})，将重试。原因: ${reason}`, true);
  await writeRunState(state);
  return false;
}

// Classify an error string/object into 'system' vs 'nonsystem' for the caps above.
function classifyErrorType(text = '') {
  const s = String(text || '').toLowerCase();
  if (/status code (4\d\d|5\d\d)|\b(403|408|429|500|502|503|504)\b|credential|凭证|page_blocked|needs_manual_action|验证码|captcha|账号|rate.?limit/i.test(s)) {
    return 'system';
  }
  return 'nonsystem';
}

function extractAgentTaskFinalReport(content = '') {
  const text = String(content || '');
  const marker = '## 最终执行结果';
  const idx = text.indexOf(marker);
  return (idx >= 0 ? text.slice(idx + marker.length) : text).trim();
}

async function findLatestCompletedAgentTask(runId, agentName, sinceMs = 0) {
  try {
    const safeRunId = normalizeAutoSelectionRunId(runId);
    const entries = await fs.readdir(AGENT_TASK_DIR, { withFileTypes: true });
    let best = null;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(`${agentName}_`) || !entry.name.endsWith('.md')) continue;
      const fullPath = path.join(AGENT_TASK_DIR, entry.name);
      const stat = await fs.stat(fullPath);
      if (sinceMs && stat.mtimeMs + 5000 < sinceMs) continue;
      const content = await fs.readFile(fullPath, 'utf8');
      if (!content.includes(safeRunId)) continue;
      if (!content.includes('任务状态:** Succeed') && !content.includes('任务状态:** Failed')) continue;
      if (!best || stat.mtimeMs > best.mtimeMs) {
        best = {
          name: entry.name,
          path: fullPath,
          mtimeMs: stat.mtimeMs,
          status: content.includes('任务状态:** Succeed') ? 'Succeed' : 'Failed',
          content,
          report: extractAgentTaskFinalReport(content)
        };
      }
    }
    return best;
  } catch (_) {
    return null;
  }
}

function extractFencedBlockContaining(content = '', marker = '') {
  const text = String(content || '');
  const re = /```(?:yaml|yml|markdown|md|text)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const block = String(match[1] || '').trim();
    if (block.includes(marker)) return block;
  }
  return '';
}

function extractPackFromReport(report = '', marker = '') {
  const text = String(report || '').trim();
  if (!text || !marker) return '';
  const fenced = extractFencedBlockContaining(text, marker);
  if (fenced) return fenced;
  const idx = text.indexOf(marker);
  if (idx < 0) return '';
  return text.slice(idx).trim();
}

function extractBriefFromReport(report = '', runId = '') {
  const text = String(report || '').trim();
  if (!text) return '';
  const fenced = extractFencedBlockContaining(text, 'SelectionBrief');
  if (fenced) return fenced;
  const headingMatch = text.match(/(^|\n)#{1,3}\s*(SelectionBrief|Selection Brief|选品任务|选品 Brief|自动选品 Brief)[^\n]*/i);
  if (headingMatch && headingMatch.index != null) {
    return text.slice(headingMatch.index + headingMatch[1].length).trim();
  }
  if (/方向\s*[A-ZＡ-Ｚ一二三甲乙丙]|候选方向|产品方向|种子词|seed/i.test(text)) {
    const safeRunId = normalizeAutoSelectionRunId(runId);
    return [
      `# SelectionBrief - ${safeRunId}`,
      '',
      '<!-- auto-extracted fallback: coordinator returned a compact brief report -->',
      '',
      text
    ].join('\n');
  }
  return '';
}

async function autoExtractHandoffForState(state = {}) {
  if (!state || !state.run_id) return { extracted: false };
  const runId = normalizeAutoSelectionRunId(state.run_id);
  const sinceMs = state.dispatched_at ? new Date(state.dispatched_at).getTime() : 0;

  if (state.status === APS_STATE.BRIEFING) {
    try {
      await fs.access(resolveAutoSelectionFile('brief', runId));
      return { extracted: true, stage: 'brief', already_exists: true };
    } catch (_) { }
    const task = await findLatestCompletedAgentTask(runId, '破壁_枢纽', sinceMs);
    if (!task) return { extracted: false };
    if (task.status !== 'Succeed') {
      return { extracted: false, completed: true, failed: true, errorText: task.report || 'coordinator task failed' };
    }
    const briefContent = extractBriefFromReport(task.report, runId);
    if (!briefContent) {
      return { extracted: false, completed: true, failed: true, errorText: 'coordinator completed without extractable SelectionBrief content' };
    }
    await autoSelectionWriteRunFile({ stage: 'brief', run_id: runId, content: briefContent, overwrite: true });
    logWorkflowEvent(`[AutoExtractor] 从 AgentTask [${task.name}] 中成功自动提取并写回 brief 文件！`);
    return { extracted: true, stage: 'brief', task };
  }

  if (state.status === APS_STATE.SCOUTING || state.status === APS_STATE.SCORING) {
    const isScout = state.status === APS_STATE.SCOUTING;
    const agentName = isScout ? AUTO_SELECTION_SCOUT_AGENT_NAME : AUTO_SELECTION_REVIEWER_AGENT_NAME;
    const successStage = isScout ? 'raw' : 'scored';
    const successMarker = isScout ? 'raw_data_pack:' : 'scored_candidate_pack:';
    const failedMarker = isScout ? 'failed_data_pack:' : 'failed_candidate_pack:';
    try {
      await fs.access(resolveAutoSelectionFile(successStage, runId));
      return { extracted: true, stage: successStage, already_exists: true };
    } catch (_) { }
    try {
      await fs.access(resolveAutoSelectionFile('failed', runId));
      return { extracted: true, stage: 'failed', already_exists: true };
    } catch (_) { }
    const task = await findLatestCompletedAgentTask(runId, agentName, sinceMs);
    if (!task) return { extracted: false };
    const successPack = extractPackFromReport(task.report, successMarker);
    if (task.status === 'Succeed' && successPack) {
      await autoSelectionWriteRunFile({ stage: successStage, run_id: runId, content: successPack, overwrite: true });
      logWorkflowEvent(`[AutoExtractor] 从 AgentTask [${task.name}] 中成功自动提取并写回 ${successStage} 文件！`);
      return { extracted: true, stage: successStage, task };
    }
    const failedPack = extractPackFromReport(task.report, failedMarker);
    if (failedPack || task.status === 'Failed') {
      const failedContent = failedPack || [
        '---',
        `failure_type: worker_failed`,
        `run_id: ${runId}`,
        `detected_at: ${nowIso()}`,
        `worker: ${isScout ? 'scout' : 'reviewer'}`,
        '---',
        '',
        task.report || 'worker task failed without a structured handoff pack'
      ].join('\n');
      await autoSelectionWriteRunFile({ stage: 'failed', run_id: runId, content: failedContent, overwrite: true });
      logWorkflowEvent(`[AutoExtractor] 从 AgentTask [${task.name}] 中提取到失败交付，已写回 failed 文件。`);
      return { extracted: true, stage: 'failed', task };
    }
    return { extracted: false, completed: true, failed: true, errorText: `${agentName} completed without ${successMarker}` };
  }

  return { extracted: false };
}

// --- Workflow Driver Tick Interval (legacy marker kept for old references below) ---


// --- Workflow Driver Functions ---

/**
 * Load ToolBox API dictionary content
 */
async function loadToolBoxContent() {
  try {
    const toolboxPath = path.join(VCP_ROOT_DIR, 'TVStxt', 'AutoProductSelectionToolBox.txt');
    TOOLBOX_CONTENT = await fs.readFile(toolboxPath, 'utf8');
    debugLog('ToolBox API dictionary loaded.');
  } catch (error) {
    console.error('[AutoProductSelection] Failed to load ToolBox:', error.message);
    TOOLBOX_CONTENT = '';
  }
}

/**
 * Parse loopback counters from run state file
 */
function parseLoopbackCounters(content = '') {
  const text = String(content || '');
  const globalMatch = text.match(/global_loopback_count:\s*(\d+)/i);
  const scoutMatch = text.match(/scout_loopback_count:\s*(\d+)/i);
  const reviewerMatch = text.match(/reviewer_loopback_count:\s*(\d+)/i);
  const reselectMatch = text.match(/reselect_count:\s*(\d+)/i);
  const earlyRejectMatch = text.match(/early_reject_count:\s*(\d+)/i);

  return {
    global_loopback_count: globalMatch ? parseInt(globalMatch[1], 10) : 0,
    scout_loopback_count: scoutMatch ? parseInt(scoutMatch[1], 10) : 0,
    reviewer_loopback_count: reviewerMatch ? parseInt(reviewerMatch[1], 10) : 0,
    // Cross-direction reselect budget, persisted so it survives DROP_AND_RESELECT
    // (which changes run_id + resets loopback counters) and process restarts.
    reselect_count: reselectMatch ? parseInt(reselectMatch[1], 10) : 0,
    // Cheap Level-1 EARLY_REJECT budget, persisted separately from the expensive reselect.
    early_reject_count: earlyRejectMatch ? parseInt(earlyRejectMatch[1], 10) : 0
  };
}

/**
 * Inject or update loopback counters in file content
 */
function injectLoopbackCounters(content = '', counters = {}) {
  const text = String(content || '');
  const global = counters.global_loopback_count || 0;
  const scout = counters.scout_loopback_count || 0;
  const reviewer = counters.reviewer_loopback_count || 0;
  const reselect = counters.reselect_count || 0;
  const earlyReject = counters.early_reject_count || 0;

  // Build counter metadata block
  const counterBlock = [
    '<!-- Loopback Circuit Breaker Counters -->',
    `global_loopback_count: ${global}`,
    `scout_loopback_count: ${scout}`,
    `reviewer_loopback_count: ${reviewer}`,
    `reselect_count: ${reselect}`,
    `early_reject_count: ${earlyReject}`,
    '<!-- End Counters -->'
  ].join('\n');

  // Check if counters already exist in content
  const hasCounters = /global_loopback_count:\s*\d+/i.test(text);

  if (hasCounters) {
    // Update existing counters
    let updated = text.replace(/global_loopback_count:\s*\d+/gi, `global_loopback_count: ${global}`);
    updated = updated.replace(/scout_loopback_count:\s*\d+/gi, `scout_loopback_count: ${scout}`);
    updated = updated.replace(/reviewer_loopback_count:\s*\d+/gi, `reviewer_loopback_count: ${reviewer}`);
    // reselect_count may be absent in older files; add it next to the others if so.
    if (/reselect_count:\s*\d+/i.test(updated)) {
      updated = updated.replace(/reselect_count:\s*\d+/gi, `reselect_count: ${reselect}`);
    } else {
      updated = updated.replace(/(reviewer_loopback_count:\s*\d+)/i, `$1\nreselect_count: ${reselect}`);
    }
    // early_reject_count likewise may be absent in older files.
    if (/early_reject_count:\s*\d+/i.test(updated)) {
      updated = updated.replace(/early_reject_count:\s*\d+/gi, `early_reject_count: ${earlyReject}`);
    } else {
      updated = updated.replace(/(reselect_count:\s*\d+)/i, `$1\nearly_reject_count: ${earlyReject}`);
    }
    return updated;
  } else {
    // Inject counters at the beginning (after first header if exists)
    const lines = text.split('\n');
    const firstHeaderIdx = lines.findIndex(line => line.startsWith('#'));

    if (firstHeaderIdx >= 0 && firstHeaderIdx < lines.length - 1) {
      // Insert after first header
      lines.splice(firstHeaderIdx + 1, 0, '', counterBlock, '');
      return lines.join('\n');
    } else {
      // Insert at beginning
      return `${counterBlock}\n\n${text}`;
    }
  }
}

/**
 * Increment loopback counters based on action type
 */
function incrementLoopbackCounters(currentCounters, action) {
  const counters = { ...currentCounters };

  if (action === 'LOOPBACK_TO_SCOUT' || action === 'LOOPBACK_TO_HAWKEYE') {
    // Scout loopback: increment global and scout, reset reviewer
    counters.global_loopback_count = (counters.global_loopback_count || 0) + 1;
    counters.scout_loopback_count = (counters.scout_loopback_count || 0) + 1;
    counters.reviewer_loopback_count = 0;
  } else if (action === 'DROP_AND_RESELECT') {
    // Drop and reselect: increment global + cross-direction reselect budget,
    // reset both scout and reviewer (a brand-new direction starts fresh loopbacks).
    // reselect_count is intentionally NOT reset here — it is the per-trigger budget.
    counters.global_loopback_count = (counters.global_loopback_count || 0) + 1;
    counters.reselect_count = (counters.reselect_count || 0) + 1;
    counters.scout_loopback_count = 0;
    counters.reviewer_loopback_count = 0;
  } else if (action === 'REVIEWER_LOOPBACK') {
    // Reviewer internal loopback: increment global and reviewer, reset scout
    counters.global_loopback_count = (counters.global_loopback_count || 0) + 1;
    counters.reviewer_loopback_count = (counters.reviewer_loopback_count || 0) + 1;
    counters.scout_loopback_count = 0;
  }

  return counters;
}

/**
 * Check if loopback circuit breaker should trigger
 */
function shouldTriggerCircuitBreaker(counters) {
  return counters.scout_loopback_count >= MAX_SCOUT_LOOPBACK ||
    counters.reviewer_loopback_count >= MAX_REVIEWER_LOOPBACK ||
    counters.global_loopback_count >= MAX_GLOBAL_LOOPBACK;
}

/**
 * Helper to check if a forge lock is configured in force_decision_mode.
 */
async function isForgeLockInForceDecisionMode(runId) {
  try {
    const lockPath = resolveAutoSelectionFile('locks', runId, 'forge');
    const content = await fs.readFile(lockPath, 'utf8');
    return content.includes('force_decision_mode: true');
  } catch (_) {
    return false;
  }
}

/**
 * Trigger immediate workflow tick with 150ms buffer delay for filesystem flushing.
 */
function triggerImmediateWorkflowTick(source, context = {}) {
  if (isWorkflowRunning && !isDriverExecuting) {
    setTimeout(() => {
      workflowDriver(source, context).catch(err => {
        console.error(`[AutoProductSelection] Immediate tick triggered by ${source} failed:`, err);
      });
    }, 150);
  }
}

/**
 * Main workflow driver that autonomously pushes the state machine forward.
 * Called on the WORKFLOW_TICK_INTERVAL_MS timer.
 */
async function workflowDriver(triggerSource = 'watchdog', context = {}) {
  if (isDriverExecuting) {
    if (debugMode) logWorkflowEvent(`[Driver] Tick from ${triggerSource} skipped — already executing.`);
    return;
  }
  isDriverExecuting = true;
  if (debugMode) logWorkflowEvent(`>>> Tick start | source: ${triggerSource} | ctx: ${JSON.stringify(context)}`);
  try {
    // Watchdog-only responsibility: sweep for runs stuck past their status timeout and
    // record a (non-system) failure against them. Normal progression is callback-driven.
    if (triggerSource === 'watchdog') {
      await sweepTimeouts();
    }

    // Pick the next actionable run and advance it exactly one step. A run is actionable if
    // it is not terminal (DONE) and not currently claimed by an in-flight step.
    const states = await listRunStates();
    const active = states.filter(s => s && s.status !== APS_STATE.DONE);

    if (active.length === 0) {
      // No active runs. If we were running a round, the round is complete -> self-terminate.
      if (isWorkflowRunning) {
        logWorkflowEvent('Round complete — no active runs. Entering self-termination.');
        await stopWorkflowDriver();
      }
      return;
    }

    // Advance the oldest active run (FIFO). One run at a time — ProductSelector is serial.
    active.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    const target = active[0];
    await advanceRun(target.run_id);
  } catch (error) {
    console.error('[AutoProductSelection Driver] Error:', error);
    logWorkflowEvent(`Driver error: ${error.message || error}`, true);
    lastWorkflowError = error.stack || error.message || String(error);
  } finally {
    isDriverExecuting = false;
    if (debugMode) logWorkflowEvent(`<<< Tick end | source: ${triggerSource}`);
  }
}

/**
 * Scan AgentTask + VCPAsyncResults for the most recent COMPLETED worker delegation of a run
 * that ended WITHOUT producing its handoff file. Returns { found, errorText, errType } so the
 * watchdog can fail fast (and classify system vs non-system) instead of waiting out the full
 * status timeout. A scout/forge that 500s surfaces here within seconds of the callback.
 */
async function detectWorkerDeliveryFailure(runId, status, sinceMs = 0) {
  // Which worker role + expected output for this status.
  const role = status === APS_STATE.SCORING ? AUTO_SELECTION_REVIEWER_AGENT_NAME
    : status === APS_STATE.SCOUTING ? AUTO_SELECTION_SCOUT_AGENT_NAME
      : null;
  if (!role) return { found: false };
  const expectedStage = status === APS_STATE.SCORING ? 'scored' : 'raw';
  // If the handoff already exists, there is no failure to detect.
  try { await fs.access(resolveAutoSelectionFile(expectedStage, runId)); return { found: false }; } catch (_) { }
  try {
    const entries = await fs.readdir(AGENT_TASK_DIR, { withFileTypes: true });
    let best = null;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(`${role}_`) || !entry.name.endsWith('.md')) continue;
      const full = path.join(AGENT_TASK_DIR, entry.name);
      const stat = await fs.stat(full);
      // Only consider a delegation result NEWER than the current dispatch, so a retry does not
      // re-trip on the previous attempt's stale failed AgentTask.
      if (sinceMs && stat.mtimeMs < sinceMs) continue;
      const content = await fs.readFile(full, 'utf8');
      if (!content.includes(runId)) continue;
      if (!content.includes('任务状态:** Failed') && !content.includes('任务状态:** Succeed')) continue;
      if (!best || stat.mtimeMs > best.mtimeMs) best = { name: entry.name, mtimeMs: stat.mtimeMs, content };
    }
    if (!best) return { found: false };
    // Pull the real error from the async result if present.
    const did = (best.name.match(/(aa-delegation-[^.]+)\.md$/) || [])[1] || '';
    let errText = '';
    if (did) {
      try {
        const ar = JSON.parse(await fs.readFile(path.join(VCP_ROOT_DIR, 'VCPAsyncResults', `AgentAssistant-${did}.json`), 'utf8'));
        errText = `${ar.status || ''} ${ar.message || ''}`;
      } catch (_) { }
    }
    if (!errText) errText = best.content.includes('任务状态:** Failed') ? 'worker task Failed' : '';
    // Only treat as a delivery failure if the task actually Failed, or Succeeded-but-no-output
    // (the latter is a worker that finished its turn without writing — also a real failure).
    const failed = best.content.includes('任务状态:** Failed');
    if (!failed && !errText) return { found: false };
    return { found: true, errorText: errText, errType: classifyErrorType(errText) };
  } catch (_) {
    return { found: false };
  }
}

/**
 * Watchdog: find runs sitting in a non-terminal status longer than allowed and record a
 * timeout failure. Before declaring a missing handoff, it gives the backend extractor one
 * chance to turn a completed AgentAssistant report into the expected runs file.
 * Also fast-fails workers whose delegation already returned an error
 * (e.g. HTTP 500) before the full status timeout. This is the ONLY thing the timer does now.
 */
async function sweepTimeouts() {
  const states = await listRunStates();
  const now = Date.now();
  for (const state of states) {
    if (!state || state.status === APS_STATE.DONE || state.status === APS_STATE.FAILED) continue;

    const extracted = await autoExtractHandoffForState(state);
    if (extracted.extracted) continue;
    if (extracted.failed) {
      const fresh = await readRunState(state.run_id);
      if (!fresh || fresh.status === APS_STATE.DONE || fresh.status === APS_STATE.FAILED) continue;
      const capped = await recordRunFailure(fresh, classifyErrorType(extracted.errorText), extracted.errorText);
      if (!capped) {
        const retry = await readRunState(fresh.run_id);
        if (retry && (retry.status === APS_STATE.BRIEFING || retry.status === APS_STATE.SCOUTING || retry.status === APS_STATE.SCORING)) {
          retry.dispatched_at = null;
          await writeRunState(retry);
          await redispatchWorkerForState(retry);
        }
      }
      continue;
    }

    // FAST PATH: a worker we're waiting on may have already failed its delegation (500/etc.)
    // without writing output. Catch + classify it now instead of waiting out the timeout.
    if ((state.status === APS_STATE.SCOUTING || state.status === APS_STATE.SCORING) && state.dispatched_at) {
      const wf = await detectWorkerDeliveryFailure(state.run_id, state.status, new Date(state.dispatched_at).getTime());
      if (wf.found) {
        const fresh = await readRunState(state.run_id);
        if (!fresh || fresh.status === APS_STATE.DONE || fresh.status === APS_STATE.FAILED) continue;
        logWorkflowEvent(`[Watchdog] ${fresh.run_id} 的 worker 交付失败 (${wf.errType}): ${String(wf.errorText).slice(0, 120)}`, true);
        const capped = await recordRunFailure(fresh, wf.errType, `worker delivery failed: ${String(wf.errorText).slice(0, 160)}`);
        if (!capped) {
          const retry = await readRunState(fresh.run_id);
          if (retry && (retry.status === APS_STATE.SCOUTING || retry.status === APS_STATE.SCORING)) {
            retry.dispatched_at = null;
            await writeRunState(retry);
            await redispatchWorkerForState(retry);
          }
        }
        continue; // handled this run this sweep
      }
    }

    // Two timeout sources:
    // (1) A claimed run whose claim is older than the status timeout (a backend step that
    //     wedged mid-execution).
    // (2) A run WAITING ON AN ASYNC WORKER (SCOUTING/SCORING/PENDING_BRIEF/PUBLISHING/FAILED)
    //     whose dispatch is older than the status timeout. The claim is cleared on dispatch,
    //     so without this a worker that dies WITHOUT writing raw/scored/failed (e.g. a 500
    //     inside its sub-tool) leaves the run stranded forever. We track dispatched_at when a
    //     worker/coordinator is sent, and time out on it.
    const waitAnchor = state.claimed_at || state.dispatched_at;
    if (!waitAnchor) continue; // genuinely idle/unclaimed at a backend state — next tick acts
    const age = now - new Date(waitAnchor).getTime();
    if (Number.isFinite(age) && age > statusTimeoutMs(state.status)) {
      const fresh = await readRunState(state.run_id);
      if (!fresh || fresh.status === APS_STATE.DONE || fresh.status === APS_STATE.FAILED) continue;
      logWorkflowEvent(`[Watchdog] ${fresh.run_id} 在 ${fresh.status} 超时 (${Math.round(age / 60000)}min，worker 未交付)。`, true);
      // Count a (non-system) timeout failure. If capped -> recordRunFailure transitions to
      // FAILED. If NOT capped, retry by clearing dispatched_at and re-driving the run so the
      // appropriate worker is re-dispatched (the run sits in a waiting state with no output).
      const capped = await recordRunFailure(fresh, 'nonsystem', `status ${fresh.status} 超时 ${Math.round(age / 60000)}min，worker 未写出交付文件`);
      if (!capped) {
        const retry = await readRunState(fresh.run_id);
        if (retry && (retry.status === APS_STATE.BRIEFING || retry.status === APS_STATE.SCOUTING || retry.status === APS_STATE.SCORING || retry.status === APS_STATE.PENDING_BRIEF)) {
          retry.dispatched_at = null; // allow re-dispatch
          await writeRunState(retry);
          await redispatchWorkerForState(retry);
        }
      }
    }
  }
}

/**
 * The single transition entry point. Reads a run's authoritative status and performs exactly
 * one step, committing the next status only on success. All dispatch/decision logic lives here.
 */
async function advanceRun(runId) {
  const peek = await readRunState(runId);
  if (!peek || peek.status === APS_STATE.DONE) return;

  switch (peek.status) {
    case APS_STATE.PENDING_BRIEF: return advancePendingBrief(runId);
    case APS_STATE.BRIEFING: return advanceBriefing(runId);
    case APS_STATE.SCOUTING: return advanceScouting(runId);
    case APS_STATE.SCORING: return advanceScoring(runId);
    case APS_STATE.EVALUATING: return advanceEvaluating(runId);
    case APS_STATE.PUBLISHING: return advancePublishing(runId);
    case APS_STATE.FAILED: return advanceFailed(runId);
    default:
      logWorkflowEvent(`[StateMachine] ${runId}: 未知状态 ${peek.status}，跳过。`, true);
  }
}

// PENDING_BRIEF: ask the coordinator (破壁_枢纽) to author a brief. The coordinator only
// returns content; the backend extracts that completion report, writes brief, then dispatches
// scout from BRIEFING. This keeps human/tool prompts out of the state transition path.
async function advancePendingBrief(runId) {
  const state = await claimRun(runId, 'coordinator:brief');
  if (!state) return;

  let strategyContent = '';
  try {
    try {
      strategyContent = await fs.readFile(path.join(__dirname, 'AutoSelectionStrategyProfile.zh-CN.md'), 'utf8');
    } catch (e) {
      strategyContent = await fs.readFile(path.join(__dirname, 'AutoSelectionStrategyProfile.md'), 'utf8');
    }
  } catch (err) {
    strategyContent = '（未能读取到本地选品策略文件，请按宽泛探索默认原则进行选品）';
  }

  const prompt = `你好，破壁_枢纽。需要为一个新的选品任务创建 brief。

【当前选品策略指导 (Strategy Profile)】：
${strategyContent}

请执行以下步骤：
1. 按你的系统提示词完成记忆核对与候选发散；记忆语义以你的系统提示词为准，插件只注入本轮策略。
2. 按注入策略做宽泛探索（除非策略明确限定品类/关键词/价格带/禁选）。从场景、人群、痛点、配件、收纳清洁、替换件、低成本改良发散。
3. 若系统记忆提示你复用、避开或重评某个历史方向，请在 Brief 里说明依据；不要把这一步变成额外工具调用。
4. 直接在最终回复中输出完整 Markdown SelectionBrief，给鹰眼 2-3 个并列候选方向（彼此真正不同），每个 1-2 个英文种子词，标注偏"场景代入型"还是"功能型"。
5. **必须使用本任务指定的 run_id：${runId}**（不要自己另造 run_id）。
6. 完整 Brief 至少包含：研究假设、目标场景与客户、产品方向、价格带、2-3 个候选方向、英文种子词、排除红线、给鹰眼的 Level-1/Level-2 取证任务，以及“记忆核对”小节。
7. 最终回复必须先输出 [[TaskComplete]]，然后在其下方输出完整 SelectionBrief 正文。后端会自动提取写盘并派发鹰眼。

注意：
- 不要调用 AutoProductSelection、AgentAssistant、FileOperator 或 ServerFileOperator。
- 策略已注入，无需重复读取。
- 不要发论坛、不写日记、不归档。`;

  try {
    await commitTransition(state, APS_STATE.BRIEFING, 'brief delegated to coordinator');
    await delegateToCoordinator('create_brief', runId, prompt);
  } catch (e) {
    const fresh = await readRunState(runId) || state;
    await recordRunFailure(fresh, classifyErrorType(e.message), `brief delegation failed: ${e.message}`);
  }
}

// BRIEFING: wait for the coordinator's AgentAssistant report, extract SelectionBrief,
// write the brief handoff file, then dispatch scout exactly once.
async function advanceBriefing(runId) {
  const existing = await autoExtractHandoffForState(await readRunState(runId));
  if (existing.failed) {
    const state = await readRunState(runId);
    if (state) await recordRunFailure(state, classifyErrorType(existing.errorText), existing.errorText);
    return;
  }

  try {
    await fs.access(resolveAutoSelectionFile('brief', runId));
  } catch (_) {
    return; // coordinator is still working; watchdog owns timeout/retry
  }

  const state = await claimRun(runId, 'backend:dispatch_scout');
  if (!state) return;
  await commitTransition(state, APS_STATE.SCOUTING, 'brief ready -> scout dispatched');
  await dispatchScout(runId);
}

// SCOUTING: the scout (rebrief or fresh) runs via AgentAssistant. When it writes raw, the
// write hook calls triggerImmediateWorkflowTick -> advanceRun sees raw and moves to SCORING.
// Here we only check: has raw appeared? If yes, classify route_decision and transition.
async function advanceScouting(runId) {
  await autoExtractHandoffForState(await readRunState(runId));

  try {
    await fs.access(resolveAutoSelectionFile('failed', runId));
    const state = await claimRun(runId, 'backend:scout_failed');
    if (state) await commitTransition(state, APS_STATE.FAILED, 'scout wrote failed handoff');
    return;
  } catch (_) { }

  const rawPath = resolveAutoSelectionFile('raw', runId);
  let rawContent = '';
  try {
    rawContent = await fs.readFile(rawPath, 'utf8');
  } catch (_) {
    return; // raw not written yet; the scout is still working (watchdog guards timeout)
  }

  const state = await claimRun(runId, 'backend:route');
  if (!state) return;

  const routeMatch = rawContent.match(/route_decision[\s\S]{0,200}?action\s*:\s*['"]?([A-Z_]+)['"]?/i);
  const route = routeMatch ? routeMatch[1].toUpperCase() : '';

  // EARLY_REJECT / FETCHED_EMPTY: cheap prescreen killed all candidates. Stage the dropped
  // direction (for the eventual diary), bump the cheap early-reject budget, and either start
  // a fresh direction or — budget exhausted — fail to a blocking report.
  if (route === 'EARLY_REJECT' || route === 'FETCHED_EMPTY') {
    state.counters.early_reject += 1;
    await stageDroppedRunFiles(runId).catch(() => { });
    await autoSelectionDeleteRunFile({ stage: 'raw', run_id: runId }).catch(() => { });
    if (state.counters.early_reject > MAX_EARLY_REJECT_PER_TRIGGER) {
      logWorkflowEvent(`[StateMachine] ${runId}: 廉价预筛换方向预算耗尽 (${state.counters.early_reject - 1}/${MAX_EARLY_REJECT_PER_TRIGGER})，转 FAILED 收尾。`);
      state.failure_reason = 'reselect_budget_exhausted';
      await commitTransition(state, APS_STATE.FAILED, 'early-reject budget exhausted');
    } else {
      logWorkflowEvent(`[StateMachine] ${runId}: EARLY_REJECT，换新方向 (early_reject ${state.counters.early_reject}/${MAX_EARLY_REJECT_PER_TRIGGER})。`);
      await spawnReselectRun(state, 'early_reject');
      await commitTransition(state, APS_STATE.DONE, 'early-reject -> spawned fresh direction');
    }
    return;
  }

  // Normal: raw is ready for the forge. Move to SCORING and dispatch the reviewer.
  await commitTransition(state, APS_STATE.SCORING, `raw ready (route=${route || 'DEEPEN'})`);
  await dispatchReviewer(runId);
}

// SCORING: reviewer runs via AgentAssistant; when it writes scored, the scoring engine has
// already run inside autoSelectionWriteRunFile. We just detect scored and move to EVALUATING.
async function advanceScoring(runId) {
  await autoExtractHandoffForState(await readRunState(runId));

  try {
    await fs.access(resolveAutoSelectionFile('failed', runId));
    const state = await claimRun(runId, 'backend:reviewer_failed');
    if (state) await commitTransition(state, APS_STATE.FAILED, 'reviewer wrote failed handoff');
    return;
  } catch (_) { }

  const scoredPath = resolveAutoSelectionFile('scored', runId);
  try {
    await fs.access(scoredPath);
  } catch (_) {
    return; // scored not written yet; reviewer still working
  }
  const state = await claimRun(runId, 'backend:evaluate');
  if (!state) return;
  await commitTransition(state, APS_STATE.EVALUATING, 'scored ready');
  await advanceEvaluating(runId);
}

// EVALUATING: the backend itself runs decideBackendAction (NO coordinator round-trip) and
// branches: publish / loopback / drop. This removes the most error-prone agent step.
async function advanceEvaluating(runId) {
  const state = await claimRun(runId, 'backend:decide');
  if (!state) return;

  let scoredContent = '';
  try {
    scoredContent = await fs.readFile(resolveAutoSelectionFile('scored', runId), 'utf8');
  } catch (_) {
    await recordRunFailure(state, 'nonsystem', 'scored file missing at EVALUATING');
    return;
  }

  let rawContent = '';
  try { rawContent = await fs.readFile(resolveAutoSelectionFile('raw', runId), 'utf8'); } catch (_) { }

  const scoreResults = calculateScoringModel(scoredContent);
  const originalAction = normalizeForgeAction(extractForgeAction(scoredContent) || '');
  const action = decideBackendAction(originalAction, scoreResults, scoredContent, state.counters.reselect, state.force_decision_mode);

  if (action === 'PUBLISH_FINAL') {
    await commitTransition(state, APS_STATE.PUBLISHING, `decided PUBLISH (score ${scoreResults.totalScore})`);
    await advancePublishing(runId);
    return;
  }

  if (action === 'LOOPBACK_TO_HAWKEYE') {
    const counters = parseLoopbackCounters(scoredContent);
    const guard = evaluateLoopbackGuard(scoredContent, rawContent, counters);
    if (!guard.allowed) {
      // Loopback denied -> force a terminal decision: re-run EVALUATING in force_decision_mode.
      state.force_decision_mode = true;
      state.counters.reviewer_loopback += 1;
      logWorkflowEvent(`[StateMachine] ${runId}: LOOPBACK 被拒(${guard.reason})，转强制裁决模式。`);
      await dispatchReviewer(runId, { forceDecision: true, instruction: `后端已拒绝继续 LOOPBACK：${guard.reason}。请基于现有证据输出终态裁决（RECOMMEND/WATCHLIST/REJECT/DATA_INSUFFICIENT），不得再 LOOPBACK。` });
      await commitTransition(state, APS_STATE.SCORING, 'loopback denied -> force decision');
      return;
    }
    // Allowed: bump counters, delete scored, dispatch scout to top up the same raw.
    state.counters.scout_loopback += 1;
    state.counters.global_loopback += 1;
    await autoSelectionDeleteRunFile({ stage: 'scored', run_id: runId }).catch(() => { });
    const loopbackBrief = injectLoopbackCounters(buildLoopbackBrief(runId, scoredContent), {
      global_loopback_count: state.counters.global_loopback,
      scout_loopback_count: state.counters.scout_loopback,
      reviewer_loopback_count: state.counters.reviewer_loopback,
      reselect_count: state.counters.reselect
    });
    await autoSelectionWriteRunFile({ stage: 'brief', run_id: runId, content: loopbackBrief, overwrite: true });
    await commitTransition(state, APS_STATE.SCOUTING, 'loopback -> scout top-up');
    await dispatchScout(runId);
    return;
  }

  if (action === 'DROP_AND_RESELECT') {
    state.counters.reselect += 1;
    await stageDroppedRunFiles(runId).catch(() => { });
    if (state.counters.reselect > MAX_RESELECT_PER_TRIGGER) {
      state.failure_reason = 'reselect_budget_exhausted';
      await commitTransition(state, APS_STATE.FAILED, 'reselect budget exhausted');
      return;
    }
    await spawnReselectRun(state, 'drop_and_reselect');
    await commitTransition(state, APS_STATE.DONE, 'drop -> spawned fresh direction');
    return;
  }

  // Unknown action: treat as a soft failure.
  await recordRunFailure(state, 'nonsystem', `unknown decideBackendAction result: ${action}`);
}

// PUBLISHING: idempotent terminal publish. Each sub-step checks its flag first, so repeated
// triggers can never produce duplicate posts or diaries (root-fix for the 3-diary bug).
// The coordinator generates CONTENT; the backend owns the flags + archival.
async function advancePublishing(runId) {
  const state = await claimRun(runId, 'coordinator:publish');
  if (!state) return;

  if (state.publish_flags.post_published && state.publish_flags.diary_written) {
    // Content already produced by a prior delegation; just archive + finish.
    await autoSelectionArchiveRun({ run_id: runId, stage: 'scored' }).catch(async () => {
      await autoSelectionCleanupRun({ run_id: runId }).catch(() => { });
    });
    state.publish_flags.archived = true;
    await commitTransition(state, APS_STATE.DONE, 'published + archived');
    return;
  }

  const scoredDroppedBlock = buildDroppedSummaryPromptBlock(await collectDroppedSummaries());
  let scoredDeferredBlock = '';
  let scoredCandidateProductsBlock = '';
  try {
    const rawContent = await fs.readFile(resolveAutoSelectionFile('raw', runId), 'utf8');
    scoredDeferredBlock = buildDeferredCandidatesPromptBlock(extractDeferredCandidates(rawContent));
    const candProd = extractCandidateProductsSection(rawContent);
    if (candProd) {
      scoredCandidateProductsBlock = `\n==================================================\n【系统自动加载的原始竞品候选数据（含 ASIN 与基本信息，无需调用工具读取，直接以此为准）】：\n${candProd}\n==================================================\n`;
    }
  } catch (_) { }

  let scoredContent = '';
  try {
    scoredContent = await fs.readFile(resolveAutoSelectionFile('scored', runId), 'utf8');
  } catch (_) {
    scoredContent = '(无法读取 scored 文件)';
  }

  const verdictEn = String(extractScalarValue(scoredContent, 'verdict') || 'WATCHLIST').trim().toUpperCase();
  const verdictMap = {
    'ACCEPTED': '推荐立项',
    'RECOMMEND': '推荐立项',
    'WATCHLIST': '列入观察',
    'REJECTED': '不予立项',
    'DROP': '不予立项',
    'DATA_INSUFFICIENT': '数据不足'
  };
  const verdictZh = verdictMap[verdictEn] || verdictEn;

  const prompt = `你好，破壁_枢纽。一个选品 run 已通过后端裁决，需要你发布研报并写日记。
【本轮裁决结论】：${verdictZh}

==================================================
【系统自动加载的 Scored 研报数据（无需调用工具读取，直接以此为准）】：
${scoredContent}
==================================================
${scoredCandidateProductsBlock}


run_id: ${runId}

请执行以下步骤（这一步只负责"产出内容"，后端会自动归档，你不需要调用 archive）：

1. 直接使用上方“系统自动加载的 Scored 研报数据”。不要调用 AutoProductSelection 读文件命令，也不要用 FileOperator/ServerFileOperator 直读路径。

2. 发布论坛帖子（VCPForum），发到「自动选品推荐板块」。这是辅助商业决策 of 研报，读者要在 3 分钟内判断"要不要投入真金白银验证"。标题：【${verdictZh}】选品研报：[产品方向] | 综合 XX/100（区间 YY-ZZ）。
   【发帖可读性与表达规范（重要）】：
   - 裁决汉化：正文与标题中严禁直接输出英文裁决状态（如 WATCHLIST/RECOMMEND/ACCEPTED 等），统一使用中文（如【列入观察】/【推荐立项】/【不予立项】）。
   - 专业术语本土化：每个英文/专业指标首次出现紧跟中文解释（如"Unit Contribution（单件毛利，卖一个净赚多少）"、"ACOS（广告花费占销售额比例）"）。每个关键数字后用一句大白话或通俗理解点明含义。
   - 去黑话：正文一律将原格式中的章节“决策摘要 TL;DR”命名为“决策摘要（核心结论）”。
   - 通俗化数据表头：“五支柱机会拆解”表格中，严禁使用“归一化值”与“权重”作为列名，统一改成“评估分（满分10分）”与“影响权重（重要性）”。
   - 措辞高压红线：严禁在内容中使用“说人话”、“人话”这类低俗或态度傲慢的字眼。通俗解释时改用“通俗解释：”、“直观含义：”或“通俗理解：”等专业、谦逊且友好的词汇。
   - 新增“十二、竞品清单与详情”章节：根据头部系统自动加载的“竞品候选数据 (candidate_products)”，制作一个精美的竞品对比表格，包含竞品主图、ASIN、价格、月销量、评论数、评分、badges 以及直达跳转链接（链接必须为 https://www.amazon.com/dp/{ASIN} ）。
     【竞品图片展示说明】：严禁调用任何截图或浏览器工具。优先使用 candidate_products 列表中对应的 image_url 字段作为 Markdown 图片链接（格式如：![图片](url)）；如果 image_url 属性缺失或为空，则在主图一列显示文字“暂无图片”或“-”，绝对不要使用已被亚马逊封锁的 legacy 链接（如 images.amazon.com/images/P/{ASIN}...）。
   - 新增“评分依据与双评分口径”小节，放在决策摘要之后或五支柱之前。必须同时解释：
     1) 熔炉业务评审分：OpportunityScore / DataReliabilityScore / ExecutionFitScore / FinalScore，各自代表什么，为什么这样打；
     2) 后端 v3 棱镜分：point_estimate、pessimistic/optimistic 区间、overall_trust、五支柱 demand/competition/profit/differentiation/execution 及权重；
     3) 若两者不一致，明确说明差异来源：熔炉是“活的业务判断/排序分”，更重视数据缺口与执行纪律；后端是“固定数学安全阀/区间模型”，把风险体现在不确定区间和 trust 中。两者都要保留，不能只展示较高分。

   正文从 scored 提取真实数据，缺失写"未取得"，按 v3 口径组织：①决策摘要（核心结论）（含裁决+推荐动作、point_estimate与区间[pessimistic,optimistic]及overall_trust、成立理由与翻车点）②评分依据与双评分口径（熔炉业务分 + 后端棱镜分，解释差异）③五支柱拆解（需求/竞争余地/利润/差异化/执行的评估分与影响权重）④卖家Listing场景代入杠杆(listing_leverage_score及依据)⑤市场需求证据⑥竞争结构证据⑦利润与广告容错(费用表/UnitContribution/base-stress CVR-PPC-CPA/BreakEvenACOS/ad ratio)⑧差异化低成本改良⑨风险盘点(逐条标严重度)⑩数据置信度审计⑪Kill Criteria与Next Validation Plan⑫本轮淘汰与待观察记录⑬竞品清单与详情。

3. 写入选品公共日记本（DailyNote.create）。本轮只写一条合并主结论日记，极简，不要复制研报全文。必须显式传 Date 参数（YYYY-MM-DD）。Tag 行必须是 Content 最后一行。格式：
   [${verdictZh}] 产品方向 - 核心原因
   outcome: ${verdictZh} / product_direction: / primary_reason: / secondary_reason: / category: / price_band: / risk_tags: / opportunity_tags:
   Tag: #状态 #主要风险 #机会标签

4. 完成发帖与日记后，输出 [[TaskComplete]]。后端会自动归档并结束本轮。

注意：发帖和日记内容必须从 scored 提取，不要编造。${scoredDroppedBlock}${scoredDeferredBlock}`;

  try {
    await delegateToCoordinator('publish_final', runId, prompt);
    // Mark intent AFTER successful delegation, so even if the coordinator double-fires, the next
    // advancePublishing sees the flags and goes straight to archive instead of re-publishing.
    state.publish_flags.post_published = true;
    state.publish_flags.diary_written = true;
    state.last_action = 'publish delegated';
    await writeRunState(state); // keep claim; coordinator completion re-triggers a tick
    // Release the claim so the post-completion tick can archive. The flags guard against dup.
    const fresh = await readRunState(runId);
    if (fresh) { fresh.claimed_by = null; fresh.claimed_at = null; await writeRunState(fresh); }
  } catch (e) {
    await recordRunFailure(state, classifyErrorType(e.message), `publish delegation failed: ${e.message}`);
  }
}

// FAILED: idempotent blocking-report publish + archive. Same flag-guarded pattern.
async function advanceFailed(runId) {
  const state = await claimRun(runId, 'coordinator:blocking');
  if (!state) return;

  if (state.publish_flags.post_published) {
    await autoSelectionArchiveRun({ run_id: runId, stage: 'failed' }).catch(async () => {
      await autoSelectionCleanupRun({ run_id: runId }).catch(() => { });
    });
    state.publish_flags.archived = true;
    await commitTransition(state, APS_STATE.DONE, 'blocking report published + archived');
    return;
  }

  // Ensure a failed file exists for the coordinator to read.
  const reason = state.failure_reason || state.failure_tracking.last_error || 'unknown failure';
  const isReselectBudget = reason === 'reselect_budget_exhausted';
  try {
    await fs.access(resolveAutoSelectionFile('failed', runId));
  } catch (_) {
    const failedContent = [
      '---', `failure_type: ${isReselectBudget ? 'reselect_budget_exhausted' : 'run_failed'}`,
      `run_id: ${runId}`, `detected_at: ${nowIso()}`,
      `system_errors: ${state.failure_tracking.system_error_count}`,
      `nonsystem_errors: ${state.failure_tracking.nonsystem_error_count}`, '---', '',
      '# 自动选品阻断', '', `run_id: ${runId}`, '', `原因：${reason}`
    ].join('\n');
    await autoSelectionWriteRunFile({ stage: 'failed', run_id: runId, content: failedContent, overwrite: true });
  }

  const droppedBlock = isReselectBudget ? buildDroppedSummaryPromptBlock(await collectDroppedSummaries()) : '';
  const prompt = `你好，破壁_枢纽。一个选品 run 已失败/阻断，需要你发布阻断报告并写极简日记。

run_id: ${runId}
failure_kind: ${isReselectBudget ? 'DATA_REJECTION（多方向均被数据否决）' : 'SYSTEM_BLOCK（系统阻断/超时，非商业否决）'}

请执行：
1. 用 auto_selection_read_run_file 读取 failed 文件（stage=failed, run_id=${runId}, ink:「始」mark_history「末」）。严禁用 FileOperator 直读。
2. 在 VCP 论坛「自动选品板块」发布阻断报告（说明原因、关键证据、数据缺口、下一步）。${isReselectBudget ? '' : '明确这是系统层面阻断（超时/系统错误），不是对方向的商业否决。'}
   【发帖表达规范】：
   - 措辞高压红线：严禁在内容中使用“说人话”、“人话”这类粗俗或态度傲慢的字眼。通俗解释时改用“通俗解释：”、“直观含义：”或“通俗理解：”等专业、谦逊且友好的词汇。
3. 写一条极简日记（DailyNote.create，显式传 Date，Tag 行放最后）：${isReselectBudget ? '\n   [淘汰] 产品方向 - 数据层面核心原因\n   Tag: #排除 #主要原因' : '\n   [系统阻断] 产品方向（若有）- 阻断原因\n   Tag: #系统阻断 #未取得数据'}
4. 完成后输出 [[TaskComplete]]。后端会自动归档结束本轮。${droppedBlock}`;

  try {
    await delegateToCoordinator('handle_failed', runId, prompt);
    state.publish_flags.post_published = true;
    state.publish_flags.diary_written = true;
    state.last_action = 'blocking delegated';
    await writeRunState(state);
    const fresh = await readRunState(runId);
    if (fresh) { fresh.claimed_by = null; fresh.claimed_at = null; await writeRunState(fresh); }
  } catch (e) {
    // Even if delegation fails, force-archive so the queue drains.
    await autoSelectionArchiveRun({ run_id: runId, stage: 'failed' }).catch(() => { });
    const f = await readRunState(runId);
    if (f) await commitTransition(f, APS_STATE.DONE, 'blocking delegation failed -> force archived');
  }
}

// Spawn a brand-new direction run (fresh run_id) carrying the cross-direction reselect and
// early-reject budgets forward. Used by both EARLY_REJECT and DROP_AND_RESELECT.
async function spawnReselectRun(prevState, reason) {
  const newRunId = normalizeAutoSelectionRunId(`${buildTimestampRunPrefix()}-reselect`);
  const fresh = freshRunState(newRunId, {
    counters: {
      global_loopback: 0, scout_loopback: 0, reviewer_loopback: 0,
      reselect: prevState.counters.reselect,           // carry expensive budget
      early_reject: prevState.counters.early_reject    // carry cheap budget
    }
  });
  fresh.last_action = `spawned from ${prevState.run_id} (${reason})`;
  await writeRunState(fresh);
  logWorkflowEvent(`[StateMachine] ${prevState.run_id}: ${reason} -> 新方向 ${newRunId} (reselect ${fresh.counters.reselect}/${MAX_RESELECT_PER_TRIGGER}, early ${fresh.counters.early_reject}/${MAX_EARLY_REJECT_PER_TRIGGER})`);
}

// Dispatch the scout for a run (brief must already exist). Used for loopback top-ups.
async function dispatchScout(runId) {
  const dispatch = await autoSelectionPrepareDispatch({ worker: 'scout', run_id: runId, overwrite_lock: true });
  if (dispatch.success && dispatch.agent_assistant_request) {
    await callAgentAssistant(dispatch.agent_assistant_request);
  }
}

// Dispatch the reviewer (forge) for a run whose raw is ready.
async function dispatchReviewer(runId, opts = {}) {
  const dispatch = await autoSelectionPrepareDispatch({
    worker: 'reviewer', run_id: runId, overwrite_lock: true,
    force_decision_mode: opts.forceDecision === true,
    reviewer_instruction: opts.instruction || ''
  });
  if (dispatch.success && dispatch.agent_assistant_request) {
    await callAgentAssistant(dispatch.agent_assistant_request);
  }
}

// Re-dispatch the worker appropriate to a run's current waiting state after a worker timeout
// (the worker died without writing its handoff file). Sets a fresh dispatched_at so the
// watchdog clock restarts for this retry.
async function redispatchWorkerForState(state) {
  const runId = state.run_id;
  try {
    if (state.status === APS_STATE.BRIEFING) {
      logWorkflowEvent(`[Watchdog] ${runId}: 回退 PENDING_BRIEF，重新委托枢纽创建 brief。`);
      state.status = APS_STATE.PENDING_BRIEF;
      state.dispatched_at = null;
      await writeRunState(state);
      triggerImmediateWorkflowTick('watchdog_redispatch_brief', { runId });
    } else if (state.status === APS_STATE.SCORING) {
      // raw exists, reviewer never delivered scored -> re-dispatch reviewer.
      logWorkflowEvent(`[Watchdog] ${runId}: 重新派发熔炉（上次未交付 scored）。`);
      state.dispatched_at = nowIso();
      await writeRunState(state);
      await dispatchReviewer(runId, { forceDecision: state.force_decision_mode === true });
    } else if (state.status === APS_STATE.SCOUTING) {
      // If a brief exists, the scout never delivered raw -> re-dispatch scout. (If no brief,
      // the coordinator brief-creation step itself failed; re-drive PENDING_BRIEF path.)
      let hasBrief = false;
      try { await fs.access(resolveAutoSelectionFile('brief', runId)); hasBrief = true; } catch (_) { }
      if (hasBrief) {
        logWorkflowEvent(`[Watchdog] ${runId}: 重新派发鹰眼（上次未交付 raw）。`);
        state.dispatched_at = nowIso();
        await writeRunState(state);
        await dispatchScout(runId);
      } else {
        logWorkflowEvent(`[Watchdog] ${runId}: brief 缺失，回退 PENDING_BRIEF 重新创建。`);
        state.status = APS_STATE.PENDING_BRIEF;
        state.dispatched_at = null;
        await writeRunState(state);
        triggerImmediateWorkflowTick('watchdog_redispatch', { runId });
      }
    } else if (state.status === APS_STATE.PENDING_BRIEF) {
      state.dispatched_at = null;
      await writeRunState(state);
      triggerImmediateWorkflowTick('watchdog_redispatch', { runId });
    }
  } catch (e) {
    logWorkflowEvent(`[Watchdog] ${runId}: 重新派发失败: ${e.message}`, true);
  }
}


/**
 * Call AgentAssistant plugin to dispatch a worker.
 */
async function callAgentAssistant(agentRequest) {
  if (!resolveAgentAssistant()) {
    console.error('[AutoProductSelection WorkflowDriver] AgentAssistant plugin not available.');
    logWorkflowEvent(`[Worker Dispatch Failed] AgentAssistant plugin not available to dispatch worker [${agentRequest?.agent_name}].`, true);
    return;
  }

  try {
    // Inject ToolBox content if available
    let finalPrompt = agentRequest.prompt;
    if (TOOLBOX_CONTENT) {
      finalPrompt = `${TOOLBOX_CONTENT}\n\n---\n\n${agentRequest.prompt}`;
    }

    logWorkflowEvent(`[Worker Dispatch] 正在向 AgentAssistant 发送派发请求 [${agentRequest.agent_name}]`);

    const result = await AgentAssistantPlugin.processToolCall({
      command: 'request_agent_assistance',
      agent_name: agentRequest.agent_name,
      prompt: finalPrompt,
      temporary_contact: agentRequest.temporary_contact,
      task_delegation: agentRequest.task_delegation,
      inject_tools: agentRequest.inject_tools
    });

    logWorkflowEvent(`[Worker Dispatch Success] 成功向 AgentAssistant 派发 [${agentRequest.agent_name}]`);
    debugLog(`AgentAssistant call result: ${JSON.stringify(result).slice(0, 200)}`);
  } catch (error) {
    console.error('[AutoProductSelection WorkflowDriver] Failed to call AgentAssistant:', error);
    logWorkflowEvent(`[Worker Dispatch Failed] 派发 Worker [${agentRequest?.agent_name}] 失败: ${error.message}`, true);
  }
}

/**
 * Delegate a coordination task to 破壁_枢纽 via AgentAssistant.
 * Creates coordinator lock before delegation.
 */
async function delegateToCoordinator(taskType, runId, prompt) {
  if (!resolveAgentAssistant()) {
    console.error('[AutoProductSelection WorkflowDriver] AgentAssistant plugin not available for delegation.');
    logWorkflowEvent(`AgentAssistant plugin not available for delegation [${taskType}] for run [${runId}].`, true);

    // Write failed state file to allow proper cleanup
    try {
      const failedContent = [
        '---',
        `failure_type: system_error`,
        `run_id: ${runId}`,
        `detected_at: ${nowIso()}`,
        '---',
        '',
        '# 自动选品系统错误',
        '',
        `run_id: ${runId}`,
        '',
        'AgentAssistant 插件未加载，无法委托任务。',
        '',
        `任务类型: ${taskType}`
      ].join('\n');

      await autoSelectionWriteRunFile({
        stage: 'failed',
        run_id: runId,
        content: failedContent,
        overwrite: true
      });

      debugLog(`Created failed state file for ${runId} due to missing AgentAssistant.`);
    } catch (error) {
      console.error(`[AutoProductSelection WorkflowDriver] Failed to write failed state for ${runId}:`, error);
    }
    return;
  }

  try {
    logWorkflowEvent(`Delegating task [${taskType}] for run [${runId}] to coordinator.`);

    // Inject ToolBox content if available
    let finalPrompt = prompt;
    if (TOOLBOX_CONTENT) {
      finalPrompt = `${TOOLBOX_CONTENT}\n\n---\n\n${prompt}`;
    }

    const result = await AgentAssistantPlugin.processToolCall({
      command: 'request_agent_assistance',
      agent_name: '破壁_枢纽',
      prompt: finalPrompt,
      temporary_contact: false,
      task_delegation: true,
      inject_tools: taskType === 'create_brief' ? '' : 'VCPForum,DailyNote'
    });

    logWorkflowEvent(`Successfully called processToolCall to delegate [${taskType}] for run [${runId}].`);
    debugLog(`Delegated ${taskType} for ${runId} to coordinator: ${JSON.stringify(result).slice(0, 200)}`);
  } catch (error) {
    console.error(`[AutoProductSelection WorkflowDriver] Failed to delegate ${taskType} for ${runId}:`, error);
    logWorkflowEvent(`Failed to delegate [${taskType}] for run [${runId}]: ${error.message}`, true);
    throw error; // let the caller (advanceX) record the failure against the run state
  }
}

/**
 * Start the workflow driver timer.
 */
function startWorkflowDriver() {
  if (workflowInterval) {
    debugLog('Workflow driver already running.');
    return;
  }

  // Run immediately on startup, then on the configured interval
  process.nextTick(() => workflowDriver('trigger_run'));
  workflowInterval = setInterval(() => workflowDriver('watchdog'), WORKFLOW_TICK_INTERVAL_MS);
  console.log(`[AutoProductSelection] Workflow driver started (${WORKFLOW_TICK_INTERVAL_MS / 1000}-second interval).`);
}

/**
 * Debug status command - provides comprehensive workflow diagnostics
 */
async function autoSelectionDebugStatus(args = {}) {
  try {
    const report = [];
    report.push('# AutoProductSelection 状态机诊断报告 (v4)');
    report.push('');
    report.push(`生成时间: ${nowIso()}`);
    report.push('');

    report.push('## 1. 驱动器');
    report.push(`- isWorkflowRunning: \`${isWorkflowRunning}\``);
    report.push(`- isDriverExecuting: \`${isDriverExecuting}\``);
    report.push(`- watchdog 定时器: ${workflowInterval ? `运行中 (${WORKFLOW_TICK_INTERVAL_MS / 1000}s)` : '已停止'}`);
    if (lastWorkflowError) report.push(`- ⚠️ 最近错误: \`${String(lastWorkflowError).slice(0, 300)}\``);
    report.push('');

    const states = await listRunStates();
    const active = states.filter(s => s && s.status !== APS_STATE.DONE);
    report.push('## 2. Run 状态 (state.json 唯一真相)');
    report.push(`- 活动 run: ${active.length} | 总 run 文件: ${states.length}`);
    report.push('');
    if (active.length === 0) {
      report.push('（无活动 run。系统空闲，等待 auto_selection_trigger_run 启动新一轮。）');
    } else {
      for (const s of active) {
        const waitAnchor = s.claimed_at || s.dispatched_at;
        const ageMin = waitAnchor ? Math.round((Date.now() - new Date(waitAnchor).getTime()) / 60000) : null;
        const timeoutMin = Math.round(statusTimeoutMs(s.status) / 60000);
        report.push(`### ${s.run_id}`);
        report.push(`- **status**: \`${s.status}\`${s.claimed_by ? ` | 认领: ${s.claimed_by}` : s.dispatched_at ? ' | 等待异步交付' : ' | 未认领（下一 tick 接管）'}${ageMin != null ? `（已 ${ageMin}min / 超时 ${timeoutMin}min）` : ''}`);
        report.push(`- 上一步: ${s.last_action || '-'} | 结果: ${s.last_action_result || '-'}`);
        const c = s.counters || {};
        report.push(`- 计数器: 回环 scout ${c.scout_loopback || 0}/${SOFT_MAX_SCOUT_LOOPBACK} · reviewer ${c.reviewer_loopback || 0} · global ${c.global_loopback || 0}/${SOFT_MAX_GLOBAL_LOOPBACK}`);
        report.push(`- 换方向预算: 廉价 early_reject ${c.early_reject || 0}/${MAX_EARLY_REJECT_PER_TRIGGER} · 昂贵 reselect ${c.reselect || 0}/${MAX_RESELECT_PER_TRIGGER}`);
        const ft = s.failure_tracking || {};
        report.push(`- 失败计数: 系统级 ${ft.system_error_count || 0}/${APS_SYSTEM_ERROR_CAP} · 非系统 ${ft.nonsystem_error_count || 0}/${APS_NONSYSTEM_ERROR_CAP}${ft.last_error ? ` | 最近: ${String(ft.last_error).slice(0, 120)}` : ''}`);
        if (s.status === APS_STATE.PUBLISHING || s.status === APS_STATE.FAILED) {
          const pf = s.publish_flags || {};
          report.push(`- 发布幂等标记: 帖 ${pf.post_published ? '✓' : '✗'} · 日记 ${pf.diary_written ? '✓' : '✗'} · 归档 ${pf.archived ? '✓' : '✗'}`);
        }
        if (s.force_decision_mode) report.push(`- ⚠️ force_decision_mode: true（已禁止继续 LOOPBACK）`);
        report.push('');
      }
    }

    report.push('## 3. 下一步预判');
    if (active.length === 0) {
      report.push('- 空闲。');
    } else {
      const next = active.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
      const nextStepMap = {
        PENDING_BRIEF: '派发枢纽创建 brief → BRIEFING',
        BRIEFING: '等待枢纽完成报告 → 后端提取 brief → 派发鹰眼',
        SCOUTING: '等待鹰眼完成报告 → 后端提取 raw（或路由到 SCORING / EARLY_REJECT 换方向）',
        SCORING: '等待熔炉完成报告 → 后端提取 scored → EVALUATING',
        EVALUATING: '后端跑 decideBackendAction → 发布/回环/换方向',
        PUBLISHING: '派发枢纽发研报+写日记 → 后端归档 → DONE',
        FAILED: '派发枢纽发阻断报告+极简日记 → 后端归档 → DONE'
      };
      report.push(`- 下一个推进的 run: \`${next.run_id}\`（${next.status}）`);
      report.push(`- 预期动作: ${nextStepMap[next.status] || '未知'}`);
    }
    report.push('');
    report.push('## 4. 提示');
    report.push('- 正常推进优先由 AgentTask 完成报告自动提取驱动；手动写 runs 文件仍作为兼容入口。watchdog 只做提取前置扫描、超时与重试兜底。');
    report.push('- 如需全新开始: auto_selection_abort_workflow（清空所有 state）后 auto_selection_trigger_run。');

    return { success: true, command: 'auto_selection_debug_status', report: report.join('\n') };
  } catch (error) {
    return { success: false, command: 'auto_selection_debug_status', error: error.message };
  }
}

/**
 * Stop the workflow driver timer and clean up.
 */
async function stopWorkflowDriver() {
  if (workflowInterval) {
    clearInterval(workflowInterval);
    workflowInterval = null;
    console.log('[AutoProductSelection] Workflow driver stopped.');
    logWorkflowEvent('Workflow driver watchdog timer stopped.');
  }
  isWorkflowRunning = false;
  consecutiveErrorCount = 0;
  logWorkflowEvent('Workflow running state set to IDLE.');
  debugLog('Workflow driver stopped. Entering silent rest mode.');
}

async function initialize(config = {}, dependencies = {}) {
  debugMode = config.DebugMode === true;
  configureAutoSelectionRuntime(config);
  await ensureAutoSelectionRunDirs();

  // Load ToolBox API dictionary
  await loadToolBoxContent();

  // Store reference to AgentAssistant plugin for workflow driver
  if (dependencies && dependencies.pluginManager) {
    pluginManagerInstance = dependencies.pluginManager;
    resolveAgentAssistant();
  }
  if (!AgentAssistantPlugin) {
    console.warn('[AutoProductSelection] AgentAssistant plugin not available - workflow driver will operate in limited mode.');
  }

  // Crash/restart recovery: if any non-terminal run state exists, AUTO-RESUME the driver.
  // Without this, a restart mid-round leaves the run stranded (the forge may write scored,
  // but with the driver in standby nothing picks it up until the next scheduled trigger —
  // the exact production hang we diagnosed). The state machine is idempotent, so resuming is
  // safe: it re-derives each run's next step purely from its status.
  try {
    const states = await listRunStates();
    const active = states.filter(s => s && s.status !== APS_STATE.DONE);
    if (active.length > 0) {
      console.log(`[AutoProductSelection] Found ${active.length} active run(s) on startup. Auto-resuming workflow driver.`);
      logWorkflowEvent(`Startup recovery: auto-resuming ${active.length} active run(s).`);
      isWorkflowRunning = true;
      startWorkflowDriver();
    } else {
      console.log('[AutoProductSelection] Plugin initialized. Workflow driver in standby mode.');
      console.log('[AutoProductSelection] Trigger via: auto_selection_trigger_run command or VCPTaskAssistant scheduled task.');
    }
  } catch (e) {
    console.error('[AutoProductSelection] Startup recovery check failed:', e.message);
  }
}

function clampNumber(value, min = 0, max = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function parseMetricValue(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || /^[-–—]$/.test(text)) return null;
  const match = text.match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!match) return null;
  let number = Number(match[0].replace(/,/g, ''));
  if (!Number.isFinite(number)) return null;
  if (/k\b/i.test(text)) number *= 1000;
  if (/m\b/i.test(text)) number *= 1000000;
  return number;
}

function parseFloatValue(content, key, defaultValue = 0) {
  const regex = new RegExp(`\\b${escapeRegExp(key)}\\s*:\\s*['"]?([^\\r\\n#'"]+)`, 'i');
  const match = String(content || '').match(regex);
  if (!match) return defaultValue;
  const value = parseMetricValue(match[1]);
  return value === null ? defaultValue : value;
}

function findFirstNumber(content, keys = [], defaultValue = null) {
  for (const key of keys) {
    let value = parseFloatValue(content, key, NaN);
    if (Number.isFinite(value)) return value;
    value = parseFloatValue(content, `estimated_${key}`, NaN);
    if (Number.isFinite(value)) return value;
  }
  return defaultValue;
}

function parseCostMetricValue(rawSpan) {
  const text = String(rawSpan || '');
  const rangeMatch = text.match(/\$?\s*(-?\d+(?:\.\d+)?)\s*(?:-|~|–|—|至|到|to)\s*\$?\s*(-?\d+(?:\.\d+)?)/i);
  if (rangeMatch) {
    const low = Number(rangeMatch[1]);
    const high = Number(rangeMatch[2]);
    if (Number.isFinite(low) && Number.isFinite(high)) {
      return (low + high) / 2;
    }
  }
  return parseMetricValue(text);
}

function parseCostValue(content, key, defaultValue = NaN) {
  const regex = new RegExp(`\\b${escapeRegExp(key)}\\s*:\\s*['"]?([^\\r\\n#'"]+)`, 'i');
  const match = String(content || '').match(regex);
  if (!match) return defaultValue;
  const value = parseCostMetricValue(match[1]);
  return value === null ? defaultValue : value;
}

function findFirstCostNumber(content, keys = [], defaultValue = null) {
  for (const key of keys) {
    let value = parseCostValue(content, key, NaN);
    if (Number.isFinite(value)) return value;
    value = parseCostValue(content, `estimated_${key}`, NaN);
    if (Number.isFinite(value)) return value;
  }
  return defaultValue;
}

function findFirstRate(content, keys = [], defaultValue = null) {
  // Percent-aware rate parsing. The authoritative signal for "this is a percentage"
  // is a literal '%' in the source text, NOT the magnitude. Magnitude-guessing alone
  // mis-reads any percent value <=1% (e.g. "1%", "1.0%", "0.5%") as a raw decimal,
  // because parseMetricValue strips the '%'. So we re-extract the raw matched span and
  // check for '%' first; only when no '%' is present do we fall back to the >1 heuristic.
  for (const key of keys) {
    for (const candidateKey of [key, `estimated_${key}`]) {
      const regex = new RegExp(`\\b${escapeRegExp(candidateKey)}\\s*:\\s*['"]?([^\\r\\n#'"]+)`, 'i');
      const match = String(content || '').match(regex);
      if (!match) continue;
      const rawSpan = match[1];
      const num = parseMetricValue(rawSpan);
      if (num === null || !Number.isFinite(num)) continue;
      if (/%/.test(rawSpan)) return num / 100; // explicit percent: "1%"->0.01, "55%"->0.55
      return num > 1 ? num / 100 : num;          // bare number: keep legacy magnitude heuristic
    }
  }
  return defaultValue;
}

function costFromRateOrDefault(content, rateKeys = [], sellingPrice = 0, defaultRate = 0) {
  const rate = findFirstRate(content, rateKeys, null);
  if (rate !== null && rate >= 0) return sellingPrice * rate;
  return sellingPrice * defaultRate;
}

function hasAnyNumber(content, keys = []) {
  return keys.some(key =>
    Number.isFinite(parseFloatValue(content, key, NaN)) ||
    Number.isFinite(parseFloatValue(content, `estimated_${key}`, NaN))
  );
}

function smoothMultiplier(value, start, end, high, low) {
  if (value <= start) return high;
  if (value >= end) return low;
  const t = (value - start) / (end - start);
  return high + (low - high) * t;
}

function extractFinalVerdict(content = '') {
  const text = String(content || '');
  const match = text.match(/final_disposition[\s\S]{0,600}?\bverdict\s*:\s*['"]?([A-Z_]+)['"]?/i) ||
    text.match(/\bverdict\s*:\s*['"]?(RECOMMEND|WATCHLIST|RESEARCH_GAP|REJECT|DATA_INSUFFICIENT)['"]?/i);
  return match?.[1] ? String(match[1]).trim().toUpperCase() : '';
}

function detectHardGateFromContent(content = '', complianceRisk = 0) {
  const text = String(content || '');
  if (/hard_gates[\s\S]{0,500}?\bpassed\s*:\s*false\b/i.test(text)) return true;
  const triggeredMatch = text.match(/triggered_gates\s*:\s*([^\r\n]*)/i);
  if (triggeredMatch && !/^\s*(\[\s*\]|none|null|无|-)?\s*$/i.test(triggeredMatch[1])) return true;
  if (/triggered_gates[\s\S]{0,300}?\n\s*-\s*\S/i.test(text)) return true;
  return Number(complianceRisk) >= 9;
}

function confidenceMultiplier(score) {
  // Gentle curve: a "good enough" reliability (>=75) is NOT re-penalized. Only
  // genuinely low confidence (<65) starts to bite, and hard (<35) is severe.
  if (score >= 75) return { level: 'High', multiplier: 1.0 };
  if (score >= 65) return { level: 'Medium-High', multiplier: smoothMultiplier(score, 65, 75, 0.92, 1.0) };
  if (score >= 50) return { level: 'Medium', multiplier: smoothMultiplier(score, 50, 65, 0.75, 0.92) };
  if (score >= 35) return { level: 'Low', multiplier: smoothMultiplier(score, 35, 50, 0.55, 0.75) };
  return { level: 'Very Low', multiplier: 0.45 };
}

function executionMultiplier(score) {
  // Gentle curve mirroring confidence: a solid execution fit (>=75) is not penalized.
  if (score >= 75) return 1.0;
  if (score >= 65) return smoothMultiplier(score, 65, 75, 0.92, 1.0);
  if (score >= 50) return smoothMultiplier(score, 50, 65, 0.75, 0.92);
  if (score >= 35) return smoothMultiplier(score, 35, 50, 0.55, 0.75);
  return 0.45;
}

// --- v3 scoring helpers ---------------------------------------------------
function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

// Logistic-ish saturating map: value at `mid` -> 0.5, rising smoothly to 1.
function saturate(value, mid, steepness = 1) {
  const x = (Number(value) - mid) * steepness;
  return 1 / (1 + Math.exp(-x));
}

// Listing-leverage boost on the differentiation pillar. L is how scene/emotion-driven
// the category's buy decision is; sigma is the seller's structural listing edge. On a
// purely functional product (L~0) the boost vanishes; on a 代入感 product (L~1) the
// seller's edge meaningfully lifts achievable differentiation.
function applyListingLeverage(diffBase, leverage, cfg) {
  const L = clamp01(leverage);
  const sigma = clamp01(cfg.seller_listing_skill);
  const gain = Math.max(0, cfg.listing_leverage_gain);
  const base = clamp01(diffBase);
  return clamp01(base + L * sigma * (1 - base) * gain);
}

// Weighted geometric mean of pillars in [0,1]. A near-zero pillar drags the result
// toward zero (a missing essential dimension is fatal), but several mid pillars
// aggregate to a mid score instead of the multiplicative collapse of the old chain.
function weightedGeometricMean(pillars, floor) {
  let wSum = 0;
  let logSum = 0;
  for (const { value, weight } of pillars) {
    const w = Math.max(0, weight);
    if (w <= 0) continue;
    const v = Math.max(floor, clamp01(value));
    wSum += w;
    logSum += w * Math.log(v);
  }
  if (wSum <= 0) return 0;
  return Math.exp(logSum / wSum);
}

function calculateScoringModel(content) {
  const text = String(content || '');
  const warnings = [];
  const missingCriticalFields = new Set();
  // Distortion signals collected as inputs are consumed. Cold/niche products often
  // come back from SellerSprite with implausible figures (cost above selling price,
  // CVR of 50%+, PPC bid above price). We sanitize those values to conservative
  // defaults at consumption so a single distorted field can't poison the unit-
  // contribution math and force-drop a possibly-good direction; the signals are
  // surfaced so decideBackendAction treats a low score as "low confidence" rather
  // than "proven bad economics".
  const distortionSignals = [];

  const oldDemand = findFirstNumber(text, ['demand_volume'], null);
  const oldDifferentiation = findFirstNumber(text, ['differentiation_feasibility'], null);
  const demandScore = findFirstNumber(text, ['demand_score', 'DemandScore'], oldDemand !== null ? oldDemand * 4 : 50);
  const growthScore = findFirstNumber(text, ['growth_score', 'GrowthScore'], 50);
  const differentiationScore = findFirstNumber(text, ['differentiation_score', 'DifferentiationScore'], oldDifferentiation !== null ? oldDifferentiation * 4 : 50);
  const competitionSeverity = clampNumber(findFirstNumber(text, ['competition_severity', 'CompetitionSeverity'], 5), 0, 10);
  const complianceRisk = clampNumber(findFirstNumber(text, ['compliance_risk', 'ComplianceRisk'], 3), 0, 10);
  const complexitySeverity = clampNumber(findFirstNumber(text, ['complexity_severity', 'ComplexitySeverity'], 5), 0, 10);
  const marketEntryScore = findFirstNumber(text, ['market_entry_score', 'MarketEntryScore'], clampNumber(100 - competitionSeverity * 8 - complexitySeverity * 3, 0, 100));

  const potentialScore = clampNumber(
    0.30 * clampNumber(demandScore) +
    0.20 * clampNumber(growthScore) +
    0.25 * clampNumber(differentiationScore) +
    0.25 * clampNumber(marketEntryScore)
  );

  const sellingPriceRaw = findFirstCostNumber(text, [
    'selling_price',
    'target_selling_price',
    'target_price',
    'target_price_usd',
    'main_band_anchor_usd',
    'anchor_price_usd',
    'target_price_band_usd',
    'target_price_band',
    'price_band_usd',
    'selling_price_estimate_usd'
  ], null);
  const sellingPrice = sellingPriceRaw && sellingPriceRaw > 0 ? sellingPriceRaw : 25.0;
  if (!sellingPriceRaw || sellingPriceRaw <= 0) {
    missingCriticalFields.add('selling_price');
    warnings.push('selling_price 缺失，后端仅用 $25.00 做保守压力测试，不作为高置信度证据。');
  }

  const bomCostRaw = findFirstCostNumber(text, [
    'bom_cost',
    'bom_landed_cost',
    'bom_estimate_per_set_usd',
    'bom_estimate_per_set',
    'bom_cost_estimate_usd',
    'bom_estimate_usd'
  ], null);
  const shippingCostRaw = findFirstCostNumber(text, [
    'shipping_cost',
    'shipping_cost_estimate_usd',
    'head_freight_usd',
    'head_freight_estimate',
    'head_freight_estimate_usd',
    'freight_cost',
    'first_leg_shipping_cost',
    'landed_shipping_cost'
  ], null);
  const fbaFeeRaw = findFirstCostNumber(text, [
    'target_fba_fee',
    'fba_fee_estimate_usd',
    'fba_fee_estimate',
    'median_fba_fee',
    'median_competitor_fba_fee',
    'real_fba_fee',
    'fba_fee'
  ], null);
  const referralFeeRaw = findFirstCostNumber(text, ['referral_fee', 'referral_fee_usd'], null);
  const packagingCostRaw = findFirstCostNumber(text, [
    'packaging_cost',
    'packaging_cost_usd',
    'packaging_estimate',
    'packaging_estimate_usd'
  ], null);
  const returnReserveRaw = findFirstCostNumber(text, ['return_reserve', 'return_reserve_usd'], null);
  const couponCostRaw = findFirstCostNumber(text, ['coupon_cost', 'coupon_cost_usd'], null);
  const storageReserveRaw = findFirstCostNumber(text, ['storage_reserve', 'storage_reserve_usd'], null);

  // A single cost component should never exceed the selling price. When it does,
  // the figure is almost certainly distorted (thin-sample SellerSprite estimate),
  // so treat it as unusable rather than letting it drag unit contribution negative.
  const sanitizeCost = (rawValue, fieldLabel) => {
    if (rawValue !== null && rawValue >= 0 && sellingPrice > 0 && rawValue > sellingPrice) {
      distortionSignals.push(`${fieldLabel} (${rawValue.toFixed(2)}) 超过售价 (${sellingPrice.toFixed(2)})，疑似失真，已回退保守估计`);
      return null; // fall through to the conservative default below
    }
    return rawValue;
  };
  const bomCostClean = sanitizeCost(bomCostRaw, 'bom_cost');
  const fbaFeeClean = sanitizeCost(fbaFeeRaw, 'fba_fee');
  const shippingCostClean = sanitizeCost(shippingCostRaw, 'shipping_cost');

  const bomCost = bomCostClean !== null && bomCostClean >= 0 ? bomCostClean : sellingPrice * 0.25;
  const shippingCost = shippingCostClean !== null && shippingCostClean >= 0 ? shippingCostClean : Math.max(1.25, sellingPrice * 0.10);
  const fbaFee = fbaFeeClean !== null && fbaFeeClean >= 0 ? fbaFeeClean : Math.max(3.0, sellingPrice * 0.18);
  const referralFee = referralFeeRaw !== null && referralFeeRaw >= 0
    ? referralFeeRaw
    : costFromRateOrDefault(text, ['referral_fee_pct', 'referral_rate', 'amazon_referral_fee_pct'], sellingPrice, 0.15);
  const packagingCost = packagingCostRaw !== null && packagingCostRaw >= 0 ? packagingCostRaw : Math.max(0.75, sellingPrice * 0.03);
  const returnReserve = returnReserveRaw !== null && returnReserveRaw >= 0
    ? returnReserveRaw
    : costFromRateOrDefault(text, ['return_reserve_pct', 'return_rate', 'return_reserve_rate'], sellingPrice, 0.05);
  const couponCost = couponCostRaw !== null && couponCostRaw >= 0
    ? couponCostRaw
    : costFromRateOrDefault(text, ['coupon_cost_pct', 'coupon_rate', 'coupon_reserve_pct'], sellingPrice, 0.05);
  const storageReserve = storageReserveRaw !== null && storageReserveRaw >= 0
    ? storageReserveRaw
    : costFromRateOrDefault(text, ['storage_reserve_pct', 'storage_rate'], sellingPrice, 0.02);

  if (bomCostRaw === null || bomCostRaw < 0) warnings.push('bom_cost 缺失，按售价 25% 保守估计。');
  if (shippingCostRaw === null || shippingCostRaw < 0) warnings.push('shipping_cost 缺失，按售价 10% 且最低 $1.25 保守估计。');
  if (fbaFeeRaw === null || fbaFeeRaw < 0) {
    missingCriticalFields.add('fba_fee');
    warnings.push('fba_fee 缺失，按售价 18% 且最低 $3.00 保守估计。');
  }

  const estimatedUnitContribution = sellingPrice - referralFee - bomCost - shippingCost - fbaFee - packagingCost - returnReserve - couponCost - storageReserve;
  const estimatedUnitContributionRate = sellingPrice > 0 ? estimatedUnitContribution / sellingPrice : 0;

  let rawCvr = findFirstRate(text, [
    'raw_click_conversion_rate',
    'click_conversion_rate',
    'industry_click_conversion_rate',
    'conversion_rate',
    'cvr'
  ], null);
  if (!rawCvr || rawCvr <= 0) {
    missingCriticalFields.add('click_conversion_rate');
    rawCvr = 0.06;
    warnings.push('click_conversion_rate 缺失，后端按 6% 行业参考做保守压力测试，并降低数据置信度。');
  }
  const matureEvidence = /\bmature_cvr_evidence\s*:\s*true\b|\bcvr_adjustment_mode\s*:\s*mature/i.test(text);
  const baseCvr = matureEvidence ? Math.min(rawCvr * 0.65, 0.12) : Math.min(rawCvr * 0.50, 0.08);
  const stressCvr = matureEvidence ? Math.min(rawCvr * 0.45, 0.08) : Math.min(rawCvr * 0.35, 0.06);

  const explicitUsedPpc = findFirstCostNumber(text, ['used_ppc', 'base_ppc', 'ppc_bid_base'], null);
  const explicitStressPpc = findFirstCostNumber(text, [
    'stress_ppc',
    'ppc_bid_stress',
    'stress_ppc_bid',
    'ppc_high',
    'ppc_bid_high'
  ], null);
  const rawPpcBidValue = findFirstCostNumber(text, [
    'raw_ppc_bid',
    'ppc_bid',
    'ppc_bid_mid',
    'ppc_mid',
    'ppc_avg',
    'ppc_bid_avg'
  ], null);
  // A PPC bid above the selling price is implausible (distorted thin-sample data).
  // Drop it so it can't inflate CPA and fail the ad-stress test on a good niche.
  let rawPpcBid = rawPpcBidValue;
  if (rawPpcBidValue !== null && rawPpcBidValue >= 0 && sellingPrice > 0 && rawPpcBidValue > sellingPrice) {
    distortionSignals.push(`ppc_bid (${rawPpcBidValue.toFixed(2)}) 超过售价 (${sellingPrice.toFixed(2)})，疑似失真，已回退保守估计`);
    rawPpcBid = null;
  }
  let usedPpc = explicitUsedPpc !== null && explicitUsedPpc >= 0 ? explicitUsedPpc : null;
  let stressPpc = explicitStressPpc !== null && explicitStressPpc >= 0 ? explicitStressPpc : null;
  if ((usedPpc === null || stressPpc === null) && rawPpcBid !== null && rawPpcBid >= 0) {
    if (usedPpc === null) usedPpc = rawPpcBid * 1.15;
    if (stressPpc === null) stressPpc = rawPpcBid * 1.35;
  }
  if (usedPpc === null || stressPpc === null) {
    missingCriticalFields.add('ppc_bid');
    if (usedPpc === null) usedPpc = 1.15;
    if (stressPpc === null) stressPpc = 1.35;
    warnings.push(`ppc_bid 缺失，后端按 $${usedPpc.toFixed(2)}/$${stressPpc.toFixed(2)} 做保守压力测试，并降低数据置信度。`);
  }

  const baseCpa = usedPpc / Math.max(baseCvr, 0.005);
  const stressCpa = stressPpc / Math.max(stressCvr, 0.005);
  const breakEvenAcos = sellingPrice > 0 ? estimatedUnitContribution / sellingPrice : 0;
  const estimatedAcos = sellingPrice > 0 ? baseCpa / sellingPrice : 0;

  // Natural-traffic blend. CPA is the cost of a *paid* order, but a listing's sales
  // are a mix of paid + organic/repeat traffic. Charging full CPA against every unit
  // overstates ad cost and makes niche products look uneconomic. We assume only a
  // fraction of orders need a paid click (paid_traffic_ratio, default 0.6, overridable
  // via the raw field). The amortized ad cost per unit is CPA * paid_traffic_ratio.
  const rawPaidRatio = findFirstRate(text, ['paid_traffic_ratio'], null);
  const paidTrafficRatio = (rawPaidRatio !== null && rawPaidRatio > 0 && rawPaidRatio <= 1) ? rawPaidRatio : 0.6;
  const blendedBaseCpa = baseCpa * paidTrafficRatio;
  const blendedStressCpa = stressCpa * paidTrafficRatio;
  const baseAdRatio = estimatedUnitContribution > 0 ? blendedBaseCpa / estimatedUnitContribution : Infinity;
  const stressAdRatio = estimatedUnitContribution > 0 ? blendedStressCpa / estimatedUnitContribution : Infinity;
  // Ad-stress thresholds loosened: ad-economics inputs are the least reliable
  // SellerSprite fields, so a soft fail only annotates/downgrades — it never drops.
  const adStressTestFailed = stressAdRatio > 1.8 || baseAdRatio > 1.5;

  // mProfit softened: a distorted/high ad ratio should dent the score, not crater it
  // to 0.05. Only a genuinely negative unit contribution is a hard profit risk.
  let mProfit;
  if (estimatedUnitContribution <= 0) {
    mProfit = 0.05;
    warnings.push(`UnitContribution 为负或为零 (${estimatedUnitContribution.toFixed(2)})，触发利润硬风险。`);
  } else if (baseAdRatio <= 0.4) {
    mProfit = 1.20;
  } else if (baseAdRatio <= 1.0) {
    mProfit = smoothMultiplier(baseAdRatio, 0.4, 1.0, 1.20, 0.90);
  } else if (baseAdRatio <= 1.8) {
    mProfit = smoothMultiplier(baseAdRatio, 1.0, 1.8, 0.90, 0.55);
    warnings.push(`广告基础压力偏高 (base_ad_ratio=${baseAdRatio.toFixed(3)})，已按低权重处理，建议人工验证真实 CPA。`);
  } else {
    mProfit = 0.45;
    warnings.push(`广告基础压力大 (base_ad_ratio=${baseAdRatio.toFixed(3)})，但广告数据可信度低，仅降权不淘汰，需人工验证。`);
  }
  if (estimatedUnitContributionRate < 0.25) {
    mProfit *= 0.80;
    warnings.push(`贡献利润率低于25% (${(estimatedUnitContributionRate * 100).toFixed(1)}%)。`);
  }
  if (estimatedUnitContribution < 6) {
    mProfit *= 0.80;
    warnings.push(`单件贡献利润低于 $6 (${estimatedUnitContribution.toFixed(2)})。`);
  }
  if (adStressTestFailed) {
    warnings.push(`广告压力测试未通过 (stress_ad_ratio=${Number.isFinite(stressAdRatio) ? stressAdRatio.toFixed(3) : 'Infinity'})，因广告数据失真风险高，仅作降权与 WATCHLIST 降级参考，不作硬性淘汰。`);
  }

  // --- Ad-economics weight compression ---
  // The user's edge (better listings, real CVR far above SellerSprite's distorted
  // niche figures, strong product-dev) means ad-economics should be a LOW-weight
  // input, not a multiplicative killer. A raw mProfit of 0.36 would crater a strong
  // market to a score of ~21. Compress it toward neutral so ad pressure can only
  // shave a bounded fraction off the opportunity score. Negative unit contribution
  // is handled separately as a hard gate, so it is exempt from the compression floor.
  const AD_ECONOMICS_WEIGHT = 0.35; // ad pressure can remove at most ~35% of opportunity
  const mProfitWeighted = estimatedUnitContribution <= 0
    ? mProfit // keep the hard 0.05 so the hard gate still fires
    : 1 - AD_ECONOMICS_WEIGHT * (1 - Math.min(mProfit, 1));
  // Allow a mild bonus for genuinely strong economics (mProfit > 1) but keep it small.
  const mProfitEffective = mProfit > 1
    ? 1 + AD_ECONOMICS_WEIGHT * (mProfit - 1)
    : mProfitWeighted;

  let mCompetition;
  if (competitionSeverity <= 2) mCompetition = 1.10;
  else if (competitionSeverity <= 5) mCompetition = smoothMultiplier(competitionSeverity, 2, 5, 1.0, 0.80);
  else if (competitionSeverity <= 8) mCompetition = smoothMultiplier(competitionSeverity, 5, 8, 0.80, 0.40);
  else mCompetition = smoothMultiplier(competitionSeverity, 8, 10, 0.40, 0.10);
  if (competitionSeverity > 8) warnings.push(`竞争激烈度极高 (competition_severity=${competitionSeverity})。`);

  let mCompliance;
  if (complianceRisk <= 2) mCompliance = 1.0;
  else if (complianceRisk <= 5) mCompliance = smoothMultiplier(complianceRisk, 2, 5, 1.0, 0.70);
  else if (complianceRisk <= 8) mCompliance = smoothMultiplier(complianceRisk, 5, 8, 0.70, 0.20);
  else mCompliance = 0.05;
  if (complianceRisk >= 8) warnings.push(`合规/侵权/平台风险极高 (compliance_risk=${complianceRisk})。`);

  const explicitOpportunityScore = findFirstNumber(text, ['opportunity_score', 'OpportunityScore'], null);
  const opportunityScore = clampNumber(
    explicitOpportunityScore !== null && !hasAnyNumber(text, [
      'demand_score',
      'DemandScore',
      'growth_score',
      'GrowthScore',
      'differentiation_score',
      'DifferentiationScore',
      'market_entry_score',
      'MarketEntryScore'
    ])
      ? explicitOpportunityScore
      : potentialScore * mProfitEffective * mCompetition * mCompliance
  );

  const sourceReliability = findFirstNumber(text, ['source_reliability_score'], null);
  const freshness = findFirstNumber(text, ['freshness_score'], null);
  const sampleCoverage = findFirstNumber(text, ['sample_coverage_score'], null);
  const crossSource = findFirstNumber(text, ['cross_source_consistency_score'], null);
  const fieldCompleteness = findFirstNumber(text, ['field_completeness_score'], null);
  const outlierControl = findFirstNumber(text, ['outlier_control_score'], null);
  const explicitDataReliability = findFirstNumber(text, ['data_reliability_score', 'DataReliabilityScore'], null);
  const oldDataConfidence = findFirstNumber(text, ['data_confidence'], null);
  let dataReliabilityScore;
  if (explicitDataReliability !== null) {
    dataReliabilityScore = explicitDataReliability;
  } else if ([sourceReliability, freshness, sampleCoverage, crossSource, fieldCompleteness, outlierControl].some(value => value !== null)) {
    dataReliabilityScore =
      0.20 * clampNumber(sourceReliability ?? 55) +
      0.15 * clampNumber(freshness ?? 55) +
      0.20 * clampNumber(sampleCoverage ?? 55) +
      0.20 * clampNumber(crossSource ?? 55) +
      0.15 * clampNumber(fieldCompleteness ?? 55) +
      0.10 * clampNumber(outlierControl ?? 55);
  } else if (oldDataConfidence !== null) {
    dataReliabilityScore = [35, 50, 70, 85][clampNumber(Math.round(oldDataConfidence), 0, 3)] || 35;
  } else {
    dataReliabilityScore = 55;
  }
  dataReliabilityScore = clampNumber(dataReliabilityScore - missingCriticalFields.size * 6);
  if (/unfetchable_gaps[\s\S]{0,2000}-\s*\S/i.test(text)) {
    dataReliabilityScore = clampNumber(dataReliabilityScore - 5);
  }

  // --- Data distortion safety net (CVR) ---
  // Cost/PPC distortions were already sanitized at input consumption (values above
  // selling price fall back to conservative defaults and pushed a distortionSignal).
  // CVR is only scaled, not dropped, so flag implausible CVR here. Treating these
  // distorted figures as ground truth could force-drop a genuinely good direction,
  // so we lower data reliability and let decideBackendAction treat a low score as
  // "low confidence" rather than "proven bad economics".
  // CVR only meaningful if it was actually present (not the 6% default fallback).
  const cvrWasProvided = !missingCriticalFields.has('click_conversion_rate');
  if (cvrWasProvided && rawCvr > 0.40) {
    distortionSignals.push(`click_conversion_rate=${(rawCvr * 100).toFixed(1)}% 不合理偏高（疑似冷门词样本过小导致失真）`);
  }
  if (cvrWasProvided && rawCvr > 0 && rawCvr < 0.002) {
    distortionSignals.push(`click_conversion_rate=${(rawCvr * 100).toFixed(2)}% 不合理偏低（疑似样本不足或失真）`);
  }

  // --- Ad-economics distortion (cpa / acos / ad_budget / aba_concentration) ---
  // These keyword-conversion-rate derived fields are the least reliable SellerSprite
  // outputs for cold/niche keywords. If they are present AND implausible relative to
  // trusted fields (CPA above selling price, ACOS far above 100%), flag distortion so
  // they only lower confidence — they must never drive a hard DROP on their own.
  const reportedCpa = findFirstCostNumber(text, ['reported_cpa', 'cpa_mid', 'cpa_avg', 'cpa'], null);
  if (reportedCpa !== null && sellingPrice > 0 && reportedCpa > sellingPrice) {
    distortionSignals.push(`cpa (${reportedCpa.toFixed(2)}) 超过售价 (${sellingPrice.toFixed(2)})，广告数据疑似失真，仅降权不淘汰`);
  }
  const reportedAcos = findFirstRate(text, ['reported_acos', 'acos_avg', 'acos_mid', 'acos'], null);
  if (reportedAcos !== null && reportedAcos > 1.5) {
    distortionSignals.push(`acos (${(reportedAcos * 100).toFixed(0)}%) 异常偏高，广告数据疑似失真，仅降权不淘汰`);
  }

  const dataDistortionSuspected = distortionSignals.length > 0;
  if (dataDistortionSuspected) {
    // Distorted inputs are a reliability problem, not a verdict. Penalize
    // confidence so the score self-protects, but let the verdict path treat
    // this as "low confidence" rather than "proven bad economics".
    dataReliabilityScore = clampNumber(dataReliabilityScore - 12);
    warnings.push(`检测到疑似失真数据，已下调数据置信度并标记 data_distortion_suspected：${distortionSignals.join('；')}`);
  }
  const confidence = confidenceMultiplier(dataReliabilityScore);

  const explicitExecutionFit = findFirstNumber(text, ['execution_fit_score', 'ExecutionFitScore'], null);
  const executionFitScore = clampNumber(explicitExecutionFit !== null ? explicitExecutionFit : (100 - complexitySeverity * 8));
  const mExecutionFit = executionMultiplier(executionFitScore);

  const hardGateTriggered = detectHardGateFromContent(text, complianceRisk) || estimatedUnitContribution <= 0;
  if (hardGateTriggered) warnings.push('Hard Gate 或负贡献利润触发，FinalScore 强制为 0。');

  // --- v3 pillar aggregation (weighted geometric mean + listing leverage) ---
  const cfg = SCORING_CONFIG;
  // listing_leverage: how scene/emotion-driven the buy decision is (0=pure spec/function,
  // 1=pure 代入感/decor/gift). Reviewer may set listing_leverage_score directly; else default.
  const leverageRaw = findFirstRate(text, ['listing_leverage_score', 'ListingLeverageScore', 'listing_leverage', 'ListingLeverage'], null);
  const listingLeverage = leverageRaw !== null ? clamp01(leverageRaw) : clamp01(cfg.listing_leverage_default);

  // Each pillar normalized to [0,1].
  const demandPillar = clamp01(0.45 * (clampNumber(demandScore) / 100) +
    0.30 * (clampNumber(growthScore) / 100) +
    0.25 * (clampNumber(marketEntryScore) / 100));
  // Competition headroom: lower severity -> more room. Geometric so a brutal market hurts.
  const competitionPillar = clamp01(1 - (competitionSeverity / 10) * 0.85);
  // Profit pillar from the (already sanitized) ad-economics multiplier, mapped to [0,1].
  const profitPillar = estimatedUnitContribution <= 0 ? cfg.pillar_floor : clamp01(mProfitEffective / 1.2);
  // Differentiation pillar gets the seller's listing-leverage boost.
  const diffBase = clampNumber(differentiationScore) / 100;
  const differentiationPillar = applyListingLeverage(diffBase, listingLeverage, cfg);
  const executionPillar = clamp01(executionFitScore / 100);

  // Compliance is a soft de-rate in the non-gate range (>=9 handled by hard gate).
  const compliancePillarMult = clamp01(Math.max(cfg.compliance_mult_floor, 1 - (complianceRisk / 10) * 0.6));

  const pillars = [
    { key: 'demand', value: demandPillar, weight: cfg.w_demand, trust: cfg.trust_demand },
    { key: 'competition', value: competitionPillar, weight: cfg.w_competition, trust: cfg.trust_competition },
    { key: 'profit', value: profitPillar, weight: cfg.w_profit, trust: cfg.trust_profit },
    { key: 'differentiation', value: differentiationPillar, weight: cfg.w_differentiation, trust: cfg.trust_differentiation },
    { key: 'execution', value: executionPillar, weight: cfg.w_execution, trust: cfg.trust_execution }
  ];

  const opportunityCore = weightedGeometricMean(pillars, cfg.pillar_floor) * compliancePillarMult;

  // Overall trust blends per-pillar input trust with measured data reliability and any
  // distortion penalty, then sets the width of the decision uncertainty band.
  const pillarTrust = pillars.reduce((acc, p) => acc + p.weight * p.trust, 0) /
    pillars.reduce((acc, p) => acc + p.weight, 0);
  const reliabilityTrust = clamp01(dataReliabilityScore / 100);
  const distortionPenalty = dataDistortionSuspected ? 0.85 : 1.0;
  const overallTrust = clamp01(0.5 * pillarTrust + 0.5 * reliabilityTrust) * distortionPenalty;

  const pointEstimate = clampNumber(100 * opportunityCore);
  const uncertaintyBand = cfg.uncertainty_min + (cfg.uncertainty_max - cfg.uncertainty_min) * (1 - overallTrust);
  const optimisticScore = clampNumber(pointEstimate + uncertaintyBand);
  const pessimisticScore = clampNumber(pointEstimate - uncertaintyBand);

  const finalScore = hardGateTriggered ? 0 : pointEstimate;
  const totalScore = Math.round(finalScore);

  return {
    scoringVersion: 'v3',
    baseScore: potentialScore,
    potentialScore,
    // v3 interval decision fields
    pointEstimate: Math.round(pointEstimate),
    optimisticScore: Math.round(optimisticScore),
    pessimisticScore: Math.round(pessimisticScore),
    uncertaintyBand: Number(uncertaintyBand.toFixed(1)),
    overallTrust: Number(overallTrust.toFixed(3)),
    listingLeverage: Number(listingLeverage.toFixed(3)),
    pillars: pillars.map(p => ({ key: p.key, value: Number(p.value.toFixed(3)), weight: p.weight })),
    opportunityScore: Math.round(opportunityScore),
    dataReliabilityScore: Math.round(dataReliabilityScore),
    executionFitScore: Math.round(executionFitScore),
    finalScore: totalScore,
    totalScore,
    confidenceLevel: confidence.level,
    hardGateTriggered,
    adStressTestFailed,
    dataDistortionSuspected,
    distortionSignals,
    mProfit,
    mProfitEffective,
    mCompetition,
    mCompliance,
    mComplexity: mExecutionFit,
    mConfidence: confidence.multiplier,
    mExecutionFit,
    margin: estimatedUnitContribution,
    cpa: baseCpa,
    ratio: baseAdRatio,
    sellingPrice,
    bomCost,
    shippingCost,
    fbaFee,
    referralFee,
    packagingCost,
    returnReserve,
    couponCost,
    storageReserve,
    estimatedUnitContribution,
    estimatedUnitContributionRate,
    rawCvr,
    baseCvr,
    stressCvr,
    rawPpcBid: rawPpcBid || 0,
    usedPpc,
    stressPpc,
    baseCpa,
    stressCpa,
    paidTrafficRatio,
    blendedBaseCpa,
    blendedStressCpa,
    estimatedAcos,
    breakEvenAcos,
    baseAdRatio,
    stressAdRatio,
    missingCriticalFields: [...missingCriticalFields],
    warnings
  };
}

function decideBackendAction(originalAction, scoreResults, content = '', reselectCount = 0, forceDecision = false) {
  let action = normalizeForgeAction(originalAction || '');
  if (forceDecision && (action === 'LOOPBACK_TO_HAWKEYE' || action === 'LOOPBACK_TO_SCOUT')) {
    console.warn(`[AutoProductSelection decideBackendAction] 检查到 forceDecisionMode 激活但 Reviewer 仍请求 LOOPBACK，后端越权覆盖为 PUBLISH_FINAL。`);
    action = 'PUBLISH_FINAL';
  }
  if (action !== 'PUBLISH_FINAL') return action;
  const verdict = extractFinalVerdict(content);
  // A real hard gate (negative contribution, compliance red line, etc.) always
  // force-drops regardless of data quality or reselect budget.
  if (scoreResults.hardGateTriggered) return 'DROP_AND_RESELECT';

  // Cross-direction reselect budget guard. Once we have already hopped directions
  // MAX_RESELECT_PER_TRIGGER times this trigger, never DROP again — converge to a
  // terminal publishable verdict so the round can self-terminate. This is the hard
  // backstop against the infinite "drop -> new direction -> drop" loop.
  const budgetExhausted = (reselectCount || 0) >= MAX_RESELECT_PER_TRIGGER;
  const toTerminalPublish = () => 'PUBLISH_FINAL';

  // Data-distortion safety net: when the score is low only because the inputs
  // look distorted (not because economics are provably bad), do NOT force-drop
  // a possibly-good niche direction.
  if (scoreResults.dataDistortionSuspected) {
    if (verdict === 'RECOMMEND') {
      // Don't publish a RECOMMEND built on distorted figures; try clean data once,
      // unless the reselect budget is spent (then just publish the cautious result).
      return budgetExhausted ? toTerminalPublish() : 'LOOPBACK_TO_HAWKEYE';
    }
    if (['WATCHLIST', 'RESEARCH_GAP', 'DATA_INSUFFICIENT', 'REJECT'].includes(verdict)) {
      return action;
    }
    // No clear verdict + distortion: re-fetch once rather than drop (budget permitting).
    return budgetExhausted ? toTerminalPublish() : 'LOOPBACK_TO_HAWKEYE';
  }

  // --- v3 interval decision -------------------------------------------------
  // Decide on the CONFIDENCE INTERVAL [pessimistic, optimistic], not a point score.
  // This is the structural fix for "熔炉打回太多 + 触顶强出一个产品":
  //   - Drop only when even the OPTIMISTIC estimate fails (optimistic < drop_ceiling).
  //     A merely-uncertain direction is never silently discarded.
  //   - Publish as-is (reviewer's verdict stands) when the PESSIMISTIC estimate already
  //     clears the recommend floor (genuinely strong, robust to the uncertainty band).
  //   - Everything in between is published as a cautious WATCHLIST for human validation,
  //     which is exactly the "可初步作为商业决策" artifact the seller wants.
  const cfg = SCORING_CONFIG;
  const optimistic = Number.isFinite(scoreResults.optimisticScore) ? scoreResults.optimisticScore : scoreResults.totalScore;
  const pessimistic = Number.isFinite(scoreResults.pessimisticScore) ? scoreResults.pessimisticScore : scoreResults.totalScore;

  if (optimistic < cfg.drop_ceiling) {
    // Even the optimistic case is weak. If the reviewer already chose a cautious
    // terminal verdict, honor it; otherwise drop within budget, else converge to publish.
    if (['WATCHLIST', 'RESEARCH_GAP', 'DATA_INSUFFICIENT'].includes(verdict)) return action;
    return budgetExhausted ? toTerminalPublish() : 'DROP_AND_RESELECT';
  }
  if (pessimistic >= cfg.recommend_floor) return action; // robustly strong: reviewer's verdict stands
  return 'PUBLISH_FINAL'; // mid/uncertain band: surface for human validation, never drop
}

function yamlString(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function updateScoredContentWithMath(content, scoreResults, action, originalAction) {
  const text = String(content || '');
  const frontMatterMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const originalFrontMatter = frontMatterMatch ? frontMatterMatch[1] : '';
  const body = frontMatterMatch ? text.slice(frontMatterMatch[0].length) : `\n${text}`;

  const lines = originalFrontMatter.split('\n');
  const cleanLines = [];
  let skipMode = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(action|total_score|backend_math_validation|backend_math_validation_v2|warnings)\s*:/i.test(line)) {
      skipMode = true;
      continue;
    }
    if (skipMode && line.length > 0 && !/^\s/.test(line)) {
      skipMode = false;
    }
    if (!skipMode && line.trim()) {
      cleanLines.push(line);
    }
  }
  const cleanFrontMatter = cleanLines.join('\n').trim();

  const block = [
    `action: ${action}`,
    originalAction && originalAction !== action ? `original_action: ${originalAction}` : '',
    `total_score: ${scoreResults.totalScore}`,
    `backend_math_validation:`,
    `  scoring_version: ${scoreResults.scoringVersion}`,
    `  total_score: ${scoreResults.totalScore}`,
    `  final_score: ${scoreResults.finalScore}`,
    `backend_math_validation_v2:`,
    `  opportunity_score: ${scoreResults.opportunityScore}`,
    `  data_reliability_score: ${scoreResults.dataReliabilityScore}`,
    `  execution_fit_score: ${scoreResults.executionFitScore}`,
    `  final_score: ${scoreResults.finalScore}`,
    `  confidence_level: ${scoreResults.confidenceLevel}`,
    `  hard_gate_triggered: ${scoreResults.hardGateTriggered}`,
    `  ad_stress_test_failed: ${scoreResults.adStressTestFailed}`,
    `  data_distortion_suspected: ${scoreResults.dataDistortionSuspected === true}`,
    ...(scoreResults.distortionSignals && scoreResults.distortionSignals.length
      ? ['  distortion_signals:', ...scoreResults.distortionSignals.map(s => `    - "${yamlString(s)}"`)]
      : []),
    ...(scoreResults.scoringVersion === 'v3'
      ? [
        `  v3_interval_decision:`,
        `    point_estimate: ${scoreResults.pointEstimate}`,
        `    optimistic_score: ${scoreResults.optimisticScore}`,
        `    pessimistic_score: ${scoreResults.pessimisticScore}`,
        `    uncertainty_band: ${scoreResults.uncertaintyBand}`,
        `    overall_trust: ${scoreResults.overallTrust}`,
        `    listing_leverage: ${scoreResults.listingLeverage}`,
        `  v3_pillars:`,
        ...(scoreResults.pillars || []).map(p => `    ${p.key}: ${p.value} (w=${p.weight})`)
      ]
      : []),
    `  multipliers:`,
    `    profit: ${scoreResults.mProfit.toFixed(3)}`,
    `    profit_effective: ${scoreResults.mProfitEffective.toFixed(3)}`,
    `    competition: ${scoreResults.mCompetition.toFixed(3)}`,
    `    compliance: ${scoreResults.mCompliance.toFixed(3)}`,
    `    confidence: ${scoreResults.mConfidence.toFixed(3)}`,
    `    execution_fit: ${scoreResults.mExecutionFit.toFixed(3)}`,
    `  financials:`,
    `    selling_price: ${scoreResults.sellingPrice.toFixed(2)}`,
    `    bom_cost: ${scoreResults.bomCost.toFixed(2)}`,
    `    shipping_cost: ${scoreResults.shippingCost.toFixed(2)}`,
    `    fba_fee: ${scoreResults.fbaFee.toFixed(2)}`,
    `    referral_fee: ${scoreResults.referralFee.toFixed(2)}`,
    `    estimated_unit_contribution: ${scoreResults.estimatedUnitContribution.toFixed(2)}`,
    `    estimated_unit_contribution_rate: ${scoreResults.estimatedUnitContributionRate.toFixed(4)}`,
    `    raw_click_conversion_rate: ${scoreResults.rawCvr.toFixed(4)}`,
    `    base_cvr: ${scoreResults.baseCvr.toFixed(4)}`,
    `    stress_cvr: ${scoreResults.stressCvr.toFixed(4)}`,
    `    raw_ppc_bid: ${scoreResults.rawPpcBid.toFixed(2)}`,
    `    used_ppc: ${scoreResults.usedPpc.toFixed(2)}`,
    `    stress_ppc: ${scoreResults.stressPpc.toFixed(2)}`,
    `    base_cpa: ${scoreResults.baseCpa.toFixed(2)}`,
    `    stress_cpa: ${scoreResults.stressCpa.toFixed(2)}`,
    `    paid_traffic_ratio: ${scoreResults.paidTrafficRatio.toFixed(2)}`,
    `    blended_base_cpa: ${scoreResults.blendedBaseCpa.toFixed(2)}`,
    `    blended_stress_cpa: ${scoreResults.blendedStressCpa.toFixed(2)}`,
    `    estimated_acos: ${scoreResults.estimatedAcos.toFixed(4)}`,
    `    break_even_acos: ${scoreResults.breakEvenAcos.toFixed(4)}`,
    `    base_ad_ratio: ${Number.isFinite(scoreResults.baseAdRatio) ? scoreResults.baseAdRatio.toFixed(4) : 'Infinity'}`,
    `    stress_ad_ratio: ${Number.isFinite(scoreResults.stressAdRatio) ? scoreResults.stressAdRatio.toFixed(4) : 'Infinity'}`,
    `  missing_critical_fields:`,
    ...(scoreResults.missingCriticalFields.length
      ? scoreResults.missingCriticalFields.map(field => `    - ${field}`)
      : ['    - none']),
    `warnings:`,
    ...(scoreResults.warnings.length
      ? scoreResults.warnings.map(w => `    - "${yamlString(w)}"`)
      : ['    - "none"'])
  ].filter(Boolean);

  const updatedFrontMatter = [cleanFrontMatter, ...block].filter(Boolean).join('\n');
  return `---\n${updatedFrontMatter}\n---${body}`;
}

async function saveDebugModeToConfig(enable) {
  const configEnvPath = path.join(__dirname, 'config.env');
  try {
    const fsSync = require('fs');
    let lines = [];
    if (fsSync.existsSync(configEnvPath)) {
      const content = fsSync.readFileSync(configEnvPath, 'utf8');
      lines = content.split('\n');
    }
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('DebugMode=')) {
        lines[i] = `DebugMode=${enable}`;
        found = true;
        break;
      }
    }
    if (!found) {
      lines.push(`DebugMode=${enable}`);
    }
    fsSync.writeFileSync(configEnvPath, lines.join('\n').trim() + '\n', 'utf8');
    logWorkflowEvent(`调试模式 (DebugMode) 已持久化写入 config.env 并设为 ${enable}`);
  } catch (error) {
    console.error('[AutoProductSelection] Failed to save DebugMode to config.env:', error.message);
    logWorkflowEvent(`持久化写入 config.env 失败: ${error.message}`, true);
  }
}

async function autoSelectionToggleDebug(args = {}) {
  const enable = parseBoolean(args.enable ?? args.debugMode ?? args.debug_mode, !debugMode);
  debugMode = enable;
  const message = `已将调试模式 (debugMode) 设置为: ${debugMode ? '启用 (true)' : '禁用 (false)'}。`;
  logWorkflowEvent(`调试模式切换为: ${debugMode}`);
  await saveDebugModeToConfig(enable);
  return {
    success: true,
    command: 'auto_selection_toggle_debug',
    debugMode,
    message
  };
}

async function autoSelectionPauseWorkflow(args = {}) {
  logWorkflowEvent('手动暂停选品工作流 (User manually paused the workflow).');
  await stopWorkflowDriver();
  return {
    success: true,
    command: 'auto_selection_pause_workflow',
    message: '工作流已成功暂停。所有中间运行文件均已保留，下次调用 auto_selection_trigger_run 将自动恢复推进。'
  };
}

async function autoSelectionAbortWorkflow(args = {}) {
  logWorkflowEvent('手动中止并重置选品工作流 (User manually aborted and reset the workflow).');
  await stopWorkflowDriver();

  // Delete every run's state file + its handoff residue. The state files are the authoritative
  // list of runs, so we drive cleanup off them.
  const states = await listRunStates();
  const runIds = states.map(s => s.run_id);
  for (const runId of runIds) {
    await cleanupAutoSelectionRunResidue(runId).catch(() => { });
    await fs.unlink(stateFilePath(runId)).catch(() => { });
  }
  // Sweep any stray dropped staging too.
  try {
    const dropped = await fs.readdir(AUTO_SELECTION_DROPPED_DIR);
    for (const name of dropped) {
      if (name === '.gitkeep') continue;
      await fs.unlink(path.join(AUTO_SELECTION_DROPPED_DIR, name)).catch(() => { });
    }
  } catch (_) { }

  logWorkflowEvent(`工作流已成功重置，清除了 ${runIds.length} 个 run 的 state 与残留文件。`);
  return {
    success: true,
    command: 'auto_selection_abort_workflow',
    message: '工作流已中止，且已清除全部选品状态机文件。下一次触发自动任务时将全新开始。',
    cleaned_runs: runIds
  };
}

async function shutdown() {
  await stopWorkflowDriver();
  debugLog('Plugin shutdown.');
}

module.exports = {
  initialize,
  processToolCall,
  shutdown,
  decideBackendAction,
  calculateScoringModel,
  extractRejectedKeywords,
  extractDeferredCandidates,
  autoSelectionToggleDebug,
  autoSelectionPauseWorkflow,
  autoSelectionAbortWorkflow,
  // Exposed for tests only:
  __test__: { workflowDriver, sweepTimeouts, readRunState, writeRunState, freshRunState, advanceRun }
};
