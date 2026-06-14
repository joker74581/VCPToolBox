# AmazonAds 中文说明

`AmazonAds` 是一个面向 VCPToolBox 的 Amazon Ads 只读分析插件。它通过 Amazon Ads MCP 服务调用广告账户、活动、广告组、投放目标、报表等接口，让 Agent 不需要直接拼接底层 MCP 请求。

公开版本不包含任何真实店铺、品牌、广告账号、Profile ID、Entity ID、Token、报表下载链接或历史报表数据。你自己的真实配置应该只放在本地 `config.env`、MCPO 配置文件和 `state/` 目录中。

## 主要能力

- 检查 Amazon Ads MCP 连接状态。
- 列出可访问的广告账户。
- 查询 Campaign、Ad Group、Ad、Target、Billing、Eligibility、Account User 等结构数据。
- 创建、轮询、下载、解析、归档、导出和聚合 Amazon Ads 报表。
- 在 `Plugin/AmazonAds/state/` 下维护本地报表索引和归档。
- 默认安全模式开启，写操作需要显式关闭安全限制并配置操作密码。
- 可选自动刷新 Amazon OAuth Token，并写回 MCPO 配置文件。

## 安装与配置

先准备一个 Amazon Ads MCP 服务配置，例如：

```json
{
  "mcpServers": {
    "amazon_ads": {
      "url": "https://your-amazon-ads-mcp-endpoint.example/mcp",
      "headers": {
        "Authorization": "Bearer <ACCESS_TOKEN>",
        "Amazon-Ads-ClientId": "<AMAZON_ADS_CLIENT_ID>"
      }
    }
  }
}
```

复制插件配置模板：

```bash
cp Plugin/AmazonAds/config.env.example Plugin/AmazonAds/config.env
```

填写这些基础项：

```env
AMAZON_ADS_MCP_CONFIG_PATH=/absolute/path/to/mcp-config.json
AMAZON_ADS_MCP_SERVER_NAME=amazon_ads
AMAZON_ADS_DEFAULT_ACCOUNT_NAME=<YOUR_ACCOUNT_NAME>
AMAZON_ADS_DEFAULT_ACCOUNT_ID=<YOUR_ADS_ACCOUNT_ID>
AMAZON_ADS_DEFAULT_PROFILE_ID=<YOUR_PROFILE_ID>
AMAZON_ADS_DEFAULT_ENTITY_ID=<YOUR_ENTITY_ID>
AMAZON_ADS_DEFAULT_MARKETPLACE=US
```

如果需要插件自动刷新 Token，再填写：

```env
AMAZON_ADS_ENABLE_TOKEN_REFRESH=true
AMAZON_CLIENT_ID=<YOUR_AMAZON_CLIENT_ID>
AMAZON_CLIENT_SECRET=<YOUR_AMAZON_CLIENT_SECRET>
AMAZON_REFRESH_TOKEN=<YOUR_AMAZON_REFRESH_TOKEN>
```

如果你已经有外部程序负责刷新 MCPO 配置里的 Token，就保持 `AMAZON_ADS_ENABLE_TOKEN_REFRESH=false`。

## 常用调用

检查状态：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonAds「末」,
command:「始」get_status「末」
<<<[END_TOOL_REQUEST]>>>
```

查看能力：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonAds「末」,
command:「始」list_capabilities「末」
<<<[END_TOOL_REQUEST]>>>
```

列出广告账户：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonAds「末」,
command:「始」list_accounts「末」
<<<[END_TOOL_REQUEST]>>>
```

查询 Campaign：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonAds「末」,
command:「始」list_campaigns「末」,
accountName:「始」<YOUR_ACCOUNT_NAME>「末」,
marketplace:「始」US「末」,
maxResults:「始」50「末」
<<<[END_TOOL_REQUEST]>>>
```

获取报表数据：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonAds「末」,
command:「始」get_report_data「末」,
reportKind:「始」campaign「末」,
dateFrom:「始」2026-01-01「末」,
dateTo:「始」2026-01-07「末」,
marketplace:「始」US「末」,
mode:「始」get_or_create「末」
<<<[END_TOOL_REQUEST]>>>
```

常见 `reportKind`：

- `campaign`
- `placement`
- `target`
- `search_term`
- `keyword`

## 报表工作流

Amazon Ads 报表是异步任务：

1. 创建或复用报表任务。
2. 轮询直到状态为 `COMPLETED`。
3. 下载并解析报表。
4. 读取行数据、导出 CSV/XLSX，或对历史归档做聚合。

如果只是查当前账户结构，用 `list_campaigns`、`list_ad_groups`、`list_targets` 等命令即可。如果要查花费、ACOS、ROAS、订单、转化、搜索词表现等历史指标，需要走报表命令。

## 字段探测

不同广告账户、站点、广告产品和 MCP 版本支持的报表字段可能不同。必要时可以使用字段探测：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AmazonAds「末」,
command:「始」probe_report_fields「末」,
preset:「始」campaign_basic「末」,
candidateFields:「始」budgetCurrency.value,metric.sales「末」,
days:「始」1「末」
<<<[END_TOOL_REQUEST]>>>
```

不要一次探测大量字段，因为探测也会创建报表任务，可能触发限流。

## 公开仓库注意事项

不要提交：

- `Plugin/AmazonAds/config.env`
- MCPO 真实配置文件
- OAuth Token、Refresh Token、Client Secret
- `Plugin/AmazonAds/state/`
- 下载后的报表、预览结果、签名下载链接
- 真实品牌、广告账号、Profile ID、Entity ID、Campaign 名称

可以提交：

- 插件源码
- `plugin-manifest.json`
- `config.env.example`
- 英文/中文 README
- 不含真实数据的能力说明
