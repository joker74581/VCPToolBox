# AutoProductSelection 中文说明

`AutoProductSelection` 是一个自动化选品工作流编排插件。它本身不负责爬取亚马逊或其他平台数据，而是负责维护文件状态机、Worker 锁、AgentAssistant 分发提示词，以及不同 Agent 之间的结果交接文件。

公开版本使用通用角色名称：

- `Coordinator`：负责任务策略、创建 brief、派发 worker、归档最终结果。
- `ProductSelectionScout`：读取 brief，通过 `ProductSelector` 或其他数据工具收集证据。
- `ProductSelectionReviewer`：审查证据，输出评分和决策建议。

你可以在配置里把真实 AgentAssistant 名称改成自己的名字。

## 这个插件解决什么问题

选品流程通常不是一次工具调用就能完成，而是由多个阶段组成：

1. 定义选品目标和约束。
2. 分发给调研 Agent 收集候选产品、关键词、竞品、价格、评论等证据。
3. 分发给评审 Agent 对证据做二次判断。
4. 由主 Agent 决定继续补证、归档、失败，还是输出最终候选。

`AutoProductSelection` 负责让这些阶段有稳定的文件交接和状态管理，避免多个 Agent 同时处理同一个任务，也方便恢复中断任务。

## 目录结构

```text
Plugin/AutoProductSelection/
  AutoProductSelection.js
  plugin-manifest.json
  README.md
  README.zh-CN.md
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

`runs/` 是运行时数据目录。公开仓库只应该提交 `.gitkeep` 或简短说明，不应该提交真实选品结果、ASIN、SKU、关键词、供应商、品牌策略等内容。

## Agent 配置

默认 Agent 名称：

```env
AUTO_SELECTION_SCOUT_AGENT_NAME=ProductSelectionScout
AUTO_SELECTION_REVIEWER_AGENT_NAME=ProductSelectionReviewer
```

用于诊断“Worker 已完成但没有写回结果文件”的任务名前缀：

```env
AUTO_SELECTION_SCOUT_TASK_PREFIXES=APS_SCOUT_,ProductSelectionScout_
AUTO_SELECTION_REVIEWER_TASK_PREFIXES=APS_REVIEWER_,ProductSelectionReviewer_
```

如果你的 AgentAssistant 里有自己的 Agent 名称，把这些配置放进根目录 `config.env` 或插件级配置文件即可。

可复制的通用配置模板见 `config.env.example`。

## 核心流程

1. Coordinator 调用 `auto_selection_queue_status` 查看当前队列。
2. 如果没有活跃任务，Coordinator 读取 `AutoSelectionStrategyProfile.md`，创建 SelectionBrief。
3. Coordinator 调用 `auto_selection_prepare_dispatch(worker=scout)`，插件写入 brief 和 lock，并返回发给调研 Agent 的 AgentAssistant 请求。
4. 调研 Agent 读取 brief，通过 `ProductSelector` 等工具收集证据，写入 `raw` 或 `failed`。
5. Coordinator 再次检查队列。如果 raw 已完成，调用 `auto_selection_prepare_dispatch(worker=reviewer)`，把任务交给评审 Agent。
6. 评审 Agent 读取 raw 证据，写入 `scored` 或 `failed`。
7. Coordinator 根据 scored 结果决定发布、补充调研、归档或失败。

为了兼容旧流程，`worker=hawkeye/forge` 仍然可用，分别等价于 `scout/reviewer`。公开集成建议使用 `scout/reviewer`。

## 命令列表

所有命令都使用 `tool_name: AutoProductSelection`。

- `auto_selection_queue_status`
- `auto_selection_write_run_file`
- `auto_selection_read_run_file`
- `auto_selection_prepare_dispatch`
- `auto_selection_apply_reviewer_decision`
- `auto_selection_archive_run`
- `auto_selection_move_run_file`
- `auto_selection_delete_run_file`
- `auto_selection_cleanup_run`
- `auto_selection_mark_worker_missing_output`
- `auto_selection_clear_locks`
- `get_status`

注意：`auto_selection_read_run_file` 只读取 `runs/` 内的交接文件。`AutoSelectionStrategyProfile.md` 是插件根目录下的策略文件，应该用普通文件读取工具读取，不要当作 run 文件读取。

### 通用派发示例

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AutoProductSelection「末」,
command:「始」auto_selection_prepare_dispatch「末」,
worker:「始」scout「末」,
run_id:「始」APS-YYYYMMDD-topic「末」
<<<[END_TOOL_REQUEST]>>>
```

收到返回的 `agent_assistant_request` 后，把字段原样交给 `AgentAssistant`。

### 评审决策应用示例

评审 Agent 写入 `scored` 后，协调者不要手动拼接删除、清锁、重写 brief、再派发等多步命令，直接调用：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AutoProductSelection「末」,
command:「始」auto_selection_apply_reviewer_decision「末」,
run_id:「始」APS-YYYYMMDD-topic「末」
<<<[END_TOOL_REQUEST]>>>
```

支持的动作：

- `PUBLISH_FINAL`：先发布最终报告，再调用 `auto_selection_archive_run`。
- `LOOPBACK_TO_SCOUT`：保留 `raw`、删除旧 `scored`、创建补采 brief，并返回新的 scout 派发请求。
- `DROP_AND_RESELECT`：清理旧 run 的 brief/raw/scored/failed 和锁；如果传入 `brief_content`，会写入 `new_run_id`（未传则自动生成）并准备新的 scout 派发请求。

兼容旧值：`LOOPBACK_TO_HAWKEYE` 等价于 `LOOPBACK_TO_SCOUT`。

### 归档示例

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AutoProductSelection「末」,
command:「始」auto_selection_archive_run「末」,
run_id:「始」APS-YYYYMMDD-topic「末」,
stage:「始」scored「末」
<<<[END_TOOL_REQUEST]>>>
```

失败阻断时使用 `stage=failed`。`auto_selection_cleanup_run` 只用于清理残留，不能替代最终归档。

## 策略文件

当前策略文件：

```text
Plugin/AutoProductSelection/AutoSelectionStrategyProfile.md
```

公开仓库里的策略应该是通用模板。如果你有真实品牌、预算、供应商、类目偏好、利润要求或内部打法，建议放在本地被忽略的私有副本中。

示例模板：

```text
Plugin/AutoProductSelection/AutoSelectionStrategyProfile.md.example
```

## 快速检查

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

## 公开仓库注意事项

不要提交：

- `runs/archived` 中的真实选品结果
- 私有策略文件
- 店铺、品牌、供应商、采购价、预算等内部资料
- ASIN/SKU/关键词/评论数据集
- 你的内部 Agent 名称或任务命名规则

可以提交：

- 插件源码
- `plugin-manifest.json`
- 英文/中文 README
- 通用策略模板
- `runs/` 子目录中的 `.gitkeep`
