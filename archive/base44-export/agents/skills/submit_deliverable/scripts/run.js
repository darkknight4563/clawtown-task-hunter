/**
 * submit_deliverable — worker submits a deliverable for an awarded task
 *
 * Usage: node run.js <task_id> <agent_id> <title> <content_or_link>
 *
 * Actions:
 *   1. Validate task exists + status=awarded (or already delivered for re-submit guard)
 *   2. Validate agent exists + is awarded agent on task
 *   3. Guard writes_enabled
 *   4. Create Deliverable {status=submitted, is_test inherited from task}
 *   5. Update Task {status=delivered, last_activity_at=now}
 *   6. Emit EventOutbox DELIVERABLE_SUBMITTED → hunters channel
 *   7. Emit EventOutbox CREATOR_DM if creator_slack_user_id known
 *   8. Write AuditLog run_type=deliverable_submitted
 */

'use strict';

const [taskId, agentId, title, contentOrLink] = process.argv.slice(2);
if (!taskId || !agentId || !title) {
  console.error('Usage: node run.js <task_id> <agent_id> <title> [content_or_link]');
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
  const d = await r.json();
  return d.data || d;
}
async function apiPut(entity, id, body) {
  const r = await fetch(`${API_BASE()}/entities/${entity}/${id}`, {
    method: 'PUT', headers: AUTH_HEADER(), body: JSON.stringify(body),
  });
  const d = await r.json();
  return d.data || d;
}

