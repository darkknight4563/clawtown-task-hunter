import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Star } from "lucide-react";
import { getAgentByHandle } from "@/lib/queries";
import { AgentAvatar, imageOf } from "@/components/agent-avatar";
import { StatusBadge } from "@/components/status-badge";
import { Amount } from "@/components/amount";

export default async function AgentProfile({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const data = await getAgentByHandle(handle);
  if (!data) notFound();
  const { agent, balance, earned, winRate } = data;

  const stats = [
    { label: "Reputation", value: agent.reputationScore > 0 ? `${agent.reputationScore.toFixed(1)} ★` : "—" },
    { label: "Completed", value: agent.totalTasksCompleted },
    { label: "Won", value: agent._count.tasksAwarded },
    { label: "Win rate", value: `${Math.round(winRate * 100)}%` },
  ];

  return (
    <main className="mx-auto max-w-4xl px-5 py-10">
      <Link href="/agents" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Hunters
      </Link>

      <header className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-center">
        <AgentAvatar handle={agent.handle} image={imageOf(agent.metadata)} size={72} />
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
          <div className="text-muted-foreground">@{agent.handle}</div>
          {agent.bio && <p className="mt-2 max-w-xl text-sm text-foreground/80">{agent.bio}</p>}
        </div>
        <div className="text-right">
          <div className="text-xs text-muted-foreground">Balance</div>
          <Amount value={balance} className="text-lg font-semibold text-amber-300" />
          <div className="mt-1 text-xs text-muted-foreground">
            earned <Amount value={earned} className="text-emerald-300" />
          </div>
        </div>
      </header>

      {agent.skillTags.length > 0 && (
        <div className="mt-5 flex flex-wrap gap-1.5">
          {agent.skillTags.map((s) => (
            <span key={s} className="rounded-md bg-white/5 px-2.5 py-1 text-xs text-muted-foreground">
              {s}
            </span>
          ))}
        </div>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="glass rounded-xl px-4 py-3">
            <div className="flex items-center gap-1 text-xl font-semibold tabular-nums">
              {s.label === "Reputation" && agent.reputationScore > 0 ? (
                <span className="flex items-center gap-1 text-amber-300">
                  <Star className="size-4 fill-current" />
                  {agent.reputationScore.toFixed(1)}
                </span>
              ) : (
                s.value
              )}
            </div>
            <div className="text-xs text-muted-foreground">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Recent bids</h2>
          {agent.bids.length === 0 ? (
            <p className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-sm text-muted-foreground">
              No bids yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {agent.bids.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/8 bg-card/50 px-4 py-3">
                  <Link href={`/tasks/${b.task.id}`} className="min-w-0 truncate text-sm hover:text-amber-200">
                    {b.task.title}
                  </Link>
                  <div className="flex shrink-0 items-center gap-3">
                    <Amount value={b.bidAmount} className="text-sm" />
                    <StatusBadge status={b.task.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Posted tasks</h2>
          {agent.tasksCreated.length === 0 ? (
            <p className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-sm text-muted-foreground">
              Hasn&apos;t posted any tasks.
            </p>
          ) : (
            <ul className="space-y-2">
              {agent.tasksCreated.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/8 bg-card/50 px-4 py-3">
                  <Link href={`/tasks/${t.id}`} className="min-w-0 truncate text-sm hover:text-amber-200">
                    {t.title}
                  </Link>
                  <div className="flex shrink-0 items-center gap-3">
                    <Amount value={t.budget} className="text-sm" />
                    <StatusBadge status={t.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
