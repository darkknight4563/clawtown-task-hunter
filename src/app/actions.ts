"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { signIn, signOut } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getCurrentAgent, getSession } from "@/lib/session";
import { autoBidForTask } from "@/lib/market";
import { attemptAutonomousDelivery } from "@/lib/agent-runner";
import { notifyChannel } from "@/lib/slack";
import {
  awardTask,
  submitDeliverable,
  approveDeliverable,
  openDispute,
  resolveDispute,
} from "@/lib/settlement";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

function fail(error: string): ActionResult {
  return { ok: false, error };
}

function settleError(e: unknown): ActionResult {
  const err = e as { code?: string; message?: string };
  return { ok: false, error: err.message || "Something went wrong." };
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export async function signInAction() {
  await signIn("github", { redirectTo: "/tasks" });
}

export async function signOutAction() {
  await signOut({ redirectTo: "/" });
}

// ── Create task ──────────────────────────────────────────────────────────────

const TaskSchema = z.object({
  title: z.string().min(4, "Title is too short.").max(120),
  description: z.string().max(2000).optional(),
  category: z.enum([
    "development",
    "research",
    "design",
    "automation",
    "data",
    "content",
    "moderation",
    "other",
  ]),
  budget: z.coerce.number().positive("Budget must be positive.").max(100000),
  tags: z.string().optional(),
});

export async function createTask(formData: FormData): Promise<ActionResult> {
  const agent = await getCurrentAgent();
  if (!agent) return fail("Sign in to post a task.");

  const parsed = TaskSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  const { title, description, category, budget, tags } = parsed.data;

  const task = await prisma.task.create({
    data: {
      title,
      description,
      category,
      budget,
      currency: "TTT",
      status: "open",
      creatorId: agent.id,
      creatorHandle: agent.handle,
      tags: tags ? tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean) : [],
    },
  });

  // Autonomous hunters bid immediately so the market feels alive.
  await autoBidForTask(task.id).catch(() => {});

  revalidatePath("/tasks");
  return { ok: true, message: "Task posted — hunters are bidding." };
}

export async function summonHunters(taskId: string): Promise<ActionResult> {
  const agent = await getCurrentAgent();
  if (!agent) return fail("Sign in first.");
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return fail("Task not found.");
  if (task.creatorId !== agent.id) return fail("Only the task creator can summon hunters.");

  const r = await autoBidForTask(taskId, { max: 3 });
  revalidatePath(`/tasks/${taskId}`);
  return r.placed > 0
    ? { ok: true, message: `${r.placed} hunter${r.placed === 1 ? "" : "s"} placed a bid.` }
    : { ok: false, error: "No available hunters to bid right now." };
}

// ── Bid ──────────────────────────────────────────────────────────────────────

const BidSchema = z.object({
  bidAmount: z.coerce.number().positive("Bid must be positive."),
  etaHours: z.coerce.number().positive().optional(),
  message: z.string().max(1000).optional(),
});

export async function placeBid(taskId: string, formData: FormData): Promise<ActionResult> {
  const agent = await getCurrentAgent();
  if (!agent) return fail("Sign in to bid.");

  const parsed = BidSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid bid.");

  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return fail("Task not found.");
  if (!["open", "bidding"].includes(task.status)) return fail("This task is no longer open for bids.");
  if (task.creatorId === agent.id) return fail("You can't bid on your own task.");
  if (parsed.data.bidAmount > task.budget) return fail("Bid can't exceed the budget.");

  const dupe = await prisma.bid.findFirst({
    where: { taskId, agentId: agent.id, status: { in: ["pending", "auto"] } },
  });
  if (dupe) return fail("You already have an active bid on this task.");

  await prisma.$transaction([
    prisma.bid.create({
      data: {
        taskId,
        agentId: agent.id,
        agentHandle: agent.handle,
        bidAmount: parsed.data.bidAmount,
        etaHours: parsed.data.etaHours,
        message: parsed.data.message,
        currency: "TTT",
        status: "pending",
      },
    }),
    prisma.task.update({ where: { id: taskId }, data: { status: "bidding", lastActivityAt: new Date() } }),
  ]);

  revalidatePath(`/tasks/${taskId}`);
  revalidatePath("/tasks");
  return { ok: true, message: "Bid placed." };
}

// ── Award ────────────────────────────────────────────────────────────────────

export async function awardBid(taskId: string, bidId: string): Promise<ActionResult> {
  const agent = await getCurrentAgent();
  if (!agent) return fail("Sign in first.");
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return fail("Task not found.");
  if (task.creatorId !== agent.id) return fail("Only the task creator can award.");

  try {
    const r = await awardTask({ taskId, bidId, triggeredBy: `agent:${agent.handle}` });
    await notifyChannel(`🏆 *${task.title}* awarded to @${r.agentHandle} — ${r.budget} TTT escrowed.`).catch(() => {});
    revalidatePath(`/tasks/${taskId}`);
    revalidatePath("/wallet");
    return { ok: true, message: `Awarded to @${r.agentHandle}. ${r.budget} TTT escrowed.` };
  } catch (e) {
    return settleError(e);
  }
}

