// Repro test for the comparability / self-consistency / ad-wash safety valve.
// Models two real failures:
//  1. Spice Drawer Organizer: optimistic paid_traffic_ratio (0.45) asserted without
//     comparable-anchor reverse-lookup evidence + a not_comparable Top anchor as basis.
//  2. Solar Lantern (APS-20260626-144535): the SAME wash, but emitted as a NESTED
//     paid_traffic_ratio_basis object with a single source anchor (the contested Top1),
//     which the legacy flat-only parser silently missed -> published RECOMMEND/76.
// Asserts: the backend reads both flat AND nested shapes, requires >=2 distinct anchors,
// clamps the ratio back, flags distortion+ad-wash, loops back when budget allows, and
// terminally DOWNGRADES to WATCHLIST under force_decision instead of publishing RECOMMEND.
const assert = require('assert');
const plugin = require('./AutoProductSelection.js');
const { calculateScoringModel, decideBackendAction } = plugin;

// Shared healthy economics so the ONLY thing under test is the ad-ratio wash.
// selling_price 25, costs leave a positive unit contribution; raw CVR + ppc make
// the full-CPA ad ratio upside-down, and only a lowered paid_traffic_ratio can rescue it.
function fixture({ paidRatio, basis, anchorComparability }) {
  return `---
scored_candidate_pack:
  final_disposition:
    verdict: RECOMMEND
  post_forge_action:
    action: PUBLISH_FINAL
score_inputs:
  demand_score: 82
  growth_score: 75
  differentiation_score: 78
  market_entry_score: 70
  competition_severity: 4
  compliance_risk: 1
  complexity_severity: 3
  data_reliability_score: 72
  execution_fit_score: 72
  listing_leverage_score: 0.7
financial_factors:
  selling_price: 25.00
  bom_cost: 6.00
  shipping_cost: 2.00
  fba_fee: 4.00
  referral_fee: 3.75
  packaging_cost: 0.75
  return_reserve: 1.25
  coupon_cost: 1.25
  storage_reserve: 0.50
  raw_click_conversion_rate: 0.10
  ppc_bid: 1.40
  paid_traffic_ratio: ${paidRatio}
${basis ? `  paid_traffic_ratio_basis: ${basis}` : ''}
comparable_anchors:
  - asin: B09K7CVJ89
    form_factor: silicone_mat
    comparability: ${anchorComparability}
    reason: "Top1 是硅胶防滑垫，与4层伸缩竹架形态不同类"
---
`;
}

// Models the Solar Lantern shape: ratio nested under the basis object + single source anchor.
function nestedFixture({ basisClassification, sourceAsins }) {
  return `---
scored_candidate_pack:
  final_disposition:
    verdict: RECOMMEND
  post_forge_action:
    action: PUBLISH_FINAL
score_inputs:
  demand_score: 82
  growth_score: 76
  differentiation_score: 80
  market_entry_score: 76
  competition_severity: 4
  compliance_risk: 2
  complexity_severity: 4
  data_reliability_score: 72
  execution_fit_score: 70
  listing_leverage_score: 0.7
financial_factors:
  selling_price: 39.99
  bom_cost: 14.00
  shipping_cost: 2.00
  fba_fee: 7.00
  referral_fee: 6.00
  raw_click_conversion_rate: 0.0678
  ppc_bid: 1.10
comparable_anchors:
  - {asin: B0BTY14F3P, comparability: comparable, role: "Top1主锚"}
paid_traffic_ratio_basis:
  value: 0.45
  classification: ${basisClassification}
  source_asins: ${JSON.stringify(sourceAsins)}
---
`;
}

