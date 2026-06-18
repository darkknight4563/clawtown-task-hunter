/**
 * approve_deliverable — creator/admin approves a deliverable, releases escrow + stake
 *
 * Usage: node run.js <task_id> [deliverable_id]
 *
 * Actions:
 *   1. Validate task status=awarded|delivered, escrow lock + stake lock exist
 *   2. Guard writes_enabled → SYSTEM_ALERT + fail if false
 *   3. Idempotency: check no prior payout tx for this task
 *   4. Create LedgerTx PAYOUT(bid_amount) → agent account
 *   5. Create LedgerTx REFUND(budget-bid) → creator account  (skip if 0)
 *   6. Create LedgerTx STAKE_RELEASE(stake_amount) → agent account
 *   7. Update LedgerAccount balances/reserved_balance for all 4 accounts
 *      (escrow, escrow_stake, creator, agent)
 *   8. Update Stake record → status=released, released_at=now
 *   9. Update Deliverable → status=approved, reviewed_at=now
 *  10. Update Task → status=completed, last_activity_at=now
 *  11. Emit EventOutbox: TASK_STATUS_CHANGED (hunters),
 *                        ESCROW_RELEASE (audit), PAYOUT (audit),
 *                        REFUND (audit, if refund>0), STAKE_RELEASE (audit)
 *  12. Write AuditLog run_type=deliverable_approved with all tx ids
 */

'use strict';

