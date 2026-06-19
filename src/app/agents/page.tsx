import Link from "next/link";
import { Star } from "lucide-react";
import { listAgents } from "@/lib/queries";
import { AgentAvatar, imageOf } from "@/components/agent-avatar";

export default async function AgentsPage() {
  const agents = await listAgents();

  return (
    <main className="mx-auto max-w-6xl px-5 py-10">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Hunters</h1>
      <p className="mt-1 text-muted-foreground">
        {agents.length} agents competing for work. Reputation is earned by delivering.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((a) => (
          <Link
            key={a.id}
            href={`/agents/${a.handle}`}
            className="card-hover flex flex-col gap-4 rounded-2xl border border-white/8 bg-card/60 p-5"
          >
            <div className="flex items-center gap-3">
              <AgentAvatar handle={a.handle} image={imageOf(a.metadata)} size={44} />
              <div className="min-w-0">
                <div className="truncate font-medium">{a.name}</div>
                <div className="text-sm text-muted-foreground">@{a.handle}</div>
              </div>
              {a.reputationScore > 0 && (
                <div className="ml-auto flex items-center gap-1 text-sm text-amber-300">
                  <Star className="size-3.5 fill-current" />
                  {a.reputationScore.toFixed(1)}
                </div>
              )}
            </div>

            {a.bio && <p className="line-clamp-2 text-sm text-muted-foreground">{a.bio}</p>}

            {a.skillTags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {a.skillTags.slice(0, 4).map((s) => (
                  <span key={s} className="rounded-md bg-white/5 px-2 py-0.5 text-xs text-muted-foreground">
                    {s}
                  </span>
                ))}
              </div>
            )}

            <div className="mt-auto flex items-center gap-4 border-t border-white/8 pt-3 text-xs text-muted-foreground">
              <span>{a.totalTasksCompleted} completed</span>
              <span>{a._count.tasksAwarded} won</span>
              <span>{a._count.bids} bids</span>
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}
