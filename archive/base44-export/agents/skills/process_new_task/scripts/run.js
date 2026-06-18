/**
 * process_new_task  v4  (REST-only, no SDK dependency)
 *
 * is_test propagation:
 *   - If Task.is_test == true:
 *       • any Bid created/updated → is_test=true
 *       • any EventOutbox emitted → is_test=true
 *       • AuditLog written → is_test=true + fixture reason in raw_payload
 *
 * Execution order:
 *   (1) Classify + score top-3 matching agents
 *   (2) Auto-bid if rules pass — upsert bid (one active bid per agent per task)
 *   (3) Build CREATOR_DM with live bid data
 *   (4) Emit EventOutbox: TASK_CREATED, BID_PLACED (if fired), CREATOR_DM
 *
 * Usage: node run.js <task_id>
 */

'use strict';

const taskId = process.argv[2];
if (!taskId) { console.error('Usage: node run.js <task_id>'); process.exit(1); }

// ── REST helpers ──────────────────────────────────────────────────────────────
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

// ── Scoring ───────────────────────────────────────────────────────────────────
function scoreAgent(agent, taskText, keywords) {
  const skills  = agent.skill_tags || [];
  const textLow = taskText.toLowerCase();
  const hits    = skills.filter(s => textLow.includes(s.toLowerCase()));
  const kwHits  = keywords.filter(k => textLow.includes(k.toLowerCase()));
  const score   = parseFloat((hits.length + (agent.reputation_score || 0) / 100).toFixed(2));
  return { agent, hits, kwHits, score };
}

function buildDmMessage(task, matches, autoBid) {
  const { id, title, budget } = task;
  const topList     = matches.map((m, i) => `${i + 1}) @${m.agent.handle} (${m.score})`).join(' ');
  const autoBidLine = autoBid
    ? `Auto-bid: @${autoBid.agent_handle} ${autoBid.bid_amount} TTT, ETA ${autoBid.eta_hours}h`
    : 'Auto-bid: none';
  const awardHandle = autoBid ? autoBid.agent_handle : (matches[0]?.agent.handle || '?');
  return [
    `🧾 New task: ${title}`,
    `Budget: ${budget} TTT | Task ID: ${id}`,
    `Top matches: ${topList}`,
    autoBidLine,
    `To award: AWARD ${id} @${awardHandle}`,
  ].join('\n');
}

// ── Audit accumulator ─────────────────────────────────────────────────────────
const audit = {
  task_id: taskId, run_type: 'task_created', triggered_by: 'automation:new_task',
  summary: '', matches: [], bids_placed: [], bids_skipped: [],
  notifications_sent: [], ledger_actions: [], errors: [], status: 'ok', raw_payload: {},
};

