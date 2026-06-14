# AutoProductSelection

`AutoProductSelection` is a workflow-orchestration plugin for automated product research. It does not scrape marketplaces by itself. Instead, it manages a file-based state machine, worker locks, AgentAssistant delegation prompts, and result handoff files.

The plugin is designed to be reusable by the community. The public version uses generic roles:

- `Coordinator`: owns strategy, creates briefs, dispatches workers, and archives outcomes.
- `ProductSelectionScout`: reads briefs and gathers evidence through `ProductSelector`.
- `ProductSelectionReviewer`: reviews evidence and writes scored decisions.

You can rename the actual AgentAssistant agents through config.

## Responsibilities

AutoProductSelection manages:

- `runs/brief`
- `runs/raw`
- `runs/scored`
- `runs/failed`
- `runs/archived`
- `runs/locks`
- worker locks and missing-output diagnostics
- dispatch payloads for AgentAssistant
- cleanup and archive flows

`ProductSelector` or another external data plugin should provide marketplace/product data.

## Directory Layout

```text
Plugin/AutoProductSelection/
  AutoProductSelection.js
  plugin-manifest.json
  README.md
  SELECTION_LOGIC.md
  AutoSelectionStrategyProfile.md
  AutoSelectionStrategyProfile.md.example
  runs/
    README.md
    brief/
    raw/
    scored/
    failed/
    archived/
    locks/
```

The `runs/` directory is runtime data. For public repositories, commit only `.gitkeep` placeholders or a short README, not real research outputs.

## Agent Configuration

Default worker agent names:

```env
AUTO_SELECTION_SCOUT_AGENT_NAME=ProductSelectionScout
AUTO_SELECTION_REVIEWER_AGENT_NAME=ProductSelectionReviewer
```

Optional task-file prefixes used to diagnose workers that completed without writing a handoff file:

```env
AUTO_SELECTION_SCOUT_TASK_PREFIXES=APS_SCOUT_,ProductSelectionScout_
AUTO_SELECTION_REVIEWER_TASK_PREFIXES=APS_REVIEWER_,ProductSelectionReviewer_
```

If you use custom AgentAssistant names, put these values in root `config.env` or a plugin-level config file according to your VCP deployment rules.

## Core Workflow

1. Coordinator reads queue state with `auto_selection_queue_status`.
2. If no active run exists, Coordinator reads `AutoSelectionStrategyProfile.md` and creates a SelectionBrief.
3. Coordinator calls `auto_selection_prepare_dispatch(worker=hawkeye)` to create a brief/lock and receive an AgentAssistant request for the scout agent.
4. Scout reads the brief, gathers evidence through `ProductSelector`, and writes `raw` or `failed`.
5. Coordinator reviews the queue. If raw is ready, it calls `auto_selection_prepare_dispatch(worker=forge)` for the reviewer agent.
6. Reviewer reads raw evidence and writes `scored` or `failed`.
7. Coordinator decides whether to publish, loop back for more evidence, archive, or mark failed.

The internal worker names are still `hawkeye` and `forge` for command compatibility, but the AgentAssistant display names are configurable.

## Commands

All commands use `tool_name: AutoProductSelection`.

- `auto_selection_queue_status`
- `auto_selection_write_run_file`
- `auto_selection_read_run_file`
- `auto_selection_prepare_dispatch`
- `auto_selection_move_run_file`
- `auto_selection_delete_run_file`
- `auto_selection_cleanup_run`
- `auto_selection_mark_worker_missing_output`
- `auto_selection_clear_locks`
- `get_status`

`auto_selection_read_run_file` only reads files inside `runs/`. `AutoSelectionStrategyProfile.md` is a plugin-root strategy file and should be read with a normal file-reading tool, not as a run file.

## Strategy File

Use:

```text
Plugin/AutoProductSelection/AutoSelectionStrategyProfile.md
```

for your current product-research strategy. Keep it generic if you publish the repository. Store private brand, supplier, budget, or account-specific preferences in a local ignored copy.

## Public Repository Hygiene

Do not commit:

- real `runs/archived` research outputs
- private strategy files
- marketplace account data
- supplier data
- brand names or internal agent names
- generated evidence packs that contain ASIN/SKU/search-term datasets

Commit:

- plugin source
- manifest
- generic README and strategy template
- `.gitkeep` placeholders for runtime folders

## Quick Check

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AutoProductSelection「末」,
command:「始」get_status「末」
<<<[END_TOOL_REQUEST]>>>
```

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AutoProductSelection「末」,
command:「始」auto_selection_queue_status「末」
<<<[END_TOOL_REQUEST]>>>
```
