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
    return `请执行一次自动选品取证任务 (Scout Worker)。

run_id: ${safeRunId}
brief_stage: brief
success_stage: raw
failure_stage: failed

${callRhythmInstruction}

读取 brief 并基于其指示抓取数据。如果是回环补采，请保留旧数据合并写回 raw。
硬性边界：ProductSelector 数据命令最多 6 次。
注意：不要死板遵循固定流程。如果某个工具无数据，请参考工具返回的 next_actions 提示，灵活切换其他工具或放宽条件。如果确实抓不到数据，必须在工具状态中明确记录 FETCHED_EMPTY 并落入 failed。
成功或部分成功时写 raw_data_pack 到 raw；工具阻断或完全无数据写 failed。必须包含 route_decision、tool_decisions 等必要字段。${completionMarkerInstruction} 不要调用评审节点，不发论坛，不写 DailyNote。`;
  }

  if (worker === 'forge') {
    return `请执行一次自动选品证据评审任务 (Reviewer Worker)。

run_id: ${safeRunId}
raw_stage: raw
success_stage: scored
failure_stage: failed

${callRhythmInstruction}

读取 raw。审计取证节点 (Scout Worker) 交付的证据，输出 scored_candidate_pack。
全局判决准则：进行“全局拼图判定”。如果现有数据足以判断该批候选没潜力（如利润低、易碎），或者发现 Scout 明确标记了 FETCHED_EMPTY（抓取后无有效数据），请直接在 post_forge_action.action 中返回 DROP_AND_RESELECT，并附理由，让 Coordinator 彻底重选方向。
只有当产品有明显潜力，但确实缺失关键决策数据时，才使用 LOOPBACK_TO_SCOUT 打回补采。
核心证据充足时允许 PUBLISH_FINAL。${completionMarkerInstruction}`;
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
    '- 只调用 ProductSelector 补齐最关键的 1-3 个缺口。',
    '- 写回 raw 时保留旧 evidence_matrix、asin_source_map、elimination_log，并追加本轮补采记录。'
  ].join('\n');
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
    public_worker: publicWorkerRole(worker),
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
  return await autoSelectionMoveRunFile({
    run_id: runId,
    from_stage: fromStage,
    to_stage: 'archived'
  });
}

async function autoSelectionApplyForgeDecision(args = {}, commandName = 'auto_selection_apply_reviewer_decision') {
  await ensureAutoSelectionRunDirs();
  if (referencesStrategyProfile(args.run_id ?? args.runId)) {
    return strategyProfileMisuseResponse(commandName);
  }
  const runId = normalizeAutoSelectionRunId(args.run_id ?? args.runId);
  const scoredPath = resolveAutoSelectionFile('scored', runId);
  const scoredContent = String(args.scored_content ?? args.scoredContent ?? await fs.readFile(scoredPath, 'utf8'));
  const action = normalizeForgeAction(args.action || extractForgeAction(scoredContent) || '');

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
      const hasStatusEmptyOrSuccess = /status:\s*['"]?(EMPTY|SUCCESS|PARTIAL_SUCCESS|FETCHED_EMPTY|FETCHED)['"]?/i.test(rawContent);
      const hasToolsCalled = /data_tools_called:[\s\S]{1,50}-/.test(rawContent);
      if (!hasStatusEmptyOrSuccess && !hasToolsCalled) {
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
    } catch (e) {}
  }

  if (action === 'LOOPBACK_TO_HAWKEYE') {
    await fs.access(resolveAutoSelectionFile('raw', runId));
    const removedScored = await autoSelectionDeleteRunFile({ stage: 'scored', run_id: runId });
    const lockCleanup = await autoSelectionClearLocks({ run_id: runId });
    const dispatch = await autoSelectionPrepareDispatch({
      worker: 'hawkeye',
      run_id: runId,
      brief_content: String(args.brief_content ?? args.briefContent ?? buildLoopbackBrief(runId, scoredContent)),
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
      agent_assistant_request: dispatch.agent_assistant_request,
      next_actions: [
        'Call AgentAssistant with agent_assistant_request.',
        'Do not post forum or write DailyNote for a loopback.',
        'After AgentAssistant succeeds, output [[NextHeartbeat::120]].'
      ]
    };
  }

  if (action === 'DROP_AND_RESELECT') {
    const replacementBrief = args.brief_content ?? args.briefContent;
    const requestedNewRunId = args.new_run_id ?? args.newRunId ?? args.next_run_id ?? args.nextRunId;
    const nextRunId = replacementBrief != null && String(replacementBrief).trim()
      ? normalizeAutoSelectionRunId(requestedNewRunId || buildAutoSelectionRunIdFromBrief(replacementBrief))
      : runId;

    const removed = [];
    for (const stage of ['scored', 'raw', 'brief', 'failed']) {
      const result = await autoSelectionDeleteRunFile({ stage, run_id: runId });
      removed.push(result.removed);
    }
    const lockCleanup = await autoSelectionClearLocks({ run_id: runId });
    if (replacementBrief != null && String(replacementBrief).trim()) {
      const dispatch = await autoSelectionPrepareDispatch({
        worker: 'hawkeye',
        run_id: nextRunId,
        brief_content: String(replacementBrief),
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
        lock_cleanup: lockCleanup.removed || [],
        brief_written: true,
        cleanup_done: true,
        agent_assistant_request: dispatch.agent_assistant_request,
        message: 'DROP_AND_RESELECT complete. Old state cleaned. New brief written. Ready to dispatch new scout with the provided agent_assistant_request.'
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
      lock_cleanup: lockCleanup.removed || [],
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
      case 'auto_selection_apply_forge_decision':
      case 'auto_selection_apply_reviewer_decision':
        return await autoSelectionApplyForgeDecision(args, command);
      case 'auto_selection_archive_run':
        return await autoSelectionArchiveRun(args);
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
