/**
 * slack_command_processor  v1
 *
 * Sweeps EventOutbox where event_type=SLACK_COMMAND_REQUEST and status=pending.
 * Routes to existing skill logic (status, submit, approve, dispute, resolve).
 * Posts ephemeral reply to Slack response_url.
 * Stamps outbox as sent/failed with metadata + attempts.
 *
 * Env injected by Base44 skill runtime:
 *   VITE_BASE44_APP_ID  (or BASE44_APP_ID)
 *   BASE44_SERVICE_TOKEN
 *   SLACK_BOT_TOKEN      (for fallback channel posting if needed)
 */

'use strict';

// ── REST helpers ──────────────────────────────────────────────────────────────
const API_BASE    = () => `${process.env.VITE_BASE44_BACKEND_URL || 'https://base44.app'}/api/apps/${process.env.VITE_BASE44_APP_ID || process.env.BASE44_APP_ID}`;
const AUTH_HEADER = () => ({
  'Authorization': `Bearer ${process.env.BASE44_SERVICE_TOKEN}`,
  'Content-Type': 'application/json',
});

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

async function apiPatch(entity, id, body) {
  const r = await fetch(`${API_BASE()}/entities/${entity}/${id}`, {
    method: 'PUT', headers: AUTH_HEADER(), body: JSON.stringify(body),
  });
  return (await r.json()).data || {};
}

// ── Slack helpers ─────────────────────────────────────────────────────────────
async function postSlack(responseUrl, payload) {
  if (!responseUrl) return;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    // non-fatal — response_url may have expired
    console.error(`postSlack failed: ${e.message}`);
  } finally {
    clearTimeout(t);
  }
}

// ── Settings loader ───────────────────────────────────────────────────────────
async function loadSettings() {
  const rows = await apiGet('PlatformSetting');
  const map = {};
  for (const row of rows) {
    const d = row.data || row;
    let v = d.value;
    if (d.value_type === 'number')  v = parseFloat(v);
    if (d.value_type === 'boolean') v = v === 'true';
    if (d.value_type === 'json')    v = JSON.parse(v);
    map[d.key] = { id: d.id || row.id, value: v };
  }
  return map;
}

// ── Command parser ────────────────────────────────────────────────────────────
function parse(text) {
  const parts = (text || '').trim().split(/\s+/).filter(Boolean);
  const cmd   = (parts[0] || 'help').toLowerCase();
  const args  = parts.slice(1);
  return { cmd, args };
}

// ── Agent resolver ────────────────────────────────────────────────────────────
async function resolveAgentBySlackId(slackUserId) {
  if (!slackUserId) return null;
  const rows = await apiGet('Agent', { slack_user_id: slackUserId });
  return rows.length ? (rows[0].data || rows[0]) : null;
}

async function resolveAgentByHandle(handle) {
  if (!handle) return null;
  const rows = await apiGet('Agent', { handle: handle.replace(/^@/, '') });
  return rows.length ? (rows[0].data || rows[0]) : null;
}

// ── Help text ─────────────────────────────────────────────────────────────────
function helpText() {
  return `*ClawTown /claw commands:*
• \`/claw status <task_id>\` — check task status
• \`/claw bid <task_id> <amount> [eta_hours]\` — place a bid
• \`/claw deliver <task_id> <title> | <description>\` — submit a deliverable
• \`/claw approve <task_id>\` — approve deliverable & release escrow
• \`/claw dispute <task_id> <reason>\` — open a dispute
• \`/claw resolve <task_id> <creator|agent|split> [notes]\` — resolve dispute
• \`/claw myagent\` — show your linked agent profile
• \`/claw help\` — show this message`;
}

// ── Command handlers ──────────────────────────────────────────────────────────

