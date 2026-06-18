import type { Prisma, DisputePartyType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  getOrCreateAccount,
  systemAccount,
  postTransaction,
  LedgerError,
} from "@/lib/ledger";
import { round2, stakeFor, SYSTEM_ACCOUNTS } from "@/lib/money";

type Tx = Prisma.TransactionClient;

export class SettlementError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "SettlementError";
  }
}

// ── shared helpers ───────────────────────────────────────────────────────────

async function assertWritesEnabled(tx: Tx) {
  const setting = await tx.platformSetting.findUnique({
    where: { key: "writes_enabled" },
  });
  if (setting && setting.value === "false") {
    throw new SettlementError(
      "WRITES_DISABLED",
      "Writes are frozen (writes_enabled kill switch). No ledger changes made.",
    );
  }
}

function audit(
  tx: Tx,
  data: {
    taskId?: string;
    runType: Prisma.AuditLogCreateInput["runType"];
    triggeredBy: string;
    summary: string;
    status?: Prisma.AuditLogCreateInput["status"];
    ledgerActions?: unknown;
    rawPayload?: unknown;
  },
) {
  return tx.auditLog.create({
    data: {
      taskId: data.taskId,
      runType: data.runType,
      triggeredBy: data.triggeredBy,
      summary: data.summary,
      status: data.status ?? "ok",
      ledgerActions: (data.ledgerActions ?? undefined) as Prisma.InputJsonValue,
      rawPayload: (data.rawPayload ?? undefined) as Prisma.InputJsonValue,
    },
  });
}

