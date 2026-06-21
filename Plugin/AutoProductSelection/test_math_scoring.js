// Test AutoProductSelection v2 mathematical scoring and safety guards.
const path = require('path');
const fs = require('fs').promises;

const mockPluginManager = {
  getServiceModule: (name) => {
    if (name === 'AgentAssistant') {
      return {
        processToolCall: async () => ({ success: true, delegation_id: 'mock-delegation' }),
        listDelegations: () => []
      };
    }
    return null;
  }
};

const RUN_ID = 'APS-TEST-MATH-999999-v2';

async function readScored() {
  return fs.readFile(path.join(__dirname, 'runs', 'scored', `${RUN_ID}-scored.md`), 'utf8');
}

async function runMathScoringTest() {
  console.log('=== AutoProductSelection v2 Math Scoring Test ===\n');

  const plugin = require('./AutoProductSelection.js');
  await plugin.initialize({ DebugMode: true }, { pluginManager: mockPluginManager });

  const cleanup = async () => {
    await plugin.processToolCall({ command: 'auto_selection_cleanup_run', run_id: RUN_ID }).catch(() => {});
  };

  try {
    await cleanup();

    await plugin.processToolCall({
      command: 'auto_selection_write_run_file',
      run_id: RUN_ID,
      stage: 'raw',
      content: `---
run_status: SUCCESS
run_id: ${RUN_ID}
raw_data_pack:
  data_audit_inputs:
    tools_called:
      - tool: run_sellersprite_keyword_conversion_rate
        status: SUCCESS
---
# Mock Raw Data Pack
`
    });

    console.log('Scenario A: v2 recommend path keeps PUBLISH_FINAL and injects conservative CVR math.');
    const healthyScored = `---
scored_candidate_pack:
  final_disposition:
    verdict: RECOMMEND
  post_forge_action:
    action: PUBLISH_FINAL
  hard_gates:
    passed: true
  scores:
    data_reliability_score: 92
    execution_fit_score: 88
  score_inputs:
    demand_score: 92
    growth_score: 82
    differentiation_score: 90
    market_entry_score: 88
    competition_severity: 2
    compliance_risk: 1
    complexity_severity: 2
  financial_factors:
    selling_price: 39.99
    bom_cost: 6.0
    shipping_cost: 2.0
    fba_fee: 6.0
    referral_fee: 6.0
    packaging_cost: 0.8
    return_reserve: 0.8
    coupon_cost: 0.5
    storage_reserve: 0.3
    raw_click_conversion_rate: 0.10
    raw_ppc_bid: 0.25
demand_volume: 23
differentiation_feasibility: 22
competition_severity: 2
compliance_risk: 1
complexity_severity: 2
data_confidence: 3
---
# Mock Healthy Scored Candidate Pack
`;

    await plugin.processToolCall({
      command: 'auto_selection_write_run_file',
      run_id: RUN_ID,
      stage: 'scored',
      content: healthyScored,
      overwrite: true
    });
    let scoredContent = await readScored();
    if (!scoredContent.includes('backend_math_validation_v2:')) throw new Error('Missing backend_math_validation_v2 block.');
    if (!scoredContent.includes('base_cvr: 0.0500')) throw new Error('CVR conservative base adjustment was not written.');

    const resultA = await plugin.processToolCall({
      command: 'auto_selection_apply_reviewer_decision',
      run_id: RUN_ID
    });
    if (resultA.action !== 'PUBLISH_FINAL') throw new Error(`Expected PUBLISH_FINAL, got ${resultA.action}`);
    console.log('✓ Scenario A passed');

    console.log('Scenario B: missing critical data can still publish WATCHLIST/DATA_INSUFFICIENT report without old <75 auto-drop.');
    const watchlistScored = `---
scored_candidate_pack:
  final_disposition:
    verdict: WATCHLIST
  post_forge_action:
    action: PUBLISH_FINAL
  hard_gates:
    passed: true
  scores:
    opportunity_score: 72
    data_reliability_score: 52
    execution_fit_score: 70
  score_inputs:
    competition_severity: 4
    compliance_risk: 2
    complexity_severity: 4
  financial_factors:
    selling_price: 29.99
demand_volume: 16
differentiation_feasibility: 16
competition_severity: 4
compliance_risk: 2
complexity_severity: 4
data_confidence: 1
---
# Mock Watchlist With Missing Data
`;

    await plugin.processToolCall({
      command: 'auto_selection_write_run_file',
      run_id: RUN_ID,
      stage: 'scored',
      content: watchlistScored,
      overwrite: true
    });
    scoredContent = await readScored();
    if (!scoredContent.includes('missing_critical_fields:')) throw new Error('Missing critical field audit was not written.');
    const resultB = await plugin.processToolCall({
      command: 'auto_selection_apply_reviewer_decision',
      run_id: RUN_ID
    });
    if (resultB.action !== 'PUBLISH_FINAL') throw new Error(`Expected WATCHLIST publication to remain PUBLISH_FINAL, got ${resultB.action}`);
    console.log('✓ Scenario B passed');

    console.log('Scenario C: unfetchable gap blocks repeated LOOPBACK and prepares force-decision reviewer.');
    await cleanup();
    await plugin.processToolCall({
      command: 'auto_selection_write_run_file',
      run_id: RUN_ID,
      stage: 'raw',
      content: `---
run_status: PARTIAL
run_id: ${RUN_ID}
raw_data_pack:
  data_audit_inputs:
    tools_called:
      - tool: run_sellersprite_keyword_conversion_rate
        status: EMPTY
    unfetchable_gaps:
      - field: click_conversion_rate
        reason: SellerSprite not indexed after parent keyword retry
---
# Mock Raw With Unfetchable Gap
`
    });
    const loopbackScored = `---
scored_candidate_pack:
  final_disposition:
    verdict: RESEARCH_GAP
  post_forge_action:
    action: LOOPBACK_TO_SCOUT
  loopback_request:
    gap_type: Critical
    missing_field: click_conversion_rate
    requested_tool: run_sellersprite_keyword_conversion_rate
    target_keywords: cold niche keyword
    required_fields: click_conversion_rate, ppc_bid
    max_additional_tool_calls: 1
    stop_after_this_loop: true
  hard_gates:
    passed: true
  scores:
    opportunity_score: 70
    data_reliability_score: 38
    execution_fit_score: 70
---
# Mock Loopback Request
`;
    await plugin.processToolCall({
      command: 'auto_selection_write_run_file',
      run_id: RUN_ID,
      stage: 'scored',
      content: loopbackScored,
      overwrite: true
    });
    const resultLoopback = await plugin.processToolCall({
      command: 'auto_selection_apply_reviewer_decision',
      run_id: RUN_ID
    });
    if (resultLoopback.state_transition !== 'loopback_denied_force_review_prepared') {
      throw new Error(`Expected loopback_denied_force_review_prepared, got ${resultLoopback.state_transition}`);
    }
    console.log('✓ Scenario C passed');

    await cleanup();
    await plugin.processToolCall({
      command: 'auto_selection_write_run_file',
      run_id: RUN_ID,
      stage: 'raw',
      content: `---
run_status: SUCCESS
run_id: ${RUN_ID}
raw_data_pack:
  data_audit_inputs:
    tools_called:
      - tool: run_sellersprite_keyword_conversion_rate
        status: SUCCESS
---
# Mock Raw Data Pack
`
    });

    console.log('Scenario D: Hard Gate overrides a bad RECOMMEND to DROP_AND_RESELECT.');
    const hardGateScored = `---
scored_candidate_pack:
  final_disposition:
    verdict: RECOMMEND
  post_forge_action:
    action: PUBLISH_FINAL
  hard_gates:
    passed: false
    triggered_gates:
      - FDA/medical claim
  scores:
    data_reliability_score: 90
    execution_fit_score: 90
  score_inputs:
    demand_score: 95
    growth_score: 90
    differentiation_score: 90
    market_entry_score: 90
    competition_severity: 1
    compliance_risk: 10
    complexity_severity: 2
  financial_factors:
    selling_price: 49.99
    bom_cost: 8
    shipping_cost: 3
    fba_fee: 7
    raw_click_conversion_rate: 0.12
    raw_ppc_bid: 0.3
demand_volume: 24
differentiation_feasibility: 24
competition_severity: 1
compliance_risk: 10
complexity_severity: 2
data_confidence: 3
---
# Mock Hard Gate
`;

    await plugin.processToolCall({
      command: 'auto_selection_write_run_file',
      run_id: RUN_ID,
      stage: 'scored',
      content: hardGateScored,
      overwrite: true
    });
    const resultC = await plugin.processToolCall({
      command: 'auto_selection_apply_reviewer_decision',
      run_id: RUN_ID
    });
    if (resultC.action !== 'DROP_AND_RESELECT') throw new Error(`Expected DROP_AND_RESELECT, got ${resultC.action}`);
    console.log('✓ Scenario D passed');

    console.log('\n=== ALL V2 MATH TESTS PASSED ===');
  } finally {
    await cleanup();
    await plugin.shutdown();
  }
}

runMathScoringTest().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});