async function cmdStatus(args) {
  const taskId = args[0];
  if (!taskId) return { ok: false, text: 'Usage: `/claw status <task_id>`' };
  const rows = await apiGet('Task', { id: taskId });
  if (!rows.length) return { ok: false, text: `Task \`${taskId.slice(-8)}\` not found.` };
  const t = rows[0].data || rows[0];
  const bids = await apiGet('Bid', { task_id: taskId });
  const activeBids = bids.filter(b => (b.data||b).status !== 'rejected' && (b.data||b).status !== 'withdrawn');
  return {
    ok: true,
    text:
      `📋 *${t.title || 'Untitled'}*\n` +
      `ID: \`${taskId.slice(-8)}\` | Status: *${t.status}* | Budget: ${t.budget} ${t.currency || 'TTT'}\n` +
      `Bids: ${activeBids.length}${t.deadline ? ` | Deadline: ${t.deadline.slice(0,10)}` : ''}`,
  };
}

async function cmdBid(args, agent) {
  if (!agent) return { ok: false, text: '❌ No agent linked to your Slack. Ask an admin to set `slack_user_id` on your Agent record.' };
  const [taskId, amountStr, etaStr] = args;
  if (!taskId || !amountStr) return { ok: false, text: 'Usage: `/claw bid <task_id> <amount> [eta_hours]`' };
  const taskRows = await apiGet('Task', { id: taskId });
  if (!taskRows.length) return { ok: false, text: `Task \`${taskId.slice(-8)}\` not found.` };
  const task = taskRows[0].data || taskRows[0];
  if (!['open', 'bidding'].includes(task.status)) return { ok: false, text: `Task is \`${task.status}\` — bids not accepted.` };

  // Dedup check
  const existingBids = await apiGet('Bid', { task_id: taskId, agent_id: agent.id });
  const active = existingBids.filter(b => {
    const s = (b.data||b).status;
    return s === 'pending' || s === 'auto';
  });
  if (active.length > 0) {
    // Update existing bid
    const existing = active[0].data || active[0];
    await apiPatch('Bid', existing.id, {
      bid_amount: parseFloat(amountStr),
      eta_hours:  etaStr ? parseFloat(etaStr) : existing.eta_hours,
      status: 'pending',
    });
    return { ok: true, text: `Updated existing bid on \`${taskId.slice(-8)}\` → ${amountStr} TTT` };
  }

  // Place new bid
  const bid = await apiPost('Bid', {
    task_id:      taskId,
    agent_id:     agent.id,
    agent_handle: agent.handle,
    bid_amount:   parseFloat(amountStr),
    currency:     task.currency || 'TTT',
    eta_hours:    etaStr ? parseFloat(etaStr) : 24,
    status:       'pending',
    is_auto_bid:  false,
  });

  // Bump task to bidding if still open
  if (task.status === 'open') {
    await apiPatch('Task', taskId, { status: 'bidding', last_activity_at: new Date().toISOString() });
  }

  // EventOutbox notification
  await apiPost('EventOutbox', {
    event_type:      'BID_PLACED',
    reference_id:    taskId,
    reference_type:  'task',
    status:          'pending',
    payload: {
      task_id:      taskId,
      title:        task.title,
      agent_handle: agent.handle,
      bid_amount:   parseFloat(amountStr),
      currency:     task.currency || 'TTT',
      eta_hours:    etaStr ? parseFloat(etaStr) : 24,
      is_auto_bid:  false,
    },
  });

  return { ok: true, text: `✅ Bid placed on \`${taskId.slice(-8)}\` — ${amountStr} TTT, ETA ${etaStr||24}h` };
}

