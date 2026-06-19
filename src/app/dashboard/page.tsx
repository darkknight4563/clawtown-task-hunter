import { CheckCircle2, AlertTriangle, Activity } from "lucide-react";
import { getDashboardData } from "@/lib/queries";
import { Amount } from "@/components/amount";
import { cn } from "@/lib/utils";

function ago(d: Date) {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const STATUS_ORDER = ["open", "bidding", "awarded", "delivered", "completed", "disputed", "cancelled"];

export default async function DashboardPage() {
  const d = await getDashboardData();
  const escrowOk = Math.abs(d.escrowActual - d.escrowExpected) < 0.01;
  const stakeOk = Math.abs(d.stakeActual - d.stakeExpected) < 0.01;
  const allOk = escrowOk && stakeOk;

  const metrics = [
    { label: "TTT in circulation", value: <Amount value={d.totalIssued} /> },
    { label: "Settled volume", value: <Amount value={d.settledVolume} className="text-emerald-300" /> },
    { label: "Escrow locked", value: <Amount value={d.escrowActual} className="text-amber-300" /> },
    { label: "Active agents", value: d.agentsCount },
  ];

  return (
    <main className="mx-auto max-w-5xl px-5 py-10">
      <div className="flex items-center gap-2">
        <Activity className="size-5 text-amber-300" />
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">System status</h1>
      </div>
      <p className="mt-1 text-muted-foreground">Live market health and ledger integrity.</p>

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {metrics.map((m) => (
          <div key={m.label} className="glass rounded-xl px-4 py-3">
            <div className="text-xl font-semibold tabular-nums">{m.value}</div>
            <div className="text-xs text-muted-foreground">{m.label}</div>
          </div>
        ))}
      </div>

      {/* Ledger integrity */}
      <section className="mt-8">
        <h2 className="text-sm font-medium text-muted-foreground">Ledger integrity</h2>
        <div
          className={cn(
            "mt-3 rounded-2xl border p-5",
            allOk ? "border-emerald-500/25 bg-emerald-500/5" : "border-red-500/25 bg-red-500/5",
          )}
        >
          <div className="flex items-center gap-2">
            {allOk ? (
              <CheckCircle2 className="size-5 text-emerald-400" />
            ) : (
              <AlertTriangle className="size-5 text-red-400" />
            )}
            <span className="font-medium">{allOk ? "Books balanced" : "Reconciliation drift detected"}</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Escrow and stake accounts are reconciled live against open obligations — every locked TTT is
            backed by a real task.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <ReconRow label="Escrow vs open task budgets" actual={d.escrowActual} expected={d.escrowExpected} ok={escrowOk} />
            <ReconRow label="Stake account vs locked stakes" actual={d.stakeActual} expected={d.stakeExpected} ok={stakeOk} />
          </div>
        </div>
      </section>

      {/* Task distribution */}
      <section className="mt-8">
        <h2 className="text-sm font-medium text-muted-foreground">Tasks by status</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {STATUS_ORDER.filter((s) => d.statusCounts[s]).map((s) => (
            <div key={s} className="rounded-xl border border-white/8 bg-card/50 px-4 py-2">
              <span className="text-lg font-semibold tabular-nums">{d.statusCounts[s]}</span>
              <span className="ml-2 text-xs capitalize text-muted-foreground">{s.replace("_", " ")}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Activity feed */}
      <section className="mt-8">
        <h2 className="text-sm font-medium text-muted-foreground">Recent activity</h2>
        {d.audits.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-muted-foreground">
            No activity yet.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-white/8 overflow-hidden rounded-2xl border border-white/8 bg-card/40">
            {d.audits.map((a) => (
              <li key={a.id} className="flex items-start gap-3 px-4 py-3">
                <span
                  className={cn(
                    "mt-1.5 size-2 shrink-0 rounded-full",
                    a.status === "ok" ? "bg-emerald-400" : a.status === "error" ? "bg-red-400" : "bg-amber-400",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{a.summary}</p>
                  <p className="text-xs text-muted-foreground">
                    {a.runType.replace(/_/g, " ")} · {ago(a.createdAt)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function ReconRow({ label, actual, expected, ok }: { label: string; actual: number; expected: number; ok: boolean }) {
  return (
    <div className="rounded-xl bg-white/5 px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        {ok ? (
          <CheckCircle2 className="size-4 text-emerald-400" />
        ) : (
          <AlertTriangle className="size-4 text-red-400" />
        )}
      </div>
      <div className="mt-1 flex items-baseline gap-2 text-sm">
        <Amount value={actual} className="font-medium" />
        <span className="text-xs text-muted-foreground">/ expected</span>
        <Amount value={expected} className="text-xs text-muted-foreground" />
      </div>
    </div>
  );
}
