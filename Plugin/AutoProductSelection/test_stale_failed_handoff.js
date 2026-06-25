const fs = require('fs').promises;
const path = require('path');

const plugin = require('./AutoProductSelection.js');

const RUN_DIR = path.join(__dirname, 'runs');
const STATE_DIR = path.join(RUN_DIR, 'state');
const RUN_ID = 'APS-TEST-STALEFAIL';
const RUN_IDS_TO_CLEAN = [RUN_ID, 'APS-TEST-STALE'];

const mockPluginManager = {
  getServiceModule: (name) => {
    if (name !== 'AgentAssistant') return null;
    return {
      listDelegations: () => [],
      processToolCall: async () => ({ success: true, delegation_id: 'mock-stale-failed' })
    };
  }
};

function runFile(stage, suffix, runId = RUN_ID) {
  return path.join(RUN_DIR, stage, `${runId}-${suffix}`);
}

async function cleanup() {
  for (const runId of RUN_IDS_TO_CLEAN) {
    await fs.rm(path.join(STATE_DIR, `${runId}.state.json`), { force: true });
    await fs.rm(runFile('brief', 'brief.md', runId), { force: true });
    await fs.rm(runFile('raw', 'raw.md', runId), { force: true });
    await fs.rm(runFile('scored', 'scored.md', runId), { force: true });
    await fs.rm(runFile('failed', 'failed.md', runId), { force: true });
    await fs.rm(path.join(RUN_DIR, 'locks', `${runId}-hawkeye.lock`), { force: true });
    await fs.rm(path.join(RUN_DIR, 'locks', `${runId}-forge.lock`), { force: true });
  }
}

async function readState() {
  return JSON.parse(await fs.readFile(path.join(STATE_DIR, `${RUN_ID}.state.json`), 'utf8'));
}

async function main() {
  await cleanup();
  await plugin.initialize({
    DebugMode: false,
    AUTO_SELECTION_SCOUT_AGENT_NAME: '破壁_鹰眼',
    AUTO_SELECTION_REVIEWER_AGENT_NAME: '破壁_熔炉'
  }, { pluginManager: mockPluginManager });

  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.mkdir(path.join(RUN_DIR, 'brief'), { recursive: true });
  await fs.mkdir(path.join(RUN_DIR, 'raw'), { recursive: true });
  await fs.mkdir(path.join(RUN_DIR, 'failed'), { recursive: true });

  const dispatchedAt = new Date().toISOString();
  await plugin.__test__.writeRunState({
    run_id: RUN_ID,
    status: 'SCOUTING',
    claimed_by: null,
    claimed_at: null,
    dispatched_at: dispatchedAt,
    created_at: dispatchedAt,
    updated_at: dispatchedAt,
    last_action: 'test',
    last_action_result: '',
    counters: { global_loopback: 0, scout_loopback: 0, reviewer_loopback: 0, reselect: 0, early_reject: 0 },
    failure_tracking: { system_error_count: 0, nonsystem_error_count: 0, last_error: '' },
    publish_flags: { post_published: false, diary_written: false, archived: false },
    force_decision_mode: false,
    history: []
  });

  await fs.writeFile(runFile('brief', 'brief.md'), '# SelectionBrief\n', 'utf8');
  const failedPath = runFile('failed', 'failed.md');
  await fs.writeFile(failedPath, 'old failed handoff', 'utf8');
  const oldDate = new Date(Date.now() - 60 * 60 * 1000);
  await fs.utimes(failedPath, oldDate, oldDate);

  await plugin.__test__.advanceRun(RUN_ID);
  let state = await readState();
  if (state.status !== 'SCOUTING') {
    throw new Error(`Expected stale failed handoff to be ignored; got ${state.status}`);
  }
  try {
    await fs.access(failedPath);
    throw new Error('Expected stale failed handoff to be removed');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  await fs.writeFile(runFile('raw', 'raw.md'), 'raw_data_pack:\n  route_decision:\n    action: READY_FOR_FORGE\n', 'utf8');
  await plugin.__test__.advanceRun(RUN_ID);
  state = await readState();
  if (state.status !== 'SCORING') {
    throw new Error(`Expected raw handoff to advance to SCORING; got ${state.status}`);
  }

  await cleanup();
  await plugin.shutdown();
  console.log('✓ stale failed handoff is ignored after redispatch');
}

main().catch(async (error) => {
  await cleanup().catch(() => {});
  await plugin.shutdown().catch(() => {});
  console.error(error);
  process.exit(1);
});
