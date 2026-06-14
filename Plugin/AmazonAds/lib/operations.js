function isTruthy(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

function redactOperation(change) {
  if (!change || typeof change !== 'object') return change;
  const clone = { ...change };
  delete clone.requireAdmin;
  return clone;
}

function normalizeChanges(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  }
  return [];
}

function validateAdmin(args, runtimeConfig, { requireDoubleConfirm = false } = {}) {
  if (isTruthy(args.dryRun ?? args.dry_run ?? true)) {
    return { ok: false, dryRun: true };
  }
  if (!args.requireAdmin) {
    throw new Error('真实执行 Amazon Ads 操作需要 requireAdmin 操作口令。');
  }
  if (!runtimeConfig.operationPassword) {
    throw new Error('AmazonAds 未配置操作口令。请在插件配置中设置 AMAZON_ADS_OPERATION_PASSWORD，查询功能不受影响。');
  }
  if (String(args.requireAdmin) !== String(runtimeConfig.operationPassword)) {
    throw new Error('AmazonAds 操作口令错误，已阻止写入操作。');
  }
  if (requireDoubleConfirm && !isTruthy(args.doubleConfirm || args.double_confirm)) {
    throw new Error('预算或状态操作需要 doubleConfirm=true 二次确认。');
  }
  return { ok: true, dryRun: false };
}

function buildAccessRequestedAccount(account) {
  return { advertiserAccountId: account.adsAccountId };
}

function buildTargetBidPayload(changes, account, includeAccessRequestedAccount) {
  const targets = changes.map(change => {
    const targetId = String(change.targetId || change.target_id || '');
    const bidValue = Number(change.newBid ?? change.new_bid ?? change.bid);
    if (!targetId) throw new Error('每个出价变更都必须包含 targetId。');
    if (!Number.isFinite(bidValue) || bidValue <= 0) throw new Error(`target ${targetId} 的 bid/newBid 必须是正数。`);
    return {
      targetId,
      bid: { bid: bidValue }
    };
  });
  const body = { targets };
  if (includeAccessRequestedAccount) body.accessRequestedAccount = buildAccessRequestedAccount(account);
  return { body };
}

function buildEntityStatePayload(changes, account, includeAccessRequestedAccount) {
  const targetChanges = changes.filter(change => change.targetId || change.target_id);
  const campaignChanges = changes.filter(change => change.campaignId || change.campaign_id);
  if (targetChanges.length && campaignChanges.length) {
    throw new Error('一次状态操作只能包含 target 或 campaign，不能混合。');
  }
  if (targetChanges.length) {
    const targets = targetChanges.map(change => ({
      targetId: String(change.targetId || change.target_id),
      state: String(change.state || change.newState || change.new_state || '').toUpperCase()
    }));
    for (const item of targets) {
      if (!item.targetId || !['ENABLED', 'PAUSED'].includes(item.state)) {
        throw new Error('target 状态变更必须包含 targetId 且 state 为 ENABLED 或 PAUSED。');
      }
    }
    const body = { targets };
    if (includeAccessRequestedAccount) body.accessRequestedAccount = buildAccessRequestedAccount(account);
    return { tool: 'campaign_management-update_target', payload: { body } };
  }
  const campaigns = campaignChanges.map(change => ({
    campaignId: String(change.campaignId || change.campaign_id),
    state: String(change.state || change.newState || change.new_state || '').toUpperCase()
  }));
  for (const item of campaigns) {
    if (!item.campaignId || !['ENABLED', 'PAUSED'].includes(item.state)) {
      throw new Error('campaign 状态变更必须包含 campaignId 且 state 为 ENABLED 或 PAUSED。');
    }
  }
  const body = { campaigns };
  if (includeAccessRequestedAccount) body.accessRequestedAccount = buildAccessRequestedAccount(account);
  return { tool: 'campaign_management-update_campaign_state', payload: { body } };
}

function buildCampaignBudgetPayload(changes, account, includeAccessRequestedAccount) {
  const campaigns = changes.map(change => {
    const campaignId = String(change.campaignId || change.campaign_id || '');
    const budgetValue = Number(change.newBudget ?? change.new_budget ?? change.budgetValue ?? change.budget);
    if (!campaignId) throw new Error('每个预算变更都必须包含 campaignId。');
    if (!Number.isFinite(budgetValue) || budgetValue <= 0) throw new Error(`campaign ${campaignId} 的预算必须是正数。`);
    return {
      campaignId,
      budgets: [
        {
          budgetType: change.budgetType || change.budget_type || 'DAILY_BUDGET',
          budgetValue,
          recurrenceTimePeriod: change.recurrenceTimePeriod || change.recurrence_time_period || 'DAILY'
        }
      ]
    };
  });
  const body = { campaigns };
  if (includeAccessRequestedAccount) body.accessRequestedAccount = buildAccessRequestedAccount(account);
  return { body };
}

function proposeChanges(kind, args) {
  const changes = normalizeChanges(args.changes || args.proposedChanges || args.proposed_changes);
  return {
    success: true,
    command: `propose_${kind}`,
    dryRun: true,
    change_count: changes.length,
    changes: changes.map(redactOperation),
    message: changes.length
      ? '已整理为待确认变更。真实执行请调用对应 apply_* 命令，并提供 dryRun=false、requireAdmin 操作口令；预算/状态另需 doubleConfirm=true。'
      : '未提供 changes，当前仅返回建议命令模板。请先基于查询报表生成具体变更列表。'
  };
}

module.exports = {
  buildCampaignBudgetPayload,
  buildEntityStatePayload,
  buildTargetBidPayload,
  isTruthy,
  normalizeChanges,
  proposeChanges,
  validateAdmin
};