async function cmdDeliver(args, agent) {
  if (!agent) return { ok: false, text: '❌ No agent linked to your Slack.' };
  const taskId = args[0];
  if (!taskId) return { ok: false, text: 'Usage: `/claw deliver <task_id> <title> | <description>`' };

  const rest = args.slice(1).join(' ');
  const [titlePart, ...descParts] = rest.split('|');
  const title = titlePart.trim() || 'Deliverable';
  const description = descParts.join('|').trim() || '';

  const taskRows = await apiGet('Task', { id: taskId });
  if (!taskRows.length) return { ok: false, text: `Task \`${taskId.slice(-8)}\` not found.` };
  const task = taskRows[0].data || taskRows[0];
  if (task.awarded_agent_id && task.awarded_agent_id !== agent.id)
    return { ok: false, text: `You are not the awarded agent for this task.` };

  const bidRows = await apiGet('Bid', { task_id: taskId, agent_id: agent.id });
  const acceptedBid = bidRows.find(b => (b.data||b).status === 'accepted');
  const bidId = acceptedBid ? (acceptedBid.data || acceptedBid).id : (task.awarded_bid_id || '');

  const deliverable = await apiPost('Deliverable', {
    task_id:      taskId,
    bid_id:       bidId,
    agent_id:     agent.id,
    title,
    description,
    status:       'submitted',
    submitted_at: new Date().toISOString(),
  });

  await apiPost('EventOutbox', {
    event_type:     'DELIVERABLE_SUBMITTED',
    reference_id:   taskId,
    reference_type: 'task',
    status:         'pending',
    payload: { task_id: taskId, title: task.title, agent_handle: agent.handle, deliverable_id: deliverable.id },
  });

  return { ok: true, text: `📦 Deliverable submitted for \`${taskId.slice(-8)}\` — "${title}"` };
}

async function cmdApprove(args, slackUserId) {
  const taskId = args[0];
  if (!taskId) return { ok: false, text: 'Usage: `/claw approve <task_id>`' };

  const taskRows = await apiGet('Task', { id: taskId });
  if (!taskRows.length) return { ok: false, text: `Task \`${taskId.slice(-8)}\` not found.` };
  const task = taskRows[0].data || taskRows[0];

  // Must be creator or admin to approve
  const isCreator = task.creator_slack_user_id === slackUserId;
  const adminRows = await apiGet('Agent', { slack_user_id: slackUserId, handle: 'admin' });
  const isAdmin   = adminRows.length > 0;
  if (!isCreator && !isAdmin) return { ok: false, text: `Only the task creator or admin can approve deliverables.` };

  const deliverableRows = await apiGet('Deliverable', { task_id: taskId, status: 'submitted' });
  if (!deliverableRows.length) return { ok: false, text: `No submitted deliverable found for \`${taskId.slice(-8)}\`.` };
  const deliverable = deliverableRows[0].data || deliverableRows[0];

  // Approve deliverable
  await apiPatch('Deliverable', deliverable.id, {
    status:      'approved',
    reviewed_at: new Date().toISOString(),
  });

  // Escrow release: find escrow lock transaction
  const escrowTxRows = await apiGet('LedgerTransaction', { reference_id: taskId, type: 'escrow_lock', status: 'completed' });
  const agentAccRows = await apiGet('LedgerAccount', { owner_id: task.awarded_agent_id, owner_type: 'agent' });
  const creatorAccRows = await apiGet('LedgerAccount', { owner_id: task.creator_id });

  const bidRows = await apiGet('Bid', { id: task.awarded_bid_id });
  const bid = bidRows.length ? (bidRows[0].data || bidRows[0]) : null;
  const bidAmount = bid ? bid.bid_amount : task.budget;
  const refund    = task.budget - bidAmount;

  if (agentAccRows.length) {
    const agentAcc = agentAccRows[0].data || agentAccRows[0];
    const payout = await apiPost('LedgerTransaction', {
      to_account_id:  agentAcc.id,
      amount:         bidAmount,
      currency:       task.currency || 'TTT',
      type:           'payout',
      reference_id:   taskId,
      reference_type: 'task',
      description:    `Payout to @${task.awarded_agent_id} for task ${taskId.slice(-8)}`,
      status:         'completed',
    });
    await apiPatch('LedgerAccount', agentAcc.id, {
      balance:       (agentAcc.balance || 0) + bidAmount,
      total_earned:  (agentAcc.total_earned || 0) + bidAmount,
    });
  }

  if (refund > 0 && creatorAccRows.length) {
    const creatorAcc = creatorAccRows[0].data || creatorAccRows[0];
    await apiPost('LedgerTransaction', {
      to_account_id:  creatorAcc.id,
      amount:         refund,
      currency:       task.currency || 'TTT',
      type:           'refund',
      reference_id:   taskId,
      reference_type: 'task',
      description:    `Budget refund to creator for task ${taskId.slice(-8)}`,
      status:         'completed',
    });
    await apiPatch('LedgerAccount', creatorAcc.id, {
      balance:          (creatorAcc.balance || 0) + refund,
      reserved_balance: Math.max(0, (creatorAcc.reserved_balance || 0) - task.budget),
    });
  }

  // Release stake
  const stakeRows = await apiGet('Stake', { task_id: taskId, agent_id: task.awarded_agent_id, status: 'locked' });
  if (stakeRows.length) {
    const stake = stakeRows[0].data || stakeRows[0];
    await apiPatch('Stake', stake.id, { status: 'released', released_at: new Date().toISOString() });
    const stakeAccRows = await apiGet('LedgerAccount', { owner_id: task.awarded_agent_id, owner_type: 'agent' });
    if (stakeAccRows.length) {
      const acc = stakeAccRows[0].data || stakeAccRows[0];
      await apiPatch('LedgerAccount', acc.id, {
        reserved_balance: Math.max(0, (acc.reserved_balance || 0) - stake.amount),
      });
    }
  }

  // Complete the task
  await apiPatch('Task', taskId, { status: 'completed', last_activity_at: new Date().toISOString() });

  // Notify
  await apiPost('EventOutbox', {
    event_type:     'DELIVERABLE_APPROVED',
    reference_id:   taskId,
    reference_type: 'task',
    status:         'pending',
    payload: {
      task_id:      taskId,
      title:        task.title,
      bid_amount:   bidAmount,
      refund,
      currency:     task.currency || 'TTT',
    },
  });

  return { ok: true, text: `✅ Deliverable approved! Task \`${taskId.slice(-8)}\` completed. Payout: ${bidAmount} TTT${refund > 0 ? `, refund: ${refund} TTT` : ''}` };
}

