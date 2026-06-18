/**
 * open_dispute — open a dispute on a task
 *
 * Usage: node run.js <task_id> <raised_by_slack_user_id> <reason_text>
 *
 * raised_by_slack_user_id: Slack user ID of person raising dispute.
 *   System looks up Agent.slack_user_id to resolve handle.
 *   If no match, falls back to treating as admin/creator dispute.
 *
 * Actions:
 *   1. Validate task status is disputable (awarded|in_progress|delivered)
 *   2. Guard writes_enabled
 *   3. No existing open dispute on same task (idempotency)
 *   4. Create Dispute{status=open}
 *   5. Update Task{status=disputed, last_activity_at=now}
 *   6. Emit EventOutbox DISPUTE_OPENED → alerts + audit
 *   7. DM both agent and creator
 *   8. AuditLog run_type=dispute_opened
 */

'use strict';

const [taskId, raisedBySlackId, ...reasonParts] = process.argv.slice(2);
const reason = reasonParts.join(' ');
if (!taskId || !raisedBySlackId || !reason) {
  console.error('Usage: node run.js <task_id> <raised_by_slack_user_id> <reason_text>');
  process.exit(1);
}

const API_BASE    = () => `${process.env.VITE_BASE44_BACKEND_URL || 'https://base44.app'}/api/apps/${process.env.VITE_BASE44_APP_ID || process.env.BASE44_APP_ID}`;
const AUTH_HEADER = () => ({ 'Authorization': `Bearer ${process.env.BASE44_SERVICE_TOKEN}`, 'Content-Type': 'application/json' });

async function apiGet(entity, query = {}) {
  const url = new URL(`${API_BASE()}/entities/${entity}`);
  if (Object.keys(query).length) url.searchParams.set('q', JSON.stringify(query));
  const r = await fetch(url.toString(), { headers: AUTH_HEADER() });
  const d = await r.json();
  return Array.isArray(d) ? d : (d.records || d.data || []);
}
async function apiPost(entity, body) {
  const r = await fetch(`${API_BASE()}/entities/${entity}`, {
    method: 'POST', headers: AUTH_HEADER(), body: JSON.stringify(body),
  });
  return (await r.json()).data || {};
}
async function apiPut(entity, id, body) {
  const r = await fetch(`${API_BASE()}/entities/${entity}/${id}`, {
    method: 'PUT', headers: AUTH_HEADER(), body: JSON.stringify(body),
  });
  return (await r.json()).data || {};
}

