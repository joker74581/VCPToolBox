const fs = require('fs').promises;
const path = require('path');

let debugMode = false;

const VCP_ROOT_DIR = path.resolve(__dirname, '..', '..');
const AUTO_SELECTION_RUNS_DIR = path.join(__dirname, 'runs');
const AUTO_SELECTION_STRATEGY_PROFILE_PATH = path.join(__dirname, 'AutoSelectionStrategyProfile.md');
const AGENT_TASK_DIR = path.join(VCP_ROOT_DIR, 'file', 'document', 'AgentTask');
const AUTO_SELECTION_STAGES = new Set(['brief', 'raw', 'scored', 'archived', 'failed', 'locks']);
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
      if (!hasExpectedPrefix && !content.includes('## 原始委托要求')) continue;
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
  const validLocks = stages.locks.filter(file => inferAutoSelectionLockName(file.name));
  const malformedLocks = stages.locks.filter(file => !inferAutoSelectionLockName(file.name));
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
  if (derived.activeBriefs?.length) return 'send_existing_brief_to_hawkeye';
  return 'create_brief_and_send_hawkeye';
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
  const lockName = args.lock_name ?? args.lockName ?? '';
  if (stage === 'locks' && !['hawkeye', 'forge'].includes(String(lockName || '').trim())) {
    return {
      success: false,
      command: 'auto_selection_write_run_file',
      stage,
      run_id: runId,
      error: 'lock_name_required',
      message: 'When stage=locks, lock_name must be hawkeye or forge.'
    };
  }
  const overwrite = parseBoolean(args.overwrite, false);
  const filePath = resolveAutoSelectionFile(stage, runId, lockName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    if (!overwrite) {
      await fs.writeFile(filePath, content || `lock created at ${nowIso()}\n`, { encoding: 'utf8', flag: 'wx' });
    } else {
      await fs.writeFile(filePath, content || `lock created at ${nowIso()}\n`, 'utf8');
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

function buildAutoSelectionWorkerPrompt(worker, runId) {
  const safeRunId = normalizeAutoSelectionRunId(runId);
  const completionMarkerInstruction = '完成时输出两个英文左方括号、TaskComplete、两个英文右方括号组成的完成标记。不要在写文件成功前输出该完成标记。';
  const callRhythmInstruction = '调用节奏：每一轮回复最多只发送 1 个 TOOL_REQUEST；等待工具摘要返回后，再基于结果决定下一步，不要在同一轮连续发多个工具块。';
  if (worker === 'hawkeye') {
    return `请执行一次自动选品取证任务。

run_id: ${safeRunId}
brief_stage: brief
success_stage: raw
failure_stage: failed

${callRhythmInstruction}

先用 AutoProductSelection 读取 brief，读不到 brief 就写 failed。接着尝试读取已有的 raw 数据包，如果存在，说明是回环补采，请保留旧数据仅针对 brief 要求的缺口进行增量抓取并合并覆盖写回 raw；如果不存在则正常从头开始。只用 ProductSelector 串行取证，一次只调用一个数据命令。至少取得一个可追溯 ASIN/产品候选，除非 brief 明确只要求市场预研。

硬性边界：ProductSelector 数据命令总数最多 3 次；同一个 command+核心参数最多重试 1 次；任何登录/页面/账号/工具协议错误连续出现 2 次，立刻写 failed。不要为了补齐理想字段反复搜索；拿到可追溯证据就落 raw，拿不到就落 failed。ProductSelector 返回 success=false、plugin_error、超时、空结果或不可追溯数据时，把原始错误摘要写入 failed 或 raw.execution_summary.fallback_log。

成功或部分成功时写 raw_data_pack 到 raw；工具阻断、数据不可追溯、只有自然语言观察、页面/账号错误或 brief 不可读时写 failed。raw 必须包含 route_decision、tool_decisions、evidence_matrix、asin_source_map、elimination_log、execution_summary.data_tools_called、execution_summary.fallback_log。failed 必须包含 failure_type、tool_decisions、failed_commands、diagnosis、next_manual_action。${completionMarkerInstruction} 不要调用评审 Agent，不发论坛，不写 DailyNote。`;
  }

  if (worker === 'forge') {
    return `请执行一次自动选品证据评审任务。

run_id: ${safeRunId}
raw_stage: raw
success_stage: scored
failure_stage: failed

${callRhythmInstruction}

先用 AutoProductSelection 读取 raw，读不到或 raw 缺结构化证据就写 failed。不要抓新数据，不发论坛，不写 DailyNote。

审计取证 Agent 交付的证据，输出 scored_candidate_pack。评审最多读取 raw 1 次、写结果 1 次；不要循环等待更完整证据。若缺失 ProductSelector 仍能补到的核心数据，写 scored 但标记 PARTIAL，并让 post_forge_action.action=LOOPBACK_TO_HAWKEYE，同时列出最多 3 个明确补采缺口。只有证据足够或剩余缺口属于人工验证时，才允许 PUBLISH_FINAL。${completionMarkerInstruction}`;
  }

  throw new Error(`Invalid auto-selection worker: ${worker}`);
}

async function autoSelectionPrepareDispatch(args = {}) {
  await ensureAutoSelectionRunDirs();
  if (referencesStrategyProfile(args.run_id ?? args.runId)) {
    return strategyProfileMisuseResponse('auto_selection_prepare_dispatch');
  }
  const worker = String(args.worker || args.lock_name || args.lockName || '').trim().toLowerCase();
  if (!['hawkeye', 'forge'].includes(worker)) {
    throw new Error('worker is required and must be hawkeye or forge.');
  }
  const runId = normalizeAutoSelectionRunId(args.run_id ?? args.runId);
  const overwriteBrief = parseBoolean(args.overwrite_brief ?? args.overwriteBrief, false);
  const overwriteLock = parseBoolean(args.overwrite_lock ?? args.overwriteLock, false);
  const briefContent = args.brief_content ?? args.briefContent ?? args.content;
  const retryCount = Math.max(0, Number(args.retry_count ?? args.retryCount ?? 0) || 0);
  const delegationId = String(args.delegation_id ?? args.delegationId ?? '').trim();
  const dispatchReason = String(args.dispatch_reason ?? args.dispatchReason ?? (retryCount > 0 ? 'retry' : 'initial')).trim() || 'initial';

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
      delegationId ? `delegation_id: ${delegationId}` : ''
    ].filter(Boolean).join('\n') + '\n',
    overwrite: overwriteLock
  });
  if (lockResult.success === false) return lockResult;

  return {
    success: true,
    command: 'auto_selection_prepare_dispatch',
    worker,
    run_id: runId,
    lock_path: lockResult.path,
    agent_assistant_request: {
      agent_name: worker === 'hawkeye' ? AUTO_SELECTION_SCOUT_AGENT_NAME : AUTO_SELECTION_REVIEWER_AGENT_NAME,
      prompt: buildAutoSelectionWorkerPrompt(worker, runId),
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
  const fromStage = normalizeAutoSelectionStage(args.from_stage ?? args.fromStage);
  const toStage = normalizeAutoSelectionStage(args.to_stage ?? args.toStage);
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

async function processToolCall(args = {}) {
  const command = String(args.command || '').trim();
  try {
    switch (command) {
      case 'auto_selection_queue_status':
        return await autoSelectionQueueStatus(args);
      case 'auto_selection_write_run_file':
        return await autoSelectionWriteRunFile(args);
      case 'auto_selection_read_run_file':
        return await autoSelectionReadRunFile(args);
      case 'auto_selection_prepare_dispatch':
        return await autoSelectionPrepareDispatch(args);
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
            'auto_selection_queue_status',
            'auto_selection_write_run_file',
            'auto_selection_read_run_file',
            'auto_selection_prepare_dispatch',
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

async function initialize(config = {}) {
  debugMode = config.DebugMode === true;
  configureAutoSelectionRuntime(config);
  await ensureAutoSelectionRunDirs();
  console.log('[AutoProductSelection] Plugin initialized.');
}

function shutdown() {
  debugLog('Plugin shutdown.');
}

module.exports = {
  initialize,
  processToolCall,
  shutdown
};
