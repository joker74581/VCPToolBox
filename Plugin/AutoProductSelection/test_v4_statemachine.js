// v4 state-machine lifecycle simulation. Mocks AgentAssistant so we can drive the full
// PENDING_BRIEF -> BRIEFING -> SCOUTING -> SCORING -> EVALUATING -> PUBLISHING -> DONE path and assert
// no duplicate publishes, correct transitions, and idempotent terminal publish.
const fs = require('fs').promises;
const path = require('path');

let passed = 0, failed = 0;
function check(name, cond, extra = '') { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, extra); } }

const RUN_DIR = path.join(__dirname, 'runs');
const STATE_DIR = path.join(RUN_DIR, 'state');
const AGENT_TASK_DIR = path.join(__dirname, '..', '..', 'file', 'document', 'AgentTask');
const ALLOW_ACTIVE_RUNS = process.env.ALLOW_APS_TEST_ON_ACTIVE_RUNS === '1';

// Track what the mock coordinator/worker was asked to do.
const dispatchLog = [];
const testAgentTaskFiles = [];

const mockPluginManager = {
  getServiceModule: (name) => {
    if (name !== 'AgentAssistant') return null;
    return {
      listDelegations: () => [],
      processToolCall: async (a) => {
        dispatchLog.push({ agent: a.agent_name, prompt: a.prompt });
        return { success: true, delegation_id: 'mock' };
      }
    };
  }
};

async function readState(plugin, runId) {
  try { return JSON.parse(await fs.readFile(path.join(STATE_DIR, `${runId}.state.json`), 'utf8')); }
  catch { return null; }
}

async function writeAgentTask(agentName, delegationId, runId, report, status = 'Succeed') {
  await fs.mkdir(AGENT_TASK_DIR, { recursive: true });
  const filePath = path.join(AGENT_TASK_DIR, `${agentName}_${delegationId}.md`);
  const content = `# 委托任务归档报告: ${delegationId}

- **执行者:** ${agentName}
- **生成时间:** 2026-06-24 00:00
- **任务状态:** ${status}

## 原始委托要求

> run_id: ${runId}

---

## 最终执行结果

${report}
`;
  await fs.writeFile(filePath, content, 'utf8');
  testAgentTaskFiles.push(filePath);
  return filePath;
}

async function cleanupTestAgentTasks() {
  for (const filePath of testAgentTaskFiles.splice(0)) {
    await fs.unlink(filePath).catch(() => {});
  }
}

async function assertNoActiveRunsBeforeTest() {
  if (ALLOW_ACTIVE_RUNS) return;
  let activeRuns = [];
  try {
    activeRuns = (await fs.readdir(STATE_DIR))
      .filter(name => name.endsWith('.state.json'))
      .map(name => name.replace(/\.state\.json$/, ''));
  } catch (_) {
    activeRuns = [];
  }
  if (activeRuns.length) {
    throw new Error(`Refusing to run destructive AutoProductSelection test while active run state exists: ${activeRuns.join(', ')}. Set ALLOW_APS_TEST_ON_ACTIVE_RUNS=1 only in a disposable test workspace.`);
  }
}