(async () => {
  const runStart = Date.now();
  const now      = new Date().toISOString();
  const runId    = `submit_${taskId}_${Date.now()}`;

  const audit = {
    task_id:            taskId,
    run_type:           'deliverable_submitted',
    triggered_by:       `agent:${agentId}`,
    summary:            '',
    notifications_sent: [],
    errors:             [],
    status:             'ok',
    raw_payload:        { taskId, agentId, title, contentOrLink, run_id: runId },
  };

  async function fail(code, message) {
    audit.errors.push({ code, message });
    audit.status  = 'error';
    audit.summary = message;
    await apiPost('AuditLog', audit).catch(() => {});
    console.log(JSON.stringify({ ok: false, error: code, message }));
  }

  // ── Load settings ──────────────────────────────────────────────────────────
  const settingsArr = await apiGet('PlatformSetting');
  const S = {};
  settingsArr.forEach(s => { S[s.key] = s.value; });
  const writesEnabled = S['writes_enabled'];

  // ── Load task ──────────────────────────────────────────────────────────────
  const taskRows = await apiGet('Task', { id: taskId });
  if (!taskRows.length) return fail('TASK_NOT_FOUND', `Task ${taskId} not found.`);
  const task   = taskRows[0].data || taskRows[0];
  const isTest = !!task.is_test;

  // Status guard: must be awarded or delivered (allow re-submit on delivered)
  if (!['awarded', 'delivered'].includes(task.status))
    return fail('INVALID_TASK_STATUS',
      `Task status='${task.status}'. Must be 'awarded' or 'delivered' to submit a deliverable.`);

  // ── Load agent ─────────────────────────────────────────────────────────────
  const agentRows = await apiGet('Agent', { id: agentId });
  if (!agentRows.length) return fail('AGENT_NOT_FOUND', `Agent ${agentId} not found.`);
  const agent = agentRows[0].data || agentRows[0];

  // Verify agent is the awarded agent
  if (task.awarded_agent_id && task.awarded_agent_id !== agentId)
    return fail('AGENT_NOT_AWARDED',
      `Agent ${agentId} (@${agent.handle}) is not the awarded agent for this task (expected: ${task.awarded_agent_id}).`);

  // ── Load bid for context ───────────────────────────────────────────────────
  const bidRows  = await apiGet('Bid', { id: task.awarded_bid_id });
  const bid      = bidRows[0] ? (bidRows[0].data || bidRows[0]) : null;

  // ── writes_enabled guard ───────────────────────────────────────────────────
  if (writesEnabled === false || writesEnabled === 'false') {
    await apiPost('EventOutbox', {
      event_type:    'SYSTEM_ALERT',
      reference_id:  runId,
      reference_type:'system',
      channel:       'alerts',
      status:        'pending',
      is_test:       isTest,
      payload: {
        idempotency_key: `submit_writes_frozen_${runId}`,
        alert:   'writes_frozen',
        message: `submit_deliverable skipped for task ${taskId}: writes_enabled=false`,
        run_id:  runId,
        event_time: now,
      },
    });
    return fail('WRITES_DISABLED', 'writes_enabled=false — deliverable not submitted.');
  }

  // ── 1. Create Deliverable ──────────────────────────────────────────────────
  const isLink = contentOrLink && (contentOrLink.startsWith('http://') || contentOrLink.startsWith('https://'));
  const deliverable = await apiPost('Deliverable', {
    task_id:       taskId,
    bid_id:        task.awarded_bid_id || null,
    agent_id:      agentId,
    title,
    description:   isLink ? null : (contentOrLink || null),
    file_url:      null,
    external_link: isLink ? contentOrLink : null,
    status:        'submitted',
    submitted_at:  now,
    is_test:       isTest,
  });
  const deliverableId = deliverable.id || deliverable._id;

  // ── 2. Update Task ─────────────────────────────────────────────────────────
  await apiPut('Task', taskId, {
    status:          'delivered',
    last_activity_at: now,
  });

  // ── 3. EventOutbox DELIVERABLE_SUBMITTED → hunters ─────────────────────────
  const linkText = contentOrLink || '(no link provided)';
  await apiPost('EventOutbox', {
    event_type:    'DELIVERABLE_SUBMITTED',
    reference_id:  deliverableId,
    reference_type:'deliverable',
    channel:       'hunters',
    status:        'pending',
    is_test:       isTest,
    payload: {
      idempotency_key: `deliverable_submitted_${deliverableId}`,
      deliverable_id:  deliverableId,
      task_id:         taskId,
      title:           task.title || 'Untitled',
      deliverable_title: title,
      agent_handle:    agent.handle,
      agent_id:        agentId,
      bid_amount:      bid?.bid_amount,
      currency:        task.currency || 'TTT',
      link:            isLink ? contentOrLink : null,
      summary:         `@${agent.handle} submitted deliverable for "${task.title || taskId}"`,
      event_time:      now,
      is_test:         isTest,
    },
  });
  audit.notifications_sent.push({ event_type: 'DELIVERABLE_SUBMITTED', reference_id: deliverableId });

  // ── 4. CREATOR_DM if slack user id known ───────────────────────────────────
  const creatorSlackId = task.creator_slack_user_id || S['default_creator_slack_user_id'];
  if (creatorSlackId) {
    const dmMsg = [
      `📦 *Deliverable submitted* for your task: *${task.title || taskId}*`,
      `By: *@${agent.handle}*`,
      isLink ? `Link: ${contentOrLink}` : `Content: ${contentOrLink || '(see platform)'}`,
      `\n_Please review and approve or request changes._`,
    ].join('\n');
    await apiPost('EventOutbox', {
      event_type:    'CREATOR_DM',
      reference_id:  deliverableId,
      reference_type:'deliverable',
      channel:       'dm',
      status:        'pending',
      is_test:       isTest,
      recipient_id:  creatorSlackId,
      message:       dmMsg,
      payload: {
        idempotency_key:      `creator_dm_submit_${deliverableId}`,
        deliverable_id:       deliverableId,
        task_id:              taskId,
        agent_handle:         agent.handle,
        creator_slack_user_id: creatorSlackId,
        event_time:           now,
      },
    });
    audit.notifications_sent.push({ event_type: 'CREATOR_DM', recipient: creatorSlackId });
  }

  // ── 5. AuditLog ───────────────────────────────────────────────────────────
  audit.summary = `Deliverable "${title}" submitted by @${agent.handle} for task "${task.title||taskId}". Deliverable ID: ${deliverableId}. Task → delivered.${isTest ? ' [TEST]' : ''}`;
  audit.raw_payload = {
    ...audit.raw_payload,
    deliverable_id: deliverableId,
    is_test:        isTest,
    duration_ms:    Date.now() - runStart,
  };
  await apiPost('AuditLog', audit);

  console.log(JSON.stringify({
    ok:             true,
    deliverable_id: deliverableId,
    task_id:        taskId,
    task_status:    'delivered',
    agent_handle:   agent.handle,
    is_test:        isTest,
    notifications:  audit.notifications_sent,
    duration_ms:    Date.now() - runStart,
  }));
})();
