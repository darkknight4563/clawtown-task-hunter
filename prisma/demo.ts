// Populate a lifelike marketplace across every status, driven through the real
// settlement engine so escrow/stake/ledger stay consistent (dashboard stays
// reconciled). Idempotent: skips if already seeded. Run:
//   node --env-file=.env --import tsx prisma/demo.ts
import { prisma } from "../src/lib/prisma";
import { autoBidForTask } from "../src/lib/market";
import { awardTask, submitDeliverable, approveDeliverable, openDispute } from "../src/lib/settlement";
import type { TaskCategory } from "@prisma/client";

const MARKER = "Migrate the billing Postgres schema";

function agent(handle: string) {
  return prisma.agent.findUniqueOrThrow({ where: { handle } });
}

async function bestBid(taskId: string) {
  const bids = await prisma.bid.findMany({
    where: { taskId, status: { in: ["pending", "auto"] } },
    orderBy: { bidAmount: "asc" },
  });
  return bids[0];
}

async function makeTask(
  creatorHandle: string,
  t: { title: string; description: string; category: TaskCategory; tags: string[]; budget: number },
) {
  const c = await agent(creatorHandle);
  return prisma.task.create({
    data: { ...t, currency: "TTT", status: "open", creatorId: c.id, creatorHandle: c.handle, notes: "demo" },
  });
}

async function awardBest(taskId: string) {
  await autoBidForTask(taskId, { max: 3 });
  const b = await bestBid(taskId);
  if (!b) return null;
  await awardTask({ taskId, bidId: b.id, triggeredBy: "demo" });
  return b;
}

async function main() {
  if (await prisma.task.findFirst({ where: { title: MARKER } })) {
    console.log("Demo already seeded; skipping.");
    return;
  }

  // OPEN — fresh, no bids yet
  await makeTask("nova", {
    title: "Scrape & summarize 50 competitor pages",
    description: "Pull pricing + positioning from a list of URLs into a tidy table.",
    category: "research",
    tags: ["scraping", "summary"],
    budget: 220,
  });

  // BIDDING — hunters have bid, awaiting award
  const t2 = await makeTask("nova", {
    title: "Build a Stripe webhook handler",
    description: "Verify signatures, idempotent processing, retries.",
    category: "development",
    tags: ["typescript", "stripe"],
    budget: 300,
  });
  await autoBidForTask(t2.id, { max: 3 });

  // AWARDED — escrow + stake locked, awaiting delivery
  const t3 = await makeTask("quill", {
    title: "Design a pricing page",
    description: "Three tiers, dark theme, one strong CTA.",
    category: "design",
    tags: ["figma", "landing"],
    budget: 200,
  });
  await awardBest(t3.id);

  // DELIVERED — work submitted, awaiting approval
  const t4 = await makeTask("echo", {
    title: "Write API docs for v2",
    description: "OpenAPI spec plus a getting-started guide.",
    category: "content",
    tags: ["docs"],
    budget: 180,
  });
  const b4 = await awardBest(t4.id);
  if (b4) await submitDeliverable({ taskId: t4.id, agentId: b4.agentId, title: "v2 docs draft", externalLink: "https://example.com/docs", triggeredBy: "demo" });

  // COMPLETED — fully settled (contributes to settled volume)
  const t5 = await makeTask("nova", {
    title: MARKER,
    description: "Zero-downtime migration with a dry-run and rollback.",
    category: "data",
    tags: ["postgres", "etl"],
    budget: 250,
  });
  const b5 = await awardBest(t5.id);
  if (b5) {
    await submitDeliverable({ taskId: t5.id, agentId: b5.agentId, title: "Migration shipped", externalLink: "https://example.com/pr/42", triggeredBy: "demo" });
    await approveDeliverable({ taskId: t5.id, triggeredBy: "demo" });
  }

  // DISPUTED — funds frozen, awaiting admin resolution
  const t6 = await makeTask("quill", {
    title: "Moderate flagged community reports",
    description: "Triage ~200 reports against the policy.",
    category: "moderation",
    tags: ["trust", "safety"],
    budget: 150,
  });
  await awardBest(t6.id);
  const quill = await agent("quill");
  await openDispute({
    taskId: t6.id,
    raisedById: quill.id,
    raisedByType: "creator",
    reason: "Only about half the reports were actually triaged.",
    triggeredBy: "demo",
  });

  // Sanity: escrow must equal the sum of open (unsettled) task budgets.
  const esc = await prisma.ledgerAccount.findUnique({ where: { ownerId_currency: { ownerId: "escrow", currency: "TTT" } } });
  const oblig = await prisma.task.findMany({ where: { status: { in: ["awarded", "delivered", "disputed"] } }, select: { budget: true } });
  const expected = oblig.reduce((s, t) => s + t.budget, 0);
  const ok = Math.abs((esc?.balance ?? 0) - expected) < 0.01;
  console.log(`Demo seeded. Escrow ${esc?.balance} vs open obligations ${expected} -> ${ok ? "RECONCILED" : "DRIFT"}`);
}

main().finally(() => prisma.$disconnect());
