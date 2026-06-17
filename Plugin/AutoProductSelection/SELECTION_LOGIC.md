# AutoProductSelection 状态机说明

本文档描述 `AutoProductSelection` 插件的公开、通用、可复用工作流契约。插件本身不抓取商品数据，只负责 runs 文件状态机、Worker 锁、AgentAssistant 派发负载和阶段交接。

## 角色

插件使用三个逻辑角色。你可以把它们映射到任意 AgentAssistant 角色名。

| 逻辑角色 | 职责 |
| --- | --- |
| Coordinator | 制定策略、创建 SelectionBrief、派发 Worker、检查队列状态、发布与归档结果。 |
| Scout | 读取 `brief`，通过 `ProductSelector` 或其他数据插件收集证据，写入 `raw` 或 `failed`。 |
| Reviewer | 读取 `raw`，评审证据，写入 `scored` 或 `failed`。 |

新集成建议使用公开 worker 名称：

- `scout`：证据收集 Worker。
- `reviewer`：证据评审 Worker。

兼容旧别名：

- `hawkeye` 等价于 `scout`。
- `forge` 等价于 `reviewer`。

## 运行目录

```text
Plugin/AutoProductSelection/runs/
  brief/
  raw/
  scored/
  failed/
  archived/
  locks/
```

文件系统是唯一状态源。AgentAssistant 的口头回复不算交付，只有预期阶段文件真实存在才算完成交接。

## SelectionBrief

`brief` 建议包含：

- `run_id`
- 研究主题
- 目标市场
- 目标价格带
- 种子关键词
- 排除约束
- 证据要求
- 最大重试或回环次数
- 期望输出格式

Coordinator 每次应只创建一个聚焦的 brief。

## RawDataPack

Scout 拿到有效证据后写入：

```text
runs/raw/{run_id}-raw.md
```

推荐字段：

- `run_id`
- `route_decision`
- `tool_decisions`
- `evidence_matrix`
- `asin_source_map`
- `candidate_products`
- `elimination_log`
- `execution_summary`

如果证据不足或工具阻断，Scout 写入：

```text
runs/failed/{run_id}-failed.md
```

## ScoredCandidatePack

Reviewer 评审 raw 后写入：

```text
runs/scored/{run_id}-scored.md
```

推荐字段：

- `run_id`
- `final_disposition`
- `candidate_scores`
- `evidence_quality`
- `risk_assessment`
- `missing_data`
- `post_forge_action`

常见 `final_disposition`：

- `RECOMMEND`
- `PARTIAL`
- `DROP`
- `NEEDS_MORE_EVIDENCE`

常见 `post_forge_action.action`：

- `PUBLISH_FINAL`
- `LOOPBACK_TO_SCOUT`
- `DROP_AND_RESELECT`

## 标准流程

1. Coordinator 调用 `auto_selection_queue_status`。
2. 如果没有活跃 run，Coordinator 读取 `AutoSelectionStrategyProfile.md`。
3. Coordinator 写入 `brief`。
4. Coordinator 调用 `auto_selection_prepare_dispatch(worker=scout)`。
5. Coordinator 将返回的 `agent_assistant_request` 交给 AgentAssistant。
6. Scout 写入 `raw` 或 `failed`。
7. Coordinator 再次检查队列。
8. 如果 raw 已就绪，Coordinator 调用 `auto_selection_prepare_dispatch(worker=reviewer)`。
9. Reviewer 写入 `scored` 或 `failed`。
10. Coordinator 根据 scored/failed 执行发布、回环、重选或归档。

## 回环

Reviewer 发现可由数据工具补齐的证据缺口时使用回环。

推荐流程：

1. 如需检查或发布内容，先读取 `scored`。
2. 调用 `auto_selection_apply_reviewer_decision`。
3. 如果返回 `agent_assistant_request`，交给 AgentAssistant，并等待下一次心跳。
4. 如果返回 `ready_for_final_publication`，先发布最终输出，再调用 `auto_selection_archive_run`。

避免无限回环。一个实用默认值是单个 run 总轮数不超过 5 轮。

## 失败处理

如果 `auto_selection_queue_status` 报告 Worker 已完成但没有写入 `raw`、`scored` 或 `failed`，使用：

```text
auto_selection_mark_worker_missing_output
```

最终发布或失败阻断后，使用：

```text
auto_selection_archive_run
```

`auto_selection_cleanup_run` 只用于清理非归档残留，不能替代最终归档。

锁过期或锁文件异常时，可使用：

```text
auto_selection_clear_locks
```

## 开源仓库卫生

不要提交真实运行输出：

- `runs/raw/*.md`
- `runs/scored/*.md`
- `runs/failed/*.md`
- `runs/archived/*.md`
- `runs/locks/*.lock`

可以提交源码、文档、模板和 `.gitkeep` 占位文件。

私有策略、供应商信息、品牌资料、市场账号信息和内部 Agent 名称应保留在本地忽略文件中。