(async () => {
  const runStart = Date.now();
  const now      = new Date().toISOString();
  const runId    = `dispute_open_${taskId}_${Date.now()}`;

  const audit = {
    task_id: taskId, run_type: 'dispute_opened',
    triggered_by: `slack:${raisedBySlackId}`,
    summary: '', notifications_sent: [], errors: [], status: 'ok',
    raw_payload: { taskId, raisedBySlackId, reason, run_id: runId },
  };

  async function fail(code, msg) {
    audit.errors.push({ code, message: msg }); audit.status = 'error'; audit.summary = msg;
    await apiPost('AuditLog', audit).catch(() => {});
    console.log(JSON.stringify({ ok: false, error: code, message: msg }));
  }

  // Settings
  const settingsArr = await apiGet('PlatformSetting');
  const S = {}; settingsArr.forEach(s => { S[s.key] = s.value; });
  const writesEnabled  = S['writes_enabled'];
  const adminSlackId   = S['default_creator_slack_user_id'] || null;

  // Load task
  const taskRows = await apiGet('Task', { id: taskId });
  if (!taskRows.length) return fail('TASK_NOT_FOUND', `Task ${taskId} not found.`);
  const task   = taskRows[0].data || taskRows[0];
  const isTest = !!task.is_test;

  const DISPUTABLE = ['awarded', 'in_progress', 'delivered'];
  if (!DISPUTABLE.includes(task.status))
    return fail('INVALID_STATUS', `Task status='${task.status}'. Must be one of: ${DISPUTABLE.join(', ')}.`);

  // Idempotency: no existing open dispute
  const existingDisputes = await apiGet('Dispute', { task_id: taskId });
  const openDispute = existingDisputes.map(d => d.data || d).find(d => d.status === 'open');
  if (openDispute)
    return fail('DISPUTE_ALREADY_OPEN', `Task already has an open dispute (${openDispute.id}).`);

  // Resolve who is raising
  const allAgents = await apiGet('Agent');
  const agentBySlack = {};
  allAgents.forEach(a => { const ag = a.data || a; if (ag.slack_user_id) agentBySlack[ag.slack_user_id] = ag; });
  const raisingAgent   = agentBySlack[raisedBySlackId] || null;
  const isAdminRaising = !raisingAgent || raisedBySlackId === adminSlackId;

  const raisedById   = raisingAgent ? raisingAgent.id   : (task.creator_id || 'admin');
  const raisedByType = raisingAgent ? 'agent'
    : (raisedBySlackId === adminSlackId ? 'admin' : 'creator');
  const raisedHandle = raisingAgent ? raisingAgent.handle : (task.creator_handle || 'admin');

  // Load awarded agent for notifications
  const awardedAgent = task.awarded_agent_id
    ? (allAgents.map(a => a.data || a).find(a => a.id === task.awarded_agent_id) || null)
    : null;

  // writes_enabled guard
  if (writesEnabled === false || writesEnabled === 'false') {
    await apiPost('EventOutbox', {
      event_type: 'SYSTEM_ALERT', reference_id: runId, reference_type: 'system',
      channel: 'alerts', status: 'pending', is_test: isTest,
      payload: { idempotency_key: `dispute_writes_frozen_${runId}`, alert: 'writes_frozen',
        message: `open_dispute blocked for task ${taskId}: writes_enabled=false`, run_id: runId, event_time: now },
    });
    return fail('WRITES_DISABLED', 'writes_enabled=false — dispute not opened.');
  }

  // 1. Create Dispute
  const dispute = await apiPost('Dispute', {
    task_id:        taskId,
    bid_id:         task.awarded_bid_id || null,
    raised_by_id:   raisedById,
    raised_by_type: raisedByType,
    against_id:     raisingAgent ? (task.creator_id || 'admin') : (task.awarded_agent_id || null),
    reason,
    status:         'open',
  });
  const disputeId = dispute.id;

  // 2. Update Task
  await apiPut('Task', taskId, { status: 'disputed', last_activity_at: now });

  // 3. DISPUTE_OPENED → alerts
  await apiPost('EventOutbox', {
    event_type: 'DISPUTE_OPENED', reference_id: disputeId, reference_type: 'dispute',
    channel: 'alerts', status: 'pending', is_test: isTest,
    payload: {
      idempotency_key: `dispute_opened_${disputeId}`,
      dispute_id:      disputeId,
      task_id:         taskId,
      title:           task.title || 'Untitled',
      raised_by:       raisedHandle,
      raised_by_type:  raisedByType,
      reason,
      escrow_at_stake: task.budget,
      currency:        task.currency || 'TTT',
      event_time:      now,
      summary:         `Dispute opened on "${task.title||taskId}" by @${raisedHandle}: ${reason}`,
    },
  });
  audit.notifications_sent.push({ event_type: 'DISPUTE_OPENED', channel: 'alerts' });

  // 4. DM awarded agent if known
  if (awardedAgent?.slack_user_id) {
    await apiPost('EventOutbox', {
      event_type: 'AGENT_DM', reference_id: disputeId, reference_type: 'dispute',
      channel: 'dm', status: 'pending', is_test: isTest,
      recipient_id: awardedAgent.slack_user_id,
      message: [
        `⚠️ *Dispute opened* on your task: *${task.title||taskId}*`,
        `Raised by: @${raisedHandle}`,
        `Reason: ${reason}`,
        `_All funds are frozen pending admin resolution._`,
      ].join('\n'),
      payload: { idempotency_key: `dispute_agent_dm_${disputeId}`, dispute_id: disputeId, task_id: taskId, event_time: now },
    });
    audit.notifications_sent.push({ event_type: 'AGENT_DM', recipient: awardedAgent.slack_user_id });
  }

  // 5. DM creator if known
  const creatorSlackId = task.creator_slack_user_id || adminSlackId;
  if (creatorSlackId && creatorSlackId !== awardedAgent?.slack_user_id) {
    await apiPost('EventOutbox', {
      event_type: 'CREATOR_DM', reference_id: disputeId, reference_type: 'dispute',
      channel: 'dm', status: 'pending', is_test: isTest,
      recipient_id: creatorSlackId,
      message: [
        `⚠️ *Dispute opened* on task: *${task.title||taskId}*`,
        `Raised by: @${raisedHandle}`,
        `Reason: ${reason}`,
        `_Awaiting admin resolution. All funds are frozen._`,
      ].join('\n'),
      payload: { idempotency_key: `dispute_creator_dm_${disputeId}`, dispute_id: disputeId, task_id: taskId, event_time: now },
    });
    audit.notifications_sent.push({ event_type: 'CREATOR_DM', recipient: creatorSlackId });
  }

  audit.summary = `Dispute ${disputeId} opened on task "${task.title||taskId}" by @${raisedHandle} (${raisedByType}). Task → disputed.${isTest ? ' [TEST]' : ''}`;
  audit.raw_payload = { ...audit.raw_payload, dispute_id: disputeId, is_test: isTest, duration_ms: Date.now() - runStart };
  await apiPost('AuditLog', audit);

  console.log(JSON.stringify({
    ok: true, dispute_id: disputeId, task_id: taskId, task_status: 'disputed',
    raised_by: raisedHandle, raised_by_type: raisedByType,
    notifications: audit.notifications_sent, duration_ms: Date.now() - runStart,
  }));
})();
