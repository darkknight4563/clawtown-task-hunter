/**
 * award_task  v3  (REST-only, no SDK dependency)
 *
 * Changes from v2:
 *   - Replaced @base44/sdk import with direct REST calls (same pattern as dispatcher)
 *   - award_task never posts to Slack directly — all notifications go via EventOutbox
 *   - No hardcoded channel IDs anywhere; routing is 100% handled by dispatch_slack_event
 *
 * is_test propagation:
 *   - Task.is_test=true → all EventOutbox records get is_test=true + fixture_reason
 *   - AuditLog entries carry is_test + fixture_reason
 *
 * Two-step flow:
 *   prepare → validation summary, AuditLog pending_confirm, nothing mutated
 *   confirm → escrow lock, stake lock, status updates, EventOutbox notifications
 *
 * Usage: node run.js <task_id> <agent_handle> <prepare|confirm>
 */

'use strict';

const [taskId, agentHandle, step] = process.argv.slice(2);
if (!taskId || !agentHandle || !step) {
  console.error('Usage: node run.js <task_id> <agent_handle> <prepare|confirm>');
  process.exit(1);
}

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

// ── Audit skeleton ─────────────────────────────────────────────────────────────
const audit = {
  task_id:            taskId,
  run_type:           step === 'prepare' ? 'award_requested' : 'award_confirmed',
  triggered_by:       `user:AWARD_${step.toUpperCase()}`,
  summary:            '',
  matches:            [],
  bids_placed:        [],
  bids_skipped:       [],
  notifications_sent: [],
  ledger_actions:     [],
  errors:             [],
  status:             'ok',
  raw_payload:        { taskId, agentHandle, step },
};

async function fail(code, message) {
  audit.errors.push({ code, message });
  audit.status  = 'error';
  audit.summary = message;
  await apiPost('AuditLog', audit).catch(() => {});
  console.log(JSON.stringify({ ok: false, error: code, message }));
}

