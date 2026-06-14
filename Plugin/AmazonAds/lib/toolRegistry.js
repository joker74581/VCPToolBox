const READ_TOOLS = {
  'ads_accounts-list_ads_accounts': {
    domain: 'account',
    description: '列出当前 token 可访问的广告账户。'
  },
  'ads_accounts-get_ads_account': {
    domain: 'account',
    description: '查询指定广告账户详情。'
  },
  'account_management-query_advertiser_account': {
    domain: 'account',
    description: '查询 advertiser/global account 访问范围。'
  },
  'account_management-query_account_link': {
    domain: 'account',
    description: '查询 manager account 与 advertiser account 链接关系。'
  },
  'campaign_management-query_campaign': {
    domain: 'campaign',
    description: '查询广告活动。'
  },
  'campaign_management-query_ad_group': {
    domain: 'campaign',
    description: '查询广告组。'
  },
  'campaign_management-query_ad': {
    domain: 'campaign',
    description: '查询广告。'
  },
  'campaign_management-query_target': {
    domain: 'campaign',
    description: '查询关键词、商品、自动投放等 target。'
  },
  'campaign_management-query_ad_association': {
    domain: 'campaign',
    description: '查询广告和广告组关联。'
  },
  'campaign_management-check_product_eligibility': {
    domain: 'eligibility',
    description: '检查商品是否可投放指定广告类型。'
  },
  'eligibility-programs': {
    domain: 'eligibility',
    description: '检查账户广告项目资格。'
  },
  'eligibility-product_list': {
    domain: 'eligibility',
    description: '查询商品广告资格。'
  },
  'billing-query_billing_notifications': {
    domain: 'billing',
    description: '查询账单和支付相关通知。'
  },
  'billing-list_invoices': {
    domain: 'billing',
    description: '查询发票。'
  },
  'users-list_users': {
    domain: 'users',
    description: '列出广告账户用户。'
  },
  'user_roles-list_user_roles': {
    domain: 'users',
    description: '查询用户角色。'
  },
  'user_permissions-list_user_permissions': {
    domain: 'users',
    description: '查询用户权限。'
  },
  'user_invitations-list': {
    domain: 'users',
    description: '查询用户邀请。'
  },
  'user_invitation-get': {
    domain: 'users',
    description: '查询指定邀请详情。'
  },
  'reporting-retrieve_report': {
    domain: 'reporting',
    description: '查询报表状态。'
  }
};

const REPORT_TASK_TOOLS = {
  'reporting-create_report': {
    domain: 'reporting',
    description: '创建只读报表任务。虽然工具名是 create，但不修改广告资产。'
  },
  'reporting-create_campaign_report': {
    domain: 'reporting',
    description: '创建 campaign 报表任务。'
  },
  'reporting-create_product_report': {
    domain: 'reporting',
    description: '创建 product 报表任务。'
  },
  'reporting-create_inventory_report': {
    domain: 'reporting',
    description: '创建 inventory 报表任务。'
  }
};

const WRITE_TOOLS = {
  'campaign_management-update_target_bid': {
    domain: 'operation',
    risk: 'bid',
    description: '更新 target bid。'
  },
  'campaign_management-update_target': {
    domain: 'operation',
    risk: 'state_or_bid',
    description: '更新 target 状态或设置。'
  },
  'campaign_management-update_campaign_state': {
    domain: 'operation',
    risk: 'state',
    description: '更新 campaign 状态。'
  },
  'campaign_management-update_campaign_budget': {
    domain: 'operation',
    risk: 'budget',
    description: '更新 campaign 预算。'
  }
};

const BLOCKED_DOMAINS = [
  'amazon_live',
  'amc',
  'test_accounts',
  'terms_token',
  'manager_accounts',
  'account_management-create',
  'account_management-update',
  'ads_accounts-create',
  'user_permissions-update',
  'user_permissions-delete',
  'user_invitations-create',
  'user_invitations-update',
  'user_invitation-redeem'
];

function normalizeToolName(toolName) {
  return String(toolName || '').trim().replace(/^amazon_ads_/, '').replace(/^\//, '');
}

function isReadToolAllowed(toolName) {
  const normalized = normalizeToolName(toolName);
  return Boolean(READ_TOOLS[normalized] || REPORT_TASK_TOOLS[normalized]);
}

function isWriteToolAllowed(toolName) {
  return Boolean(WRITE_TOOLS[normalizeToolName(toolName)]);
}

function getToolInfo(toolName) {
  const normalized = normalizeToolName(toolName);
  return READ_TOOLS[normalized] || REPORT_TASK_TOOLS[normalized] || WRITE_TOOLS[normalized] || null;
}

function listCapabilities() {
  return {
    focus: 'Amazon.com 站内 Sponsored Products / 购物广告分析',
    read_tools: Object.entries(READ_TOOLS).map(([tool, meta]) => ({ tool, ...meta })),
    report_task_tools: Object.entries(REPORT_TASK_TOOLS).map(([tool, meta]) => ({ tool, ...meta })),
    write_tools: Object.entries(WRITE_TOOLS).map(([tool, meta]) => ({
      tool,
      ...meta,
      default_mode: 'dryRun',
      requires_vcp_approval: true,
      requires_admin_code: true
    })),
    blocked_domains: BLOCKED_DOMAINS,
    notes: [
      'call_read_tool 只允许 read_tools 和 report_task_tools。',
      'apply_* 命令默认 dryRun，真实执行必须 dryRun=false、requireAdmin 插件操作口令验证通过。',
      'Amazon Live、AMC、DSP/电视、账号和用户权限写操作不在第一阶段开放。'
    ]
  };
}

module.exports = {
  READ_TOOLS,
  REPORT_TASK_TOOLS,
  WRITE_TOOLS,
  getToolInfo,
  isReadToolAllowed,
  isWriteToolAllowed,
  listCapabilities,
  normalizeToolName
};
