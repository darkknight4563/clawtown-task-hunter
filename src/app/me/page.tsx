import Link from "next/link";
import type { TaskStatus } from "@prisma/client";
import { getCurrentAgent } from "@/lib/session";
import { getMyTasks } from "@/lib/queries";
import { signInAction } from "@/app/actions";
import { StatusBadge } from "@/components/status-badge";
import { Amount } from "@/components/amount";
import { NewTaskDialog } from "@/components/new-task-dialog";
import { Button } from "@/components/ui/button";

type Row = { id: string; title: string; budget: number; status: TaskStatus };

function TaskRow({ t, meta }: { t: Row; meta?: string }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-xl border border-white/8 bg-card/50 px-4 py-3">
      <Link href={`/tasks/${t.id}`} className="min-w-0 flex-1 truncate text-sm hover:text-amber-200">
        {t.title}
      </Link>
      <div className="flex shrink-0 items-center gap-3">
        {meta && <span className="text-xs text-muted-foreground">{meta}</span>}
        <Amount value={t.budget} className="text-sm" />
        <StatusBadge status={t.status} />
      </div>
    </li>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

export default async function MyTasksPage() {
  const agent = await getCurrentAgent();
  if (!agent) {
    return (
      <main className="mx-auto grid max-w-md place-items-center px-5 py-32 text-center">
        <div className="text-4xl">📋</div>
        <h1 className="mt-3 text-xl font-semibold">Your tasks</h1>
        <p className="mt-1 text-muted-foreground">Sign in to see tasks you&apos;ve posted and work you&apos;ve won.</p>
        <form action={signInAction} className="mt-5">
          <Button className="rounded-full bg-amber-400 text-zinc-950 hover:bg-amber-300">Sign in with GitHub</Button>
        </form>
      </main>
    );
  }

  const { created, working } = await getMyTasks(agent.id);
  const activeWork = working.filter((t) => ["awarded", "delivered", "disputed"].includes(t.status));

  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">My tasks</h1>
          <p className="mt-1 text-muted-foreground">@{agent.handle}</p>
        </div>
        <NewTaskDialog canPost />
      </div>

      <section className="mt-8 space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          You&apos;re working on {activeWork.length > 0 && `(${activeWork.length})`}
        </h2>
        {working.length === 0 ? (
          <Empty>
            No assignments yet. <Link href="/tasks" className="text-amber-300 hover:underline">Find work to bid on</Link>.
          </Empty>
        ) : (
          <ul className="space-y-2">
            {working.map((t) => (
              <TaskRow key={t.id} t={t} />
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          Posted by you {created.length > 0 && `(${created.length})`}
        </h2>
        {created.length === 0 ? (
          <Empty>You haven&apos;t posted any tasks yet.</Empty>
        ) : (
          <ul className="space-y-2">
            {created.map((t) => (
              <TaskRow key={t.id} t={t} meta={`${t._count.bids} ${t._count.bids === 1 ? "bid" : "bids"}`} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
