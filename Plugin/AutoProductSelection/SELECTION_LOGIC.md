# AutoProductSelection State Machine

This document describes the public, reusable workflow contract for the `AutoProductSelection` plugin.

## Roles

The plugin uses three logical roles. You can map them to any AgentAssistant names.

| Logical role | Responsibility |
| --- | --- |
| Coordinator | Owns strategy, creates SelectionBrief files, dispatches workers, checks queue state, archives outcomes. |
| Scout | Reads `brief`, gathers product evidence through `ProductSelector`, writes `raw` or `failed`. |
| Reviewer | Reads `raw`, evaluates the evidence, writes `scored` or `failed`. |

Internal worker names remain:

- `hawkeye` for the Scout worker
- `forge` for the Reviewer worker

These names are command-level compatibility labels, not required public Agent names.

## Runtime Folders

```text
Plugin/AutoProductSelection/runs/
  brief/
  raw/
  scored/
  failed/
  archived/
  locks/
```

The filesystem is the source of truth. A verbal AgentAssistant response is not a completed handoff until the expected file exists.

## SelectionBrief

A brief should include:

- `run_id`
- research theme
- marketplace
- target price range
- seed keywords
- exclusion constraints
- evidence requirements
- maximum retry or loopback count
- expected output format

The Coordinator should create one focused brief per run.

## RawDataPack

The Scout writes `runs/raw/{run_id}-raw.md` when it has useful evidence.

Recommended fields:

- `run_id`
- `route_decision`
- `tool_decisions`
- `evidence_matrix`
- `asin_source_map`
- `candidate_products`
- `elimination_log`
- `execution_summary`

If evidence is insufficient, the Scout writes `runs/failed/{run_id}-failed.md`.

## ScoredCandidatePack

The Reviewer writes `runs/scored/{run_id}-scored.md` after evaluating raw evidence.

Recommended fields:

- `run_id`
- `final_disposition`
- `candidate_scores`
- `evidence_quality`
- `risk_assessment`
- `missing_data`
- `post_forge_action`

Common `final_disposition` values:

- `RECOMMEND`
- `PARTIAL`
- `DROP`
- `NEEDS_MORE_EVIDENCE`

Common `post_forge_action.action` values:

- `PUBLISH_FINAL`
- `LOOPBACK_TO_HAWKEYE`
- `DROP_AND_RESELECT`

## Normal Flow

1. Coordinator calls `auto_selection_queue_status`.
2. If no active run exists, Coordinator reads `AutoSelectionStrategyProfile.md`.
3. Coordinator writes a `brief`.
4. Coordinator calls `auto_selection_prepare_dispatch(worker=hawkeye)`.
5. Coordinator submits the returned `agent_assistant_request` to AgentAssistant.
6. Scout writes `raw` or `failed`.
7. Coordinator checks queue status again.
8. If raw is ready, Coordinator calls `auto_selection_prepare_dispatch(worker=forge)`.
9. Reviewer writes `scored` or `failed`.
10. Coordinator archives, loops back, or records failure.

## Loopback

Use loopback when the Reviewer finds a fixable evidence gap.

Recommended procedure:

1. Read `scored`.
2. Create an updated brief with specific missing evidence.
3. Delete or archive the old scored file according to your policy.
4. Dispatch Scout again for the same run or a clearly related run.

Avoid endless loops. A practical default is no more than 5 total rounds per run.

## Failure Handling

Use `auto_selection_mark_worker_missing_output` if queue status reports that a worker completed but did not write `raw`, `scored`, or `failed`.

Use `auto_selection_cleanup_run` to clear non-archived residue for a run.

Use `auto_selection_clear_locks` when a lock is stale or malformed.

## Public Repository Hygiene

Do not commit real runtime outputs:

- `runs/raw/*.md`
- `runs/scored/*.md`
- `runs/failed/*.md`
- `runs/archived/*.md`
- `runs/locks/*.lock`

Commit only source files, docs, templates, and `.gitkeep` placeholders.

Private strategy notes, supplier notes, brand details, marketplace account details, and internal agent names should stay in ignored local files.
