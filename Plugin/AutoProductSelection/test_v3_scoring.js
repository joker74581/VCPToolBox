// Unit test for the AutoProductSelection v3 scoring engine.
// Calls calculateScoringModel + decideBackendAction directly (no file IO, no plugin
// init) so it is a pure, fast math regression. Run: node test_v3_scoring.js
const plugin = require('./AutoProductSelection.js');
const { calculateScoringModel, decideBackendAction } = plugin;

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} -- ${detail || ''}`); }
}

function buildScored({ verdict = 'WATCHLIST', action = 'PUBLISH_FINAL', hardGates = true, triggered = '', scoreInputs = {}, financial = {}, extra = '' }) {
  const si = {
    demand_score: 60, growth_score: 55, differentiation_score: 55, market_entry_score: 60,
    competition_severity: 5, compliance_risk: 2, complexity_severity: 4,
    data_reliability_score: 65, execution_fit_score: 65, ...scoreInputs
  };
  const ff = {
    selling_price: 35.0, bom_cost: 7.0, shipping_cost: 2.5, fba_fee: 5.5, referral_fee: 5.25,
    raw_click_conversion_rate: 0.08, raw_ppc_bid: 0.9, ...financial
  };
  const fmt = (obj, indent) => Object.entries(obj).map(([k, v]) => `${indent}${k}: ${v}`).join('\n');
  return `---
scored_candidate_pack:
  final_disposition:
    verdict: ${verdict}
  post_forge_action:
    action: ${action}
  hard_gates:
    passed: ${hardGates}
${triggered ? `    triggered_gates:\n      - ${triggered}` : ''}
  scores:
${fmt({ data_reliability_score: si.data_reliability_score, execution_fit_score: si.execution_fit_score }, '    ')}
  score_inputs:
${fmt(si, '    ')}
  financial_factors:
