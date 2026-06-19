import { prisma } from "@/lib/prisma";
import type { TaskStatus } from "@prisma/client";

export type TaskFilter = { status?: TaskStatus; q?: string };

export async function listTasks(filter: TaskFilter = {}) {
  return prisma.task.findMany({
    where: {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.q
        ? {
            OR: [
              { title: { contains: filter.q, mode: "insensitive" } },
              { description: { contains: filter.q, mode: "insensitive" } },
              { tags: { has: filter.q.toLowerCase() } },
            ],
          }
        : {}),
    },
    include: {
      creator: { select: { handle: true, name: true } },
      awardedAgent: { select: { handle: true } },
      _count: { select: { bids: true } },
    },
    orderBy: [{ createdAt: "desc" }],
    take: 60,
  });
}

export async function getTask(id: string) {
  return prisma.task.findUnique({
    where: { id },
    include: {
      creator: true,
      awardedAgent: true,
      bids: { include: { agent: { select: { handle: true, name: true } } }, orderBy: { createdAt: "asc" } },
      deliverables: { include: { agent: { select: { handle: true } } }, orderBy: { submittedAt: "desc" } },
      disputes: { orderBy: { createdAt: "desc" } },
      stakes: true,
    },
  });
}

export async function getWallet(agentId: string) {
  const account = await prisma.ledgerAccount.findUnique({
    where: { ownerId_currency: { ownerId: agentId, currency: "TTT" } },
  });
  if (!account) return { balance: 0, transactions: [], earned: 0, spent: 0 };

  const transactions = await prisma.ledgerTransaction.findMany({
    where: { OR: [{ fromAccountId: account.id }, { toAccountId: account.id }] },
    orderBy: { createdAt: "desc" },
    take: 40,
  });

  const earned = transactions
    .filter((t) => t.toAccountId === account.id && ["payout", "stake_release", "refund", "dispute_split", "reward"].includes(t.type))
    .reduce((s, t) => s + t.amount, 0);
  const spent = transactions
    .filter((t) => t.fromAccountId === account.id && ["escrow_lock", "stake_lock"].includes(t.type))
    .reduce((s, t) => s + t.amount, 0);

  return { account, balance: account.balance, transactions, earned: Math.round(earned * 100) / 100, spent: Math.round(spent * 100) / 100 };
}

export async function listAgents() {
  return prisma.agent.findMany({
    orderBy: [{ reputationScore: "desc" }, { totalTasksCompleted: "desc" }],
    include: { _count: { select: { bids: true, tasksAwarded: true } } },
  });
}

export async function getAgentByHandle(handle: string) {
  const agent = await prisma.agent.findUnique({
    where: { handle },
    include: {
      tasksCreated: { orderBy: { createdAt: "desc" }, take: 6 },
      tasksAwarded: { orderBy: { lastActivityAt: "desc" }, take: 6 },
      bids: {
        orderBy: { createdAt: "desc" },
        take: 8,
        include: { task: { select: { id: true, title: true, status: true } } },
      },
      _count: { select: { bids: true, tasksAwarded: true, tasksCreated: true } },
    },
  });
  if (!agent) return null;

  const account = await prisma.ledgerAccount.findUnique({
    where: { ownerId_currency: { ownerId: agent.id, currency: "TTT" } },
  });
  let earned = 0;
  if (account) {
    const txs = await prisma.ledgerTransaction.findMany({
      where: { toAccountId: account.id, type: { in: ["payout", "stake_release", "dispute_split"] } },
    });
    earned = Math.round(txs.reduce((s, t) => s + t.amount, 0) * 100) / 100;
  }
  const winRate = agent._count.bids > 0 ? agent._count.tasksAwarded / agent._count.bids : 0;

  return { agent, balance: account?.balance ?? 0, earned, winRate };
}

export async function getDashboardData() {
  const round = (n: number) => Math.round(n * 100) / 100;
  const [accounts, escrow, escrowStake, platform, obligTasks, lockedStakes, payouts, statusGroups, agentsCount, audits] =
    await Promise.all([
      prisma.ledgerAccount.findMany({ where: { currency: "TTT" } }),
      prisma.ledgerAccount.findUnique({ where: { ownerId_currency: { ownerId: "escrow", currency: "TTT" } } }),
      prisma.ledgerAccount.findUnique({ where: { ownerId_currency: { ownerId: "escrow_stake", currency: "TTT" } } }),
      prisma.ledgerAccount.findUnique({ where: { ownerId_currency: { ownerId: "platform", currency: "TTT" } } }),
      prisma.task.findMany({ where: { status: { in: ["awarded", "delivered", "disputed"] } }, select: { budget: true } }),
      prisma.stake.findMany({ where: { status: "locked" }, select: { amount: true } }),
      prisma.ledgerTransaction.findMany({ where: { type: "payout" }, select: { amount: true } }),
      prisma.task.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.agent.count(),
      prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 12 }),
    ]);

  const statusCounts: Record<string, number> = {};
  for (const g of statusGroups) statusCounts[g.status] = g._count._all;

  return {
    totalIssued: round(accounts.reduce((s, a) => s + a.balance, 0)),
    settledVolume: round(payouts.reduce((s, p) => s + p.amount, 0)),
    agentsCount,
    escrowActual: round(escrow?.balance ?? 0),
    escrowExpected: round(obligTasks.reduce((s, t) => s + t.budget, 0)),
    stakeActual: round(escrowStake?.balance ?? 0),
    stakeExpected: round(lockedStakes.reduce((s, st) => s + st.amount, 0)),
    platformFees: round(platform?.balance ?? 0),
    statusCounts,
    audits,
  };
}

export async function getMarketStats() {
  const [open, inFlight, completed, agents, escrow] = await Promise.all([
    prisma.task.count({ where: { status: { in: ["open", "bidding"] } } }),
    prisma.task.count({ where: { status: { in: ["awarded", "delivered", "disputed"] } } }),
    prisma.task.count({ where: { status: "completed" } }),
    prisma.agent.count(),
    prisma.ledgerAccount.findUnique({ where: { ownerId_currency: { ownerId: "escrow", currency: "TTT" } } }),
  ]);
  return { open, inFlight, completed, agents, escrowLocked: escrow?.balance ?? 0 };
}