async function cmdDispute(args, agent, slackUserId) {
  const taskId = args[0];
  const reason = args.slice(1).join(' ');
  if (!taskId || !reason) return { ok: false, text: 'Usage: `/claw dispute <task_id> <reason>`' };

  const taskRows = await apiGet('Task', { id: taskId });
  if (!taskRows.length) return { ok: false, text: `Task \`${taskId.slice(-8)}\` not found.` };
  const task = taskRows[0].data || taskRows[0];

  const isAgent   = agent && task.awarded_agent_id === agent.id;
  const isCreator = task.creator_slack_user_id === slackUserId;
  const adminRows = await apiGet('Agent', { slack_user_id: slackUserId, handle: 'admin' });
  const isAdmin   = adminRows.length > 0;

  if (!isAgent && !isCreator && !isAdmin)
    return { ok: false, text: 'Only the task creator, awarded agent, or admin can open a dispute.' };

  const raisedByType = isAdmin ? 'admin' : (isCreator ? 'creator' : 'agent');
  const raisedById   = isAdmin ? 'admin' : (isCreator ? task.creator_id : agent.id);

  const dispute = await apiPost('Dispute', {
    task_id:       taskId,
    bid_id:        task.awarded_bid_id || '',
    raised_by_id:  raisedById,
    raised_by_type: raisedByType,
    against_id:    isCreator ? task.awarded_agent_id : task.creator_id,
    reason,
    status:        'open',
  });

  await apiPatch('Task', taskId, { status: 'disputed', last_activity_at: new Date().toISOString() });

  await apiPost('EventOutbox', {
    event_type:     'DISPUTE_OPENED',
    reference_id:   taskId,
    reference_type: 'task',
    status:         'pending',
    payload: { task_id: taskId, title: task.title, raised_by_type: raisedByType, reason, dispute_id: dispute.id },
  });

  return { ok: true, text: `⚠️ Dispute opened on \`${taskId.slice(-8)}\`. ID: \`${dispute.id?.slice(-8)}\`. Funds frozen until resolved.` };
}

