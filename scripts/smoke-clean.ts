// One-off: remove any residual smoke-test rows (smk_* agents, "Smoke *" tasks).
// Run: node --env-file=.env --import tsx scripts/smoke-clean.ts
import { prisma } from "../src/lib/prisma";

async function main() {
  const tasks = await prisma.task.findMany({
    where: { title: { startsWith: "Smoke " } },
    select: { id: true },
  });
  const taskIds = tasks.map((t) => t.id);
  if (taskIds.length) {
    await prisma.ledgerTransaction.deleteMany({ where: { referenceId: { in: taskIds } } });
    await prisma.auditLog.deleteMany({ where: { taskId: { in: taskIds } } });
    await prisma.eventOutbox.deleteMany({ where: { referenceId: { in: taskIds } } });
    await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
  }
  const agents = await prisma.agent.findMany({
    where: { handle: { startsWith: "smk_" } },
    select: { id: true },
  });
  const agentIds = agents.map((a) => a.id);
  if (agentIds.length) {
    await prisma.ledgerAccount.deleteMany({ where: { agentId: { in: agentIds } } });
    await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  }
  const total = await prisma.ledgerAccount.aggregate({ where: { currency: "TTT" }, _sum: { balance: true } });
  console.log(`Removed ${taskIds.length} tasks, ${agentIds.length} agents. Total TTT now: ${total._sum.balance}`);
}

main().finally(() => prisma.$disconnect());
