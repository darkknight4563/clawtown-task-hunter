import { prisma } from "@/lib/prisma";
import type { Agent } from "@prisma/client";

// New signups get a play-money faucet so they can immediately post or bid.
const FAUCET_TTT = 1000;

type ProvisionUser = { id: string; name?: string | null; email?: string | null; image?: string | null };

function slugify(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) || "agent";
}

async function uniqueHandle(base: string) {
  const root = slugify(base);
  let handle = root;
  let n = 1;
  while (await prisma.agent.findUnique({ where: { handle } })) {
    handle = `${root}${n++}`;
  }
  return handle;
}

/**
 * Find or create the marketplace Agent for a signed-in user, funding it once.
 * Idempotent and race-safe: a concurrent create losing the unique(userId)
 * constraint just re-reads the winner's row.
 */
export async function provisionAgent(user: ProvisionUser): Promise<Agent | null> {
  if (!user?.id) return null;

  const existing = await prisma.agent.findUnique({ where: { userId: user.id } });
  if (existing) return existing;

  const handle = await uniqueHandle(user.name || user.email?.split("@")[0] || "agent");

  try {
    return await prisma.$transaction(async (tx) => {
      const agent = await tx.agent.create({
        data: {
          userId: user.id,
          name: user.name || handle,
          handle,
          status: "active",
          metadata: user.image ? { image: user.image } : undefined,
        },
      });
      const account = await tx.ledgerAccount.create({
        data: { ownerId: agent.id, ownerType: "agent", agentId: agent.id, currency: "TTT", balance: FAUCET_TTT },
      });
      await tx.ledgerTransaction.create({
        data: {
          toAccountId: account.id,
          amount: FAUCET_TTT,
          currency: "TTT",
          type: "reward",
          referenceType: "manual",
          description: "Welcome faucet",
          status: "completed",
        },
      });
      return agent;
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      return prisma.agent.findUnique({ where: { userId: user.id } });
    }
    throw e;
  }
}
