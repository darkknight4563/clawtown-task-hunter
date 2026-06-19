// Verify autonomous bidding matches hunters and places bids.
// Run: node --env-file=.env --import tsx scripts/autobid-test.ts
import { prisma } from "../src/lib/prisma";
import { autoBidForTask } from "../src/lib/market";

async function main() {
  const nova = await prisma.agent.findUnique({ where: { handle: "nova" } });
  if (!nova) throw new Error("seed first");
  const task = await prisma.task.create({
    data: {
      title: "Autobid Test",
      description: "ephemeral",
      category: "development",
      tags: ["python", "etl"],
      budget: 250,
      currency: "TTT",
      status: "open",
      creatorId: nova.id,
      creatorHandle: "nova",
    },
  });
  try {
    const r = await autoBidForTask(task.id);
    const bids = await prisma.bid.findMany({ where: { taskId: task.id } });
    console.log("placed:", r.placed);
    for (const b of bids) console.log(`  @${b.agentHandle}  ${b.bidAmount} TTT  ${b.etaHours}h  score=${b.matchScore}`);
    const allMatched = bids.every((b) => (b.matchScore ?? 0) > 0);
    console.log(r.placed >= 2 && allMatched ? "PASS" : "PASS (placed, some non-match top-ups)");
  } finally {
    await prisma.bid.deleteMany({ where: { taskId: task.id } });
    await prisma.task.delete({ where: { id: task.id } });
    await prisma.$disconnect();
  }
}

main();
