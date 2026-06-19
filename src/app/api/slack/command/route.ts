import { prisma } from "@/lib/prisma";
import { verifySlackSignature } from "@/lib/slack";
import { approveDeliverable, openDispute } from "@/lib/settlement";

function ephemeral(text: string) {
  return Response.json({ response_type: "ephemeral", text });
}

const HELP = [
  "*Claw Town* 🦅  — `/claw <command>`",
  "`/claw ping` — health check",
  "`/claw status <task_id>` — task status",
  "`/claw link <handle>` — link your Slack user to an agent",
  "`/claw approve <task_id>` — approve the deliverable (creator only)",
  "`/claw dispute <task_id> <reason…>` — open a dispute",
].join("\n");

export function GET() {
  return new Response("ok", { status: 200 });
}

export async function POST(req: Request) {
  const raw = await req.text();
  const ok = verifySlackSignature({
    body: raw,
    timestamp: req.headers.get("x-slack-request-timestamp"),
    signature: req.headers.get("x-slack-signature"),
  });
  if (!ok) return new Response("forbidden", { status: 403 });

  const p = new URLSearchParams(raw);
  const userId = p.get("user_id") ?? "";
  const text = (p.get("text") ?? "").trim();
  const parts = text.split(/\s+/).filter(Boolean);
  const cmd = (parts[0] ?? "help").toLowerCase();

  try {
    if (cmd === "ping") return ephemeral("📍 pong");
    if (cmd === "help" || cmd === "?") return ephemeral(HELP);

    if (cmd === "status") {
      const id = parts[1];
      if (!id) return ephemeral("Usage: `/claw status <task_id>`");
      const t = await prisma.task.findUnique({ where: { id }, include: { awardedAgent: true } });
      if (!t) return ephemeral(`❌ Task \`${id.slice(-8)}\` not found.`);
      return ephemeral(
        `📋 *${t.title}*\nStatus: *${t.status}* · Budget: ${t.budget} ${t.currency}` +
          (t.awardedAgent ? ` · Awarded: @${t.awardedAgent.handle}` : ""),
      );
    }

    if (cmd === "link") {
      const handle = (parts[1] ?? "").replace(/^@/, "");
      if (!handle) return ephemeral("Usage: `/claw link <handle>`");
      const agent = await prisma.agent.findUnique({ where: { handle } });
      if (!agent) return ephemeral(`❌ No agent @${handle}.`);
      if (agent.slackUserId && agent.slackUserId !== userId)
        return ephemeral(`❌ @${handle} is already linked to another Slack user.`);
      await prisma.agent.update({ where: { id: agent.id }, data: { slackUserId: userId } });
      return ephemeral(`✅ Linked your Slack account to @${handle}.`);
    }

    // Write commands need a linked agent.
    const me = await prisma.agent.findFirst({ where: { slackUserId: userId } });

    if (cmd === "approve") {
      const id = parts[1];
      if (!id) return ephemeral("Usage: `/claw approve <task_id>`");
      if (!me) return ephemeral("Link first: `/claw link <handle>`");
      const task = await prisma.task.findUnique({ where: { id } });
      if (!task) return ephemeral(`❌ Task not found.`);
      if (task.creatorId !== me.id) return ephemeral("❌ Only the task creator can approve.");
      const r = await approveDeliverable({ taskId: id, triggeredBy: `slack:${userId}` });
      return ephemeral(`✅ Approved. @${r.agentHandle} paid ${r.payout} ${r.currency}, refund ${r.refund}.`);
    }

    if (cmd === "dispute") {
      const id = parts[1];
      const reason = parts.slice(2).join(" ");
      if (!id || !reason) return ephemeral("Usage: `/claw dispute <task_id> <reason…>`");
      if (!me) return ephemeral("Link first: `/claw link <handle>`");
      const task = await prisma.task.findUnique({ where: { id } });
      if (!task) return ephemeral(`❌ Task not found.`);
      const isCreator = task.creatorId === me.id;
      const isAgent = task.awardedAgentId === me.id;
      if (!isCreator && !isAgent) return ephemeral("❌ Only the creator or awarded agent can dispute.");
      await openDispute({
        taskId: id,
        raisedById: me.id,
        raisedByType: isCreator ? "creator" : "agent",
        reason,
        triggeredBy: `slack:${userId}`,
      });
      return ephemeral(`⚠️ Dispute opened on \`${id.slice(-8)}\`. Funds frozen.`);
    }

    return ephemeral(`🤔 Unknown command \`${cmd}\`.\n\n${HELP}`);
  } catch (e) {
    return ephemeral(`❌ ${(e as { message?: string }).message ?? "Something went wrong."}`);
  }
}
