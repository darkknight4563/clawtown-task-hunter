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
