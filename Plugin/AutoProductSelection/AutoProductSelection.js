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

function parsePrefixList(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function configureAutoSelectionRuntime(config = {}) {
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
 * Scan the dropped staging area and summarize each eliminated direction. Reads the
 * scored file when present (richest), else raw, else brief. Extracts product_direction,
 * final verdict and total_score so the coordinator can publish/diary them in one pass.
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
    summaries.push({ run_id: runId, source_stage: stage, direction, verdict, total_score: totalScore, reason });
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
    return `- 选品 ID: ${item.run_id} | 方向: ${item.direction || '(未标注)'}${scorePart} | 结果: ${item.verdict}${reasonPart}`;
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
    '- 日记只写一条（本轮合并）：在本轮主结论日记里追加一个「本轮淘汰清单」段落，逐条列出被淘汰方向与核心原因，不要为每个淘汰方向单独写多条日记。',
    '- 该条合并日记的 Tag 行必须放在 Content 最后一行，标签需同时覆盖主结论与淘汰（至少含 `#排除`）。',
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
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === '.gitkeep' || entry.name === 'README.md') continue;
    const fromPath = path.join(AUTO_SELECTION_DROPPED_DIR, entry.name);
    const toPath = path.join(archivedDir, `dropped-${entry.name}`);
    try {
      await fs.rm(toPath, { force: true });
      await fs.rename(fromPath, toPath);
      archived.push(toPath);
    } catch (err) {
      console.error(`[AutoProductSelection] Failed to archive dropped file ${entry.name}:`, err.message);
    }
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
  return 'create_brief_and_send_scout';
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
      const writeReselectCount = Math.max(parseLoopbackCounters(content).reselect_count || 0, reselectCountThisTrigger || 0);
      const action = decideBackendAction(originalAction, scoreResults, content, writeReselectCount);
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

function buildAutoSelectionWorkerPrompt(worker, runId, options = {}) {
  const safeRunId = normalizeAutoSelectionRunId(runId);
  const callRhythmInstruction = '调用节奏：每一轮回复最多只发送 1 个 TOOL_REQUEST；等待工具摘要返回后，再基于结果决定下一步，不要在同一轮连续发多个工具块。';
  const counterInstruction = '【重要】如果你读取的 brief 或 raw 文件中包含回退计数器（global_loopback_count、scout_loopback_count、reviewer_loopback_count），你必须将这些计数器原样复制到你输出的文件中。这些计数器用于防止死循环，绝对不能丢失。';
  const memoryGuidance = '【记忆运用】你可以检索《选品公共日记本》学习历史经验。关注 #选中 案例的成功模式，避免 #排除 案例的失败路径。429/500、账号、验证码、页面阻断等系统级错误立即停止，标记阻断原因。';
  const lockCleanupInstruction = `【任务完成标记】成功写入输出文件（raw/failed 或 scored/failed）后，必须在最终回复的末尾输出完成标记 [[TaskComplete]]。不要在未成功写出文件前输出此标记。`;
  const extraInstruction = String(options.extra_instruction || options.extraInstruction || '').trim();
  const forceDecisionMode = options.force_decision_mode === true || options.forceDecisionMode === true;

  if (worker === 'hawkeye') {
    return `你是破壁_鹰眼（ProductSelectionScout），数据侦察专家。请执行一次自动选品取证任务。

run_id: ${safeRunId}
brief_stage: brief
success_stage: raw
failure_stage: failed

${callRhythmInstruction}

## 你的任务
读取 brief 并基于其指示抓取数据。如果是回环补采，请保留旧数据合并写回 raw。

## 硬性约束
- ProductSelector 数据命令最多 6 次
- 遇到 429/500、账号错误、验证码、页面阻断等系统级错误立即停止，写 failed 或 partial raw，绝不循环重试
- 普通冷门长尾词空结果不是失败结论：允许同义词/父词重试 1 次；同类数据连续 2 次为空后写入 unfetchable_gaps
- 不要死板遵循固定流程，灵活 Pivot（关键词、价格带、市场），但回环补采只能补 reviewer 指定字段

## 数据采集原则
1. **Level 1 方向体检**: 优先抓关键词选品、关键词转化率、产品/竞品基础表。判断需求、购买、PPC、CVR、价格带、评论门槛、FBA占比、头部集中度。
2. **Level 2 候选验证**: 只有方向有潜力时，再做关键词反查、Amazon 商品页、Amazon 评论。
3. **Level 3 回环补采**: 只补 brief/loopback_request 指定的 tool、keyword、asin、field；保留旧 raw，合并写回，overwrite=true。
4. **证据最小化**: raw 输出聚合摘要、样本统计、异常说明和 source_map，不塞长评论原文或超长关键词表。
5. **果断早停**: 如果低客单价高 PPC、需求低供给高、Review/ABA 高集中、FBA/price>25%、红线品类或广告明显倒挂，允许 EARLY_REJECT。

${memoryGuidance}

${counterInstruction}

## 交付要求
成功或部分成功时写 raw_data_pack 到 raw；工具阻断或完全无数据写 failed。必须在 YAML 中包含：
- route_decision (EARLY_REJECT | PIVOT | DEEPEN | READY_FOR_FORGE)
- data_audit_inputs.tools_called / sample_counts / unfetchable_gaps / outlier_notes
- keyword_market_summary / competitor_summary / profitability_raw_estimates / review_insight_summary
- source_map / evidence_matrix / elimination_log
- conversion_rate_matrix 与 candidate_products 旧字段仍要保留，方便兼容旧报告读取
- 每个候选 ASIN 必须带 Amazon URL、售价、月销量或销量口径、review_count、rating、FBA费用或缺失说明

${lockCleanupInstruction}

不要调用评审节点，不发论坛，不写 DailyNote。`;
  }

  if (worker === 'forge') {
    return `你是破壁_熔炉（ProductSelectionReviewer），市场评审专家。请执行一次自动选品证据评审任务。

run_id: ${safeRunId}
raw_stage: raw
success_stage: scored
failure_stage: failed

${callRhythmInstruction}

## 你的任务
读取 raw，审计取证节点交付的证据，输出 scored_candidate_pack。
${forceDecisionMode ? '\n【force_decision_mode】后端已阻止继续回环。本次必须基于现有证据输出终态裁决：RECOMMEND、WATCHLIST、REJECT 或 DATA_INSUFFICIENT；post_forge_action.action 不得再写 LOOPBACK_TO_SCOUT。' : ''}
${extraInstruction ? `\n【后端补充指令】\n${extraInstruction}` : ''}

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

空数据不是自动失败。如果 Scout 已把字段写入 unfetchable_gaps，你不得因同一字段继续 LOOPBACK，只能降低 DataReliabilityScore 并裁决。

## 输出要求
必须包含：
- analysis_status (SUCCESS | PARTIAL | DATA_CORRUPTED)
- final_disposition (verdict: RECOMMEND | WATCHLIST | RESEARCH_GAP | REJECT | DATA_INSUFFICIENT)
- post_forge_action (action: PUBLISH_FINAL | LOOPBACK_TO_SCOUT | DROP_AND_RESELECT)
- loopback_request（如回环，必须指定 missing_field/requested_tool/target_keywords/target_asins/required_fields/max_additional_tool_calls/stop_after_this_loop）
- hard_gates / scores / score_inputs / multipliers / financial_factors / data_reliability_audit
- business_analysis / product_optimization_directions / key_risks / kill_criteria / next_validation_steps / elimination_summary
- 旧字段 demand_volume、differentiation_feasibility、competition_severity、compliance_risk、complexity_severity、data_confidence、financial_factors.click_conversion_rate、financial_factors.ppc_bid 仍要保留

${lockCleanupInstruction}`;
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
      prompt: buildAutoSelectionWorkerPrompt(worker, runId, {
        force_decision_mode: forceDecisionMode,
        extra_instruction: extraInstruction
      }),
      temporary_contact: true,
      task_delegation: true,
      inject_tools: worker === 'hawkeye' ? 'AutoProductSelection,ProductSelector' : 'AutoProductSelection'
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
  const action = decideBackendAction(originalAction, scoreResults, scoredContent, effectiveReselectCount);

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
      return {
        success: true,
        command: commandName,
        run_id: runId,
        action: 'FORCE_DECISION_REVIEW',
        original_action: action,
        state_transition: 'loopback_denied_force_review_prepared',
        denied_loopback_reason: loopbackGuard.reason,
        loopback_request: loopbackGuard.request,
        removed_scored: removedScored.removed,
        lock_cleanup: lockCleanup.removed || [],
        agent_assistant_request: dispatch.agent_assistant_request,
        next_actions: [
          'Call AgentAssistant with agent_assistant_request.',
          'Do not post forum or write DailyNote before the force-decision scored file is written.'
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
    return {
      success: true,
      command: commandName,
      run_id: runId,
      action,
      state_transition: 'scored_deleted_raw_preserved_scout_redispatch_prepared',
      removed_scored: removedScored.removed,
      lock_cleanup: lockCleanup.removed || [],
      loopback_counters: newCounters,
      agent_assistant_request: dispatch.agent_assistant_request,
      next_actions: [
        'Call AgentAssistant with agent_assistant_request.',
        'Do not post forum or write DailyNote for a loopback.',
        'After AgentAssistant succeeds, output [[NextHeartbeat::120]].'
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
  // Check if workflow is already running
  if (isWorkflowRunning) {
    return {
      success: false,
      command: 'auto_selection_trigger_run',
      error: 'workflow_already_running',
      message: '工作流已在运行中。后端驱动器正在自动推进，你（破壁_枢纽）当前无需采取任何行动，请直接输出 [[TaskComplete]] 结束本次调度。',
      next_actions: [
        'Do not create a new brief.',
        'Do not dispatch any worker.',
        'Output [[TaskComplete]] immediately to end this activation.'
      ]
    };
  }

  // Check queue status
  const queue = await autoSelectionQueueStatus({ include_content: false });
  if (!queue.success) {
    return {
      success: false,
      command: 'auto_selection_trigger_run',
      error: 'queue_status_failed',
      message: '无法获取队列状态。'
    };
  }

  // New trigger lifecycle: reset the cross-direction reselect budget and loop guards.
  reselectCountThisTrigger = 0;
  createBriefCountThisTrigger = 0;
  failedDelegationAttempts.clear();
  scoredDelegationAttempts.clear();

  // Calculate active runs (locks + briefs + raw + scored)
  const activeRuns = (queue.derived?.valid_locks?.length || 0) +
    (queue.derived?.active_briefs?.length || 0) +
    (queue.stages?.raw?.length || 0) +
    (queue.stages?.scored?.length || 0);

  // Recovery strategy configuration
  const recoveryMode = args.recovery_mode || args.recoveryMode || 'auto';
  // 'auto' (default): auto-resume existing tasks
  // 'clear_and_new': clear all pending and start fresh
  // 'oldest_first': process oldest task first, clean others

  if (activeRuns > 0) {
    // Unfinished tasks detected - apply recovery strategy
    if (recoveryMode === 'clear_and_new') {
      // Clear all pending tasks and start fresh
      console.log(`[AutoProductSelection] Recovery mode: clear_and_new. Clearing ${activeRuns} pending tasks.`);

      const runIds = new Set();
      queue.derived?.active_briefs?.forEach(f => runIds.add(f.run_id));
      queue.stages?.raw?.forEach(f => runIds.add(f.run_id));
      queue.stages?.scored?.forEach(f => runIds.add(f.run_id));
      queue.derived?.valid_locks?.forEach(f => runIds.add(f.run_id));

      for (const runId of runIds) {
        await autoSelectionCleanupRun({ run_id: runId });
      }

      // Start new workflow
      console.log('[AutoProductSelection] Starting new workflow after cleanup...');
      isWorkflowRunning = true;
      workflowState = 'INIT';
      startWorkflowDriver();

      return {
        success: true,
        command: 'auto_selection_trigger_run',
        mode: 'new',
        recovery_mode: 'clear_and_new',
        cleared_tasks: activeRuns,
        message: `已清理 ${activeRuns} 个未完成任务，准备启动新任务。`
      };

    } else if (recoveryMode === 'oldest_first' && activeRuns > 1) {
      // Multiple tasks: process oldest first, clean others
      console.log(`[AutoProductSelection] Recovery mode: oldest_first. Processing oldest, cleaning ${activeRuns - 1} others.`);

      const allTasks = [
        ...(queue.derived?.active_briefs || []),
        ...(queue.stages?.raw || []),
        ...(queue.stages?.scored || [])
      ];

      if (allTasks.length > 0) {
        allTasks.sort((a, b) => String(a.modified_at || '').localeCompare(String(b.modified_at || '')));
        const oldestRunId = allTasks[0].run_id;

        // Clean up all except oldest
        for (const task of allTasks) {
          if (task.run_id !== oldestRunId) {
            await autoSelectionCleanupRun({ run_id: task.run_id });
          }
        }

        // Also clean locks for non-oldest tasks
        const allLocks = queue.derived?.valid_locks || [];
        for (const lock of allLocks) {
          if (lock.run_id !== oldestRunId) {
            await autoSelectionClearLocks({ run_id: lock.run_id });
          }
        }

        console.log(`[AutoProductSelection] Resuming oldest task: ${oldestRunId}`);
        isWorkflowRunning = true;
        workflowState = 'ACTIVE';
        startWorkflowDriver();

        return {
          success: true,
          command: 'auto_selection_trigger_run',
          mode: 'resume',
          recovery_mode: 'oldest_first',
          active_runs: 1,
          cleared_tasks: activeRuns - 1,
          oldest_run_id: oldestRunId,
          message: `已清理 ${activeRuns - 1} 个任务，恢复处理最早的任务: ${oldestRunId}。`
        };
      }
    }

    // Default: resume mode (process all existing tasks)
    console.log(`[AutoProductSelection] Resuming ${activeRuns} existing task(s)...`);

    let warningMessage = '';
    if (activeRuns > 1) {
      warningMessage = ` 注意：检测到多个任务，将按队列顺序依次处理。如需清理请使用 recovery_mode='clear_and_new' 或 'oldest_first'。`;
    }

    isWorkflowRunning = true;
    workflowState = 'ACTIVE';
    startWorkflowDriver();

    return {
      success: true,
      command: 'auto_selection_trigger_run',
      mode: 'resume',
      recovery_mode: 'auto',
      active_runs: activeRuns,
      message: `工作流已启动，接管 ${activeRuns} 个未完成任务。${warningMessage}`
    };
  }

  // Start new workflow
  console.log('[AutoProductSelection] Starting new workflow...');
  isWorkflowRunning = true;
  workflowState = 'INIT';  // Mark as initiated
  startWorkflowDriver();

  return {
    success: true,
    command: 'auto_selection_trigger_run',
    mode: 'new',
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
      case 'auto_selection_queue_status':
        return await autoSelectionQueueStatus(args);
      case 'auto_selection_write_run_file':
        return await autoSelectionWriteRunFile(args);
      case 'auto_selection_read_run_file':
        return await autoSelectionReadRunFile(args);
      case 'auto_selection_prepare_dispatch': {
        const result = await autoSelectionPrepareDispatch(args);
        if (result && result.success !== false) {
          await removeCoordinatorLock();
        }
        return result;
      }
      case 'auto_selection_apply_forge_decision':
      case 'auto_selection_apply_reviewer_decision':
        return await autoSelectionApplyForgeDecision(args, command);
      case 'auto_selection_archive_run': {
        const result = await autoSelectionArchiveRun(args);
        if (result && result.success !== false) {
          await removeCoordinatorLock();
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
const MAX_RESELECT_PER_TRIGGER = 4;   // 单次 trigger 闭环内最多重选方向次数；达到后强制收尾休眠
let reselectCountThisTrigger = 0;     // 当前 trigger 生命周期内已累计的跨方向重选次数

// --- Workflow Driver Tick Interval ---
// 60s 偏短：AgentAssistant 委托是异步的，单个 worker 通常要数分钟，60s tick 大量空转。
// 但在测试/开发调试期间，180s 偏慢，调小为 30s 以加快 manual 响应和状态机流转。
const WORKFLOW_TICK_INTERVAL_MS = 30 * 1000;

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
 * Check and manage coordinator lock to prevent duplicate delegations
 */
async function checkCoordinatorLock() {
  const lockPath = path.join(AUTO_SELECTION_RUNS_DIR, 'locks', 'coordinator.lock');
  try {
    await fs.access(lockPath);
    return true; // Lock exists
  } catch {
    return false; // Lock doesn't exist
  }
}

async function createCoordinatorLock(reason = 'delegation') {
  const lockPath = path.join(AUTO_SELECTION_RUNS_DIR, 'locks', 'coordinator.lock');
  const content = [
    `lock_type: coordinator`,
    `created_at: ${nowIso()}`,
    `reason: ${reason}`
  ].join('\n') + '\n';
  await fs.writeFile(lockPath, content, 'utf8');
  debugLog('Coordinator lock created.');
}

async function removeCoordinatorLock() {
  const lockPath = path.join(AUTO_SELECTION_RUNS_DIR, 'locks', 'coordinator.lock');
  try {
    await fs.unlink(lockPath);
    debugLog('Coordinator lock removed.');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[AutoProductSelection] Failed to remove coordinator lock:', error);
    }
  }
}

/**
 * Check if there's an active coordinator task (破壁_枢纽)
 */
async function checkActiveCoordinatorTask() {
  try {
    const entries = await fs.readdir(AGENT_TASK_DIR, { withFileTypes: true });
    const coordinatorFiles = entries.filter(entry =>
      entry.isFile() &&
      entry.name.startsWith('破壁_枢纽_') &&
      entry.name.endsWith('.md')
    );

    for (const entry of coordinatorFiles) {
      const fullPath = path.join(AGENT_TASK_DIR, entry.name);
      const stat = await fs.stat(fullPath);
      const fileAge = (Date.now() - stat.mtimeMs) / 1000 / 60;

      // 只检查最近15分钟内的文件，避免网络请求过慢被跳过
      if (fileAge > 15) continue;

      const content = await fs.readFile(fullPath, 'utf8');

      // 检查是否包含自动选品相关内容且未完成
      if (content.includes('AutoProductSelection') || content.includes('auto_selection_')) {
        // 如果任务状态是 Succeed 或 Failed，认为已完成
        if (content.includes('任务状态:** Succeed') || content.includes('任务状态:** Failed')) {
          continue;
        }

        // 如果文件在10分钟内被修改，认为任务仍在活跃（适配慢网络/慢API及大模型长耗时）
        if (fileAge < 10) {
          return true;
        }
      }
    }

    return false;
  } catch (error) {
    debugLog(`Failed to check active coordinator task: ${error.message}`);
    return false; // 检查失败时假设无活跃任务
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

  return {
    global_loopback_count: globalMatch ? parseInt(globalMatch[1], 10) : 0,
    scout_loopback_count: scoutMatch ? parseInt(scoutMatch[1], 10) : 0,
    reviewer_loopback_count: reviewerMatch ? parseInt(reviewerMatch[1], 10) : 0,
    // Cross-direction reselect budget, persisted so it survives DROP_AND_RESELECT
    // (which changes run_id + resets loopback counters) and process restarts.
    reselect_count: reselectMatch ? parseInt(reselectMatch[1], 10) : 0
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

  // Build counter metadata block
  const counterBlock = [
    '<!-- Loopback Circuit Breaker Counters -->',
    `global_loopback_count: ${global}`,
    `scout_loopback_count: ${scout}`,
    `reviewer_loopback_count: ${reviewer}`,
    `reselect_count: ${reselect}`,
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
 * Main workflow driver that autonomously pushes the state machine forward.
 * Called on the WORKFLOW_TICK_INTERVAL_MS timer.
 */
async function workflowDriver() {
  try {
    debugLog('Workflow driver tick started.');

    // Check coordinator lock first
    const hasCoordinatorLock = await checkCoordinatorLock();
    if (hasCoordinatorLock) {
      const lockPath = path.join(AUTO_SELECTION_RUNS_DIR, 'locks', 'coordinator.lock');
      try {
        const stat = await fs.stat(lockPath);
        const lockAge = (Date.now() - stat.mtimeMs) / 1000 / 60; // minutes

        // Check if there's an active coordinator task
        const hasActiveTask = await checkActiveCoordinatorTask();

        if (!hasActiveTask && lockAge > 10) {
          // No active coordinator task and lock is older than 10 minutes - orphaned lock
          console.warn(`[AutoProductSelection WorkflowDriver] Coordinator lock orphaned (${Math.floor(lockAge)} minutes, no active task). Removing it.`);
          await removeCoordinatorLock();
        } else if (lockAge > 25) {
          // Force cleanup after 25 minutes (increased from 15 to accommodate slow runs)
          console.warn(`[AutoProductSelection WorkflowDriver] Coordinator lock is stale (${Math.floor(lockAge)} minutes old). Removing it.`);
          await removeCoordinatorLock();
        } else {
          debugLog(`Coordinator lock exists (${Math.floor(lockAge)} minutes old) - waiting for delegation to complete.`);
          consecutiveErrorCount = 0; // Reset error count on normal wait
          return;
        }
      } catch (error) {
        // Lock file doesn't exist anymore, continue
        debugLog('Coordinator lock check failed, continuing.');
      }
    }

    const queue = await autoSelectionQueueStatus({ include_content: true });

    if (!queue.success) {
      console.error('[AutoProductSelection WorkflowDriver] Failed to get queue status:', queue);
      consecutiveErrorCount++;
      if (consecutiveErrorCount >= MAX_CONSECUTIVE_ERRORS) {
        console.error('[AutoProductSelection WorkflowDriver] Max consecutive errors reached. Stopping workflow.');
        await stopWorkflowDriver();
      }
      return;
    }

    // Reset consecutive error count on success
    consecutiveErrorCount = 0;
    lastWorkflowError = null;  // Clear error on success

    // Auto-clean malformed worker locks (lock files without a hawkeye/forge suffix
    // and without corresponding output). These never map to a real worker, so they
    // would otherwise pin next_action_hint at cleanup_malformed_locks forever while
    // also not counting toward activeRuns (causing a silent self-termination deadlock).
    // coordinator.lock is intentionally excluded here — it is managed separately above.
    const malformedLocks = queue.derived?.malformed_locks || [];
    for (const malformed of malformedLocks) {
      if (!malformed?.name || malformed.name === 'coordinator.lock') continue;
      try {
        await fs.unlink(malformed.path);
        console.warn(`[AutoProductSelection WorkflowDriver] Removed malformed lock: ${malformed.name}`);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.error(`[AutoProductSelection WorkflowDriver] Failed to remove malformed lock ${malformed.name}:`, error.message);
        }
      }
    }

    // Calculate active runs. MUST include valid_locks (hawkeye/forge worker locks):
    // active_briefs EXCLUDES locked briefs, so while a worker is running, brief is hidden
    // and raw/scored not yet written -> activeRuns would be 0 and the driver would
    // self-terminate mid-work. Counting valid_locks keeps the driver alive until the
    // worker actually produces output (or its stale lock is cleaned up above).
    // This mirrors the activeRuns calculation in autoSelectionTriggerRun.
    const activeRuns = (queue.derived?.active_briefs?.length || 0) +
      (queue.derived?.valid_locks?.length || 0) +
      (queue.stages?.raw?.length || 0) +
      (queue.stages?.scored?.length || 0);

    // Check if this round has completed (lifecycle closure detection)
    if (workflowState === 'ACTIVE' && activeRuns === 0) {
      console.log('[AutoProductSelection WorkflowDriver] Round completed - active runs returned to zero. Entering self-termination.');
      await stopWorkflowDriver();
      return;
    }

    const hint = queue.next_action_hint;
    debugLog(`Workflow driver: next_action_hint = ${hint}`);

    switch (hint) {
      case 'cleanup_archived_residue':
        await handleCleanupArchivedResidue(queue);
        break;
      case 'handle_failed':
        await handleFailedRuns(queue);
        break;
      case 'evaluate_scored':
        await handleEvaluateScored(queue);
        break;
      case 'evaluate_raw':
        await handleEvaluateRaw(queue);
        break;
      case 'retry_worker_once':
        await handleRetryWorker(queue);
        break;
      case 'handle_worker_missing_output':
        await handleWorkerMissingOutput(queue);
        break;
      case 'send_existing_brief_to_scout':
        workflowState = 'ACTIVE'; // Mark state as active once we proceed
        await handleSendBriefToScout(queue);
        break;
      case 'create_brief_and_send_scout':
        if (workflowState === 'INIT') {
          workflowState = 'ACTIVE'; // Move to ACTIVE to allow self-termination later
          createBriefCountThisTrigger += 1;
          await handleCreateBriefAndSendScout();
        } else if (createBriefCountThisTrigger > MAX_RESELECT_PER_TRIGGER) {
          // Hard ceiling: never relaunch beyond the reselect budget, regardless of state.
          console.warn(`[AutoProductSelection WorkflowDriver] create_brief ceiling reached (${createBriefCountThisTrigger}); stopping to prevent an unbounded reselect loop.`);
          await stopWorkflowDriver();
        } else {
          console.log('[AutoProductSelection WorkflowDriver] Queue is idle and workflow is not in INIT state. Refusing to auto-create new brief.');
          await stopWorkflowDriver();
        }
        break;
      case 'wait_for_worker':
        debugLog('Workflow driver: waiting for worker to complete.');
        break;
      case 'cleanup_malformed_locks':
        // Malformed locks were already unlinked above; nothing more to do this tick.
        // The next tick re-derives next_action_hint from the cleaned-up queue.
        debugLog('Workflow driver: malformed locks cleaned, will re-evaluate next tick.');
        break;
      default:
        debugLog(`Workflow driver: unknown hint ${hint}, skipping.`);
    }
  } catch (error) {
    console.error('[AutoProductSelection WorkflowDriver] Error:', error);
    lastWorkflowError = error.stack || error.message || String(error);  // Record error
    consecutiveErrorCount++;
    if (consecutiveErrorCount >= MAX_CONSECUTIVE_ERRORS) {
      console.error('[AutoProductSelection WorkflowDriver] Max consecutive errors reached. Stopping workflow.');
      await stopWorkflowDriver();
    }
  }
}

/**
 * Cleanup archived residue files.
 */
async function handleCleanupArchivedResidue(queue) {
  const residues = queue.derived?.archived_residues || [];
  if (residues.length === 0) return;

  debugLog(`Cleaning up ${residues.length} archived residues.`);
  for (const residue of residues) {
    try {
      await autoSelectionCleanupRun({ run_id: residue.run_id });
      debugLog(`Cleaned up residue for run_id: ${residue.run_id}`);
    } catch (error) {
      console.error(`[AutoProductSelection WorkflowDriver] Failed to cleanup ${residue.run_id}:`, error);
    }
  }
}

/**
 * Handle failed runs - delegate to 破壁_枢纽 to publish blocking report and archive.
 * After completion, stop workflow driver.
 */
async function handleFailedRuns(queue) {
  const failedFiles = queue.stages?.failed || [];
  if (failedFiles.length === 0) return;

  const failed = failedFiles[0];
  debugLog(`Handling failed run: ${failed.run_id}`);

  // Loop backstop: count how many times we have delegated this failed run. If the
  // coordinator keeps failing to archive it, force-archive here so the queue drains.
  const attempts = (failedDelegationAttempts.get(failed.run_id) || 0) + 1;
  failedDelegationAttempts.set(failed.run_id, attempts);
  if (attempts > MAX_FAILED_DELEGATIONS) {
    console.warn(`[AutoProductSelection WorkflowDriver] handle_failed for ${failed.run_id} exceeded ${MAX_FAILED_DELEGATIONS} delegations. Force-archiving to break the loop.`);
    try {
      await autoSelectionArchiveRun({ run_id: failed.run_id, stage: 'failed' });
    } catch (error) {
      console.error(`[AutoProductSelection WorkflowDriver] Force-archive failed for ${failed.run_id}:`, error.message);
      // Last resort: clean residue so the queue cannot stay stuck on this run.
      await autoSelectionCleanupRun({ run_id: failed.run_id }).catch(() => { });
    }
    await removeCoordinatorLock();
    failedDelegationAttempts.delete(failed.run_id);
    return;
  }

  // Classify the failure: system-level blocks (worker never produced data) must NOT
  // be recorded as a product "淘汰" — there is no data basis to eliminate a direction.
  // Only data-driven rejections become eliminations / diary 淘汰 records.
  let failedContent = failed.content || '';
  if (!failedContent) {
    try {
      failedContent = await fs.readFile(failed.path, 'utf8');
    } catch (_) {
      failedContent = '';
    }
  }
  const failureTypeMatch = failedContent.match(/failure_type:\s*([a-z_]+)/i);
  const failureType = failureTypeMatch ? failureTypeMatch[1].toLowerCase() : '';
  const SYSTEM_BLOCK_TYPES = ['worker_missing_output', 'system_error', 'reselect_budget_exhausted'];
  const isSystemBlock = SYSTEM_BLOCK_TYPES.includes(failureType) ||
    /classification:\s*worker_timeout/i.test(failedContent) ||
    /worker.*(timed out|timeout|missing output|未.*输出|缺交付)/i.test(failedContent);

  const droppedSummaries = await collectDroppedSummaries();
  const droppedBlock = buildDroppedSummaryPromptBlock(droppedSummaries);

  const diaryStep = isSystemBlock
    ? `3. 在选品公共日记本中写入一条系统阻断记录（注意：这不是商业淘汰，本轮未取得有效数据，不要把它当作"方向淘汰"）。
   请使用 DailyNote.create 写入，必须在工具调用中显式传入 Date 参数（格式 YYYY-MM-DD，从当前时间提取）。
   Content 部分按以下格式书写，且 Tag 行必须放在 Content 最后一行的尾部：
   [系统阻断] 产品方向（若有）- 阻断原因摘要
   outcome: 系统阻断/数据未取得
   note: 本轮因 worker 超时/缺交付/系统错误中断，未对该方向做出商业结论，后续可重新探索。
   Tag: #系统阻断 #未取得数据`
    : `3. 在选品公共日记本中写入极简淘汰日志。
   请使用 DailyNote.create 写入，必须在工具调用中显式传入 Date 参数（格式 YYYY-MM-DD，从当前时间提取）。
   Content 部分按以下格式书写，且 Tag 行必须放在 Content 最后一行的尾部：
   [淘汰] 产品方向 - 数据层面的核心淘汰原因
   outcome: 淘汰
   primary_reason: 核心淘汰原因
   Tag: #排除 #主要原因`;

  const prompt = `你好，破壁_枢纽。AutoProductSelection 工作流驱动器检测到失败 run，需要你处理：

run_id: ${failed.run_id}
failed_file: ${failed.path}
failure_kind: ${isSystemBlock ? 'SYSTEM_BLOCK（系统阻断，非商业淘汰）' : 'DATA_REJECTION（基于数据的淘汰）'}

请执行以下步骤：
1. 调用 AutoProductSelection 的 auto_selection_read_run_file 读取 failed 文件内容（必须加 ink:「始」mark_history「末」）。
2. 基于失败原因，在 VCP 论坛发布阻断报告。${isSystemBlock ? '帖子要明确这是系统层面阻断（worker 超时/缺交付/系统错误），不是对该方向的商业否决。' : ''}
${diaryStep}
4. 调用 auto_selection_archive_run，stage=failed，run_id=${failed.run_id}。
5. 完成后输出 [[TaskComplete]]。

注意：
- 不要尝试重试或创建新 brief。
- 只处理这一个 failed run。
- 写入日记时，必须在 DailyNote.create 调用中显式传入 Date 参数（格式 YYYY-MM-DD，例如 Date:「始」2026-06-20「末」），绝对不能省略！
- 日记 Tag 行必须是 Content 的最后一行，否则 DailyNote 会报错。
- 归档完成后必须输出 [[TaskComplete]]。${isSystemBlock ? '' : droppedBlock}`;

  await delegateToCoordinator('handle_failed', failed.run_id, prompt);

  // After delegation, workflow will auto-terminate when coordinator completes
}

/**
 * Handle evaluate_scored - check circuit breaker then delegate or direct action.
 * After PUBLISH_FINAL, stop workflow driver.
 */
async function handleEvaluateScored(queue) {
  const scoredFiles = queue.stages?.scored || [];
  if (scoredFiles.length === 0) return;

  const scored = scoredFiles[0];
  debugLog(`Handling scored evaluation: ${scored.run_id}`);

  // Loop backstop: count how many times we have delegated this scored run. If the
  // coordinator keeps failing to archive/publish it, force-archive here so the queue drains.
  const attempts = (scoredDelegationAttempts.get(scored.run_id) || 0) + 1;
  scoredDelegationAttempts.set(scored.run_id, attempts);
  if (attempts > MAX_FAILED_DELEGATIONS) {
    console.warn(`[AutoProductSelection WorkflowDriver] evaluate_scored for ${scored.run_id} exceeded ${MAX_FAILED_DELEGATIONS} delegations. Force-archiving to break the loop.`);
    try {
      await autoSelectionArchiveRun({ run_id: scored.run_id, stage: 'scored' });
    } catch (error) {
      console.error(`[AutoProductSelection WorkflowDriver] Force-archive scored failed for ${scored.run_id}:`, error.message);
      // Last resort: clean residue so the queue cannot stay stuck on this run.
      await autoSelectionCleanupRun({ run_id: scored.run_id }).catch(() => { });
    }
    await removeCoordinatorLock();
    scoredDelegationAttempts.delete(scored.run_id);
    return;
  }

  // Check circuit breaker
  const counters = parseLoopbackCounters(scored.content || '');
  if (shouldTriggerCircuitBreaker(counters)) {
    console.warn(`[AutoProductSelection WorkflowDriver] Circuit breaker triggered for ${scored.run_id}:`, counters);

    // Force archive as failed
    const failedContent = [
      '---',
      `failure_type: circuit_breaker`,
      `run_id: ${scored.run_id}`,
      `detected_at: ${nowIso()}`,
      `global_loopback_count: ${counters.global_loopback_count}`,
      `scout_loopback_count: ${counters.scout_loopback_count}`,
      `reviewer_loopback_count: ${counters.reviewer_loopback_count}`,
      '---',
      '',
      '# 自动选品智能熔断',
      '',
      `run_id: ${scored.run_id}`,
      '',
      '[智能熔断] 检测到单阶段连续回退或全局累计回退达到安全上限，强制终止任务以防止死循环烧 Token。',
      '',
      '## 回退计数',
      '',
      `- 全局回退: ${counters.global_loopback_count}/${MAX_GLOBAL_LOOPBACK}`,
      `- 鹰眼回退: ${counters.scout_loopback_count}/${MAX_SCOUT_LOOPBACK}`,
      `- 熔炉回退: ${counters.reviewer_loopback_count}/${MAX_REVIEWER_LOOPBACK}`
    ].join('\n');

    await autoSelectionWriteRunFile({
      stage: 'failed',
      run_id: scored.run_id,
      content: failedContent,
      overwrite: true
    });

    // Delete scored and trigger failed handler
    await autoSelectionDeleteRunFile({ stage: 'scored', run_id: scored.run_id });
    await autoSelectionClearLocks({ run_id: scored.run_id });
    await removeCoordinatorLock();
    return;
  }

  const scoredDroppedSummaries = await collectDroppedSummaries();
  const scoredDroppedBlock = buildDroppedSummaryPromptBlock(scoredDroppedSummaries);

  const prompt = `你好，破壁_枢纽。AutoProductSelection 工作流驱动器检测到 scored 文件需要处理：

run_id: ${scored.run_id}
scored_file: ${scored.path}

请执行以下步骤：

1. 调用 AutoProductSelection 的 auto_selection_read_run_file 读取 scored 文件内容（必须加 ink:「始」mark_history「末」）。

2. 检查 post_forge_action.action 字段，识别动作类型。

3. 调用 auto_selection_apply_reviewer_decision，run_id=${scored.run_id}。

4. 根据返回结果执行相应操作：

   **如果返回 agent_assistant_request（LOOPBACK/DROP）**：
   - 原样传递给 AgentAssistant
   - 输出 [[TaskComplete]]

   **如果返回 ready_for_final_publication（PUBLISH_FINAL）**：

   a) 发布论坛帖子（VCPForum 工具）。标题格式：
   [verdict] 自动选品研报：[产品方向] | FinalScore XX/100

   正文必须从 scored 文件提取，不要编造。结构：
   - 一句话裁决：RECOMMEND / WATCHLIST / RESEARCH_GAP / REJECT / DATA_INSUFFICIENT
   - 四分展示：OpportunityScore / DataReliabilityScore / ExecutionFitScore / FinalScore
   - Hard Gates：是否通过、触发项和 warning
   - 后端数学与广告压力测试：UnitContribution、base/stress CVR、used/stress PPC、base/stress CPA、BreakEvenACOS、base/stress ad ratio
   - 市场需求证据：关键词搜索、购买、购买率、增长、需供比
   - 竞争结构证据：Top ASIN、评论门槛、销量、ABA 集中度、自然/广告流量
   - 利润与广告容错：费用表、贡献利润、FBA 占比、PPC 压力
   - 差异化机会：来自差评痛点和场景组合的低成本改良
   - 合规/侵权/平台风险
   - 供应链与资金压力
   - 数据置信度审计：missing_critical_fields、conflicting_signals、accepted_unfetchable_gaps、CVR 保守修正说明
   - 缺口与假设：哪些数据最影响结论，关键假设错了是否会反转
   - Kill Criteria
   - Next Validation Plan
   - 淘汰记录与经验标签

   b) 写入选品公共日记本。本轮只写一条合并日记，日记必须极简，不要复制研报全文。
   【重要：必须在 DailyNote.create 调用中显式传入 Date 参数（格式 YYYY-MM-DD，例如 Date:「始」2026-06-20「末」），绝对不能省略！】
   【重要：Tag 行必须是 Content 的最后一行，否则 DailyNote 会报 "Tag is missing" 错误】。
   Content 部分按以下格式书写（如有淘汰汇总，把淘汰清单并入这一条日记，不要另写多条），且 Tag 行必须放在 Content 最后一行的尾部：
   [入选/观察/淘汰/数据不足] 产品方向 - 核心原因摘要
   outcome:
   product_direction:
   primary_reason:
   secondary_reason:
   category:
   price_band:
   risk_tags:
   opportunity_tags:
   本轮淘汰清单（若有，逐条：方向 - 核心原因）:
   Tag: #入选或#排除 #主要风险 #机会标签

   c) 调用 auto_selection_archive_run stage=scored。

   d) 输出 [[TaskComplete]]。

注意：
- 必须原样传递 agent_assistant_request 的所有字段给 AgentAssistant
- 论坛帖子和日记内容从 scored 文件提取，不要编造数据
- 写入日记时，必须在 DailyNote.create 调用中显式传入 Date 参数（格式 YYYY-MM-DD，例如 Date:「始」2026-06-20「末」），绝对不能省略！
- 日记标签必须规范：Tag 行放在 Content 最后一行，以 Tag: 开头，标签间空格分隔（例如 Tag: #淘汰 #广告倒挂 #厨房收纳）
- LOOPBACK 和 DROP 不发论坛、不写日记、不归档
- 所有分支完成后都必须输出 [[TaskComplete]] 以清理 coordinator 锁${scoredDroppedBlock}`;

  await delegateToCoordinator('evaluate_scored', scored.run_id, prompt);
}

/**
 * Handle evaluate_raw - fast path for READY_FOR_FORGE, delegate for others.
 */
async function handleEvaluateRaw(queue) {
  const rawFiles = queue.stages?.raw || [];
  if (rawFiles.length === 0) return;

  const raw = rawFiles[0];
  debugLog(`Handling raw evaluation: ${raw.run_id}`);

  // Check circuit breaker
  const counters = parseLoopbackCounters(raw.content || '');
  if (shouldTriggerCircuitBreaker(counters)) {
    console.warn(`[AutoProductSelection WorkflowDriver] Circuit breaker triggered for ${raw.run_id}:`, counters);

    // Force archive as failed
    const failedContent = [
      '---',
      `failure_type: circuit_breaker`,
      `run_id: ${raw.run_id}`,
      `detected_at: ${nowIso()}`,
      `global_loopback_count: ${counters.global_loopback_count}`,
      `scout_loopback_count: ${counters.scout_loopback_count}`,
      `reviewer_loopback_count: ${counters.reviewer_loopback_count}`,
      '---',
      '',
      '# 自动选品智能熔断',
      '',
      `run_id: ${raw.run_id}`,
      '',
      '[智能熔断] 检测到单阶段连续回退或全局累计回退达到安全上限，强制终止任务以防止死循环烧 Token。',
      '',
      '## 回退计数',
      '',
      `- 全局回退: ${counters.global_loopback_count}/${MAX_GLOBAL_LOOPBACK}`,
      `- 鹰眼回退: ${counters.scout_loopback_count}/${MAX_SCOUT_LOOPBACK}`,
      `- 熔炉回退: ${counters.reviewer_loopback_count}/${MAX_REVIEWER_LOOPBACK}`
    ].join('\n');

    await autoSelectionWriteRunFile({
      stage: 'failed',
      run_id: raw.run_id,
      content: failedContent,
      overwrite: true
    });

    // Delete raw and trigger failed handler
    await autoSelectionDeleteRunFile({ stage: 'raw', run_id: raw.run_id });
    await autoSelectionClearLocks({ run_id: raw.run_id });
    await removeCoordinatorLock();
    return;
  }

  // Fast path: Check if route_decision is READY_FOR_FORGE
  const rawContent = raw.content || '';
  const routeMatch = rawContent.match(/route_decision[\s\S]{0,200}?action\s*:\s*['"]?([A-Z_]+)['"]?/i);
  const routeAction = routeMatch ? routeMatch[1].toUpperCase() : '';

  if (routeAction === 'READY_FOR_FORGE') {
    debugLog(`Fast path: READY_FOR_FORGE detected for ${raw.run_id}, dispatching reviewer directly.`);

    try {
      // Clean up orphaned coordinator lock before fast path dispatch
      const hasLock = await checkCoordinatorLock();
      if (hasLock) {
        const hasActiveTask = await checkActiveCoordinatorTask();
        if (!hasActiveTask) {
          debugLog('Removing orphaned coordinator lock before fast path dispatch.');
          await removeCoordinatorLock();
        }
      }

      const dispatch = await autoSelectionPrepareDispatch({
        worker: 'reviewer',
        run_id: raw.run_id,
        overwrite_lock: false
      });

      if (dispatch.success && dispatch.agent_assistant_request) {
        await callAgentAssistant(dispatch.agent_assistant_request);
        debugLog(`Successfully dispatched reviewer for ${raw.run_id}`);
        return;
      }

      // Dispatch did not succeed. The most common cause is an existing forge lock
      // (a reviewer is already in-flight, or a stale lock survived a restart/crash).
      // Do NOT silently no-op every tick. Distinguish in-flight from stale by lock age:
      // a fresh lock means a reviewer is likely still working (wait); a lock older than
      // the worker timeout means the worker is dead and we must re-dispatch. We avoid
      // blindly overwriting a fresh lock, which would duplicate an in-flight delegation.
      if (dispatch.error === 'file_exists') {
        const forgeLock = (queue.derived?.valid_locks || []).find(
          lock => lock.run_id === raw.run_id && inferAutoSelectionLockName(lock.name) === 'forge'
        );
        const lockAgeMinutes = forgeLock
          ? (Date.now() - new Date(forgeLock.modified_at).getTime()) / 60000
          : 0;
        const staleThreshold = queue.worker_timeout_minutes || 60;
        if (forgeLock && Number.isFinite(lockAgeMinutes) && lockAgeMinutes > staleThreshold) {
          console.warn(`[AutoProductSelection WorkflowDriver] Fast path: stale reviewer lock for ${raw.run_id} (${Math.floor(lockAgeMinutes)}min > ${staleThreshold}min). Re-dispatching reviewer.`);
          const redispatch = await autoSelectionPrepareDispatch({
            worker: 'reviewer',
            run_id: raw.run_id,
            overwrite_lock: true,
            dispatch_reason: 'fast_path_stale_lock_redispatch'
          });
          if (redispatch.success && redispatch.agent_assistant_request) {
            await callAgentAssistant(redispatch.agent_assistant_request);
            debugLog(`Re-dispatched reviewer after stale lock for ${raw.run_id}`);
          }
          return;
        }
        console.warn(`[AutoProductSelection WorkflowDriver] Fast path: reviewer lock already exists for ${raw.run_id} (age ${Math.floor(lockAgeMinutes)}min); treating as in-flight.`);
        return;
      }
      console.warn(`[AutoProductSelection WorkflowDriver] Fast path dispatch did not succeed for ${raw.run_id}:`, dispatch.error || dispatch.message || 'unknown');
      return;
    } catch (error) {
      console.error(`[AutoProductSelection WorkflowDriver] Fast path dispatch failed for ${raw.run_id}:`, error);
      // Fall through to delegation
    }
  }

  // Delegate to coordinator for non-READY_FOR_FORGE cases. Surface the persisted
  // cross-direction reselect budget so the coordinator knows when to stop reselecting.
  const rawCounters = parseLoopbackCounters(rawContent);
  const rawReselectCount = Math.max(rawCounters.reselect_count || 0, reselectCountThisTrigger || 0);
  const budgetLine = `本次 trigger 已重选方向 ${rawReselectCount}/${MAX_RESELECT_PER_TRIGGER} 次。`;
  const budgetGuidance = rawReselectCount >= MAX_RESELECT_PER_TRIGGER
    ? '已达跨方向重选上限：禁止再 DROP_AND_RESELECT，请直接写 failed（failure_type: reselect_budget_exhausted）并归档收尾，输出 [[TaskComplete]]。'
    : '如需换方向 DROP_AND_RESELECT，请在新 brief 中保留 reselect_count 计数器；达到上限后不得再换方向。';
  const prompt = `你好，破壁_枢纽。AutoProductSelection 工作流驱动器检测到 raw 文件需要评审：

run_id: ${raw.run_id}
raw_file: ${raw.path}
${budgetLine}

请执行以下步骤：
1. 调用 AutoProductSelection 的 auto_selection_read_run_file 读取 raw 文件内容（必须加 ink:「始」mark_history「末」）。
2. 检查 route_decision 字段：
   - 如果是 READY_FOR_FORGE：调用 auto_selection_prepare_dispatch，worker=reviewer，run_id=${raw.run_id}，然后将返回的 agent_assistant_request 原样传递给 AgentAssistant，最后输出 [[TaskComplete]]。
   - 如果是 EARLY_REJECT：${budgetGuidance}

注意：
- 必须原样传递 agent_assistant_request 的所有字段给 AgentAssistant。
- 派发评审后输出 [[TaskComplete]] 以清理 coordinator 锁，后端驱动器会自动推进。`;

  await delegateToCoordinator('evaluate_raw', raw.run_id, prompt);
}

/**
 * Handle retry_worker_once - auto-retry eligible worker with incremented retry_count.
 */
async function handleRetryWorker(queue) {
  const missingOutputs = queue.derived?.worker_missing_outputs || [];
  const eligible = missingOutputs.find(item => item.retry_guard?.eligible_now === true);

  if (!eligible) return;

  debugLog(`Retrying worker for run: ${eligible.run_id}, retry_count: ${eligible.retry_count}`);

  try {
    const worker = eligible.lock_name === 'forge' ? 'reviewer' : 'scout';
    const dispatch = await autoSelectionPrepareDispatch({
      worker,
      run_id: eligible.run_id,
      overwrite_lock: true,
      retry_count: eligible.retry_count + 1,
      dispatch_reason: 'auto_retry_once'
    });

    if (dispatch.success && dispatch.agent_assistant_request) {
      await callAgentAssistant(dispatch.agent_assistant_request);
      debugLog(`Successfully retried worker for ${eligible.run_id}`);
    }
  } catch (error) {
    console.error(`[AutoProductSelection WorkflowDriver] Failed to retry worker for ${eligible.run_id}:`, error);
  }
}

/**
 * Handle worker_missing_output - mark as failed and delegate to coordinator.
 */
async function handleWorkerMissingOutput(queue) {
  const missingOutputs = queue.derived?.worker_missing_outputs || [];
  if (missingOutputs.length === 0) return;

  const missing = missingOutputs[0];
  debugLog(`Handling worker missing output: ${missing.run_id}`);

  try {
    const markResult = await autoSelectionMarkWorkerMissingOutput({
      run_id: missing.run_id,
      overwrite: false
    });

    if (markResult.success) {
      debugLog(`Marked worker missing output for ${missing.run_id}, delegating to coordinator.`);
      await handleFailedRuns(await autoSelectionQueueStatus({ include_content: true }));
    }
  } catch (error) {
    console.error(`[AutoProductSelection WorkflowDriver] Failed to mark worker missing output for ${missing.run_id}:`, error);
  }
}

/**
 * Handle send_existing_brief_to_scout - dispatch scout with existing brief.
 * Fixed: Use overwrite_lock: true to prevent lock conflicts on restart.
 */
async function handleSendBriefToScout(queue) {
  const activeBriefs = queue.derived?.active_briefs || [];
  if (activeBriefs.length === 0) return;

  const brief = activeBriefs[0];
  debugLog(`Dispatching scout for existing brief: ${brief.run_id}`);

  try {
    const dispatch = await autoSelectionPrepareDispatch({
      worker: 'scout',
      run_id: brief.run_id,
      overwrite_lock: true  // Fixed: Prevent lock conflicts after restart
    });

    if (dispatch.success && dispatch.agent_assistant_request) {
      await callAgentAssistant(dispatch.agent_assistant_request);
      debugLog(`Successfully dispatched scout for ${brief.run_id}`);
    }
  } catch (error) {
    console.error(`[AutoProductSelection WorkflowDriver] Failed to dispatch scout for ${brief.run_id}:`, error);
  }
}

/**
 * Handle create_brief_and_send_scout - delegate to 破壁_枢纽 to create new brief.
 */
async function handleCreateBriefAndSendScout() {
  debugLog('Delegating new brief creation to coordinator.');

  let strategyContent = '';
  try {
    const cnPath = path.join(__dirname, 'AutoSelectionStrategyProfile.zh-CN.md');
    const enPath = path.join(__dirname, 'AutoSelectionStrategyProfile.md');
    try {
      strategyContent = await fs.readFile(cnPath, 'utf8');
      debugLog('Successfully loaded strategy profile from AutoSelectionStrategyProfile.zh-CN.md');
    } catch (e) {
      strategyContent = await fs.readFile(enPath, 'utf8');
      debugLog('Successfully loaded strategy profile from AutoSelectionStrategyProfile.md');
    }
  } catch (err) {
    console.error('[AutoProductSelection WorkflowDriver] Failed to read strategy profile:', err);
    strategyContent = '（未能读取到本地选品策略文件，请按宽泛探索默认原则进行选品）';
  }

  const prompt = `你好，破壁_枢纽。AutoProductSelection 工作流驱动器检测到队列空闲，需要创建新 brief。

我们已经为你自动加载并注入了最新的选品策略，请直接阅读并严格遵循以下策略要求：

【当前选品策略指导 (Strategy Profile)】：
${strategyContent}

请执行以下步骤：
1. 审视上方为你自动加载的《选品公共日记本》历史记忆，避免重复已淘汰的具体死因。
2. 根据上述【当前选品策略指导】，默认允许并推荐进行宽泛探索（除非策略中明确限定了品类、关键词、禁选方向或价格带，否则不要过度收窄）。请从场景、人群、痛点、周边配件、收纳清洁、替换件和低成本改良角度发散。
3. 基于反共识、场景驱动、时间差预判的战略思维，生成新的 SelectionBrief。Brief 必须给鹰眼 3-5 个不同角度 of 英文种子词/微场景，并要求输出 Min Evidence Pack。
4. 生成 run_id（格式：APS-YYYYMMDD-HHMMSS-slug）。
5. 调用 auto_selection_prepare_dispatch，worker=scout，run_id=生成的run_id，brief_content=生成的brief内容。
6. 将返回的 agent_assistant_request 原样传递给 AgentAssistant。
7. 完成后输出 [[TaskComplete]]。

注意：
- 策略文件已在上方注入，你无需且不应调用 ServerFileOperator.ReadFile 去重复读取。
- 必须遵循上述注入的策略和历史日记。
- 必须原样传递 agent_assistant_request 的所有字段给 AgentAssistant。
- 派发成功后必须输出 [[TaskComplete]] 以清理 coordinator 锁。
- 不要发论坛、不要写日记、不要归档。`;

  await delegateToCoordinator('create_brief', 'new', prompt);
}

/**
 * Call AgentAssistant plugin to dispatch a worker.
 */
async function callAgentAssistant(agentRequest) {
  if (!resolveAgentAssistant()) {
    console.error('[AutoProductSelection WorkflowDriver] AgentAssistant plugin not available.');
    return;
  }

  try {
    // Inject ToolBox content if available
    let finalPrompt = agentRequest.prompt;
    if (TOOLBOX_CONTENT) {
      finalPrompt = `${TOOLBOX_CONTENT}\n\n---\n\n${agentRequest.prompt}`;
    }

    const result = await AgentAssistantPlugin.processToolCall({
      command: 'request_agent_assistance',
      agent_name: agentRequest.agent_name,
      prompt: finalPrompt,
      temporary_contact: agentRequest.temporary_contact,
      task_delegation: agentRequest.task_delegation,
      inject_tools: agentRequest.inject_tools
    });

    debugLog(`AgentAssistant call result: ${JSON.stringify(result).slice(0, 200)}`);
  } catch (error) {
    console.error('[AutoProductSelection WorkflowDriver] Failed to call AgentAssistant:', error);
  }
}

/**
 * Delegate a coordination task to 破壁_枢纽 via AgentAssistant.
 * Creates coordinator lock before delegation.
 */
async function delegateToCoordinator(taskType, runId, prompt) {
  if (!resolveAgentAssistant()) {
    console.error('[AutoProductSelection WorkflowDriver] AgentAssistant plugin not available for delegation.');

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
    // Create coordinator lock before delegation
    await createCoordinatorLock(taskType);

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
      inject_tools: 'AutoProductSelection,ServerFileOperator,VCPForum,DailyNote'
    });

    debugLog(`Delegated ${taskType} for ${runId} to coordinator: ${JSON.stringify(result).slice(0, 200)}`);
  } catch (error) {
    console.error(`[AutoProductSelection WorkflowDriver] Failed to delegate ${taskType} for ${runId}:`, error);

    // Remove lock on delegation failure
    await removeCoordinatorLock();
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
  process.nextTick(workflowDriver);
  workflowInterval = setInterval(workflowDriver, WORKFLOW_TICK_INTERVAL_MS);
  console.log(`[AutoProductSelection] Workflow driver started (${WORKFLOW_TICK_INTERVAL_MS / 1000}-second interval).`);
}

/**
 * Debug status command - provides comprehensive workflow diagnostics
 */
async function autoSelectionDebugStatus(args = {}) {
  try {
    const report = [];

    // Header
    report.push('# AutoProductSelection 工作流诊断报告');
    report.push('');
    report.push(`生成时间: ${nowIso()}`);
    report.push('');

    // 1. Memory State
    report.push('## 1. 内存状态');
    report.push('');
    report.push(`- **isWorkflowRunning**: \`${isWorkflowRunning}\``);
    report.push(`- **workflowState**: \`${workflowState}\` (IDLE=休眠 | INIT=已触发 | ACTIVE=运行中)`);
    report.push(`- **consecutiveErrorCount**: \`${consecutiveErrorCount}\` / ${MAX_CONSECUTIVE_ERRORS}`);
    report.push(`- **定时器状态**: ${workflowInterval ? `✅ 运行中 (${WORKFLOW_TICK_INTERVAL_MS / 1000}秒间隔)` : '⏸️  已停止'}`);

    if (lastWorkflowError) {
      report.push(`- **最近错误**: \`\`\`\n${lastWorkflowError}\n\`\`\``);
    } else {
      report.push(`- **最近错误**: 无`);
    }
    report.push('');

    // 2. Physical Locks
    report.push('## 2. 物理锁状态');
    report.push('');
    const locksDir = path.join(AUTO_SELECTION_RUNS_DIR, 'locks');
    try {
      const lockFiles = await fs.readdir(locksDir);
      if (lockFiles.length === 0) {
        report.push('- 🟢 无锁文件（系统空闲）');
      } else {
        report.push(`- 🔒 检测到 ${lockFiles.length} 个锁文件：`);
        for (const lockFile of lockFiles) {
          const lockPath = path.join(locksDir, lockFile);
          const stat = await fs.stat(lockPath);
          const age = Math.floor((Date.now() - stat.mtimeMs) / 1000 / 60); // minutes
          report.push(`  - \`${lockFile}\` (${age} 分钟前创建)`);
        }
      }
    } catch (error) {
      report.push(`- ⚠️  无法读取锁目录: ${error.message}`);
    }
    report.push('');

    // 3. Queue Status
    report.push('## 3. 队列状态');
    report.push('');
    const queue = await autoSelectionQueueStatus({ include_content: false });

    if (queue.success) {
      const activeRuns = (queue.derived?.valid_locks?.length || 0) +
        (queue.derived?.active_briefs?.length || 0) +
        (queue.stages?.raw?.length || 0) +
        (queue.stages?.scored?.length || 0);

      report.push(`- **活动任务数 (activeRuns)**: ${activeRuns}`);
      report.push(`- **下一步行动 (next_action_hint)**: \`${queue.next_action_hint}\``);
      report.push('');
      report.push('### 各阶段文件统计');
      report.push('');
      report.push(`- Brief 文件: ${queue.stages?.brief?.length || 0}`);
      report.push(`- Raw 文件: ${queue.stages?.raw?.length || 0}`);
      report.push(`- Scored 文件: ${queue.stages?.scored?.length || 0}`);
      report.push(`- Failed 文件: ${queue.stages?.failed?.length || 0}`);
      report.push(`- Archived 文件: ${queue.stages?.archived?.length || 0}`);
      report.push(`- 有效锁: ${queue.derived?.valid_locks?.length || 0}`);
      report.push(`- 畸形锁: ${queue.derived?.malformed_locks?.length || 0}`);

      // Worker missing output
      const missingOutputs = queue.derived?.worker_missing_outputs || [];
      if (missingOutputs.length > 0) {
        report.push('');
        report.push('### ⚠️  Worker 缺失输出');
        report.push('');
        for (const item of missingOutputs) {
          const ageDisplay = item.lock_age_minutes != null
            ? `${item.lock_age_minutes} 分钟无输出`
            : (item.timeout_minutes != null ? `超过 ${item.timeout_minutes} 分钟超时` : '已完成但无输出');
          report.push(`- **${item.run_id}** (${item.lock_name}): ${ageDisplay}`);
          if (item.retry_guard?.eligible_now) {
            report.push(`  - 可重试 (retry_count: ${item.retry_count})`);
          }
        }
      }
    } else {
      report.push(`- ❌ 无法获取队列状态: ${queue.error || 'unknown'}`);
    }
    report.push('');

    // 4. Circuit Breaker Counters
    report.push('## 4. 熔断计数器');
    report.push('');

    let foundCounters = false;

    // Check brief files
    if (queue.success && queue.stages?.brief?.length > 0) {
      for (const brief of queue.stages.brief) {
        try {
          const briefContent = await fs.readFile(brief.path, 'utf8');
          const counters = parseLoopbackCounters(briefContent);

          if (counters.global_loopback_count > 0 || counters.scout_loopback_count > 0 || counters.reviewer_loopback_count > 0) {
            foundCounters = true;
            report.push(`### Brief: ${brief.run_id}`);
            report.push('');
            report.push(`- global_loopback_count: ${counters.global_loopback_count} / ${MAX_GLOBAL_LOOPBACK}`);
            report.push(`- scout_loopback_count: ${counters.scout_loopback_count} / ${MAX_SCOUT_LOOPBACK}`);
            report.push(`- reviewer_loopback_count: ${counters.reviewer_loopback_count} / ${MAX_REVIEWER_LOOPBACK}`);

            // Check if close to circuit breaker
            if (shouldTriggerCircuitBreaker(counters)) {
              report.push(`- ⚠️  **警告**: 已达到熔断阈值，下次扫描将自动终止`);
            } else if (counters.global_loopback_count >= MAX_GLOBAL_LOOPBACK - 2 ||
              counters.scout_loopback_count >= MAX_SCOUT_LOOPBACK - 1 ||
              counters.reviewer_loopback_count >= MAX_REVIEWER_LOOPBACK - 1) {
              report.push(`- ⚠️  **注意**: 接近熔断阈值`);
            }
            report.push('');
          }
        } catch (error) {
          // Ignore read errors
        }
      }
    }

    // Check raw files
    if (queue.success && queue.stages?.raw?.length > 0) {
      for (const raw of queue.stages.raw) {
        try {
          const rawContent = await fs.readFile(raw.path, 'utf8');
          const counters = parseLoopbackCounters(rawContent);

          if (counters.global_loopback_count > 0 || counters.scout_loopback_count > 0 || counters.reviewer_loopback_count > 0) {
            foundCounters = true;
            report.push(`### Raw: ${raw.run_id}`);
            report.push('');
            report.push(`- global_loopback_count: ${counters.global_loopback_count} / ${MAX_GLOBAL_LOOPBACK}`);
            report.push(`- scout_loopback_count: ${counters.scout_loopback_count} / ${MAX_SCOUT_LOOPBACK}`);
            report.push(`- reviewer_loopback_count: ${counters.reviewer_loopback_count} / ${MAX_REVIEWER_LOOPBACK}`);

            if (shouldTriggerCircuitBreaker(counters)) {
              report.push(`- ⚠️  **警告**: 已达到熔断阈值，下次扫描将自动终止`);
            }
            report.push('');
          }
        } catch (error) {
          // Ignore read errors
        }
      }
    }

    // Check scored files
    if (queue.success && queue.stages?.scored?.length > 0) {
      for (const scored of queue.stages.scored) {
        try {
          const scoredContent = await fs.readFile(scored.path, 'utf8');
          const counters = parseLoopbackCounters(scoredContent);

          if (counters.global_loopback_count > 0 || counters.scout_loopback_count > 0 || counters.reviewer_loopback_count > 0) {
            foundCounters = true;
            report.push(`### Scored: ${scored.run_id}`);
            report.push('');
            report.push(`- global_loopback_count: ${counters.global_loopback_count} / ${MAX_GLOBAL_LOOPBACK}`);
            report.push(`- scout_loopback_count: ${counters.scout_loopback_count} / ${MAX_SCOUT_LOOPBACK}`);
            report.push(`- reviewer_loopback_count: ${counters.reviewer_loopback_count} / ${MAX_REVIEWER_LOOPBACK}`);

            if (shouldTriggerCircuitBreaker(counters)) {
              report.push(`- ⚠️  **警告**: 已达到熔断阈值，下次扫描将自动终止`);
            }
            report.push('');
          }
        } catch (error) {
          // Ignore read errors
        }
      }
    }

    if (!foundCounters) {
      report.push('- 无活动任务或计数器为 0');
    }
    report.push('');

    // 5. Recommendations
    report.push('## 5. 诊断建议');
    report.push('');

    if (!isWorkflowRunning) {
      report.push('- 🟢 工作流未运行，系统处于静默休眠状态');
      report.push('- 💡 如需启动工作流，调用 `auto_selection_trigger_run`');
    } else if (workflowState === 'IDLE') {
      report.push('- ⚠️  异常状态：工作流标记为运行中但状态为 IDLE');
      report.push('- 💡 建议手动停止工作流');
    } else {
      const activeRuns = (queue.derived?.valid_locks?.length || 0) +
        (queue.derived?.active_briefs?.length || 0) +
        (queue.stages?.raw?.length || 0) +
        (queue.stages?.scored?.length || 0);

      if (activeRuns === 0 && workflowState === 'ACTIVE') {
        report.push('- 🟡 工作流运行中但无活动任务');
        report.push('- 💡 下次扫描应自动终止并休眠');
      } else if (queue.next_action_hint === 'wait_for_worker') {
        report.push('- 🟡 正在等待 Worker 完成任务');
        report.push('- 💡 如果长时间无进展，检查 Worker 是否卡死');
      } else {
        report.push('- 🟢 工作流正常运行中');
      }
    }

    if (consecutiveErrorCount > 0) {
      report.push(`- ⚠️  已累计 ${consecutiveErrorCount} 次连续错误`);
      if (consecutiveErrorCount >= MAX_CONSECUTIVE_ERRORS - 1) {
        report.push('- 🔴 接近最大错误阈值，下次错误将自动停止工作流');
      }
    }

    if (lastWorkflowError) {
      report.push('- 🔴 检测到最近错误，请查看上方错误详情');
    }

    const lockFiles = await fs.readdir(path.join(AUTO_SELECTION_RUNS_DIR, 'locks')).catch(() => []);
    if (lockFiles.some(f => f === 'coordinator.lock')) {
      report.push('- 🔒 协调器锁存在，工作流暂停等待委托完成');
    }

    return {
      success: true,
      command: 'auto_selection_debug_status',
      report: report.join('\n'),
      summary: {
        workflow_running: isWorkflowRunning,
        workflow_state: workflowState,
        consecutive_errors: consecutiveErrorCount,
        has_recent_error: !!lastWorkflowError,
        active_runs: queue.success ? (queue.derived?.valid_locks?.length || 0) +
          (queue.derived?.active_briefs?.length || 0) +
          (queue.stages?.raw?.length || 0) +
          (queue.stages?.scored?.length || 0) : 0,
        next_action: queue.success ? queue.next_action_hint : 'unknown'
      }
    };
  } catch (error) {
    return {
      success: false,
      command: 'auto_selection_debug_status',
      error: error.message,
      report: `# 诊断失败\n\n错误: ${error.message}\n\n${error.stack || ''}`
    };
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
  }

  // Reset state
  isWorkflowRunning = false;
  workflowState = 'IDLE';  // Reset lifecycle flag
  consecutiveErrorCount = 0;
  reselectCountThisTrigger = 0;  // Reset cross-direction reselect budget for next trigger
  createBriefCountThisTrigger = 0;  // Reset create_brief ceiling for next trigger
  failedDelegationAttempts.clear();  // Reset handle_failed loop backstop for next trigger
  scoredDelegationAttempts.clear();  // Reset evaluate_scored loop backstop for next trigger

  // Remove coordinator lock
  await removeCoordinatorLock();

  debugLog('Workflow driver stopped and state reset. Entering silent rest mode.');
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

  // Workflow driver is in standby mode on startup
  // Trigger it via: auto_selection_trigger_run, or scheduled tasks
  console.log('[AutoProductSelection] Plugin initialized. Workflow driver in standby mode.');
  console.log('[AutoProductSelection] Trigger via: auto_selection_trigger_run command or VCPTaskAssistant scheduled task.');
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

function findFirstRate(content, keys = [], defaultValue = null) {
  const value = findFirstNumber(content, keys, defaultValue);
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return defaultValue;
  return Number(value) > 1 ? Number(value) / 100 : Number(value);
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
  const demandScore = findFirstNumber(text, ['demand_score'], oldDemand !== null ? oldDemand * 4 : 50);
  const growthScore = findFirstNumber(text, ['growth_score'], 50);
  const differentiationScore = findFirstNumber(text, ['differentiation_score'], oldDifferentiation !== null ? oldDifferentiation * 4 : 50);
  const competitionSeverity = clampNumber(findFirstNumber(text, ['competition_severity'], 5), 0, 10);
  const complianceRisk = clampNumber(findFirstNumber(text, ['compliance_risk'], 3), 0, 10);
  const complexitySeverity = clampNumber(findFirstNumber(text, ['complexity_severity'], 5), 0, 10);
  const marketEntryScore = findFirstNumber(text, ['market_entry_score'], clampNumber(100 - competitionSeverity * 8 - complexitySeverity * 3, 0, 100));

  const potentialScore = clampNumber(
    0.30 * clampNumber(demandScore) +
    0.20 * clampNumber(growthScore) +
    0.25 * clampNumber(differentiationScore) +
    0.25 * clampNumber(marketEntryScore)
  );

  const sellingPriceRaw = findFirstNumber(text, ['selling_price'], null);
  const sellingPrice = sellingPriceRaw && sellingPriceRaw > 0 ? sellingPriceRaw : 25.0;
  if (!sellingPriceRaw || sellingPriceRaw <= 0) {
    missingCriticalFields.add('selling_price');
    warnings.push('selling_price 缺失，后端仅用 $25.00 做保守压力测试，不作为高置信度证据。');
  }

  const bomCostRaw = findFirstNumber(text, ['bom_cost'], null);
  const shippingCostRaw = findFirstNumber(text, ['shipping_cost'], null);
  const fbaFeeRaw = findFirstNumber(text, ['fba_fee'], null);
  const referralFeeRaw = findFirstNumber(text, ['referral_fee'], null);
  const packagingCostRaw = findFirstNumber(text, ['packaging_cost'], null);
  const returnReserveRaw = findFirstNumber(text, ['return_reserve'], null);
  const couponCostRaw = findFirstNumber(text, ['coupon_cost'], null);
  const storageReserveRaw = findFirstNumber(text, ['storage_reserve'], null);

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
  const referralFee = referralFeeRaw !== null && referralFeeRaw >= 0 ? referralFeeRaw : sellingPrice * 0.15;
  const packagingCost = packagingCostRaw !== null && packagingCostRaw >= 0 ? packagingCostRaw : Math.max(0.75, sellingPrice * 0.03);
  const returnReserve = returnReserveRaw !== null && returnReserveRaw >= 0 ? returnReserveRaw : sellingPrice * 0.05;
  const couponCost = couponCostRaw !== null && couponCostRaw >= 0 ? couponCostRaw : sellingPrice * 0.05;
  const storageReserve = storageReserveRaw !== null && storageReserveRaw >= 0 ? storageReserveRaw : sellingPrice * 0.02;

  if (bomCostRaw === null || bomCostRaw < 0) warnings.push('bom_cost 缺失，按售价 25% 保守估计。');
  if (shippingCostRaw === null || shippingCostRaw < 0) warnings.push('shipping_cost 缺失，按售价 10% 且最低 $1.25 保守估计。');
  if (fbaFeeRaw === null || fbaFeeRaw < 0) {
    missingCriticalFields.add('fba_fee');
    warnings.push('fba_fee 缺失，按售价 18% 且最低 $3.00 保守估计。');
  }

  const estimatedUnitContribution = sellingPrice - referralFee - bomCost - shippingCost - fbaFee - packagingCost - returnReserve - couponCost - storageReserve;
  const estimatedUnitContributionRate = sellingPrice > 0 ? estimatedUnitContribution / sellingPrice : 0;

  let rawCvr = findFirstRate(text, ['raw_click_conversion_rate', 'click_conversion_rate'], null);
  if (!rawCvr || rawCvr <= 0) {
    missingCriticalFields.add('click_conversion_rate');
    rawCvr = 0.06;
    warnings.push('click_conversion_rate 缺失，后端按 6% 行业参考做保守压力测试，并降低数据置信度。');
  }
  const matureEvidence = /\bmature_cvr_evidence\s*:\s*true\b|\bcvr_adjustment_mode\s*:\s*mature/i.test(text);
  const baseCvr = matureEvidence ? Math.min(rawCvr * 0.65, 0.12) : Math.min(rawCvr * 0.50, 0.08);
  const stressCvr = matureEvidence ? Math.min(rawCvr * 0.45, 0.08) : Math.min(rawCvr * 0.35, 0.06);

  const explicitUsedPpc = findFirstNumber(text, ['used_ppc'], null);
  const explicitStressPpc = findFirstNumber(text, ['stress_ppc'], null);
  const rawPpcBidValue = findFirstNumber(text, ['raw_ppc_bid', 'ppc_bid'], null);
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

  const explicitOpportunityScore = findFirstNumber(text, ['opportunity_score'], null);
  const opportunityScore = clampNumber(
    explicitOpportunityScore !== null && !hasAnyNumber(text, ['demand_score', 'growth_score', 'differentiation_score', 'market_entry_score'])
      ? explicitOpportunityScore
      : potentialScore * mProfitEffective * mCompetition * mCompliance
  );

  const sourceReliability = findFirstNumber(text, ['source_reliability_score'], null);
  const freshness = findFirstNumber(text, ['freshness_score'], null);
  const sampleCoverage = findFirstNumber(text, ['sample_coverage_score'], null);
  const crossSource = findFirstNumber(text, ['cross_source_consistency_score'], null);
  const fieldCompleteness = findFirstNumber(text, ['field_completeness_score'], null);
  const outlierControl = findFirstNumber(text, ['outlier_control_score'], null);
  const explicitDataReliability = findFirstNumber(text, ['data_reliability_score'], null);
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
  const reportedCpa = findFirstNumber(text, ['reported_cpa', 'cpa_avg', 'cpa'], null);
  if (reportedCpa !== null && sellingPrice > 0 && reportedCpa > sellingPrice) {
    distortionSignals.push(`cpa (${reportedCpa.toFixed(2)}) 超过售价 (${sellingPrice.toFixed(2)})，广告数据疑似失真，仅降权不淘汰`);
  }
  const reportedAcos = findFirstRate(text, ['reported_acos', 'acos_avg', 'acos'], null);
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

  const explicitExecutionFit = findFirstNumber(text, ['execution_fit_score'], null);
  const executionFitScore = clampNumber(explicitExecutionFit !== null ? explicitExecutionFit : (100 - complexitySeverity * 8));
  const mExecutionFit = executionMultiplier(executionFitScore);

  const hardGateTriggered = detectHardGateFromContent(text, complianceRisk) || estimatedUnitContribution <= 0;
  if (hardGateTriggered) warnings.push('Hard Gate 或负贡献利润触发，FinalScore 强制为 0。');

  const finalScore = hardGateTriggered
    ? 0
    : clampNumber(opportunityScore * confidence.multiplier * mExecutionFit);
  const totalScore = Math.round(finalScore);

  return {
    scoringVersion: 'v2',
    baseScore: potentialScore,
    potentialScore,
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

function decideBackendAction(originalAction, scoreResults, content = '', reselectCount = 0) {
  const action = normalizeForgeAction(originalAction || '');
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

  // Ad-stress failure is a SOFT signal now (the ad-economics inputs — cpa/acos/
  // ad_budget — are the least reliable SellerSprite fields). It must not by itself
  // drop a direction NOR rescue a genuinely weak one. It only annotates; the score
  // thresholds below (driven mostly by market/CVR/execution) remain the real gate.

  // Publish/drop bands. The system is a high-confidence REFERENCE for a human who
  // does the final validation, so the bias is "surface for review, don't silently
  // discard". Only genuinely weak directions are dropped.
  //   >= 75            → publish as-is (strong; reviewer's RECOMMEND/etc. stands)
  //   50 <= score < 75 → publish, but as a cautious WATCHLIST for human validation
  //                      (do NOT drop — this is what fixes "永远选不出产品")
  //   < 50             → drop and try a new direction (within reselect budget)
  const score = scoreResults.totalScore;
  if (score >= 75) return action;
  if (score >= 50) return 'PUBLISH_FINAL'; // mid band: surface for human validation
  // Weak band (<50): drop within budget, else converge to a terminal publish.
  if (['WATCHLIST', 'RESEARCH_GAP', 'DATA_INSUFFICIENT'].includes(verdict)) {
    // Reviewer already chose a cautious terminal verdict — let it publish.
    return action;
  }
  return budgetExhausted ? toTerminalPublish() : 'DROP_AND_RESELECT';
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

async function shutdown() {
  await stopWorkflowDriver();
  debugLog('Plugin shutdown.');
}

module.exports = {
  initialize,
  processToolCall,
  shutdown,
  decideBackendAction,
  calculateScoringModel
};
