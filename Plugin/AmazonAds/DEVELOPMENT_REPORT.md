# AmazonAds 开发记录

本文档是该插件社区版本的公开开发总结。私有的账户验证记录、真实的报表示例、Campaign 名称、ASIN、Profile ID 和签名 URL 应存储在 Git 之外。

## 当前范围

- 将选定的 Amazon Ads MCP 读取流程封装在稳定的 VCP 命令后面。
- 保持面向 Agent 的命令紧凑且可预测。
- 将报表任务本地归档以供重用和聚合。
- 支持可选的 OAuth token 刷新，且不在响应中暴露 token。
- 将写操作保护在安全模式和操作密码之后。

## 主要模块

| 文件 | 职责 |
| --- | --- |
| `lib/service.js` | 命令路由和插件生命周期。 |
| `lib/config.js` | 配置加载和默认值。 |
| `lib/mcpClient.js` | MCP 传输和工具调用。 |
| `lib/reporting.js` | 报表创建/获取/下载的编排。 |
| `lib/reportStore.js` | 本地状态、归档、CSV/XLSX 导出、聚合。 |
| `lib/fieldPresets.js` | 维护的报表预设和候选字段。 |
| `lib/tokenRefresh.js` | 可选的 OAuth 刷新流程。 |
| `lib/toolRegistry.js` | 工具元数据和能力展示。 |

## 公开数据卫生要求

在发布前：

- 保持 `Plugin/AmazonAds/config.env` 不被追踪 (untracked)。
- 保持 `Plugin/AmazonAds/state/` 不被追踪。
- 保持 MCP 配置文件不被追踪。
- 从文档中移除真实的账户名、账户 ID、Profile ID、Campaign ID、ASIN、SKU、搜索词和签名 URL。
- 在示例中使用 `<YOUR_...>` 占位符。

## 建议的格式化验证

使用私有的本地配置，然后运行：

```text
AmazonAds.get_status
AmazonAds.list_capabilities
AmazonAds.list_accounts
AmazonAds.list_campaigns
AmazonAds.get_report_data
AmazonAds.list_report_jobs
```

验证后不要提交生成的 state 目录。
