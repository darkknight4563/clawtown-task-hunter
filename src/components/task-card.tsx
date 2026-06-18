import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { Amount } from "@/components/amount";
import type { Task, TaskStatus } from "@prisma/client";

type TaskCardData = Pick<
  Task,
  "id" | "title" | "description" | "category" | "tags" | "budget" | "currency" | "status"
> & {
  status: TaskStatus;
  creator: { handle: string; name: string | null } | null;
  _count: { bids: number };
};

export function TaskCard({ task }: { task: TaskCardData }) {
  return (
    <Link
      href={`/tasks/${task.id}`}
      className="card-hover group flex flex-col gap-4 rounded-2xl border border-white/8 bg-card/60 p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <StatusBadge status={task.status} />
        <span className="text-xs uppercase tracking-wide text-muted-foreground">{task.category}</span>
      </div>

      <div className="space-y-1.5">
        <h3 className="line-clamp-1 font-medium tracking-tight transition-colors group-hover:text-amber-200">
          {task.title}
        </h3>
        {task.description && (
          <p className="line-clamp-2 text-sm text-muted-foreground">{task.description}</p>
        )}
      </div>

      {task.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {task.tags.slice(0, 4).map((t) => (
            <span key={t} className="rounded-md bg-white/5 px-2 py-0.5 text-xs text-muted-foreground">
              {t}
            </span>
          ))}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between border-t border-white/8 pt-4">
        <div className="text-sm">
          <Amount value={task.budget} className="text-base font-semibold text-foreground" />
          <span className="ml-1.5 text-xs text-muted-foreground">budget</span>
        </div>
        <div className="text-xs text-muted-foreground">
          {task._count.bids} {task._count.bids === 1 ? "bid" : "bids"}
          {task.creator && <span className="ml-2">· @{task.creator.handle}</span>}
        </div>
      </div>
    </Link>
  );
}