const [taskId, deliverableIdArg] = process.argv.slice(2);
if (!taskId) {
  console.error('Usage: node run.js <task_id> [deliverable_id]');
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
  const runId    = `approve_${taskId}_${Date.now()}`;

  const audit = {
    task_id:            taskId,
    run_type:           'deliverable_approved',
    triggered_by:       'admin:approve_deliverable',
    summary:            '',
    ledger_actions:     [],
    notifications_sent: [],
    errors:             [],
    status:             'ok',
    raw_payload:        { taskId, deliverableIdArg, run_id: runId },
  };

  async function fail(code, message) {
    audit.errors.push({ code, message });
    audit.status  = 'error';
    audit.summary = message;
    await apiPost('AuditLog', audit).catch(() => {});
    console.log(JSON.stringify({ ok: false, error: code, message }));
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  const settingsArr = await apiGet('PlatformSetting');
  const S = {};
  settingsArr.forEach(s => { S[s.key] = s.value; });
  const writesEnabled = S['writes_enabled'];

  // ── Load task ──────────────────────────────────────────────────────────────
  const taskRows = await apiGet('Task', { id: taskId });
  if (!taskRows.length) return fail('TASK_NOT_FOUND', `Task ${taskId} not found.`);
  const task   = taskRows[0].data || taskRows[0];
  const isTest = !!task.is_test;

  if (!['awarded', 'delivered'].includes(task.status))
    return fail('INVALID_TASK_STATUS',
      `Task status='${task.status}'. Must be 'awarded' or 'delivered' to approve.`);
  if (!task.awarded_agent_id || !task.awarded_bid_id)
    return fail('TASK_NOT_AWARDED', `Task has no awarded_agent_id or awarded_bid_id.`);

  const currency = task.currency || 'TTT';
  const budget   = task.budget;

  // ── Load bid ───────────────────────────────────────────────────────────────
  const bidRows = await apiGet('Bid', { id: task.awarded_bid_id });
  if (!bidRows.length) return fail('BID_NOT_FOUND', `Awarded bid ${task.awarded_bid_id} not found.`);
  const bid       = bidRows[0].data || bidRows[0];
  const bidAmount = bid.bid_amount;
  const refund    = parseFloat((budget - bidAmount).toFixed(2));

  // ── Load agent ─────────────────────────────────────────────────────────────
  const agentRows = await apiGet('Agent', { id: task.awarded_agent_id });
  if (!agentRows.length) return fail('AGENT_NOT_FOUND', `Agent ${task.awarded_agent_id} not found.`);
  const agent = agentRows[0].data || agentRows[0];

  // ── Load deliverable ───────────────────────────────────────────────────────
  let deliverable = null;
  if (deliverableIdArg) {
    const dRows = await apiGet('Deliverable', { id: deliverableIdArg });
    if (dRows.length) deliverable = dRows[0].data || dRows[0];
  }
  if (!deliverable) {
    // Find latest submitted deliverable for this task
    const allD = await apiGet('Deliverable', { task_id: taskId });
    const submitted = allD
      .map(d => d.data || d)
      .filter(d => ['submitted', 'pending'].includes(d.status))
      .sort((a, b) => new Date(b.submitted_at||b.created_date) - new Date(a.submitted_at||a.created_date));
    if (!submitted.length) return fail('NO_DELIVERABLE', `No submitted deliverable found for task ${taskId}.`);
    deliverable = submitted[0];
  }
  const deliverableId = deliverable.id || deliverable._id;

  // ── Load stake ─────────────────────────────────────────────────────────────
  const stakeRows = await apiGet('Stake', { task_id: taskId });
  const stake     = stakeRows.find(s => {
    const sd = s.data || s;
    return sd.status === 'locked' && sd.agent_id === task.awarded_agent_id;
  });
  const stakeData   = stake ? (stake.data || stake) : null;
  const stakeAmount = stakeData?.amount ?? parseFloat((bidAmount * 0.1).toFixed(2)); // fallback calc
  const stakeId     = stake?.id || null;

  // ── Load LedgerAccounts ────────────────────────────────────────────────────
  const allAccts = await apiGet('LedgerAccount');
  const normalize = (a) => a.data || a;
  const escrowAcct      = allAccts.map(normalize).find(a => a.owner_id === 'escrow'        && a.currency === currency);
  const escrowStakeAcct = allAccts.map(normalize).find(a => a.owner_id === 'escrow_stake'  && a.currency === currency);
  const creatorAcct     = allAccts.map(normalize).find(a => a.owner_id === task.creator_id && a.currency === currency);
  const agentAcct       = allAccts.map(normalize).find(a => a.owner_id === task.awarded_agent_id && a.currency === currency);

  if (!escrowAcct)      return fail('ESCROW_ACCOUNT_NOT_FOUND', 'Escrow account not found.');
  if (!escrowStakeAcct) return fail('ESCROW_STAKE_ACCOUNT_NOT_FOUND', 'Escrow stake account not found.');
  if (!agentAcct)       return fail('AGENT_ACCOUNT_NOT_FOUND', `Ledger account for agent ${task.awarded_agent_id} not found.`);

  // Validate escrow holds enough funds
  if (escrowAcct.balance < bidAmount)
    return fail('ESCROW_INSUFFICIENT',
      `Escrow balance ${escrowAcct.balance} < bid amount ${bidAmount} ${currency}.`);
  if (escrowStakeAcct.balance < stakeAmount)
    return fail('ESCROW_STAKE_INSUFFICIENT',
      `Escrow stake balance ${escrowStakeAcct.balance} < stake ${stakeAmount} ${currency}.`);

  // ── Idempotency: check for prior payout tx on this task ───────────────────
  const existingTxs = await apiGet('LedgerTransaction', { reference_id: taskId });
  const alreadyPaid = existingTxs
    .map(t => t.data || t)
    .some(t => t.type === 'payout' && t.reference_id === taskId);
  if (alreadyPaid)
    return fail('ALREADY_PAID', `Payout already exists for task ${taskId}. Idempotency check blocked double-pay.`);

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
        idempotency_key: `approve_writes_frozen_${runId}`,
        alert:   'writes_frozen',
        message: `approve_deliverable blocked for task ${taskId}: writes_enabled=false`,
        run_id:  runId,
        event_time: now,
      },
    });
    return fail('WRITES_DISABLED', 'writes_enabled=false — approval blocked, no ledger changes made.');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LEDGER MUTATIONS
  // ══════════════════════════════════════════════════════════════════════════

  // ── 1. PAYOUT: escrow → agent ──────────────────────────────────────────────
  const payoutTx = await apiPost('LedgerTransaction', {
    from_account_id: escrowAcct.id,
    to_account_id:   agentAcct.id,
    amount:          bidAmount,
    currency,
    type:            'payout',
    reference_id:    taskId,
    reference_type:  'task',
    description:     `Payout: ${bidAmount} ${currency} to @${agent.handle} for "${task.title||taskId}"`,
    status:          'completed',
  });
  audit.ledger_actions.push({ type: 'payout', amount: bidAmount, tx_id: payoutTx.id });

  // ── 2. REFUND: escrow → creator (only if refund > 0) ──────────────────────
  let refundTxId = null;
  if (refund > 0 && creatorAcct) {
    const refundTx = await apiPost('LedgerTransaction', {
      from_account_id: escrowAcct.id,
      to_account_id:   creatorAcct.id,
      amount:          refund,
      currency,
      type:            'refund',
      reference_id:    taskId,
      reference_type:  'task',
      description:     `Refund: ${refund} ${currency} to creator (budget ${budget} − bid ${bidAmount})`,
      status:          'completed',
    });
    refundTxId = refundTx.id;
    audit.ledger_actions.push({ type: 'refund', amount: refund, tx_id: refundTxId });
  }

  // ── 3. STAKE_RELEASE: escrow_stake → agent ─────────────────────────────────
  const stakeRelTx = await apiPost('LedgerTransaction', {
    from_account_id: escrowStakeAcct.id,
    to_account_id:   agentAcct.id,
    amount:          stakeAmount,
    currency,
    type:            'stake_release',
    reference_id:    taskId,
    reference_type:  'task',
    description:     `Stake release: ${stakeAmount} ${currency} to @${agent.handle} — task completed`,
    status:          'completed',
  });
  audit.ledger_actions.push({ type: 'stake_release', amount: stakeAmount, tx_id: stakeRelTx.id });

  // ── 4. Update LedgerAccount balances ──────────────────────────────────────
  // Escrow: deduct payout + refund, clear reserved
  await apiPut('LedgerAccount', escrowAcct.id, {
    balance:          parseFloat((escrowAcct.balance - bidAmount - (refund > 0 ? refund : 0)).toFixed(2)),
    reserved_balance: parseFloat(Math.max(0, (escrowAcct.reserved_balance || 0) - budget).toFixed(2)),
  });
  // Escrow stake: deduct stake amount
  await apiPut('LedgerAccount', escrowStakeAcct.id, {
    balance:          parseFloat((escrowStakeAcct.balance - stakeAmount).toFixed(2)),
    reserved_balance: parseFloat(Math.max(0, (escrowStakeAcct.reserved_balance || 0) - stakeAmount).toFixed(2)),
  });
  // Agent: receive payout + stake_release, release reserved
  await apiPut('LedgerAccount', agentAcct.id, {
    balance:          parseFloat((agentAcct.balance + bidAmount + stakeAmount).toFixed(2)),
    reserved_balance: parseFloat(Math.max(0, (agentAcct.reserved_balance || 0) - stakeAmount).toFixed(2)),
    total_earned:     parseFloat(((agentAcct.total_earned || 0) + bidAmount).toFixed(2)),
  });
  // Creator: receive refund, clear reserved (if account exists)
  if (creatorAcct && refund > 0) {
    await apiPut('LedgerAccount', creatorAcct.id, {
      balance:          parseFloat((creatorAcct.balance + refund).toFixed(2)),
      reserved_balance: parseFloat(Math.max(0, (creatorAcct.reserved_balance || 0) - budget).toFixed(2)),
      total_spent:      parseFloat(((creatorAcct.total_spent || 0) + bidAmount).toFixed(2)),
    });
  } else if (creatorAcct) {
    // refund=0 but still clear reserved
    await apiPut('LedgerAccount', creatorAcct.id, {
      reserved_balance: parseFloat(Math.max(0, (creatorAcct.reserved_balance || 0) - budget).toFixed(2)),
      total_spent:      parseFloat(((creatorAcct.total_spent || 0) + bidAmount).toFixed(2)),
    });
  }

  // ── 5. Release stake record ────────────────────────────────────────────────
  if (stakeId) {
    await apiPut('Stake', stakeId, {
      status:      'released',
      released_at: now,
      ledger_tx_id: stakeRelTx.id,
    });
  }

  // ── 6. Approve deliverable ─────────────────────────────────────────────────
  await apiPut('Deliverable', deliverableId, {
    status:        'approved',
    reviewed_at:   now,
    reviewer_notes:`Approved by admin. Payout: ${bidAmount} ${currency}. Refund: ${refund} ${currency}.`,
  });

  // ── 7. Complete task ───────────────────────────────────────────────────────
  await apiPut('Task', taskId, {
    status:          'completed',
    last_activity_at: now,
  });

  // ── 8. Emit EventOutbox ────────────────────────────────────────────────────
  // TASK_STATUS_CHANGED → hunters
  await apiPost('EventOutbox', {
    event_type:    'TASK_STATUS_CHANGED',
    reference_id:  taskId,
    reference_type:'task',
    channel:       'hunters',
    status:        'pending',
    is_test:       isTest,
    payload: {
      idempotency_key: `task_completed_${taskId}`,
      task_id:         taskId,
      title:           task.title || 'Untitled',
      old_status:      task.status,
      new_status:      'completed',
      agent_handle:    agent.handle,
      bid_amount:      bidAmount,
      refund_amount:   refund,
      stake_amount:    stakeAmount,
      currency,
      deliverable_id:  deliverableId,
      payout_tx_id:    payoutTx.id,
      refund_tx_id:    refundTxId,
      stake_release_tx_id: stakeRelTx.id,
      event_time:      now,
      summary:         `Task "${task.title||taskId}" completed. @${agent.handle} paid ${bidAmount} ${currency}.`,
    },
  });
  audit.notifications_sent.push({ event_type: 'TASK_STATUS_CHANGED', reference_id: taskId });

  // ESCROW_RELEASE → audit
  await apiPost('EventOutbox', {
    event_type:    'ESCROW_RELEASE',
    reference_id:  taskId,
    reference_type:'task',
    channel:       'audit',
    status:        'pending',
    is_test:       isTest,
    payload: {
      idempotency_key: `escrow_release_${taskId}`,
      task_id:         taskId,
      agent_handle:    agent.handle,
      agent_payout:    bidAmount,
      creator_refund:  refund,
      currency,
      payout_tx_id:    payoutTx.id,
      refund_tx_id:    refundTxId,
      event_time:      now,
    },
  });
  audit.notifications_sent.push({ event_type: 'ESCROW_RELEASE', reference_id: taskId });

  // PAYOUT → audit
  await apiPost('EventOutbox', {
    event_type:    'PAYOUT',
    reference_id:  payoutTx.id,
    reference_type:'ledger_tx',
    channel:       'audit',
    status:        'pending',
    is_test:       isTest,
    payload: {
      idempotency_key: `payout_${payoutTx.id}`,
      task_id:         taskId,
      agent_handle:    agent.handle,
      amount:          bidAmount,
      currency,
      tx_id:           payoutTx.id,
      event_time:      now,
    },
  });

  // REFUND → audit (only if > 0)
  if (refund > 0) {
    await apiPost('EventOutbox', {
      event_type:    'REFUND',
      reference_id:  refundTxId,
      reference_type:'ledger_tx',
      channel:       'audit',
      status:        'pending',
      is_test:       isTest,
      payload: {
        idempotency_key: `refund_${refundTxId}`,
        task_id:         taskId,
        creator_handle:  task.creator_handle || 'admin',
        amount:          refund,
        currency,
        tx_id:           refundTxId,
        event_time:      now,
      },
    });
  }

  // STAKE_RELEASE → audit
  await apiPost('EventOutbox', {
    event_type:    'STAKE_RELEASE',
    reference_id:  stakeRelTx.id,
    reference_type:'ledger_tx',
    channel:       'audit',
    status:        'pending',
    is_test:       isTest,
    payload: {
      idempotency_key: `stake_release_${stakeRelTx.id}`,
      task_id:         taskId,
      agent_handle:    agent.handle,
      amount:          stakeAmount,
      currency,
      tx_id:           stakeRelTx.id,
      event_time:      now,
    },
  });

  // ── 9. AuditLog ───────────────────────────────────────────────────────────
  const durationMs = Date.now() - runStart;
  audit.summary = [
    `Deliverable approved for task "${task.title||taskId}".`,
    `@${agent.handle} paid ${bidAmount} ${currency}.`,
    refund > 0 ? `Creator refunded ${refund} ${currency}.` : 'No refund (budget == bid).',
    `Stake ${stakeAmount} ${currency} released.`,
    isTest ? '[TEST]' : '',
  ].filter(Boolean).join(' ');
  audit.raw_payload = {
    ...audit.raw_payload,
    is_test:             isTest,
    duration_ms:         durationMs,
    deliverable_id:      deliverableId,
    budget,
    bid_amount:          bidAmount,
    refund_amount:       refund,
    stake_amount:        stakeAmount,
    payout_tx_id:        payoutTx.id,
    refund_tx_id:        refundTxId,
    stake_release_tx_id: stakeRelTx.id,
    ledger_before: {
      escrow:       escrowAcct.balance,
      escrow_stake: escrowStakeAcct.balance,
      agent:        agentAcct.balance,
      creator:      creatorAcct?.balance ?? null,
    },
    ledger_after: {
      escrow:       parseFloat((escrowAcct.balance - bidAmount - refund).toFixed(2)),
      escrow_stake: parseFloat((escrowStakeAcct.balance - stakeAmount).toFixed(2)),
      agent:        parseFloat((agentAcct.balance + bidAmount + stakeAmount).toFixed(2)),
      creator:      creatorAcct ? parseFloat((creatorAcct.balance + (refund > 0 ? refund : 0)).toFixed(2)) : null,
    },
  };
  await apiPost('AuditLog', audit);

  console.log(JSON.stringify({
    ok:                  true,
    task_id:             taskId,
    task_status:         'completed',
    deliverable_id:      deliverableId,
    deliverable_status:  'approved',
    agent_handle:        agent.handle,
    payout:              bidAmount,
    refund,
    stake_released:      stakeAmount,
    payout_tx_id:        payoutTx.id,
    refund_tx_id:        refundTxId,
    stake_release_tx_id: stakeRelTx.id,
    duration_ms:         durationMs,
  }));
})();
