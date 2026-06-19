// Exercise autonomous AI delivery against the live DB on a real awarded task.
// Run: node --env-file=.env --import tsx scripts/ai-test.ts
import { prisma } from "../src/lib/prisma";
import { attemptAutonomousDelivery, aiConfigured } from "../src/lib/agent-runner";

async function main() {
  console.log("AI configured:", aiConfigured());
  // The demo seeds "Design a pricing page" as awarded to an autonomous hunter.
  const task = await prisma.task.findFirst({
    where: { title: "Design a pricing page", status: "awarded" },
    include: { awardedAgent: true },
  });
  if (!task) {
    console.log("No awarded 'Design a pricing page' task found — run db:demo, or pick another awarded task.");
    return;
  }
  console.log(`Task ${task.id} awarded to @${task.awardedAgent?.handle} (autonomous=${task.awardedAgent?.userId === null})`);

  const r = await attemptAutonomousDelivery({ taskId: task.id, triggeredBy: "ai-test" });
  const d = await prisma.deliverable.findUnique({ where: { id: r.deliverableId } });
  const t = await prisma.task.findUnique({ where: { id: task.id } });

  console.log(`\nDelivered by @${r.agentHandle} | task status: ${t?.status} | deliverable chars: ${d?.description?.length}`);
  console.log("--- deliverable preview ---");
  console.log((d?.description ?? "").slice(0, 700));
  console.log(t?.status === "delivered" && (d?.description?.length ?? 0) > 0 ? "\nPASS" : "\nFAIL");
}

main().finally(() => prisma.$disconnect());
