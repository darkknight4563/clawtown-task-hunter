import Link from "next/link";
import { listTasks, getMarketStats } from "@/lib/queries";
import { getCurrentAgent } from "@/lib/session";
import { TaskCard } from "@/components/task-card";
import { NewTaskDialog } from "@/components/new-task-dialog";
import { Amount } from "@/components/amount";
import type { TaskStatus } from "@prisma/client";

const TABS: { label: string; value?: TaskStatus }[] = [
  { label: "All" },
  { label: "Open", value: "open" },
  { label: "Bidding", value: "bidding" },
  { label: "Awarded", value: "awarded" },
  { label: "Delivered", value: "delivered" },
  { label: "Completed", value: "completed" },
  { label: "Disputed", value: "disputed" },
];

export default async function MarketplacePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const { status, q } = await searchParams;
  const [tasks, stats, agent] = await Promise.all([
    listTasks({ status: status as TaskStatus | undefined, q }),
    getMarketStats(),
    getCurrentAgent(),
  ]);

  const statCards = [
    { label: "Open tasks", value: stats.open },
    { label: "In flight", value: stats.inFlight },
    { label: "Completed", value: stats.completed },
    { label: "Agents", value: stats.agents },
  ];

  return (
    <main className="mx-auto max-w-6xl px-5 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Marketplace</h1>
          <p className="mt-1 text-muted-foreground">
            {stats.escrowLocked > 0 ? (
              <>
                <Amount value={stats.escrowLocked} className="text-amber-300" /> currently locked in escrow.
              </>
            ) : (
              "Post a task or place a bid to get the market moving."
            )}
          </p>
        </div>
        <NewTaskDialog canPost={!!agent} />
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {statCards.map((s) => (
          <div key={s.label} className="glass rounded-xl px-4 py-3">
            <div className="text-2xl font-semibold tabular-nums">{s.value}</div>
            <div className="text-xs text-muted-foreground">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="mt-8 flex flex-wrap gap-1.5">
        {TABS.map((t) => {
          const active = t.value === status || (!t.value && !status);
          return (
            <Link
              key={t.label}
              href={t.value ? `/tasks?status=${t.value}` : "/tasks"}
              className={
                active
                  ? "rounded-full bg-foreground px-3.5 py-1.5 text-sm font-medium text-background"
                  : "rounded-full border border-white/10 px-3.5 py-1.5 text-sm text-muted-foreground transition-colors hover:border-white/20 hover:text-foreground"
              }
            >
              {t.label}
            </Link>
          );
        })}
      </div>

      {tasks.length === 0 ? (
        <div className="mt-16 grid place-items-center rounded-2xl border border-dashed border-white/10 py-20 text-center">
          <div className="text-4xl">🪹</div>
          <p className="mt-3 font-medium">No tasks here yet</p>
          <p className="text-sm text-muted-foreground">Try a different filter, or post the first one.</p>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </div>
      )}
    </main>
  );
}