async function run() {
  // 1. Load task
  const taskRows = await apiGet('Task', { id: taskId });
  if (!taskRows.length) {
    audit.errors.push({ code: 'TASK_NOT_FOUND', task_id: taskId });
    audit.status = 'error'; audit.summary = `Task ${taskId} not found.`;
    await apiPost('AuditLog', audit);
    console.log(JSON.stringify({ ok: false, error: 'TASK_NOT_FOUND' }));
    return;
  }
  const task   = { id: taskRows[0].id || taskId, ...(taskRows[0].data || taskRows[0]) };
  const isTest = !!task.is_test;
  const fixtureReason = isTest
    ? 'Regression fixture — used to verify process_new_task pipeline end-to-end.'
    : null;

  const { title = '', description = '', category = '', tags = [], budget = 0, currency = 'TTT',
          creator_id, creator_handle, creator_slack_user_id, auto_bid_attempted } = task;

  audit.raw_payload = {
    title, category, budget, currency,
    creator_slack_user_id: creator_slack_user_id || null,
    is_test: isTest,
    ...(fixtureReason ? { fixture_reason: fixtureReason } : {}),
  };

  // 2. Platform settings
  const settingRows = await apiGet('PlatformSetting');
  const settings = {};
  for (const s of settingRows) {
    const d = s.data || s;
    settings[d.key] = d.value_type === 'number'  ? parseFloat(d.value)
                    : d.value_type === 'boolean' ? d.value === 'true'
                    : d.value_type === 'json'    ? JSON.parse(d.value)
                    : d.value;
  }

  const AUTO_BID_ENABLED    = settings['auto_bid_enabled']        ?? true;
  const AUTO_BID_THRESHOLD  = settings['auto_bid_threshold_ttt']  ?? 200;
  const AUTO_BID_PCT        = settings['auto_bid_pct']            ?? 0.90;
  const AUTO_BID_ETA        = settings['auto_bid_eta_hours']      ?? 6;
  const AUTO_BID_CATEGORIES = settings['auto_bid_categories']     ?? ['development', 'automation'];
  const AUTO_BID_KEYWORDS   = settings['auto_bid_keywords']       ?? ['typescript', 'backend', 'node', 'api', 'fastapi', 'python'];
  const SAFETY_MAX          = settings['safety_max_auto_bid_ttt'] ?? 10000;

  // 3. Score agents
  const agentRows = await apiGet('Agent', { status: 'active' });
  const agents    = agentRows.map(r => ({ id: r.id, ...(r.data || r) }));
  const taskText  = `${title} ${description} ${tags.join(' ')}`;

  const scored = agents
    .map(agent => scoreAgent(agent, taskText, AUTO_BID_KEYWORDS))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  audit.matches = scored.map((r, i) => ({
    rank: i + 1, agent_id: r.agent.id, handle: r.agent.handle,
    score: r.score, skill_hits: r.hits, keyword_hits: r.kwHits,
    reputation_score: r.agent.reputation_score,
  }));

  // 4. Auto-bid
  const topMatch      = scored[0];
  const autoBidAmount = parseFloat((budget * AUTO_BID_PCT).toFixed(2));

  const skipReason =
      !AUTO_BID_ENABLED                          ? 'auto_bid_enabled=false'
    : !AUTO_BID_CATEGORIES.includes(category)    ? `category '${category}' not in list`
    : !topMatch                                  ? 'no matching agents'
    : topMatch.kwHits.length === 0               ? 'no keyword hits in task text'
    : budget < AUTO_BID_THRESHOLD                ? `budget ${budget} < threshold ${AUTO_BID_THRESHOLD}`
    : autoBidAmount > SAFETY_MAX                 ? `bid ${autoBidAmount} > safety cap ${SAFETY_MAX}`
    : auto_bid_attempted                         ? 'auto_bid_attempted already set'
    : null;

  const autoBidEligible = !skipReason;
  let   autoBidRecord   = null;

  if (autoBidEligible) {
    const { agent, hits, kwHits } = topMatch;
    const bidMsg = `Auto-bid by ClawTown Task Hunter. Skills: ${hits.join(', ')}. Keywords: ${kwHits.join(', ')}. Bid: ${autoBidAmount} ${currency} | ETA: ${AUTO_BID_ETA}h.`;

    const existingRows = await apiGet('Bid', { task_id: task.id, agent_id: agent.id });
    const activeBid    = existingRows.find(r => {
      const d = r.data || r;
      return ['pending', 'auto'].includes(d.status);
    });

    let bid, wasUpdate = false;
    if (activeBid) {
      const updated = await apiPut('Bid', activeBid.id, {
        bid_amount: autoBidAmount, eta_hours: AUTO_BID_ETA, message: bidMsg,
        is_auto_bid: true, match_score: topMatch.score,
        match_reason: `Auto-bid update. Keywords: ${kwHits.join(', ')}.`,
        status: 'auto', is_test: isTest,
      });
      bid = { id: activeBid.id, ...(updated || {}) };
      wasUpdate = true;
    } else {
      const created = await apiPost('Bid', {
        task_id: task.id, agent_id: agent.id, agent_handle: agent.handle,
        bid_amount: autoBidAmount, currency, eta_hours: AUTO_BID_ETA,
        message: bidMsg, status: 'auto', is_auto_bid: true,
        match_score: topMatch.score,
        match_reason: `Auto-bid: category=${category}, keywords=[${kwHits.join(', ')}], budget ${budget} ≥ ${AUTO_BID_THRESHOLD}.`,
        is_test: isTest,  // ← propagate
      });
      bid = { id: created.id || created?.id, ...(created || {}) };
    }

    await apiPut('Task', task.id, {
      auto_bid_attempted: true, auto_bid_agent_id: agent.id, status: 'bidding',
    });

    autoBidRecord = {
      bid_id: bid.id, agent_id: agent.id, agent_handle: agent.handle,
      bid_amount: autoBidAmount, eta_hours: AUTO_BID_ETA, currency, was_update: wasUpdate,
    };

    audit.bids_placed.push({
      action: wasUpdate ? 'updated_existing' : 'created',
      bid_id: bid.id, agent_handle: agent.handle,
      amount: autoBidAmount, eta_hours: AUTO_BID_ETA,
      is_auto_bid: true, was_duplicate: wasUpdate, is_test: isTest,
    });
  } else {
    audit.bids_skipped.push({ reason: skipReason });
  }

  // 5. DM message
  const dmMessage = buildDmMessage(task, scored, autoBidRecord);

  // Helper: stamp is_test on every outbox record
  const outbox = (fields) => ({ ...fields, is_test: isTest });
  const now = new Date().toISOString();

  // 5a. TASK_CREATED
  await apiPost('EventOutbox', outbox({
    event_type: 'TASK_CREATED', reference_id: task.id, reference_type: 'task',
    channel: 'slack', status: 'pending', attempts: 0,
    payload: { task_id: task.id, event_time: now, actor: creator_handle || creator_id || 'unknown',
      targets: ['broadcast'], summary: `New task posted: ${title}`,
      title, budget_ttt: budget, category, tags, currency, is_test: isTest },
  }));
  audit.notifications_sent.push({ type: 'TASK_CREATED', channel: 'broadcast', is_test: isTest });

  // 5b. BID_PLACED
  if (autoBidRecord) {
    await apiPost('EventOutbox', outbox({
      event_type: 'BID_PLACED', reference_id: autoBidRecord.bid_id, reference_type: 'bid',
      channel: 'slack', status: 'pending', attempts: 0,
      payload: { task_id: task.id, event_time: now, actor: autoBidRecord.agent_handle,
        targets: ['broadcast'], title, bid_id: autoBidRecord.bid_id,
        agent_handle: autoBidRecord.agent_handle, bid_amount: autoBidRecord.bid_amount,
        eta_hours: autoBidRecord.eta_hours, currency, is_auto_bid: true, is_test: isTest },
    }));
    audit.notifications_sent.push({ type: 'BID_PLACED', agent: autoBidRecord.agent_handle, is_test: isTest });
  }

  // 5c. CREATOR_DM (idempotency guard)
  if (creator_slack_user_id) {
    const idempotency_key = `dm_task_${task.id}_${creator_slack_user_id}`;
    const existingDms = await apiGet('EventOutbox', { event_type: 'CREATOR_DM', reference_id: task.id });
    const alreadySent = existingDms.find(r => {
      const d = r.data || r;
      return d.payload?.idempotency_key === idempotency_key &&
             (d.status === 'sent' || d.metadata?.slack_ts);
    });

    if (!alreadySent) {
      await apiPost('EventOutbox', outbox({
        event_type: 'CREATOR_DM', reference_id: task.id, reference_type: 'task',
        channel: 'slack', status: 'pending', attempts: 0,
        recipient_id: creator_slack_user_id,
        payload: {
          recipient_slack_user_id: creator_slack_user_id, message: dmMessage,
          task_id: task.id, actor: 'ClawTown Task Hunter', idempotency_key, title,
          budget_ttt: budget, auto_bid_fired: !!autoBidRecord,
          bid_id: autoBidRecord?.bid_id || null, agent_handle: autoBidRecord?.agent_handle || null,
          bid_amount: autoBidRecord?.bid_amount || null, eta_hours: autoBidRecord?.eta_hours || null,
          is_test: isTest,
        },
      }));
      audit.notifications_sent.push({ type: 'CREATOR_DM', recipient: creator_slack_user_id, idempotency_key, is_test: isTest });
    } else {
      audit.notifications_sent.push({ type: 'CREATOR_DM', skipped: true, reason: 'idempotency_key_exists' });
    }
  }

  // 6. AuditLog
  audit.summary = autoBidEligible
    ? `Task processed. ${audit.matches.length} match(es). Auto-bid @${autoBidRecord.agent_handle} ${autoBidRecord.bid_amount} TTT. Creator DM ${creator_slack_user_id ? 'queued' : 'unavailable'}.${isTest ? ' [TEST FIXTURE]' : ''}`
    : `Task processed. ${audit.matches.length} match(es). Auto-bid skipped: ${skipReason}.${isTest ? ' [TEST FIXTURE]' : ''}`;
  audit.status = audit.errors.length > 0 ? 'partial' : 'ok';
  audit.raw_payload = {
    ...audit.raw_payload,
    auto_bid_fired: !!autoBidRecord,
    auto_bid_agent: autoBidRecord?.agent_handle || null,
    bid_id: autoBidRecord?.bid_id || null,
    task_id: task.id, is_test: isTest,
    ...(fixtureReason ? { fixture_reason: fixtureReason } : {}),
  };

  await apiPost('AuditLog', audit);

  console.log(JSON.stringify({
    ok: true, task_id: task.id, is_test: isTest,
    matches: audit.matches.length,
    auto_bid: autoBidRecord
      ? { agent: autoBidRecord.agent_handle, amount: autoBidRecord.bid_amount, bid_id: autoBidRecord.bid_id }
      : null,
    skip_reason: skipReason || null,
    creator_dm: creator_slack_user_id ? 'queued' : 'unavailable',
    summary: audit.summary,
  }));
}

run().catch(async err => {
  audit.errors.push({ code: 'UNHANDLED_EXCEPTION', message: err.message });
  audit.status = 'error'; audit.summary = `Unhandled error: ${err.message}`;
  await apiPost('AuditLog', audit).catch(() => {});
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
