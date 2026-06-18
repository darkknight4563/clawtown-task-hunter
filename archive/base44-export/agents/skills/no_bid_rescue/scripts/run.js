/**
 * no_bid_rescue — hourly loop to nudge open/bidding tasks with no bids
 *
 * Triggered by: scheduled automation (hourly)
 * Guards:       no_bid_rescue_enabled, writes_enabled PlatformSettings
 * Per-task:     increment rescue_reminders_sent, set last_activity_at, find top-3 tag-match agents
 * Emits:        N × NO_BID_RESCUE records (one per eligible task, up to 20)
 *               1 × NO_BID_RESCUE_SUMMARY
 * Writes:       N × Task updates (rescue_reminders_sent + last_activity_at)
 *               1 × AuditLog
 */

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

function tagOverlap(taskTags, agentTags) {
  if (!taskTags || !agentTags) return 0;
  const tSet = new Set(taskTags);
  return agentTags.filter(t => tSet.has(t)).length;
}

(async () => {
  const runId    = `rescue_${Date.now()}`;
  const runStart = Date.now();
  const now      = new Date().toISOString();

  // Load settings
  const settingsArr = await apiGet('PlatformSetting');
  const settings    = {};
  settingsArr.forEach(s => { settings[s.key] = s.value; });

  const enabled       = settings['no_bid_rescue_enabled'];
  const writesEnabled = settings['writes_enabled'];
  const minAgeMins    = parseInt(settings['no_bid_rescue_min_age_minutes']) || 60;
  const minBudget     = parseFloat(settings['no_bid_rescue_min_budget_ttt']) || 200;
  const maxReminders  = parseInt(settings['no_bid_rescue_max_reminders']) || 2;
  const actorHandle   = settings['system_actor_handle'] || 'system';

  // Guard 1: enabled?
  if (enabled === false || enabled === 'false') {
    await apiPost('AuditLog', {
      run_type: 'no_bid_rescue', triggered_by: 'automation:no_bid_rescue',
      summary: 'No-bid rescue skipped: no_bid_rescue_enabled=false.',
      status: 'skipped', raw_payload: { run_id: runId },
    });
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'no_bid_rescue_enabled=false', run_id: runId }));
    return;
  }

  // Guard 2: writes frozen?
  if (writesEnabled === false || writesEnabled === 'false') {
    await apiPost('AuditLog', {
      run_type: 'no_bid_rescue', triggered_by: 'automation:no_bid_rescue',
      summary: 'No-bid rescue halted: writes_enabled=false.',
      status: 'skipped', raw_payload: { run_id: runId, reason: 'writes_enabled=false' },
    });
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'writes_enabled=false', run_id: runId }));
    return;
  }

  // Fetch tasks, bids, agents
  const [tasks, bids, agents] = await Promise.all([
    apiGet('Task'),
    apiGet('Bid'),
    apiGet('Agent'),
  ]);

  // Filter candidates: open/bidding, no bids, old enough, budget >= min
  const bidsByTask = {};
  bids.forEach(b => { bidsByTask[b.task_id] = (bidsByTask[b.task_id] || []).concat(b); });

  const now_ms = Date.now();
  const candidates = tasks.filter(t => {
    if (t.is_test) return false;
    if (!['open', 'bidding'].includes(t.status)) return false;
    if ((bidsByTask[t.id] || []).length > 0) return false;  // has bids
    if ((t.budget || 0) < minBudget) return false;
    const age_ms = now_ms - new Date(t.created_date).getTime();
    if (age_ms < minAgeMins * 60 * 1000) return false;
    // Only rescue if not already at max reminders
    if ((t.rescue_reminders_sent || 0) >= maxReminders) return false;
    return true;
  }).sort((a, b) => new Date(a.created_date) - new Date(b.created_date));  // oldest first

  // Limit to 20 per run
  const toRescue = candidates.slice(0, 20);

  // Build EventOutbox records + Task updates
  const outboxRecords = [];
  const taskUpdates   = [];

  for (const task of toRescue) {
    const nextReminder = (task.rescue_reminders_sent || 0) + 1;
    const age_ms = now_ms - new Date(task.created_date).getTime();
    const age_mins = Math.round(age_ms / 60000);

    // Find top 3 agents by tag overlap
    const matches = agents
      .filter(a => !a.is_test && a.status === 'active')
      .map(a => ({ agent: a, overlap: tagOverlap(task.tags || [], a.skill_tags || []) }))
      .filter(m => m.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 3);

    // Emit NO_BID_RESCUE event
    outboxRecords.push({
      event_type: 'NO_BID_RESCUE',
      reference_type: 'task',
      reference_id: task.id,
      channel: 'hunters',
      status: 'pending',
      is_test: false,
      payload: {
        task_id: task.id,
        title: task.title || 'Untitled',
        budget: task.budget,
        age_minutes: age_mins,
        reminder_number: nextReminder,
        creator_handle: task.creator_handle,
        suggested_agents: matches.map(m => ({ handle: m.agent.handle, overlap: m.overlap })),
        idempotency_key: `rescue_${task.id}_${nextReminder}`,
      },
    });

    // Queue Task update
    taskUpdates.push({
      id: task.id,
      rescue_reminders_sent: nextReminder,
      last_activity_at: now,
    });
  }

  // Execute all writes in parallel
  const writePromises = [
    ...taskUpdates.map(u => apiPut('Task', u.id, {
      rescue_reminders_sent: u.rescue_reminders_sent,
      last_activity_at: u.last_activity_at,
    })),
    ...outboxRecords.map(rec => apiPost('EventOutbox', rec)),
  ];

  // Also emit ONE summary
  const summaryRecord = {
    event_type: 'NO_BID_RESCUE_SUMMARY',
    reference_type: 'system',
    reference_id: runId,
    channel: 'hunters',
    status: 'pending',
    is_test: false,
    payload: {
      run_id: runId,
      tasks_scanned: tasks.length,
      candidates_found: candidates.length,
      tasks_rescued: toRescue.length,
      min_age_minutes: minAgeMins,
      min_budget_ttt: minBudget,
      summary: `Scanned ${tasks.length} tasks, found ${candidates.length} stuck with 0 bids, rescued ${toRescue.length}.`,
      idempotency_key: runId,
    },
  };

  writePromises.push(apiPost('EventOutbox', summaryRecord));

  await Promise.all(writePromises);

  // Write AuditLog
  const durationMs = Date.now() - runStart;
  await apiPost('AuditLog', {
    run_type: 'no_bid_rescue',
    triggered_by: 'automation:no_bid_rescue',
    summary: `Rescued ${toRescue.length}/${candidates.length} stuck tasks (${minAgeMins}m+ old, ${minBudget}+ TTT).`,
    status: 'ok',
    notifications_sent: [
      { channel: 'hunters', event_type: 'NO_BID_RESCUE', count: toRescue.length },
      { channel: 'hunters', event_type: 'NO_BID_RESCUE_SUMMARY', count: 1 },
    ],
    raw_payload: {
      run_id: runId,
      tasks_scanned: tasks.length,
      candidates_found: candidates.length,
      tasks_rescued: toRescue.length,
      min_age_minutes: minAgeMins,
      min_budget_ttt: minBudget,
      max_reminders: maxReminders,
      task_ids: toRescue.map(t => t.id),
      duration_ms: durationMs,
    },
  });

  console.log(JSON.stringify({
    ok: true,
    run_id: runId,
    tasks_scanned: tasks.length,
    candidates_found: candidates.length,
    tasks_rescued: toRescue.length,
    outbox_records_emitted: toRescue.length + 1,
    duration_ms: durationMs,
  }));
})();
