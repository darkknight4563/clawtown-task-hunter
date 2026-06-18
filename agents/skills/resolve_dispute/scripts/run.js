/**
 * resolve_dispute — admin resolves a dispute with proportional payout
 *
 * Usage: node run.js <task_id> <creator_pct> <agent_pct> [slash=true|false] [resolution_notes...]
 *   creator_pct + agent_pct must = 100
 *   slash=true → stake_slash tx (Stake slashed, platform keeps stake)
 *   slash=false (default) → stake returned to agent
 *
 * Math (escrow balance = task.budget, stake in escrow_stake):
 *   creator_payout = escrow * (creator_pct/100)
 *   agent_payout   = escrow * (agent_pct/100)
 *   stake → slashed (to platform/escrow_stake kept) OR released to agent
 *
 * Idempotency: blocks if dispute_split tx already exists for this task.
 */

'use strict';

const [taskId, creatorPctStr, agentPctStr, slashStr, ...notesParts] = process.argv.slice(2);
const creatorPct    = parseFloat(creatorPctStr);
const agentPct      = parseFloat(agentPctStr);
const slashStake    = (slashStr || 'false').toLowerCase() !== 'false';
const resolutionNote = notesParts.join(' ') || `Split ${creatorPct}/${agentPct} by admin.`;

