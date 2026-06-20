import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { submitDeliverable, SettlementError } from "@/lib/settlement";

// Autonomous delivery: an awarded hunter actually produces the work via Claude,
// then submits it as a deliverable. Gated on ANTHROPIC_API_KEY so the rest of
// the app runs without it.

const MODEL = "claude-opus-4-8";

// Cost guardrails on the only path that spends real API money.
const GLOBAL_DAILY_CAP = 40; // total AI deliveries across all users / 24h
const PER_USER_DAILY = 5; // per signed-in user / 24h

export function aiConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

export async function attemptAutonomousDelivery(opts: { taskId: string; triggeredBy: string }) {
  if (!aiConfigured()) {
    throw new SettlementError("AI_NOT_CONFIGURED", "Autonomous delivery isn't configured (no ANTHROPIC_API_KEY).");
  }

  const task = await prisma.task.findUnique({
    where: { id: opts.taskId },
    include: { awardedAgent: true },
  });
  if (!task) throw new SettlementError("TASK_NOT_FOUND", "Task not found.");
  if (task.status !== "awarded") throw new SettlementError("INVALID_TASK_STATUS", `Task is '${task.status}'; must be awarded.`);
  const agent = task.awardedAgent;
  if (!agent) throw new SettlementError("NO_AGENT", "Task has no awarded agent.");
  if (agent.userId) throw new SettlementError("NOT_AUTONOMOUS", "Awarded agent is a human, not an autonomous hunter.");

  // ── Cost guardrails (kill switch + rate limits) ─────────────────────────────
  const killSwitch = await prisma.platformSetting.findUnique({ where: { key: "ai_delivery_enabled" } });
  if (killSwitch?.value === "false")
    throw new SettlementError("AI_DISABLED", "Autonomous delivery is paused right now.");

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // AI deliveries are triggered by the creator (triggeredBy "creator:…"); human
  // self-deliveries use "agent:…", so this counts only the paid path.
  const globalToday = await prisma.auditLog.count({
    where: { runType: "deliverable_submitted", triggeredBy: { startsWith: "creator:" }, createdAt: { gte: since } },
  });
  if (globalToday >= GLOBAL_DAILY_CAP)
    throw new SettlementError("AI_AT_CAPACITY", "Autonomous delivery is at capacity for today — try again tomorrow.");

  const mineToday = await prisma.auditLog.count({
    where: { runType: "deliverable_submitted", triggeredBy: opts.triggeredBy, createdAt: { gte: since } },
  });
  if (mineToday >= PER_USER_DAILY)
    throw new SettlementError("AI_RATE_LIMIT", `Daily limit reached (${PER_USER_DAILY} AI deliveries/day). Try again tomorrow.`);

  const client = new Anthropic();

  const system = [
    `You are ${agent.name} (@${agent.handle}), an autonomous agent on the Claw Town marketplace.`,
    agent.bio ? `Your background: ${agent.bio}` : "",
    agent.skillTags.length ? `Your skills: ${agent.skillTags.join(", ")}.` : "",
    "You have been awarded a task. Produce the actual deliverable — not a plan to do it, the work itself.",
    "Be concrete and useful. Use Markdown. Keep it focused and proportional to the budget; don't pad.",
    "If the task implies code, include the code. If it implies content, write the content. If research, give findings.",
  ]
    .filter(Boolean)
    .join("\n");

  const userMsg = [
    `# Task: ${task.title}`,
    task.description ? `\n## Brief\n${task.description}` : "",
    task.tags.length ? `\n## Tags\n${task.tags.join(", ")}` : "",
    `\n## Category\n${task.category}`,
    `\n## Budget\n${task.budget} TTT`,
    `\nDeliver the completed work now.`,
  ]
    .filter(Boolean)
    .join("\n");

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    thinking: { type: "adaptive" },
    system,
    messages: [{ role: "user", content: userMsg }],
  });

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (!text) throw new SettlementError("EMPTY_OUTPUT", "The agent produced no output.");

  const title = `${task.title} — delivered by @${agent.handle}`;
  const result = await submitDeliverable({
    taskId: task.id,
    agentId: agent.id,
    title: title.slice(0, 180),
    description: text,
    triggeredBy: opts.triggeredBy,
  });

  return { ok: true as const, deliverableId: result.deliverableId, agentHandle: agent.handle };
}
