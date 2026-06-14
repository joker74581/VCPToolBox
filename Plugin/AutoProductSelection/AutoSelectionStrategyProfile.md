# Auto Product Selection Strategy Profile

This public strategy profile is intentionally generic. Customize a private local copy for your own brand, budget, supplier constraints, marketplace account, or internal operating rules.

## Purpose

- Give the Coordinator a concise source of strategy when creating a new SelectionBrief.
- Keep strategy separate from runtime handoff files under `runs/`.
- Make the plugin usable without private seller or brand context.

## Default Marketplace And Budget

- `marketplace`: Amazon US
- `price_band`: 25-150 USD
- `capital_style`: small team, light inventory, limited upfront risk
- `target_candidate_window`: 1-3 candidates per run

## Exploration Theme

- `scan_theme`: open-ended product opportunity discovery within normal compliance and safety boundaries.
- `strategic_angle`: prefer products with clear use cases, observable pain points, and room for lightweight differentiation.
- `why_now`: identify ideas that can be quickly validated or rejected with accessible marketplace evidence.

## Preferred Opportunity Signals

- Clear customer pain point.
- Review complaints point to specific improvement opportunities.
- Reasonable logistics profile.
- Not dominated entirely by protected brands or heavy moats.
- Price supports margin after marketplace fees, shipping, returns, and ads.
- Evidence can be traced to concrete product examples, keywords, or market data.

## Negative Signals

- Very low price with little room for margin.
- Heavy, fragile, regulated, or high-liability product class.
- Strong brand monopoly with weak differentiation room.
- Requires complex certification, support, or supply-chain depth.
- Evidence is anecdotal and cannot be reproduced.

## Seed Keyword Guidance

- Provide at least three English seed keywords per new brief.
- Use varied angles: scenario, pain point, product form, target user, material, or use environment.
- Avoid three near-identical keywords.

## Output Preferences

- Start with a one-sentence conclusion.
- Explain why the opportunity is worth reviewing.
- For each candidate, include strengths, risks, evidence quality, and next validation steps.
- Keep an elimination log, but eliminate specific products, keywords, or sub-directions rather than entire broad categories.

## Commonly Tuned Fields

- `scan_theme`
- `strategic_angle`
- `why_now`
- preferred scenarios
- seed keyword style
- `price_band`
- positive and negative signals
