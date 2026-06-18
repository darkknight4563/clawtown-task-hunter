// End-to-end smoke test against the real database, exercising the settlement
// engine through two full lifecycles and asserting the double-entry invariant.
// Run: node --env-file=.env --import tsx scripts/smoke.ts
import { prisma } from "../src/lib/prisma";
import {
  awardTask,
  submitDeliverable,
  approveDeliverable,
  openDispute,
  resolveDispute,
} from "../src/lib/settlement";

const ts = Date.now();
let failures = 0;

function check(label: string, got: number, want: number) {
  const ok = Math.abs(got - want) < 0.001;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${got}${ok ? "" : ` (expected ${want})`}`);
  if (!ok) failures++;
}

async function bal(ownerId: string) {
  const a = await prisma.ledgerAccount.findUnique({
    where: { ownerId_currency: { ownerId, currency: "TTT" } },
  });
  return a?.balance ?? 0;
}

async function totalTTT() {
  const r = await prisma.ledgerAccount.aggregate({
    where: { currency: "TTT" },
    _sum: { balance: true },
  });
  return r._sum.balance ?? 0;
}

async function fundedAgent(handle: string, balance: number) {
  const agent = await prisma.agent.create({
    data: { name: handle, handle, status: "active" },
  });
  await prisma.ledgerAccount.create({
    data: { ownerId: agent.id, ownerType: "agent", agentId: agent.id, currency: "TTT", balance },
  });
  return agent;
}

async function main() {
  const creator = await fundedAgent(`smk_creator_${ts}`, 1000);
  const worker = await fundedAgent(`smk_worker_${ts}`, 1000);
  const baseline = await totalTTT(); // money must never leave the system after this

  // ── Part A: happy path (award -> deliver -> approve) ──────────────────────
  const taskA = await prisma.task.create({
    data: { title: "Smoke A", budget: 200, currency: "TTT", status: "open", creatorId: creator.id },
  });
  const bidA = await prisma.bid.create({
    data: { taskId: taskA.id, agentId: worker.id, bidAmount: 160, currency: "TTT", status: "pending" },
  });

  await awardTask({ taskId: taskA.id, bidId: bidA.id, triggeredBy: "smoke" });
  await submitDeliverable({ taskId: taskA.id, agentId: worker.id, externalLink: "http://x", triggeredBy: "smoke" });
  await approveDeliverable({ taskId: taskA.id, triggeredBy: "smoke" });

  check("A creator balance (1000 - 200 + 40 refund)", await bal(creator.id), 840);
  check("A worker balance (1000 - 16 stake + 160 payout + 16 release)", await bal(worker.id), 1160);

  // idempotency: a second approval must be rejected. The status guard fires
  // first (task is now completed); the ALREADY_PAID guard covers the
  // concurrent-retry case where status hasn't advanced yet. Either is correct.
  let blockedCode = "";
  try {
    await approveDeliverable({ taskId: taskA.id, triggeredBy: "smoke" });
  } catch (e) {
    blockedCode = (e as { code?: string }).code ?? "THREW";
  }
  const blocked = ["ALREADY_PAID", "INVALID_TASK_STATUS"].includes(blockedCode);
  console.log(`${blocked ? "PASS" : "FAIL"}  A double-approve blocked (${blockedCode || "not blocked"})`);
  if (!blocked) failures++;

  // ── Part B: dispute path (award -> dispute -> resolve 50/50, no slash) ─────
  const taskB = await prisma.task.create({
    data: { title: "Smoke B", budget: 100, currency: "TTT", status: "open", creatorId: creator.id },
  });
  const bidB = await prisma.bid.create({
    data: { taskId: taskB.id, agentId: worker.id, bidAmount: 100, currency: "TTT", status: "pending" },
  });

  await awardTask({ taskId: taskB.id, bidId: bidB.id, triggeredBy: "smoke" });
  await openDispute({
    taskId: taskB.id,
    raisedById: creator.id,
    raisedByType: "creator",
    reason: "Quality",
    triggeredBy: "smoke",
  });
  await resolveDispute({
    taskId: taskB.id,
    creatorPct: 50,
    agentPct: 50,
    slashStake: false,
    resolvedById: "admin",
    triggeredBy: "smoke",
  });

  // B award: creator -100 (840->740); worker -10 stake (1160->1150)
  // B resolve 50/50: +50 creator (->790), +50 worker (->1200), +10 stake release (->1210)
  check("B creator balance", await bal(creator.id), 790);
  check("B worker balance", await bal(worker.id), 1210);

  // ── Invariant: escrow drained, total conserved ────────────────────────────
  check("escrow drained", await bal("escrow"), 0);
  check("escrow_stake drained", await bal("escrow_stake"), 0);
  check("total TTT conserved", await totalTTT(), baseline);

  // Clean up everything this run created so the DB returns to its seeded state.
  const taskIds = [taskA.id, taskB.id];
  await prisma.ledgerTransaction.deleteMany({ where: { referenceId: { in: taskIds } } });
  await prisma.auditLog.deleteMany({ where: { taskId: { in: taskIds } } });
  await prisma.eventOutbox.deleteMany({ where: { referenceId: { in: taskIds } } });
  await prisma.task.deleteMany({ where: { id: { in: taskIds } } }); // cascades bids/deliverables/disputes/stakes
  await prisma.ledgerAccount.deleteMany({ where: { agentId: { in: [creator.id, worker.id] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [creator.id, worker.id] } } });

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((e) => {
    console.error("Smoke run threw:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
