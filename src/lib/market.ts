import { prisma } from "@/lib/prisma";
import { round2 } from "@/lib/money";

// Autonomous "hunter" agents. We treat any agent without a linked user account
// (i.e. seeded bots, not humans) as an autonomous bidder.

const PITCHES = [
  "I've shipped this exact thing before — clean handoff, no surprises.",
  "Strong skill match here. I can start immediately.",
  "Done a dozen of these. Fast turnaround, well documented.",
  "This is squarely in my wheelhouse — happy to scope it tightly.",
  "I'll over-communicate and deliver ahead of the ETA.",
  "Quick, reliable, and I stand behind my work with the stake.",
];

function pick<T>(arr: T[]) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Place autonomous bids on a task from matching hunter agents. Idempotent:
 * skips hunters that already bid, and is capped per call. Bids are priced as a
 * fraction of budget with some spread, biased lower for stronger skill matches.
 */
export async function autoBidForTask(taskId: string, opts: { max?: number } = {}) {
  const max = opts.max ?? 3;
  const task = await prisma.task.findUnique({ where: { id: taskId }, include: { bids: true } });
  if (!task || !["open", "bidding"].includes(task.status)) return { placed: 0 };

  const alreadyBid = new Set(task.bids.map((b) => b.agentId));
  const hunters = await prisma.agent.findMany({
    where: { userId: null, status: "active", id: { not: task.creatorId } },
  });

  const tagSet = new Set(task.tags.map((t) => t.toLowerCase()));
  const scored = hunters
    .filter((h) => !alreadyBid.has(h.id))
    .map((h) => {
      const skills = new Set(h.skillTags.map((t) => t.toLowerCase()));
      let score = 0;
      if (skills.has(task.category)) score += 2;
      for (const t of tagSet) if (skills.has(t)) score += 1;
      return { h, score };
    })
    .sort((a, b) => b.score - a.score);

  // Prefer matches; if too few match, top up with others so the market still moves.
  const matches = scored.filter((s) => s.score > 0);
  let chosen = matches.slice(0, max);
  if (chosen.length < Math.min(2, scored.length)) {
    const extras = scored.filter((s) => !chosen.includes(s)).slice(0, 2 - chosen.length);
    chosen = [...chosen, ...extras];
  }
  if (chosen.length === 0) return { placed: 0 };

  const bids = chosen.map(({ h, score }) => {
    // stronger match → leaner, more competitive bid
    const lo = score > 0 ? 0.55 : 0.7;
    const factor = lo + Math.random() * (0.95 - lo);
    const amount = Math.min(task.budget, Math.max(1, round2(task.budget * factor)));
    return {
      taskId,
      agentId: h.id,
      agentHandle: h.handle,
      bidAmount: amount,
      currency: task.currency,
      etaHours: 12 + Math.floor(Math.random() * 60),
      message: pick(PITCHES),
      status: "auto" as const,
      isAutoBid: true,
      matchScore: score,
    };
  });

  await prisma.$transaction([
    prisma.bid.createMany({ data: bids }),
    prisma.task.update({
      where: { id: taskId },
      data: { status: "bidding", autoBidAttempted: true, lastActivityAt: new Date() },
    }),
  ]);

  return { placed: bids.length };
}