function run() {
  console.log('=== Comparability / self-consistency / ad-wash safety valve ===\n');

  // --- Scenario A: optimistic ratio WITHOUT anchor evidence + not_comparable anchor ---
  const bad = fixture({ paidRatio: 0.45, basis: null, anchorComparability: 'not_comparable' });
  const badScore = calculateScoringModel(bad);
  assert.strictEqual(badScore.paidTrafficRatio, 0.6,
    `expected clamp back to 0.6, got ${badScore.paidTrafficRatio}`);
  console.log('  ✓ unsupported paid_traffic_ratio=0.45 clamped back to 0.6');

  assert.strictEqual(badScore.dataDistortionSuspected, true,
    'expected data_distortion_suspected=true');
  console.log('  ✓ data_distortion_suspected flagged');
  assert.ok(badScore.distortionSignals.some(s => s.includes('paid_traffic_ratio')),
    'expected a paid_traffic_ratio clamp signal');
  assert.ok(badScore.distortionSignals.some(s => s.includes('not_comparable') || s.includes('可比')),
    'expected a comparability contradiction signal');
  console.log('  ✓ clamp + comparability contradiction signals present');

  const badAction = decideBackendAction('PUBLISH_FINAL', badScore, bad, 0, false);
  assert.strictEqual(badAction, 'LOOPBACK_TO_HAWKEYE',
    `expected LOOPBACK_TO_HAWKEYE, got ${badAction}`);
  console.log('  ✓ RECOMMEND + distortion routed to LOOPBACK_TO_HAWKEYE (not published)');

  // --- Scenario B (control): same numbers, anchor-reverse-verified + >=2 distinct anchors ---
  const good = fixture({ paidRatio: 0.45, basis: 'anchor_reverse_verified\n  source_asins: [B0AAAA1111, B0BBBB2222]', anchorComparability: 'comparable' });
  const goodScore = calculateScoringModel(good);
  assert.strictEqual(goodScore.paidTrafficRatio, 0.45,
    `expected evidence-backed 0.45 to be accepted, got ${goodScore.paidTrafficRatio}`);
  console.log('  ✓ evidence-backed (>=2 anchors) paid_traffic_ratio=0.45 accepted');
  assert.strictEqual(goodScore.paidTrafficRatioEvidenceBacked, true,
    'expected paidTrafficRatioEvidenceBacked=true');
  assert.ok(!goodScore.distortionSignals.some(s => s.includes('paid_traffic_ratio')),
    'control should not raise a paid_traffic_ratio clamp signal');
  console.log('  ✓ control raises no clamp signal');

  // --- Scenario C: budget exhausted -> ad-wash downgrades to WATCHLIST (not silent publish) ---
  const exhaustedAction = decideBackendAction('PUBLISH_FINAL', badScore, bad, 99, false);
  assert.strictEqual(exhaustedAction, 'PUBLISH_AS_WATCHLIST',
    `expected terminal PUBLISH_AS_WATCHLIST when budget spent on an ad-wash, got ${exhaustedAction}`);
  console.log('  ✓ reselect budget exhausted on ad-wash -> terminal PUBLISH_AS_WATCHLIST');

  // --- Scenario D: NESTED basis object + single source anchor (the Solar Lantern bug) ---
  const nestedSingle = nestedFixture({ basisClassification: 'anchor_reverse_verified_conservative', sourceAsins: ['B0BTY14F3P'] });
  const nestedScore = calculateScoringModel(nestedSingle);
  assert.strictEqual(nestedScore.paidTrafficRatio, 0.6,
    `nested single-anchor 0.45 should clamp to 0.6, got ${nestedScore.paidTrafficRatio}`);
  console.log('  ✓ nested paid_traffic_ratio_basis.value=0.45 is now SEEN (not silently missed)');
  assert.strictEqual(nestedScore.paidTrafficRatioEvidenceBacked, false,
    'single anchor must not count as evidence-backed');
  assert.strictEqual(nestedScore.adWashSuspected, true, 'expected adWashSuspected=true');
  assert.ok(nestedScore.distortionSignals.some(s => s.includes('平行验证') || s.includes('≥2')),
    'expected a >=2-anchor parallel-verification signal');
  console.log('  ✓ single anchor rejected: needs >=2 distinct comparable anchors');

  // force_decision (the exact state the failing run was in) -> WATCHLIST, not RECOMMEND publish.
  const nestedForce = decideBackendAction('PUBLISH_FINAL', nestedScore, nestedSingle, 0, true);
  assert.strictEqual(nestedForce, 'PUBLISH_AS_WATCHLIST',
    `force_decision ad-wash should downgrade to WATCHLIST, got ${nestedForce}`);
  console.log('  ✓ force_decision ad-wash -> PUBLISH_AS_WATCHLIST (evidence/verdict separation)');

  // --- Scenario E (control): nested basis with 2 distinct anchors -> accepted ---
  const nestedDouble = nestedFixture({ basisClassification: 'anchor_reverse_verified', sourceAsins: ['B0AAAA1111', 'B0BBBB2222'] });
  const nestedDoubleScore = calculateScoringModel(nestedDouble);
  assert.strictEqual(nestedDoubleScore.paidTrafficRatio, 0.45,
    `nested 2-anchor 0.45 should be accepted, got ${nestedDoubleScore.paidTrafficRatio}`);
  assert.strictEqual(nestedDoubleScore.paidTrafficRatioEvidenceBacked, true,
    'two distinct anchors should count as evidence-backed');
  console.log('  ✓ nested basis with 2 distinct anchors accepted');

  console.log('\n=== ALL COMPARABILITY GUARD TESTS PASSED ===');
}

run();