async function run() {
  console.log('=== v4 State Machine Lifecycle Simulation ===\n');
  await assertNoActiveRunsBeforeTest();
  const plugin = require('./AutoProductSelection.js');
  const T = plugin.__test__;
  const testConfig = {
    DebugMode: false,
    AUTO_SELECTION_SCOUT_AGENT_NAME: '破壁_鹰眼',
    AUTO_SELECTION_REVIEWER_AGENT_NAME: '破壁_熔炉',
    AUTO_SELECTION_SCOUT_TASK_PREFIXES: 'APS_SCOUT_,破壁_鹰眼_',
    AUTO_SELECTION_REVIEWER_TASK_PREFIXES: 'APS_REVIEWER_,破壁_熔炉_'
  };
  await plugin.initialize(testConfig, { pluginManager: mockPluginManager });

  // Clean slate
  await plugin.processToolCall({ command: 'auto_selection_abort_workflow' });

  // 1. Trigger a new round -> BRIEFING, then extract coordinator AgentTask -> SCOUTING.
  console.log('Scenario 1: trigger creates BRIEFING and extracts coordinator brief');
  const trig = await plugin.processToolCall({ command: 'auto_selection_trigger_run' });
  check('trigger mode=new', trig.mode === 'new', JSON.stringify(trig));
  const runId = trig.run_id;
  await T.workflowDriver('watchdog');
  let st = await readState(plugin, runId);
  check('run advanced to BRIEFING after brief dispatch', st && st.status === 'BRIEFING', st && st.status);
  check('coordinator was dispatched for brief', dispatchLog.some(d => d.agent === '破壁_枢纽'), JSON.stringify(dispatchLog));
  await writeAgentTask('破壁_枢纽', 'aa-delegation-test-brief', runId, `# SelectionBrief - ${runId}

run_id: ${runId}
候选方向:
- 方向 A: test organizer | seed: test organizer
`);
  await T.workflowDriver('watchdog');
  st = await readState(plugin, runId);
  check('coordinator AgentTask -> brief -> SCOUTING', st && st.status === 'SCOUTING', st && st.status);
  const scoutDispatch = dispatchLog.filter(d => d.agent === '破壁_鹰眼').at(-1);
  check('scout prompt includes backend-loaded brief', scoutDispatch && scoutDispatch.prompt.includes(`SelectionBrief - ${runId}`), scoutDispatch && scoutDispatch.prompt.slice(0, 200));

  // 2. Simulate scout completion report -> backend extracts raw -> SCORING.
  console.log('Scenario 2: scout AgentTask raw -> SCORING');
  await writeAgentTask('破壁_鹰眼', 'aa-delegation-test-raw', runId, `\`\`\`yaml
raw_data_pack:
  route_decision:
    action: READY_FOR_FORGE
  data_audit_inputs:
    tools_called:
      - tool: x
        status: SUCCESS
\`\`\`
`);
  await T.workflowDriver('watchdog');
  st = await readState(plugin, runId);
  check('raw AgentTask -> SCORING', st && st.status === 'SCORING', st && st.status);
  const forgeDispatch = dispatchLog.filter(d => d.agent === '破壁_熔炉').at(-1);
  check('forge prompt includes backend-loaded raw', forgeDispatch && forgeDispatch.prompt.includes('raw_data_pack:'), forgeDispatch && forgeDispatch.prompt.slice(0, 200));

  // 3. Simulate forge completion report -> backend extracts scored -> PUBLISHING.
  console.log('Scenario 3: forge AgentTask scored -> backend decides -> PUBLISHING');
  await writeAgentTask('破壁_熔炉', 'aa-delegation-test-scored', runId, `\`\`\`yaml
scored_candidate_pack:
  final_disposition: { verdict: RECOMMEND }
  post_forge_action: { action: PUBLISH_FINAL }
  hard_gates: { passed: true }
  score_inputs:
    demand_score: 85
    growth_score: 80
    differentiation_score: 80
    market_entry_score: 80
    competition_severity: 2
    compliance_risk: 1
    complexity_severity: 2
    data_reliability_score: 88
    execution_fit_score: 85
  financial_factors:
    selling_price: 39
    bom_cost: 6
    fba_fee: 5
    raw_click_conversion_rate: 0.09
    raw_ppc_bid: 0.4
listing_leverage_score: 0.8
\`\`\`
`);
  await T.workflowDriver('watchdog');
  await T.workflowDriver('watchdog');
  st = await readState(plugin, runId);
  check('scored -> terminal publish path (publish flags set)', st && ['PUBLISHING', 'DONE'].includes(st.status) && st.publish_flags.post_published, st && st.status);
  const publishDispatches = dispatchLog.filter(d => d.prompt.includes('研报') || d.prompt.includes('发布')).length;

  // 4. Idempotency: fire the tick again repeatedly; must NOT re-dispatch a second publish.
  console.log('Scenario 4: repeated ticks do NOT duplicate publish');
  const dispatchCountBefore = dispatchLog.length;
  // Simulate coordinator completion by re-triggering ticks (as watchdog would).
  for (let i = 0; i < 3; i++) {
    await plugin.processToolCall({ command: 'auto_selection_queue_status' }).catch(() => {});
    await new Promise(r => setTimeout(r, 50));
  }
  // Manually drive archive by simulating the coordinator finished (flags already set) -> next advance archives.
  // Trigger one more advance cycle:
  await plugin.processToolCall({ command: 'auto_selection_trigger_run' }).catch(() => {});
  await new Promise(r => setTimeout(r, 500));
  st = await readState(plugin, runId);
  // After flags set, advancePublishing should archive -> DONE (or still PUBLISHING if claim race; both not duplicate)
  const publishDispatchesAfter = dispatchLog.filter(d => d.prompt.includes('研报') || d.prompt.includes('发布')).length;
  check('no duplicate publish dispatch', publishDispatchesAfter <= publishDispatches + 0 || publishDispatchesAfter === publishDispatches, `before=${publishDispatches} after=${publishDispatchesAfter}`);

  await plugin.processToolCall({ command: 'auto_selection_abort_workflow' });
  await cleanupTestAgentTasks();
  await plugin.shutdown();

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
}