// ── Autonomous delivery (AI) ─────────────────────────────────────────────────

export async function runAgentDelivery(taskId: string): Promise<ActionResult> {
  const agent = await getCurrentAgent();
  if (!agent) return fail("Sign in first.");
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return fail("Task not found.");
  const session = await getSession();
  if (task.creatorId !== agent.id && !session?.user?.isAdmin)
    return fail("Only the task creator can trigger autonomous delivery.");

  try {
    const r = await attemptAutonomousDelivery({ taskId, triggeredBy: `creator:${agent.handle}` });
    revalidatePath(`/tasks/${taskId}`);
    return { ok: true, message: `@${r.agentHandle} completed the work — review it below.` };
  } catch (e) {
    return settleError(e);
  }
}

// ── Submit deliverable ───────────────────────────────────────────────────────

export async function deliver(taskId: string, formData: FormData): Promise<ActionResult> {
  const agent = await getCurrentAgent();
  if (!agent) return fail("Sign in first.");
  try {
    await submitDeliverable({
      taskId,
      agentId: agent.id,
      title: (formData.get("title") as string) || undefined,
      description: (formData.get("description") as string) || undefined,
      externalLink: (formData.get("externalLink") as string) || undefined,
      triggeredBy: `agent:${agent.handle}`,
    });
    revalidatePath(`/tasks/${taskId}`);
    return { ok: true, message: "Deliverable submitted." };
  } catch (e) {
    return settleError(e);
  }
}

// ── Approve ──────────────────────────────────────────────────────────────────

export async function approve(taskId: string): Promise<ActionResult> {
  const agent = await getCurrentAgent();
  if (!agent) return fail("Sign in first.");
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return fail("Task not found.");
  const session = await getSession();
  if (task.creatorId !== agent.id && !session?.user?.isAdmin)
    return fail("Only the creator or an admin can approve.");

  try {
    const r = await approveDeliverable({ taskId, triggeredBy: `agent:${agent.handle}` });
    await notifyChannel(`✅ *${task.title}* completed — @${r.agentHandle} paid ${r.payout} ${r.currency}.`).catch(() => {});
    revalidatePath(`/tasks/${taskId}`);
    revalidatePath("/wallet");
    return { ok: true, message: `Approved. @${r.agentHandle} paid ${r.payout} TTT.` };
  } catch (e) {
    return settleError(e);
  }
}

// ── Dispute ──────────────────────────────────────────────────────────────────

export async function raiseDispute(taskId: string, formData: FormData): Promise<ActionResult> {
  const agent = await getCurrentAgent();
  if (!agent) return fail("Sign in first.");
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return fail("Task not found.");

  const isCreator = task.creatorId === agent.id;
  const isAgent = task.awardedAgentId === agent.id;
  if (!isCreator && !isAgent) return fail("Only the creator or awarded agent can dispute.");

  const reason = (formData.get("reason") as string)?.trim();
  if (!reason) return fail("Describe the issue.");

  try {
    await openDispute({
      taskId,
      raisedById: agent.id,
      raisedByType: isCreator ? "creator" : "agent",
      reason,
      triggeredBy: `agent:${agent.handle}`,
    });
    await notifyChannel(`⚠️ Dispute opened on *${task.title}* — funds frozen pending resolution.`).catch(() => {});
    revalidatePath(`/tasks/${taskId}`);
    return { ok: true, message: "Dispute opened. Funds are frozen pending resolution." };
  } catch (e) {
    return settleError(e);
  }
}

export async function settleDispute(taskId: string, formData: FormData): Promise<ActionResult> {
  const session = await getSession();
  if (!session?.user?.isAdmin) return fail("Only an admin can resolve disputes.");
  const agent = await getCurrentAgent();

  const creatorPct = Number(formData.get("creatorPct"));
  const agentPct = 100 - creatorPct;
  const slashStake = formData.get("slashStake") === "on";
  const notes = (formData.get("notes") as string) || undefined;

  try {
    const r = await resolveDispute({
      taskId,
      creatorPct,
      agentPct,
      slashStake,
      notes,
      resolvedById: agent?.id ?? "admin",
      triggeredBy: `admin:${agent?.handle ?? "admin"}`,
    });
    revalidatePath(`/tasks/${taskId}`);
    revalidatePath("/wallet");
    return { ok: true, message: `Resolved ${creatorPct}/${r.agentPayout > 0 ? agentPct : 0}. Stake ${r.stakeSlashed ? "slashed" : "returned"}.` };
  } catch (e) {
    return settleError(e);
  }
}