async function run() {
  // ── Load task ─────────────────────────────────────────────────────────────
  const taskRows = await apiGet('Task', { id: taskId });
  if (!taskRows.length) return fail('TASK_NOT_FOUND', `Task ${taskId} not found.`);
  const task   = { id: taskRows[0].id || taskId, ...(taskRows[0].data || taskRows[0]) };
  const isTest = !!task.is_test;
  const fixtureReason = isTest ? 'Regression fixture — award_task pipeline verification.' : null;

  audit.raw_payload = {
    ...audit.raw_payload,
    is_test: isTest,
    ...(fixtureReason ? { fixture_reason: fixtureReason } : {}),
  };

  if (!['open', 'bidding'].includes(task.status))
    return fail('INVALID_TASK_STATUS', `Task status='${task.status}'. Must be open or bidding.`);

  const escrowAmount = task.budget;
  const currency     = task.currency || 'TTT';

  // ── Load agent ────────────────────────────────────────────────────────────
  const agentRows = await apiGet('Agent', { handle: agentHandle });
  if (!agentRows.length) return fail('AGENT_NOT_FOUND', `Agent @${agentHandle} not found.`);
  const agent = { id: agentRows[0].id, ...(agentRows[0].data || agentRows[0]) };
  if (agent.status !== 'active')
    return fail('AGENT_NOT_ACTIVE', `@${agentHandle} is '${agent.status}'.`);

  // ── Load bid ──────────────────────────────────────────────────────────────
  const allBidRows = await apiGet('Bid', { task_id: taskId });
  const allBids    = allBidRows.map(r => ({ id: r.id, ...(r.data || r) }));
  const activeBid  = allBids
    .filter(b => b.agent_id === agent.id)
    .find(b => ['pending', 'auto'].includes(b.status));
  if (!activeBid)
    return fail('BID_NOT_FOUND', `No active bid from @${agentHandle} on task ${taskId}.`);

  const bidAmount    = activeBid.bid_amount;
  const refundAmount = parseFloat((escrowAmount - bidAmount).toFixed(2));
  const stakeAmount  = parseFloat((bidAmount * 0.1).toFixed(2));

  // ── Ledger accounts ───────────────────────────────────────────────────────
  const [creatorAcctRows, agentAcctRows] = await Promise.all([
    apiGet('LedgerAccount', { owner_id: task.creator_id, currency }),
    apiGet('LedgerAccount', { owner_id: agent.id,        currency }),
  ]);
  const creatorAccount = creatorAcctRows[0] ? { id: creatorAcctRows[0].id, ...(creatorAcctRows[0].data || creatorAcctRows[0]) } : null;
  const agentAccount   = agentAcctRows[0]   ? { id: agentAcctRows[0].id,   ...(agentAcctRows[0].data   || agentAcctRows[0])   } : null;
  const creatorBalance = creatorAccount?.balance ?? null;
  const agentBalance   = agentAccount?.balance   ?? null;

  if (creatorBalance !== null && creatorBalance < escrowAmount)
    return fail('INSUFFICIENT_FUNDS',
      `Creator balance ${creatorBalance} ${currency} < escrow required ${escrowAmount} ${currency} (full budget).`);
  if (agentBalance !== null && agentBalance < stakeAmount)
    return fail('INSUFFICIENT_STAKE',
      `@${agentHandle} balance ${agentBalance} < stake required ${stakeAmount} ${currency}.`);

  // ══════════════════════════════════════════════════════════════
  // PREPARE — read-only validation, nothing mutated
  // ══════════════════════════════════════════════════════════════
  if (step === 'prepare') {
    const otherBidsToReject = allBids
      .filter(b => b.id !== activeBid.id && !['rejected', 'withdrawn'].includes(b.status))
      .map(b => `bid ${b.id} (@${b.agent_handle}) → rejected`);

    const summary = {
      task_id: taskId, task_title: task.title,
      is_test: isTest, ...(fixtureReason ? { fixture_reason: fixtureReason } : {}),
      task_budget: escrowAmount, task_status: task.status, currency,
      agent_handle: agentHandle, agent_status: agent.status,
      bid_id: activeBid.id, bid_amount: bidAmount,
      bid_type:  activeBid.is_auto_bid ? 'auto-bid' : 'manual',
      eta_hours: activeBid.eta_hours,
      balance_checks: {
        creator_balance:  `${creatorBalance} ${currency}`,
        escrow_required:  `${escrowAmount} ${currency}  ← FULL BUDGET`,
        creator_funds_ok: true,
        agent_balance:    `${agentBalance} ${currency}`,
        stake_required:   `${stakeAmount} ${currency}  (10% of bid)`,
        agent_stake_ok:   true,
      },
      status_changes_on_confirm: {
        task:        `${task.status} → awarded`,
        winning_bid: `pending/auto → accepted  [${activeBid.id}]`,
        other_bids:  otherBidsToReject,
      },
      ledger_entries_on_confirm: [
        { type: 'escrow_lock', from: `${task.creator_handle || 'creator'} (${creatorAccount?.id})`,
          amount: escrowAmount, currency,
          note: `balance ${creatorBalance}→${(creatorBalance||0)-escrowAmount} | reserved +${escrowAmount}` },
        { type: 'stake_lock', from: `@${agentHandle} (${agentAccount?.id})`,
          amount: stakeAmount, currency,
          note: `balance ${agentBalance}→${(agentBalance||0)-stakeAmount} | reserved +${stakeAmount}` },
      ],
      on_completion: {
        escrow_release_to_agent: `${bidAmount} ${currency} → @${agentHandle}`,
        refund_to_creator:       `${refundAmount} ${currency} → ${task.creator_handle || 'creator'}  (${escrowAmount}−${bidAmount})`,
        stake_release_to_agent:  `${stakeAmount} ${currency} → @${agentHandle}`,
      },
      next_step: 'Send CONFIRM AWARD to execute. Nothing has changed yet.',
    };

    audit.summary     = `PREPARE OK: "${task.title}" → @${agentHandle}. Escrow: ${escrowAmount} TTT. Bid: ${bidAmount}. Refund: ${refundAmount}. Stake: ${stakeAmount}. Awaiting CONFIRM AWARD.${isTest ? ' [TEST FIXTURE]' : ''}`;
    audit.status      = 'pending_confirm';
    audit.raw_payload = { ...audit.raw_payload, summary };
    await apiPost('AuditLog', audit);
    console.log(JSON.stringify({ ok: true, step: 'prepare', is_test: isTest, summary }));
    return;
  }

  // ══════════════════════════════════════════════════════════════
  // CONFIRM — mutate everything, emit EventOutbox
  // ══════════════════════════════════════════════════════════════
  if (step === 'confirm') {
    // Stamp is_test on every outbox record — routing handled 100% by dispatcher
    const outbox = (fields) => ({ ...fields, is_test: isTest });

    // 1. Accept winning bid, reject others
    await apiPut('Bid', activeBid.id, { status: 'accepted' });
    const otherBids = allBids.filter(b => b.id !== activeBid.id && !['rejected', 'withdrawn'].includes(b.status));
    for (const ob of otherBids) await apiPut('Bid', ob.id, { status: 'rejected' });

    // 2. Award task
    await apiPut('Task', taskId, {
      status: 'awarded', awarded_agent_id: agent.id, awarded_bid_id: activeBid.id,
    });

    // 3. ESCROW LOCK — full budget
    let escrowTxId = null;
    if (creatorAccount) {
      const tx = await apiPost('LedgerTransaction', {
        from_account_id: creatorAccount.id,
        amount:          escrowAmount,
        currency,
        type:            'escrow_lock',
        reference_id:    taskId,
        reference_type:  'task',
        description:     `Escrow lock: full budget ${escrowAmount} TTT for "${task.title}" → @${agentHandle}. Pay ${bidAmount} TTT on completion, refund ${refundAmount} TTT to creator.`,
        status:          'completed',
      });
      escrowTxId = tx.id;
      await apiPut('LedgerAccount', creatorAccount.id, {
        balance:          parseFloat((creatorAccount.balance - escrowAmount).toFixed(2)),
        reserved_balance: parseFloat(((creatorAccount.reserved_balance || 0) + escrowAmount).toFixed(2)),
        total_spent:      parseFloat(((creatorAccount.total_spent      || 0) + escrowAmount).toFixed(2)),
      });
      audit.ledger_actions.push({
        type: 'escrow_lock', tx_id: escrowTxId, amount: escrowAmount, currency,
        note: `full budget locked; pay ${bidAmount} to agent + refund ${refundAmount} to creator on completion`,
      });
    }

    // 4. STAKE LOCK — 10% of bid
    let stakeTxId = null;
    if (agentAccount) {
      const tx = await apiPost('LedgerTransaction', {
        from_account_id: agentAccount.id,
        amount:          stakeAmount,
        currency,
        type:            'stake_lock',
        reference_id:    taskId,
        reference_type:  'task',
        description:     `Stake lock: 10% of bid (${stakeAmount} TTT) for "${task.title}" — @${agentHandle}. Released on approval, slashed on dispute loss.`,
        status:          'completed',
      });
      stakeTxId = tx.id;
      await apiPut('LedgerAccount', agentAccount.id, {
        balance:          parseFloat((agentAccount.balance - stakeAmount).toFixed(2)),
        reserved_balance: parseFloat(((agentAccount.reserved_balance || 0) + stakeAmount).toFixed(2)),
      });
    }

    const stake = await apiPost('Stake', {
      agent_id:    agent.id,
      task_id:     taskId,
      bid_id:      activeBid.id,
      amount:      stakeAmount,
      currency,
      status:      'locked',
      locked_at:   new Date().toISOString(),
      ledger_tx_id: stakeTxId,
    });
    audit.ledger_actions.push({
      type: 'stake_lock', tx_id: stakeTxId, stake_id: stake.id, amount: stakeAmount, currency,
      note: 'released on deliverable approved; slashed if dispute lost',
    });

    // 5. EventOutbox notifications — NO direct Slack, all routed via dispatcher
    //    Channel resolution is dispatcher's job entirely.
    const now = new Date().toISOString();
    const basePayload = {
      task_id:      taskId,
      task_title:   task.title,
      agent_handle: agentHandle,
      bid_amount:   bidAmount,
      budget_ttt:   escrowAmount,
      refund_ttt:   refundAmount,
      stake_amount: stakeAmount,
      escrow_tx_id: escrowTxId,
      stake_id:     stake.id,
      eta_hours:    activeBid.eta_hours,
      is_test:      isTest,
      ...(fixtureReason ? { fixture_reason: fixtureReason } : {}),
    };

    const notifSpecs = [
      {
        event_type:      'CREATOR_DM',
        recipient_id:    task.creator_slack_user_id || task.creator_id,
        recipient_handle: task.creator_handle || 'creator',
        message: `✅ Task "${task.title}" awarded to @${agentHandle}!\n🔒 Escrow: ${escrowAmount} TTT (full budget)\n💰 Agent payout on completion: ${bidAmount} TTT\n💸 Your refund on completion: ${refundAmount} TTT\n⏱ ETA: ${activeBid.eta_hours}h  |  🔐 Stake: ${stakeAmount} TTT\n📋 Escrow TX: ${escrowTxId || 'skipped'}`,
      },
      {
        event_type:      'AGENT_DM',
        recipient_id:    agent.id,
        recipient_handle: agentHandle,
        message: `🏆 Awarded: "${task.title}"!\n💰 You earn ${bidAmount} TTT on approval\n⏱ ETA: ${activeBid.eta_hours}h  |  🔐 Stake: ${stakeAmount} TTT locked\nSubmit a Deliverable record to trigger release.`,
      },
      {
        event_type:      'TASK_AWARDED',
        recipient_id:    null,
        recipient_handle: null,
        message:         null,  // formatted by dispatcher from payload
      },
      {
        event_type:      'ESCROW_LOCK',
        recipient_id:    null,
        recipient_handle: null,
        message:         null,
      },
      {
        event_type:      'STAKE_LOCK',
        recipient_id:    null,
        recipient_handle: null,
        message:         null,
      },
    ];

    for (const spec of notifSpecs) {
      await apiPost('EventOutbox', outbox({
        event_type:      spec.event_type,
        reference_id:    taskId,
        reference_type:  'task',
        channel:         'slack',
        status:          'pending',
        attempts:        0,
        recipient_id:    spec.recipient_id    || null,
        recipient_handle: spec.recipient_handle || null,
        ...(spec.message ? { message: spec.message } : {}),
        payload:         { ...basePayload, event_time: now },
      }));
      audit.notifications_sent.push({
        type:      spec.event_type,
        recipient: spec.recipient_handle || null,
        is_test:   isTest,
      });
    }

    audit.summary = `CONFIRM OK: "${task.title}" awarded to @${agentHandle}. Escrow: ${escrowAmount} TTT. Bid: ${bidAmount} TTT. Refund: ${refundAmount} TTT. Stake: ${stakeAmount} TTT.${isTest ? ' [TEST FIXTURE]' : ''}`;
    audit.status  = 'ok';
    audit.raw_payload = {
      ...audit.raw_payload,
      escrow_tx_id:  escrowTxId,
      stake_tx_id:   stakeTxId,
      stake_id:      stake.id,
      bid_id:        activeBid.id,
      bid_amount:    bidAmount,
      escrow_amount: escrowAmount,
      refund_amount: refundAmount,
      stake_amount:  stakeAmount,
    };
    await apiPost('AuditLog', audit);

    console.log(JSON.stringify({
      ok: true, step: 'confirm', is_test: isTest,
      task_id: taskId, agent: agentHandle,
      escrow_tx: escrowTxId, stake_id: stake.id,
      bid_amount: bidAmount, escrow_amount: escrowAmount,
      summary: audit.summary,
    }));
  }
}

run().catch(async err => {
  audit.errors.push({ code: 'UNHANDLED_EXCEPTION', message: err.message });
  audit.status  = 'error';
  audit.summary = `Unhandled error: ${err.message}`;
  await apiPost('AuditLog', audit).catch(() => {});
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