if (!taskId || isNaN(creatorPct) || isNaN(agentPct)) {
  console.error('Usage: node run.js <task_id> <creator_pct> <agent_pct> [slash=true|false] [notes]');
  process.exit(1);
}
if (Math.abs((creatorPct + agentPct) - 100) > 0.01)
  { console.log(JSON.stringify({ ok: false, error: 'INVALID_SPLIT', message: `creator_pct (${creatorPct}) + agent_pct (${agentPct}) must = 100` })); process.exit(0); }

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
  const runId    = `dispute_resolve_${taskId}_${Date.now()}`;

  const audit = {
    task_id: taskId, run_type: 'dispute_resolved',
    triggered_by: 'admin:resolve_dispute',
    summary: '', ledger_actions: [], notifications_sent: [], errors: [], status: 'ok',
    raw_payload: { taskId, creatorPct, agentPct, slashStake, resolutionNote, run_id: runId },
  };

  async function fail(code, msg) {
    audit.errors.push({ code, message: msg }); audit.status = 'error'; audit.summary = msg;
    await apiPost('AuditLog', audit).catch(() => {});
    console.log(JSON.stringify({ ok: false, error: code, message: msg }));
  }

  // Settings
  const settingsArr = await apiGet('PlatformSetting');
  const S = {}; settingsArr.forEach(s => { S[s.key] = s.value; });
  const writesEnabled = S['writes_enabled'];
  const adminSlackId  = S['default_creator_slack_user_id'] || null;

  // Load task
  const taskRows = await apiGet('Task', { id: taskId });
  if (!taskRows.length) return fail('TASK_NOT_FOUND', `Task ${taskId} not found.`);
  const task   = taskRows[0].data || taskRows[0];
  const isTest = !!task.is_test;
  if (task.status !== 'disputed')
    return fail('TASK_NOT_DISPUTED', `Task status='${task.status}'. Must be 'disputed'.`);

  const currency = task.currency || 'TTT';
  const budget   = task.budget;

  // Load dispute
  const disputeRows = await apiGet('Dispute', { task_id: taskId });
  const openDispute = disputeRows.map(d => d.data || d).find(d => d.status === 'open');
  if (!openDispute) return fail('NO_OPEN_DISPUTE', `No open dispute found for task ${taskId}.`);
  const disputeId = openDispute.id || openDispute._id;

  // Load agent + bid
  const agentRows = await apiGet('Agent', { id: task.awarded_agent_id });
  if (!agentRows.length) return fail('AGENT_NOT_FOUND', `Agent ${task.awarded_agent_id} not found.`);
  const agent = agentRows[0].data || agentRows[0];

  const bidRows = await apiGet('Bid', { id: task.awarded_bid_id });
  const bid     = bidRows[0] ? (bidRows[0].data || bidRows[0]) : null;

  // Load ledger accounts
  const allAccts        = await apiGet('LedgerAccount');
  const norm            = a => a.data || a;
  const escrowAcct      = allAccts.map(norm).find(a => a.owner_id === 'escrow'       && a.currency === currency);
  const escrowStakeAcct = allAccts.map(norm).find(a => a.owner_id === 'escrow_stake' && a.currency === currency);
  const agentAcct       = allAccts.map(norm).find(a => a.owner_id === task.awarded_agent_id && a.currency === currency);
  const creatorAcct     = allAccts.map(norm).find(a => a.owner_id === task.creator_id && a.currency === currency);

  if (!escrowAcct) return fail('NO_ESCROW', 'Escrow account not found.');

  // Idempotency: no prior dispute_split tx
  const existingTxs = await apiGet('LedgerTransaction', { reference_id: taskId });
  const alreadySplit = existingTxs.map(t => t.data || t).some(t => t.type === 'dispute_split');
  if (alreadySplit) return fail('ALREADY_RESOLVED', `Dispute for task ${taskId} already has payout txs.`);

  // Stake record
  const stakeRows = await apiGet('Stake', { task_id: taskId });
  const stakeRec  = stakeRows.map(s => s.data || s).find(s => s.status === 'locked' && s.agent_id === task.awarded_agent_id);
  const stakeAmount = stakeRec?.amount ?? parseFloat(((bid?.bid_amount || 0) * 0.1).toFixed(2));
  const stakeId     = stakeRec?.id || null;

  // writes_enabled guard
  if (writesEnabled === false || writesEnabled === 'false') {
    await apiPost('EventOutbox', {
      event_type: 'SYSTEM_ALERT', reference_id: runId, reference_type: 'system',
      channel: 'alerts', status: 'pending', is_test: isTest,
      payload: { idempotency_key: `resolve_writes_frozen_${runId}`, alert: 'writes_frozen',
        message: `resolve_dispute blocked for task ${taskId}: writes_enabled=false`, run_id: runId, event_time: now },
    });
    return fail('WRITES_DISABLED', 'writes_enabled=false — resolution blocked.');
  }

  // ── COMPUTE PAYOUTS ──────────────────────────────────────────────────────────
  const creatorPayout = parseFloat((budget * creatorPct / 100).toFixed(2));
  const agentPayout   = parseFloat((budget * agentPct  / 100).toFixed(2));
  // handle rounding: ensure sum = budget
  const roundingAdj = parseFloat((budget - creatorPayout - agentPayout).toFixed(2));

  // ── LEDGER TXS ──────────────────────────────────────────────────────────────
  let creatorPayTxId = null, agentPayTxId = null, stakeTxId = null;

  // Creator payout from escrow
  if (creatorPayout > 0 && creatorAcct) {
    const tx = await apiPost('LedgerTransaction', {
      from_account_id: escrowAcct.id, to_account_id: creatorAcct.id,
      amount: creatorPayout, currency,
      type: 'dispute_split', reference_id: taskId, reference_type: 'dispute',
      description: `Dispute resolved ${creatorPct}/${agentPct}: ${creatorPayout} ${currency} → creator`,
      status: 'completed',
    });
    creatorPayTxId = tx.id;
    audit.ledger_actions.push({ type: 'dispute_split_creator', amount: creatorPayout, tx_id: tx.id });
  }

  // Agent payout from escrow
  if (agentPayout > 0 && agentAcct) {
    const agentActualPayout = agentPayout + roundingAdj; // absorb rounding in agent side
    const tx = await apiPost('LedgerTransaction', {
      from_account_id: escrowAcct.id, to_account_id: agentAcct.id,
      amount: agentActualPayout, currency,
      type: 'dispute_split', reference_id: taskId, reference_type: 'dispute',
      description: `Dispute resolved ${creatorPct}/${agentPct}: ${agentActualPayout} ${currency} → agent @${agent.handle}`,
      status: 'completed',
    });
    agentPayTxId = tx.id;
    audit.ledger_actions.push({ type: 'dispute_split_agent', amount: agentActualPayout, tx_id: tx.id });
  }

  // Stake: slash or release
  if (stakeId && escrowStakeAcct) {
    if (slashStake) {
      // Slash: stake stays in escrow_stake (platform keeps it). Just update Stake record + emit event.
      stakeTxId = `slashed_in_place_${stakeId}`;
      await apiPut('Stake', stakeId, {
        status: 'slashed', slash_reason: `Dispute resolved: admin slashed stake. ${resolutionNote}`,
      });
      audit.ledger_actions.push({ type: 'stake_slash', amount: stakeAmount, note: 'slashed_in_place' });
    } else {
      // Release stake back to agent
      const tx = await apiPost('LedgerTransaction', {
        from_account_id: escrowStakeAcct.id, to_account_id: agentAcct?.id,
        amount: stakeAmount, currency,
        type: 'stake_release', reference_id: taskId, reference_type: 'stake',
        description: `Dispute resolved: stake ${stakeAmount} ${currency} returned to @${agent.handle}`,
        status: 'completed',
      });
      stakeTxId = tx.id;
      await apiPut('Stake', stakeId, { status: 'released', released_at: now, ledger_tx_id: tx.id });
      audit.ledger_actions.push({ type: 'stake_release', amount: stakeAmount, tx_id: tx.id });
    }
  }

  // ── BALANCE UPDATES ──────────────────────────────────────────────────────────
  // Escrow: drain creatorPayout + agentPayout (full budget gone)
  await apiPut('LedgerAccount', escrowAcct.id, {
    balance:          parseFloat(Math.max(0, escrowAcct.balance - budget).toFixed(2)),
    reserved_balance: parseFloat(Math.max(0, (escrowAcct.reserved_balance||0) - budget).toFixed(2)),
  });

  // Escrow stake: drain if slash (keep), or drain if release
  if (escrowStakeAcct) {
    await apiPut('LedgerAccount', escrowStakeAcct.id, {
      balance:          parseFloat(Math.max(0, escrowStakeAcct.balance - stakeAmount).toFixed(2)),
      reserved_balance: parseFloat(Math.max(0, (escrowStakeAcct.reserved_balance||0) - stakeAmount).toFixed(2)),
    });
  }

  // Agent account
  if (agentAcct) {
    const agentDelta = (agentPayout > 0 ? agentPayout + roundingAdj : 0) + (!slashStake ? stakeAmount : 0);
    await apiPut('LedgerAccount', agentAcct.id, {
      balance:          parseFloat((agentAcct.balance + agentDelta).toFixed(2)),
      reserved_balance: parseFloat(Math.max(0, (agentAcct.reserved_balance||0) - stakeAmount).toFixed(2)),
      total_earned:     parseFloat(((agentAcct.total_earned||0) + (agentPayout > 0 ? agentPayout : 0)).toFixed(2)),
    });
  }

  // Creator account
  if (creatorAcct && creatorPayout > 0) {
    await apiPut('LedgerAccount', creatorAcct.id, {
      balance:          parseFloat((creatorAcct.balance + creatorPayout).toFixed(2)),
      reserved_balance: parseFloat(Math.max(0, (creatorAcct.reserved_balance||0) - budget).toFixed(2)),
    });
  } else if (creatorAcct) {
    await apiPut('LedgerAccount', creatorAcct.id, {
      reserved_balance: parseFloat(Math.max(0, (creatorAcct.reserved_balance||0) - budget).toFixed(2)),
    });
  }

  // ── STATUS UPDATES ───────────────────────────────────────────────────────────
  const resolution = creatorPct === 100 ? 'resolved_creator'
    : agentPct === 100 ? 'resolved_agent' : 'resolved_split';

  await apiPut('Dispute', disputeId, {
    status:           resolution,
    resolution_notes: resolutionNote,
    resolved_at:      now,
    payout_creator:   creatorPayout,
    payout_agent:     agentPayout + (roundingAdj || 0),
  });
  await apiPut('Task', taskId, { status: 'completed', last_activity_at: now });

  // ── EVENTS ───────────────────────────────────────────────────────────────────
  // DISPUTE_RESOLVED → audit + hunters
  const resolvedMsg = [
    `⚖️ *DISPUTE RESOLVED* | Task \`${taskId.slice(-8)}\` — ${resolution.replace(/_/g,' ').toUpperCase()}`,
    `*${task.title||'Untitled'}*`,
    `Split: creator ${creatorPct}% (${creatorPayout} ${currency}) / agent ${agentPct}% (${agentPayout} ${currency})`,
    slashStake ? `Stake *SLASHED* — ${stakeAmount} ${currency} forfeited` : `Stake returned to @${agent.handle}`,
    `_${resolutionNote}_`,
  ].join('\n');

  await apiPost('EventOutbox', {
    event_type: 'DISPUTE_RESOLVED', reference_id: disputeId, reference_type: 'dispute',
    channel: 'audit', status: 'pending', is_test: isTest,
    payload: {
      idempotency_key: `dispute_resolved_${disputeId}`,
      dispute_id: disputeId, task_id: taskId,
      title: task.title||'Untitled',
      resolution, creator_pct: creatorPct, agent_pct: agentPct,
      creator_payout: creatorPayout, agent_payout: agentPayout,
      stake_amount: stakeAmount, stake_slashed: slashStake,
      creator_pay_tx_id: creatorPayTxId, agent_pay_tx_id: agentPayTxId, stake_tx_id: stakeTxId,
      currency, event_time: now,
      summary: `Dispute resolved ${creatorPct}/${agentPct}${slashStake?' (stake slashed)':''}`,
    },
  });
  audit.notifications_sent.push({ event_type: 'DISPUTE_RESOLVED', channel: 'audit' });

  // Hunters broadcast
  await apiPost('EventOutbox', {
    event_type: 'TASK_STATUS_CHANGED', reference_id: taskId, reference_type: 'task',
    channel: 'hunters', status: 'pending', is_test: isTest,
    payload: {
      idempotency_key: `dispute_task_completed_${taskId}`,
      task_id: taskId, title: task.title||'Untitled',
      old_status: 'disputed', new_status: 'completed',
      agent_handle: agent.handle,
      bid_amount: agentPayout, refund_amount: creatorPayout, currency,
      summary: `Dispute resolved. Task completed via ${resolution.replace(/_/g,' ')}.`,
      event_time: now,
    },
  });

  // STAKE_SLASH event if slashed
  if (slashStake) {
    await apiPost('EventOutbox', {
      event_type: 'STAKE_SLASH', reference_id: stakeId || taskId, reference_type: 'stake',
      channel: 'audit', status: 'pending', is_test: isTest,
      payload: {
        idempotency_key: `stake_slash_${stakeId||taskId}`,
        task_id: taskId, agent_handle: agent.handle,
        amount: stakeAmount, currency, reason: resolutionNote, event_time: now,
      },
    });
  }

  // DM both parties the outcome
  const creatorSlackId = task.creator_slack_user_id || adminSlackId;
  if (creatorSlackId) {
    await apiPost('EventOutbox', {
      event_type: 'CREATOR_DM', reference_id: disputeId, reference_type: 'dispute',
      channel: 'dm', status: 'pending', is_test: isTest,
      recipient_id: creatorSlackId,
      message: `⚖️ *Dispute resolved* on task: *${task.title||taskId}*\nYou receive: *${creatorPayout} ${currency}* (${creatorPct}% of escrow)\n_${resolutionNote}_`,
      payload: { idempotency_key: `dispute_creator_outcome_dm_${disputeId}`, dispute_id: disputeId, event_time: now },
    });
  }
  if (agent.slack_user_id) {
    await apiPost('EventOutbox', {
      event_type: 'AGENT_DM', reference_id: disputeId, reference_type: 'dispute',
      channel: 'dm', status: 'pending', is_test: isTest,
      recipient_id: agent.slack_user_id,
      message: [
        `⚖️ *Dispute resolved* on task: *${task.title||taskId}*`,
        `You receive: *${agentPayout} ${currency}* (${agentPct}% of escrow)`,
        slashStake ? `Your stake of *${stakeAmount} ${currency}* was *slashed*.` : `Your stake of *${stakeAmount} ${currency}* was returned.`,
        `_${resolutionNote}_`,
      ].join('\n'),
      payload: { idempotency_key: `dispute_agent_outcome_dm_${disputeId}`, dispute_id: disputeId, event_time: now },
    });
  }

  // ── AUDITLOG ─────────────────────────────────────────────────────────────────
  const durationMs = Date.now() - runStart;
  audit.summary = [
    `Dispute ${disputeId} resolved on task "${task.title||taskId}".`,
    `Split ${creatorPct}/${agentPct}: creator gets ${creatorPayout}, agent gets ${agentPayout} ${currency}.`,
    slashStake ? `Stake ${stakeAmount} ${currency} SLASHED.` : `Stake ${stakeAmount} ${currency} returned.`,
    isTest ? '[TEST]' : '',
  ].filter(Boolean).join(' ');
  audit.raw_payload = {
    ...audit.raw_payload, is_test: isTest, duration_ms: durationMs,
    dispute_id: disputeId, resolution,
    creator_payout: creatorPayout, agent_payout: agentPayout,
    stake_slashed: slashStake, stake_amount: stakeAmount,
    creator_pay_tx_id: creatorPayTxId, agent_pay_tx_id: agentPayTxId, stake_tx_id: stakeTxId,
  };
  await apiPost('AuditLog', audit);

  console.log(JSON.stringify({
    ok: true, dispute_id: disputeId, task_id: taskId, task_status: 'completed',
    resolution, creator_payout: creatorPayout, agent_payout: agentPayout,
    stake_slashed: slashStake, stake_amount: stakeAmount,
    creator_pay_tx_id: creatorPayTxId, agent_pay_tx_id: agentPayTxId, stake_tx_id: stakeTxId,
    duration_ms: durationMs,
  }));
})();
