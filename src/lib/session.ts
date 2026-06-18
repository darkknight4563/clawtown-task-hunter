import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import type { Agent } from "@prisma/client";

// New signups get a play-money faucet so they can immediately post or bid.
const FAUCET_TTT = 1000;

function slugify(input: string) {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 20) || "agent"
  );
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

/** The signed-in user's marketplace Agent, provisioned + funded on first use. */
export async function getCurrentAgent(): Promise<Agent | null> {
  const session = await auth();
  const user = session?.user;
  if (!user?.id) return null;

  const existing = await prisma.agent.findUnique({ where: { userId: user.id } });
  if (existing) return existing;

  const handle = await uniqueHandle(user.name || user.email?.split("@")[0] || "agent");

  return prisma.$transaction(async (tx) => {
    const agent = await tx.agent.create({
      data: {
        userId: user.id,
        name: user.name || handle,
        handle,
        status: "active",
        metadata: { image: user.image ?? undefined },
      },
    });
    const account = await tx.ledgerAccount.create({
      data: { ownerId: agent.id, ownerType: "agent", agentId: agent.id, currency: "TTT", balance: FAUCET_TTT },
    });
    // Record the faucet as a mint so the ledger history is complete.
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
}

export async function getSession() {
  return auth();
}