function emit(
  tx: Tx,
  data: {
    eventType: Prisma.EventOutboxCreateInput["eventType"];
    referenceId?: string;
    referenceType?: string;
    payload?: unknown;
    idempotencyKey?: string;
  },
) {
  return tx.eventOutbox.create({
    data: {
      eventType: data.eventType,
      referenceId: data.referenceId,
      referenceType: data.referenceType,
      payload: (data.payload ?? undefined) as Prisma.InputJsonValue,
      idempotencyKey: data.idempotencyKey,
      status: "pending",
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Award: preview (read-only) + execute
// ─────────────────────────────────────────────────────────────────────────────

export async function previewAward(taskId: string, bidId: string) {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new SettlementError("TASK_NOT_FOUND", `Task ${taskId} not found.`);
  const bid = await prisma.bid.findUnique({ where: { id: bidId } });
  if (!bid || bid.taskId !== taskId)
    throw new SettlementError("BID_NOT_FOUND", `Bid ${bidId} not on task ${taskId}.`);

  const budget = task.budget;
  const bidAmount = bid.bidAmount;
  const refund = round2(budget - bidAmount);
  const stake = stakeFor(bidAmount);

  const [creatorAcct, agentAcct] = await Promise.all([
    prisma.ledgerAccount.findUnique({
      where: { ownerId_currency: { ownerId: task.creatorId, currency: task.currency } },
    }),
    prisma.ledgerAccount.findUnique({
      where: { ownerId_currency: { ownerId: bid.agentId, currency: task.currency } },
    }),
  ]);

  return {
    taskId,
    bidId,
    budget,
    bidAmount,
    refund,
    stake,
    currency: task.currency,
    creatorBalance: creatorAcct?.balance ?? 0,
    agentBalance: agentAcct?.balance ?? 0,
    creatorFundsOk: (creatorAcct?.balance ?? 0) >= budget,
    agentStakeOk: (agentAcct?.balance ?? 0) >= stake,
  };
}

export async function awardTask(opts: {
  taskId: string;
  bidId: string;
  triggeredBy: string;
}) {
  return prisma.$transaction(async (tx) => {
    await assertWritesEnabled(tx);

    const task = await tx.task.findUnique({ where: { id: opts.taskId } });
    if (!task) throw new SettlementError("TASK_NOT_FOUND", `Task ${opts.taskId} not found.`);
    if (!["open", "bidding"].includes(task.status))
      throw new SettlementError(
        "INVALID_TASK_STATUS",
        `Task is '${task.status}'; must be open or bidding to award.`,
      );

    const bid = await tx.bid.findUnique({ where: { id: opts.bidId } });
    if (!bid || bid.taskId !== opts.taskId)
      throw new SettlementError("BID_NOT_FOUND", `Bid not found on this task.`);
    if (!["pending", "auto"].includes(bid.status))
      throw new SettlementError("BID_NOT_ACTIVE", `Bid is '${bid.status}', not active.`);

    const agent = await tx.agent.findUnique({ where: { id: bid.agentId } });
    if (!agent) throw new SettlementError("AGENT_NOT_FOUND", "Bidding agent not found.");
    if (agent.status !== "active")
      throw new SettlementError("AGENT_NOT_ACTIVE", `Agent @${agent.handle} is ${agent.status}.`);

    const { budget, currency } = task;
    const bidAmount = bid.bidAmount;
    if (bidAmount > budget)
      throw new SettlementError("BID_EXCEEDS_BUDGET", `Bid ${bidAmount} > budget ${budget}.`);
    const refund = round2(budget - bidAmount);
    const stake = stakeFor(bidAmount);

    const creatorAcct = await getOrCreateAccount(tx, {
      ownerId: task.creatorId,
      ownerType: "agent",
      currency,
      agentId: task.creatorId,
    });
    const agentAcct = await getOrCreateAccount(tx, {
      ownerId: agent.id,
      ownerType: "agent",
      currency,
      agentId: agent.id,
    });
    const escrow = await systemAccount(tx, SYSTEM_ACCOUNTS.escrow, currency);
    const escrowStake = await systemAccount(tx, SYSTEM_ACCOUNTS.escrowStake, currency);

    if (creatorAcct.balance < budget)
      throw new SettlementError(
        "INSUFFICIENT_FUNDS",
        `Creator balance ${creatorAcct.balance} < escrow ${budget} ${currency}.`,
      );
    if (agentAcct.balance < stake)
      throw new SettlementError(
        "INSUFFICIENT_STAKE",
        `Agent balance ${agentAcct.balance} < stake ${stake} ${currency}.`,
      );

    // Escrow the full budget; lock the agent's stake. Real money moves.
    const escrowTx = await postTransaction(tx, {
      fromAccountId: creatorAcct.id,
      toAccountId: escrow.id,
      amount: budget,
      currency,
      type: "escrow_lock",
      referenceId: task.id,
      referenceType: "task",
      description: `Escrow lock: ${budget} ${currency} for "${task.title}".`,
      idempotencyKey: `escrow_lock_${task.id}`,
    });
    const stakeTx = await postTransaction(tx, {
      fromAccountId: agentAcct.id,
      toAccountId: escrowStake.id,
      amount: stake,
      currency,
      type: "stake_lock",
      referenceId: task.id,
      referenceType: "task",
      description: `Stake lock: ${stake} ${currency} from @${agent.handle}.`,
      idempotencyKey: `stake_lock_${task.id}`,
    });

    const stakeRecord = await tx.stake.create({
      data: {
        taskId: task.id,
        bidId: bid.id,
        agentId: agent.id,
        amount: stake,
        currency,
        status: "locked",
      },
    });

    await tx.bid.update({ where: { id: bid.id }, data: { status: "accepted" } });
    await tx.bid.updateMany({
      where: { taskId: task.id, id: { not: bid.id }, status: { in: ["pending", "auto"] } },
      data: { status: "rejected" },
    });

    await tx.task.update({
      where: { id: task.id },
      data: {
        status: "awarded",
        awardedAgentId: agent.id,
        awardedBidId: bid.id,
        lastActivityAt: new Date(),
      },
    });

    await audit(tx, {
      taskId: task.id,
      runType: "award_confirmed",
      triggeredBy: opts.triggeredBy,
      summary: `Awarded "${task.title}" to @${agent.handle}. Escrow ${budget}, bid ${bidAmount}, refund ${refund}, stake ${stake} ${currency}.`,
      ledgerActions: [
        { type: "escrow_lock", amount: budget, txId: escrowTx.id },
        { type: "stake_lock", amount: stake, txId: stakeTx.id },
      ],
    });
    await emit(tx, {
      eventType: "TASK_AWARDED",
      referenceId: task.id,
      referenceType: "task",
      idempotencyKey: `task_awarded_${task.id}`,
      payload: { taskId: task.id, agentHandle: agent.handle, bidAmount, stake },
    });

    return {
      ok: true as const,
      taskId: task.id,
      agentHandle: agent.handle,
      budget,
      bidAmount,
      refund,
      stake,
      stakeId: stakeRecord.id,
      escrowTxId: escrowTx.id,
      stakeTxId: stakeTx.id,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Submit deliverable
// ─────────────────────────────────────────────────────────────────────────────

export async function submitDeliverable(opts: {
  taskId: string;
  agentId: string;
  title?: string;
  description?: string;
  externalLink?: string;
  fileUrl?: string;
  triggeredBy: string;
}) {
  return prisma.$transaction(async (tx) => {
    await assertWritesEnabled(tx);
    const task = await tx.task.findUnique({ where: { id: opts.taskId } });
    if (!task) throw new SettlementError("TASK_NOT_FOUND", `Task ${opts.taskId} not found.`);
    if (!["awarded", "delivered"].includes(task.status))
      throw new SettlementError(
        "INVALID_TASK_STATUS",
        `Task is '${task.status}'; must be awarded to deliver.`,
      );
    if (task.awardedAgentId !== opts.agentId)
      throw new SettlementError("NOT_AWARDEE", "Task is not awarded to you.");

    const deliverable = await tx.deliverable.create({
      data: {
        taskId: task.id,
        bidId: task.awardedBidId,
        agentId: opts.agentId,
        title: opts.title,
        description: opts.description,
        externalLink: opts.externalLink,
        fileUrl: opts.fileUrl,
        status: "submitted",
      },
    });

    await tx.task.update({
      where: { id: task.id },
      data: { status: "delivered", lastActivityAt: new Date() },
    });

    await audit(tx, {
      taskId: task.id,
      runType: "deliverable_submitted",
      triggeredBy: opts.triggeredBy,
      summary: `Deliverable submitted for "${task.title}".`,
    });
    await emit(tx, {
      eventType: "DELIVERABLE_SUBMITTED",
      referenceId: task.id,
      referenceType: "task",
      payload: { taskId: task.id, deliverableId: deliverable.id },
    });

    return { ok: true as const, deliverableId: deliverable.id };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Approve deliverable → settle
// ─────────────────────────────────────────────────────────────────────────────

export async function approveDeliverable(opts: {
  taskId: string;
  deliverableId?: string;
  triggeredBy: string;
}) {
  return prisma.$transaction(async (tx) => {
    await assertWritesEnabled(tx);

    const task = await tx.task.findUnique({ where: { id: opts.taskId } });
    if (!task) throw new SettlementError("TASK_NOT_FOUND", `Task ${opts.taskId} not found.`);
    if (!["awarded", "delivered"].includes(task.status))
      throw new SettlementError(
        "INVALID_TASK_STATUS",
        `Task is '${task.status}'; must be awarded/delivered to approve.`,
      );
    if (!task.awardedAgentId || !task.awardedBidId)
      throw new SettlementError("TASK_NOT_AWARDED", "Task has no awarded agent/bid.");

    // Idempotency: a payout for this task means it was already settled.
    const priorPayout = await tx.ledgerTransaction.findFirst({
      where: { referenceId: task.id, type: "payout" },
    });
    if (priorPayout)
      throw new SettlementError("ALREADY_PAID", "Task already settled (idempotency guard).");

    const bid = await tx.bid.findUniqueOrThrow({ where: { id: task.awardedBidId } });
    const agent = await tx.agent.findUniqueOrThrow({ where: { id: task.awardedAgentId } });
    const { budget, currency } = task;
    const bidAmount = bid.bidAmount;
    const refund = round2(budget - bidAmount);

    const deliverable = opts.deliverableId
      ? await tx.deliverable.findUnique({ where: { id: opts.deliverableId } })
      : await tx.deliverable.findFirst({
          where: { taskId: task.id, status: "submitted" },
          orderBy: { submittedAt: "desc" },
        });
    if (!deliverable)
      throw new SettlementError("NO_DELIVERABLE", "No submitted deliverable to approve.");

    const stakeRecord = await tx.stake.findFirst({
      where: { taskId: task.id, agentId: agent.id, status: "locked" },
    });
    const stakeAmount = stakeRecord?.amount ?? stakeFor(bidAmount);

    const escrow = await systemAccount(tx, SYSTEM_ACCOUNTS.escrow, currency);
    const escrowStake = await systemAccount(tx, SYSTEM_ACCOUNTS.escrowStake, currency);
    const agentAcct = await getOrCreateAccount(tx, {
      ownerId: agent.id,
      ownerType: "agent",
      currency,
      agentId: agent.id,
    });
    const creatorAcct = await getOrCreateAccount(tx, {
      ownerId: task.creatorId,
      ownerType: "agent",
      currency,
      agentId: task.creatorId,
    });

    const payoutTx = await postTransaction(tx, {
      fromAccountId: escrow.id,
      toAccountId: agentAcct.id,
      amount: bidAmount,
      currency,
      type: "payout",
      referenceId: task.id,
      referenceType: "task",
      description: `Payout: ${bidAmount} ${currency} to @${agent.handle}.`,
      idempotencyKey: `payout_${task.id}`,
    });

    let refundTxId: string | null = null;
    if (refund > 0) {
      const refundTx = await postTransaction(tx, {
        fromAccountId: escrow.id,
        toAccountId: creatorAcct.id,
        amount: refund,
        currency,
        type: "refund",
        referenceId: task.id,
        referenceType: "task",
        description: `Refund: ${refund} ${currency} to creator (budget − bid).`,
        idempotencyKey: `refund_${task.id}`,
      });
      refundTxId = refundTx.id;
    }

    const stakeReleaseTx = await postTransaction(tx, {
      fromAccountId: escrowStake.id,
      toAccountId: agentAcct.id,
      amount: stakeAmount,
      currency,
      type: "stake_release",
      referenceId: task.id,
      referenceType: "task",
      description: `Stake release: ${stakeAmount} ${currency} to @${agent.handle}.`,
      idempotencyKey: `stake_release_${task.id}`,
    });

    if (stakeRecord)
      await tx.stake.update({ where: { id: stakeRecord.id }, data: { status: "released" } });
    await tx.deliverable.update({
      where: { id: deliverable.id },
      data: {
        status: "approved",
        reviewedAt: new Date(),
        reviewerNotes: `Approved. Payout ${bidAmount}, refund ${refund} ${currency}.`,
      },
    });
    await tx.task.update({
      where: { id: task.id },
      data: { status: "completed", lastActivityAt: new Date() },
    });
    await tx.agent.update({
      where: { id: agent.id },
      data: { totalTasksCompleted: { increment: 1 } },
    });

    await audit(tx, {
      taskId: task.id,
      runType: "deliverable_approved",
      triggeredBy: opts.triggeredBy,
      summary: `Approved "${task.title}". @${agent.handle} paid ${bidAmount}, refund ${refund}, stake ${stakeAmount} ${currency} released.`,
      ledgerActions: [
        { type: "payout", amount: bidAmount, txId: payoutTx.id },
        ...(refundTxId ? [{ type: "refund", amount: refund, txId: refundTxId }] : []),
        { type: "stake_release", amount: stakeAmount, txId: stakeReleaseTx.id },
      ],
    });
    await emit(tx, {
      eventType: "TASK_COMPLETED",
      referenceId: task.id,
      referenceType: "task",
      idempotencyKey: `task_completed_${task.id}`,
      payload: {
        taskId: task.id,
        agentHandle: agent.handle,
        payout: bidAmount,
        refund,
        stakeReleased: stakeAmount,
        currency,
      },
    });

    return {
      ok: true as const,
      taskId: task.id,
      agentHandle: agent.handle,
      payout: bidAmount,
      refund,
      stakeReleased: stakeAmount,
      currency,
      payoutTxId: payoutTx.id,
      refundTxId,
      stakeReleaseTxId: stakeReleaseTx.id,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Disputes
// ─────────────────────────────────────────────────────────────────────────────

export async function openDispute(opts: {
  taskId: string;
  raisedById: string;
  raisedByType: DisputePartyType;
  reason: string;
  evidenceUrls?: string[];
  triggeredBy: string;
}) {
  return prisma.$transaction(async (tx) => {
    await assertWritesEnabled(tx);
    const task = await tx.task.findUnique({ where: { id: opts.taskId } });
    if (!task) throw new SettlementError("TASK_NOT_FOUND", `Task ${opts.taskId} not found.`);
    if (!["awarded", "delivered", "in_progress"].includes(task.status))
      throw new SettlementError(
        "INVALID_TASK_STATUS",
        `Cannot dispute a '${task.status}' task.`,
      );

    const dispute = await tx.dispute.create({
      data: {
        taskId: task.id,
        bidId: task.awardedBidId,
        raisedById: opts.raisedById,
        raisedByType: opts.raisedByType,
        againstId: task.awardedAgentId,
        reason: opts.reason,
        evidenceUrls: opts.evidenceUrls ?? [],
        status: "open",
      },
    });
    await tx.task.update({
      where: { id: task.id },
      data: { status: "disputed", lastActivityAt: new Date() },
    });

    await audit(tx, {
      taskId: task.id,
      runType: "dispute_opened",
      triggeredBy: opts.triggeredBy,
      summary: `Dispute opened on "${task.title}": ${opts.reason}`,
      status: "ok",
    });
    await emit(tx, {
      eventType: "DISPUTE_OPENED",
      referenceId: task.id,
      referenceType: "task",
      payload: { taskId: task.id, disputeId: dispute.id, reason: opts.reason },
    });

    // Funds stay locked in escrow; no money moves until resolution.
    return { ok: true as const, disputeId: dispute.id };
  });
}

export async function resolveDispute(opts: {
  taskId: string;
  creatorPct: number;
  agentPct: number;
  slashStake?: boolean;
  notes?: string;
  resolvedById: string;
  triggeredBy: string;
}) {
  if (Math.abs(opts.creatorPct + opts.agentPct - 100) > 0.01)
    throw new SettlementError("BAD_SPLIT", "creatorPct + agentPct must equal 100.");

  return prisma.$transaction(async (tx) => {
    await assertWritesEnabled(tx);
    const task = await tx.task.findUnique({ where: { id: opts.taskId } });
    if (!task) throw new SettlementError("TASK_NOT_FOUND", `Task ${opts.taskId} not found.`);
    if (task.status !== "disputed")
      throw new SettlementError("NOT_DISPUTED", `Task is '${task.status}', not disputed.`);

    const dispute = await tx.dispute.findFirst({
      where: { taskId: task.id, status: { in: ["open", "under_review"] } },
      orderBy: { createdAt: "desc" },
    });
    if (!dispute) throw new SettlementError("NO_OPEN_DISPUTE", "No open dispute to resolve.");

    const priorSplit = await tx.ledgerTransaction.findFirst({
      where: { referenceId: task.id, type: "dispute_split" },
    });
    if (priorSplit)
      throw new SettlementError("ALREADY_RESOLVED", "Dispute already settled (idempotency guard).");

    const { budget, currency } = task;
    // Compute agent payout, then give the creator the exact remainder so the
    // escrow drains to zero without rounding leftovers.
    const agentPayout = round2((budget * opts.agentPct) / 100);
    const creatorPayout = round2(budget - agentPayout);

    const agentId = task.awardedAgentId!;
    const agent = await tx.agent.findUniqueOrThrow({ where: { id: agentId } });
    const stakeRecord = await tx.stake.findFirst({
      where: { taskId: task.id, agentId, status: "locked" },
    });
    const stakeAmount = stakeRecord?.amount ?? 0;

    const escrow = await systemAccount(tx, SYSTEM_ACCOUNTS.escrow, currency);
    const escrowStake = await systemAccount(tx, SYSTEM_ACCOUNTS.escrowStake, currency);
    const platform = await systemAccount(tx, SYSTEM_ACCOUNTS.platform, currency);
    const agentAcct = await getOrCreateAccount(tx, {
      ownerId: agentId,
      ownerType: "agent",
      currency,
      agentId,
    });
    const creatorAcct = await getOrCreateAccount(tx, {
      ownerId: task.creatorId,
      ownerType: "agent",
      currency,
      agentId: task.creatorId,
    });

    if (creatorPayout > 0)
      await postTransaction(tx, {
        fromAccountId: escrow.id,
        toAccountId: creatorAcct.id,
        amount: creatorPayout,
        currency,
        type: "dispute_split",
        referenceId: task.id,
        referenceType: "dispute",
        description: `Dispute split: ${creatorPayout} ${currency} to creator (${opts.creatorPct}%).`,
        idempotencyKey: `dispute_creator_${task.id}`,
      });
    if (agentPayout > 0)
      await postTransaction(tx, {
        fromAccountId: escrow.id,
        toAccountId: agentAcct.id,
        amount: agentPayout,
        currency,
        type: "dispute_split",
        referenceId: task.id,
        referenceType: "dispute",
        description: `Dispute split: ${agentPayout} ${currency} to @${agent.handle} (${opts.agentPct}%).`,
        idempotencyKey: `dispute_agent_${task.id}`,
      });

    let stakeSlashed = false;
    if (stakeAmount > 0) {
      if (opts.slashStake) {
        await postTransaction(tx, {
          fromAccountId: escrowStake.id,
          toAccountId: platform.id,
          amount: stakeAmount,
          currency,
          type: "stake_slash",
          referenceId: task.id,
          referenceType: "stake",
          description: `Stake slashed: ${stakeAmount} ${currency} from @${agent.handle}.`,
          idempotencyKey: `stake_slash_${task.id}`,
        });
        stakeSlashed = true;
      } else {
        await postTransaction(tx, {
          fromAccountId: escrowStake.id,
          toAccountId: agentAcct.id,
          amount: stakeAmount,
          currency,
          type: "stake_release",
          referenceId: task.id,
          referenceType: "stake",
          description: `Stake returned: ${stakeAmount} ${currency} to @${agent.handle}.`,
          idempotencyKey: `stake_release_${task.id}`,
        });
      }
      if (stakeRecord)
        await tx.stake.update({
          where: { id: stakeRecord.id },
          data: { status: stakeSlashed ? "slashed" : "released" },
        });
    }

    await tx.dispute.update({
      where: { id: dispute.id },
      data: {
        status: "resolved",
        resolutionNotes: opts.notes ?? `Resolved ${opts.creatorPct}/${opts.agentPct}.`,
        resolvedById: opts.resolvedById,
        resolvedAt: new Date(),
        payoutCreator: creatorPayout,
        payoutAgent: agentPayout,
      },
    });
    await tx.task.update({
      where: { id: task.id },
      data: { status: "completed", lastActivityAt: new Date() },
    });

    await audit(tx, {
      taskId: task.id,
      runType: "dispute_resolved",
      triggeredBy: opts.triggeredBy,
      summary: `Dispute resolved ${opts.creatorPct}/${opts.agentPct}. Creator ${creatorPayout}, agent ${agentPayout}, stake ${stakeSlashed ? "slashed" : "returned"} ${stakeAmount} ${currency}.`,
    });
    await emit(tx, {
      eventType: "DISPUTE_RESOLVED",
      referenceId: task.id,
      referenceType: "task",
      idempotencyKey: `dispute_resolved_${task.id}`,
      payload: {
        taskId: task.id,
        creatorPayout,
        agentPayout,
        stakeSlashed,
        stakeAmount,
        currency,
      },
    });

    return {
      ok: true as const,
      taskId: task.id,
      creatorPayout,
      agentPayout,
      stakeSlashed,
      stakeAmount,
      currency,
    };
  });
}

export { LedgerError };
