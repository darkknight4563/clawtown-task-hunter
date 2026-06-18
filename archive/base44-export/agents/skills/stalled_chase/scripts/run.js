/**
 * stalled_chase — every 2 hours, find tasks stuck in in_progress/delivered with no recent activity
 *
 * Guards:  stalled_chase_enabled, writes_enabled
 * For each stale task:
 *   - if stalled_pings_sent >= max_pings: emit INVARIANT_FAIL
 *   - else: increment stalled_pings_sent, set last_activity_at, emit STALLED_CHASE
 * Always emit one STALLED_CHASE_SUMMARY per run
 * Write one AuditLog stalled_chase record
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

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const runId    = `stalled_run_${Date.now()}`;
  const runStart = Date.now();
  const now      = new Date().toISOString();

  // ── Load settings ─────────────────────────────────────────────────────────
  const settingsArr = await apiGet('PlatformSetting');
  const S = {};
  settingsArr.forEach(s => { S[s.key] = s.value; });

  const stalledEnabled      = S['stalled_chase_enabled'];
  const writesEnabled       = S['writes_enabled'];
  const actorHandle         = S['system_actor_handle'] || 'system';
  const inProgressStaleHrs  = parseFloat(S['stalled_chase_in_progress_stale_hours'] ?? 24);
  const deliveredStaleHrs   = parseFloat(S['stalled_chase_delivered_stale_hours']    ?? 24);
  const maxPings            = parseFloat(S['stalled_chase_max_pings']                ?? 2);

  // ── Guards ────────────────────────────────────────────────────────────────
  if (stalledEnabled === false || stalledEnabled === 'false') {
    await apiPost('AuditLog', {
      run_type: 'stalled_chase', triggered_by: 'automation:stalled_chase',
      summary: 'Stalled chase skipped: stalled_chase_enabled=false.',
      status: 'skipped',
      raw_payload: { run_id: runId, kill_switch: 'stalled_chase_enabled' },
    });
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'stalled_chase_enabled=false', run_id: runId }));
    return;
  }

  if (writesEnabled === false || writesEnabled === 'false') {
    // Emit SYSTEM_ALERT, then skip
    await apiPost('EventOutbox', {
      event_type:    'SYSTEM_ALERT',
      reference_id:  runId,
      reference_type:'system',
      channel:       'slack',
      status:        'pending',
      is_test:       false,
      payload: {
        alert:    'writes_enabled=false',
        context:  'stalled_chase automation attempted to run',
        event_time: now,
        actor:    actorHandle,
      },
    });
    await apiPost('AuditLog', {
      run_type: 'stalled_chase', triggered_by: 'automation:stalled_chase',
      summary: 'Stalled chase skipped: writes_enabled=false.',
      status: 'skipped',
      raw_payload: { run_id: runId, kill_switch: 'writes_enabled' },
    });
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'writes_enabled=false', run_id: runId }));
    return;
  }

  // ── Fetch tasks ───────────────────────────────────────────────────────────
  const allTasks = await apiGet('Task');
  const nowMs    = Date.now();
  const inProgressStaleMs = inProgressStaleHrs * 3600 * 1000;
  const deliveredStaleMs  = deliveredStaleHrs * 3600 * 1000;

  // ── Find stale tasks ──────────────────────────────────────────────────────
  const staleTasks = allTasks.filter(t => {
    if (t.is_test) return false;
    if (!['in_progress', 'delivered'].includes(t.status)) return false;

    const lastActivityAt = t.last_activity_at
      ? new Date(t.last_activity_at).getTime()
      : new Date(t.created_date).getTime();
    const ageMs = nowMs - lastActivityAt;

    if (t.status === 'in_progress' && ageMs >= inProgressStaleMs) return true;
    if (t.status === 'delivered' && ageMs >= deliveredStaleMs) return true;
    return false;
  });

  // ── Process each stale task ───────────────────────────────────────────────
  const chased       = [];
  const escalated    = [];
  const errors       = [];

  for (const task of staleTasks) {
    try {
      const lastActivityAt = task.last_activity_at
        ? new Date(task.last_activity_at).getTime()
        : new Date(task.created_date).getTime();
      const ageMs = nowMs - lastActivityAt;
      const ageHours = Math.round(ageMs / 3600000 * 10) / 10; // 1 decimal
      const pingSent = task.stalled_pings_sent || 0;
      const nextPing = pingSent + 1;

      if (pingSent >= maxPings) {
        // ── Escalate: emit INVARIANT_FAIL ──────────────────────────────────
        await apiPost('EventOutbox', {
          event_type:    'INVARIANT_FAIL',
          reference_id:  task.id,
          reference_type:'task',
          channel:       'alerts',
          status:        'pending',
          is_test:       false,
          payload: {
            invariant:      'stalled_task_max_pings_reached',
            task_id:        task.id,
            title:          task.title || 'Untitled',
            status:         task.status,
            age_hours:      ageHours,
            pings_sent:     pingSent,
            max_pings:      maxPings,
            actor:          actorHandle,
            event_time:     now,
          },
        });
        escalated.push({
          id:          task.id,
          title:       task.title || 'Untitled',
          status:      task.status,
          age_hours:   ageHours,
          pings_sent:  pingSent,
        });
      } else {
        // ── Chase: increment ping + emit STALLED_CHASE ──────────────────────
        await apiPut('Task', task.id, {
          stalled_pings_sent: nextPing,
          last_activity_at:   now,
        });

        await apiPost('EventOutbox', {
          event_type:    'STALLED_CHASE',
          reference_id:  task.id,
          reference_type:'task',
          channel:       'hunters',
          status:        'pending',
          is_test:       false,
          payload: {
            task_id:        task.id,
            title:          task.title || 'Untitled',
            status:         task.status,
            age_hours:      ageHours,
            pings_sent:     nextPing,
            max_pings:      maxPings,
            awarded_agent:  task.awarded_agent_id,
            actor:          actorHandle,
            event_time:     now,
          },
        });

        chased.push({
          id:          task.id,
          title:       task.title || 'Untitled',
          status:      task.status,
          age_hours:   ageHours,
          pings_sent:  nextPing,
        });
      }
    } catch (err) {
      errors.push({ task_id: task.id, error: err.message });
      console.error(`stalled error task ${task.id}: ${err.message}`);
    }
  }

  // ── Emit ONE summary outbox record ────────────────────────────────────────
  const summaryIdempotencyKey = `stalled_summary_${runId}`;
  await apiPost('EventOutbox', {
    event_type:    'STALLED_CHASE_SUMMARY',
    reference_id:  runId,
    reference_type:'system',
    channel:       'hunters',
    status:        'pending',
    is_test:       false,
    payload: {
      idempotency_key: summaryIdempotencyKey,
      event_time:      now,
      actor:           actorHandle,
      tasks_chased:    chased.length,
      tasks_escalated: escalated.length,
      tasks_errored:   errors.length,
      chased_tasks:    chased,
      escalated_tasks: escalated,
    },
  });

  // ── Write AuditLog ────────────────────────────────────────────────────────
  const durationMs = Date.now() - runStart;
  const status     = errors.length > 0
    ? (chased.length + escalated.length > 0 ? 'partial' : 'error')
    : 'ok';

  await apiPost('AuditLog', {
    run_type:    'stalled_chase',
    triggered_by:'automation:stalled_chase',
    summary:     `Stalled chase: ${chased.length} chased, ${escalated.length} escalated, ${errors.length} errors. ${durationMs}ms.`,
    status,
    notifications_sent: [
      ...chased.map(t => ({ task_id: t.id, event_type: 'STALLED_CHASE', ping_number: t.pings_sent })),
      ...escalated.map(t => ({ task_id: t.id, event_type: 'INVARIANT_FAIL', reason: 'max_pings_reached' })),
    ],
    errors,
    raw_payload: {
      run_id:            runId,
      event_time:        now,
      duration_ms:       durationMs,
      tasks_chased:      chased.length,
      tasks_escalated:   escalated.length,
      tasks_errored:     errors.length,
      chased_task_ids:   chased.map(t => t.id),
      escalated_task_ids:escalated.map(t => t.id),
      chased_tasks:      chased,
      escalated_tasks:   escalated,
      settings: {
        in_progress_stale_hours: inProgressStaleHrs,
        delivered_stale_hours:   deliveredStaleHrs,
        max_pings:               maxPings,
      },
    },
  });

  console.log(JSON.stringify({
    ok: true,
    run_id:            runId,
    tasks_chased:      chased.length,
    tasks_escalated:   escalated.length,
    tasks_errored:     errors.length,
    duration_ms:       durationMs,
    chased_tasks:      chased,
    escalated_tasks:   escalated,
  }));
})();
