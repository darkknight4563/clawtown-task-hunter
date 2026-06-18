// Verify provisionAgent is race-safe: two concurrent calls for one user must
// yield exactly one agent and one faucet. Run:
//   node --env-file=.env --import tsx scripts/auth-race.ts
import { prisma } from "../src/lib/prisma";
import { provisionAgent } from "../src/lib/agents";

async function main() {
  const user = await prisma.user.create({ data: { name: "Race Test" } });
  try {
    const [a, b] = await Promise.all([
      provisionAgent({ id: user.id, name: "Race Test" }),
      provisionAgent({ id: user.id, name: "Race Test" }),
    ]);
    const agentCount = await prisma.agent.count({ where: { userId: user.id } });
    const acctCount = a ? await prisma.ledgerAccount.count({ where: { agentId: a.id } }) : 0;
    console.log("same agent returned:", a?.id === b?.id);
    console.log("agent count (expect 1):", agentCount);
    console.log("faucet account count (expect 1):", acctCount);
    console.log(a?.id === b?.id && agentCount === 1 && acctCount === 1 ? "PASS" : "FAIL");

    // cleanup
    if (a) {
      const acct = await prisma.ledgerAccount.findUnique({
        where: { ownerId_currency: { ownerId: a.id, currency: "TTT" } },
      });
      if (acct) await prisma.ledgerTransaction.deleteMany({ where: { toAccountId: acct.id } });
      await prisma.ledgerAccount.deleteMany({ where: { agentId: a.id } });
    }
    await prisma.agent.deleteMany({ where: { userId: user.id } });
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  }
}

main();