${fmt(ff, '    ')}
${extra}
---
# Mock v3 scored
`;
}

function decide(content, reselect = 0, force = false) {
  const sr = calculateScoringModel(content);
  const action = decideBackendAction('PUBLISH_FINAL', sr, content, reselect, force);
  return { sr, action };
}

console.log('=== v3 Scoring Engine Test ===\n');

// Scenario 1: a thoroughly mediocre-but-legitimate product should NOT be force-dropped.
// Under the old multiplicative chain this landed ~25 and was dropped. v3 should
// publish it (WATCHLIST) for human validation.
console.log('Scenario 1: mediocre legitimate product -> publish (not drop)');
{
  const { sr, action } = decide(buildScored({}));
  check('scoringVersion is v3', sr.scoringVersion === 'v3', sr.scoringVersion);
  check('point estimate is mid-band (>=40)', sr.pointEstimate >= 40, `point=${sr.pointEstimate}`);
  check('not force-dropped', action !== 'DROP_AND_RESELECT', `action=${action} opt=${sr.optimisticScore} pess=${sr.pessimisticScore}`);
}

// Scenario 2: listing leverage. A scene/emotion-driven product (decor/toy, leverage=0.9)
// should score HIGHER than the same product framed as purely functional (leverage=0.05),
// because the seller's listing edge pays off only on 代入感 products.
console.log('\nScenario 2: listing leverage lifts 代入感 products, not functional ones');
{
  const base = { scoreInputs: { differentiation_score: 55 } };
  const sceney = decide(buildScored({ ...base, extra: 'listing_leverage_score: 0.9' })).sr;
  const functional = decide(buildScored({ ...base, extra: 'listing_leverage_score: 0.05' })).sr;
  check('scene product scores higher', sceney.pointEstimate > functional.pointEstimate,
    `scene=${sceney.pointEstimate} functional=${functional.pointEstimate}`);
  check('leverage recorded', sceney.listingLeverage === 0.9, `lev=${sceney.listingLeverage}`);
}

// Scenario 3: a genuinely strong, robust product publishes as-is (RECOMMEND stands).
console.log('\nScenario 3: strong robust product -> RECOMMEND stands');
{
  const { sr, action } = decide(buildScored({
    verdict: 'RECOMMEND',
    scoreInputs: { demand_score: 88, growth_score: 80, differentiation_score: 82, market_entry_score: 85,
      competition_severity: 2, compliance_risk: 1, complexity_severity: 2, data_reliability_score: 88, execution_fit_score: 88 },
    financial: { selling_price: 39.99, bom_cost: 6, shipping_cost: 2, fba_fee: 6, raw_click_conversion_rate: 0.10, raw_ppc_bid: 0.4 },
    extra: 'listing_leverage_score: 0.7'
  }));
  check('pessimistic clears recommend floor', sr.pessimisticScore >= 62, `pess=${sr.pessimisticScore}`);
  check('verdict stands (PUBLISH_FINAL)', action === 'PUBLISH_FINAL', `action=${action}`);
}

// Scenario 4: hard gate (compliance red line) force-drops regardless of score.
console.log('\nScenario 4: hard gate -> DROP_AND_RESELECT');
{
  const { action } = decide(buildScored({
    verdict: 'RECOMMEND', hardGates: false, triggered: 'FDA/medical claim',
    scoreInputs: { compliance_risk: 10 }
  }));
  check('hard gate drops', action === 'DROP_AND_RESELECT', `action=${action}`);
}

// Scenario 5: distorted ad data should not force-drop a possibly-good niche; it loops
// back once (budget permitting) instead.
console.log('\nScenario 5: distorted data -> loopback, not silent drop');
{
  const { sr, action } = decide(buildScored({
    verdict: 'RECOMMEND',
    financial: { selling_price: 30, raw_click_conversion_rate: 0.55, raw_ppc_bid: 0.5 } // CVR 55% = implausible
  }));
  check('distortion flagged', sr.dataDistortionSuspected === true, `distortion=${sr.dataDistortionSuspected}`);
  check('not dropped (loopback or publish)', action !== 'DROP_AND_RESELECT', `action=${action}`);
}

// Scenario 6: a near-dead pillar (negative unit contribution) still craters via hard gate.
console.log('\nScenario 6: negative unit contribution -> hard gate drop');
{
  const { sr, action } = decide(buildScored({
    financial: { selling_price: 12, bom_cost: 9, shipping_cost: 4, fba_fee: 5, referral_fee: 2 }
  }));
  check('hard gate triggered', sr.hardGateTriggered === true, `gate=${sr.hardGateTriggered}`);
  check('dropped', action === 'DROP_AND_RESELECT', `action=${action}`);
}

// Scenario 7: percent-aware rate parsing. A CVR written as "1%" must parse to 0.01,
// NOT 1.0 (100%). Regression for the >1 magnitude-guess boundary bug.
console.log('\nScenario 7: percent-aware CVR parsing (1% != 100%)');
{
  const mkCvr = (txt) => buildScored({ financial: { raw_click_conversion_rate: txt } });
  const rate = (txt) => calculateScoringModel(mkCvr(txt));
  check('"1%" -> 0.01', Math.abs(rate('1%').rawCvr - 0.01) < 1e-6, `got ${rate('1%').rawCvr}`);
  check('"1%" not flagged distorted', rate('1%').dataDistortionSuspected === false, `distort=${rate('1%').dataDistortionSuspected}`);
  check('"0.5%" -> 0.005', Math.abs(rate('0.5%').rawCvr - 0.005) < 1e-6, `got ${rate('0.5%').rawCvr}`);
  check('"55%" -> 0.55 still flagged', rate('55%').dataDistortionSuspected === true, `distort=${rate('55%').dataDistortionSuspected}`);
  check('bare "0.08" unchanged', Math.abs(rate('0.08').rawCvr - 0.08) < 1e-6, `got ${rate('0.08').rawCvr}`);
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);