run()
  .then(() => runTimeoutTest())
  .then(() => process.exit(failed === 0 && process.exitCode !== 1 ? 0 : 1))
  .catch(e => { console.error('SIM ERROR:', e); process.exit(1); });

// Scenario 5 (appended): worker timeout -> retry up to non-system cap (3) -> FAILED.
// Guards the production hang where a scout 500s without writing raw/failed: the run must
// not sit in SCOUTING forever; the watchdog times it out, retries, then blocks at the cap.
async function runTimeoutTest() {
  const fs = require('fs').promises;
  const plugin = require('./AutoProductSelection.js');
  const T = plugin.__test__;
  let p = 0, f = 0; const ck = (n, c, e='') => { c ? (p++, console.log('  ✓', n)) : (f++, console.log('  ✗', n, e)); };
  let dispatches = 0;
  const mpm = { getServiceModule: (n) => n === 'AgentAssistant' ? { listDelegations: () => [], processToolCall: async () => { dispatches++; return { success: true, delegation_id: 'm' }; } } : null };
  await plugin.initialize({
    DebugMode: false,
    AUTO_SELECTION_SCOUT_AGENT_NAME: '破壁_鹰眼',
    AUTO_SELECTION_REVIEWER_AGENT_NAME: '破壁_熔炉'
  }, { pluginManager: mpm });
  await plugin.processToolCall({ command: 'auto_selection_abort_workflow' });
  console.log('\nScenario 5: worker timeout retries then FAILED at non-system cap');
  const id = 'APS-TEST-TIMEOUT-scout';
  await fs.writeFile(path.join(STATE_DIR, '..', 'brief', id + '-brief.md'), '# SelectionBrief\n方向A\n').catch(()=>{});
  const oldTs = () => new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const mkStuck = async () => {
    let ft = { system_error_count: 0, nonsystem_error_count: 0, last_error: '' };
    try { ft = JSON.parse(await fs.readFile(path.join(STATE_DIR, id + '.state.json'), 'utf8')).failure_tracking; } catch {}
    const st = { run_id: id, status: 'SCOUTING', claimed_by: null, claimed_at: null, dispatched_at: oldTs(), created_at: oldTs(), updated_at: oldTs(), counters: { global_loopback: 0, scout_loopback: 0, reviewer_loopback: 0, reselect: 0, early_reject: 0 }, failure_tracking: ft, publish_flags: { post_published: false, diary_written: false, archived: false }, force_decision_mode: false, history: [] };
    await fs.writeFile(path.join(STATE_DIR, id + '.state.json'), JSON.stringify(st, null, 2));
  };
  const statuses = [];
  for (let i = 1; i <= 3; i++) { await mkStuck(); await T.sweepTimeouts(); await new Promise(r => setTimeout(r, 50)); statuses.push(JSON.parse(await fs.readFile(path.join(STATE_DIR, id + '.state.json'), 'utf8')).status); }
  ck('cycle1 retries (SCOUTING)', statuses[0] === 'SCOUTING', statuses[0]);
  ck('cycle2 retries (SCOUTING)', statuses[1] === 'SCOUTING', statuses[1]);
  ck('cycle3 hits cap (FAILED)', statuses[2] === 'FAILED', statuses[2]);
  await plugin.processToolCall({ command: 'auto_selection_abort_workflow' });
  await plugin.shutdown();
  console.log(`\n  [timeout test] ${p} passed, ${f} failed`);
  if (f > 0) process.exitCode = 1;
}
// Chain it after the main run() resolves (run() calls process.exit, so guard).