async function cmdResolve(args, slackUserId) {
  const taskId     = args[0];
  const resolution = (args[1] || '').toLowerCase(); // creator | agent | split
  const notes      = args.slice(2).join(' ');

  if (!taskId || !['creator', 'agent', 'split'].includes(resolution))
    return { ok: false, text: 'Usage: `/claw resolve <task_id> <creator|agent|split> [notes]`' };

  // Admin-only
  const adminRows = await apiGet('Agent', { slack_user_id: slackUserId, handle: 'admin' });
  if (!adminRows.length) return { ok: false, text: 'Only admin can resolve disputes.' };

  const taskRows = await apiGet('Task', { id: taskId });
  if (!taskRows.length) return { ok: false, text: `Task \`${taskId.slice(-8)}\` not found.` };
  const task = taskRows[0].data || taskRows[0];

  const disputeRows = await apiGet('Dispute', { task_id: taskId, status: 'open' });
  if (!disputeRows.length) return { ok: false, text: `No open dispute for \`${taskId.slice(-8)}\`.` };
  const dispute = disputeRows[0].data || disputeRows[0];

  const bidRows = await apiGet('Bid', { id: task.awarded_bid_id });
  const bid = bidRows.length ? (bidRows[0].data || bidRows[0]) : null;
  const bidAmount = bid ? bid.bid_amount : task.budget;

  let payoutCreator = 0, payoutAgent = 0;
  if (resolution === 'creator')     { payoutCreator = task.budget; }
  else if (resolution === 'agent')  { payoutAgent   = bidAmount;  payoutCreator = task.budget - bidAmount; }
  else /* split */                  { payoutAgent   = Math.floor(bidAmount / 2); payoutCreator = task.budget - payoutAgent; }

  const resolvedStatus = resolution === 'creator' ? 'resolved_creator' : resolution === 'agent' ? 'resolved_agent' : 'resolved_split';

  await apiPatch('Dispute', dispute.id, {
    status:           resolvedStatus,
    resolution_notes: notes || `Resolved in favour of ${resolution}`,
    resolved_by_id:   adminRows[0].id || 'admin',
    resolved_at:      new Date().toISOString(),
    payout_creator:   payoutCreator,
    payout_agent:     payoutAgent,
  });

  await apiPatch('Task', taskId, { status: 'completed', last_activity_at: new Date().toISOString() });

  await apiPost('EventOutbox', {
    event_type:     'DISPUTE_RESOLVED',
    reference_id:   taskId,
    reference_type: 'task',
    status:         'pending',
    payload: {
      task_id:      taskId,
      title:        task.title,
      resolution,
      payout_creator: payoutCreator,
      payout_agent:   payoutAgent,
      currency:       task.currency || 'TTT',
      notes,
    },
  });

  return {
    ok: true,
    text:
      `✅ Dispute resolved (${resolution}) on \`${taskId.slice(-8)}\`.\n` +
      `Creator: ${payoutCreator} TTT | Agent: ${payoutAgent} TTT`,
  };
}

async function cmdMyAgent(agent) {
  if (!agent) return { ok: false, text: '❌ No agent linked to your Slack user. Ask an admin to set `slack_user_id` on your Agent record.' };
  return {
    ok: true,
    text:
      `👤 *@${agent.handle}* (${agent.name || 'unnamed'})\n` +
      `Status: ${agent.status || 'unknown'} | Rep: ${agent.reputation_score || 0}\n` +
      `Skills: ${(agent.skill_tags || []).join(', ') || 'none'}\n` +
      `Tasks won: ${agent.total_tasks_won || 0} | Completed: ${agent.total_tasks_completed || 0}`,
  };
}

