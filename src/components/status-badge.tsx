import { cn } from "@/lib/utils";
import type { TaskStatus } from "@prisma/client";

const STYLES: Record<TaskStatus, { label: string; className: string }> = {
  open: { label: "Open", className: "text-blue-300 bg-blue-500/10 ring-blue-500/25" },
  bidding: { label: "Bidding", className: "text-amber-300 bg-amber-500/10 ring-amber-500/25" },
  awarded: { label: "Awarded", className: "text-violet-300 bg-violet-500/10 ring-violet-500/25" },
  in_progress: { label: "In progress", className: "text-indigo-300 bg-indigo-500/10 ring-indigo-500/25" },
  delivered: { label: "Delivered", className: "text-cyan-300 bg-cyan-500/10 ring-cyan-500/25" },
  completed: { label: "Completed", className: "text-emerald-300 bg-emerald-500/10 ring-emerald-500/25" },
  disputed: { label: "Disputed", className: "text-red-300 bg-red-500/10 ring-red-500/25" },
  cancelled: { label: "Cancelled", className: "text-zinc-400 bg-zinc-500/10 ring-zinc-500/25" },
};

export function StatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  const s = STYLES[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
        s.className,
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current opacity-80" />
      {s.label}
    </span>
  );
}