// ── Main dispatcher ───────────────────────────────────────────────────────────
async function handleCommand({ cmd, args, slackUserId, settings }) {
  const agent = await resolveAgentBySlackId(slackUserId);

  switch (cmd) {
    case 'status':   return cmdStatus(args);
    case 'bid':      return cmdBid(args, agent);
    case 'deliver':  return cmdDeliver(args, agent);
    case 'approve':  return cmdApprove(args, slackUserId);
    case 'dispute':  return cmdDispute(args, agent, slackUserId);
    case 'resolve':  return cmdResolve(args, slackUserId);
    case 'myagent':  return cmdMyAgent(agent);
    case 'help':
    default:
      return { ok: true, text: helpText() };
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
export default async function run() {
  const appId    = process.env.VITE_BASE44_APP_ID || process.env.BASE44_APP_ID;
  const svcToken = process.env.BASE44_SERVICE_TOKEN;

  if (!appId || !svcToken) {
    console.log(JSON.stringify({ ok: false, error: 'Missing VITE_BASE44_APP_ID/BASE44_SERVICE_TOKEN' }));
    return;
  }

  // Kill switch check
  const settings = await loadSettings();
  const dispatchEnabled = settings['dispatch_enabled']?.value ?? true;
  if (!dispatchEnabled) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'dispatch_enabled=false' }));
    return;
  }

  // Sweep pending SLACK_COMMAND_REQUEST
  const pending = await apiGet('EventOutbox', { event_type: 'SLACK_COMMAND_REQUEST', status: 'pending' });
  const batch   = pending.slice(0, 20);

  let sent = 0, failed = 0;

  for (const row of batch) {
    const r         = row.data || row;
    const id        = r.id;
    const attempts  = Number(r.attempts || 0);
    const payload   = r.payload || {};
    const responseUrl  = payload.response_url;
    const slackUserId  = payload.user_id;
    const text         = payload.text || '';

    // Dedup: already processed
    if (r.metadata?.slack_ts) {
      await apiPatch('EventOutbox', id, { status: 'sent' });
      continue;
    }

    // Max attempts guard
    if (attempts >= 3) {
      await apiPatch('EventOutbox', id, { status: 'failed', error: 'max_attempts_exceeded' });
      failed++;
      continue;
    }

    try {
      const { cmd, args }  = parse(text);
      const res            = await handleCommand({ cmd, args, slackUserId, settings });

      await postSlack(responseUrl, {
        response_type: 'ephemeral',
        text: res.ok ? `✅ ${res.text}` : `❌ ${res.text}`,
      });

      await apiPatch('EventOutbox', id, {
        status:   'sent',
        attempts: attempts + 1,
        sent_at:  new Date().toISOString(),
        metadata: {
          ...(r.metadata || {}),
          routed_to: cmd,
          slack_ts:  String(Date.now()),
        },
      });

      sent++;
    } catch (e) {
      const nextAttempts = attempts + 1;
      await apiPatch('EventOutbox', id, {
        status:   nextAttempts >= 3 ? 'failed' : 'pending',
        attempts: nextAttempts,
        error:    String(e?.message || e),
      });
      failed++;
      console.error(`[slack_command_processor] Error on ${id}: ${e?.message || e}`);
    }
  }

  // AuditLog
  await apiPost('AuditLog', {
    run_type:    'slack_command',
    triggered_by: 'automation:slack_command_processor',
    status:      failed ? (sent ? 'partial' : 'error') : 'ok',
    summary:     `slack_command_processor: processed=${batch.length} sent=${sent} failed=${failed}`,
    raw_payload: { processed: batch.length, sent, failed },
  });

  console.log(JSON.stringify({ ok: true, processed: batch.length, sent, failed }));
}
