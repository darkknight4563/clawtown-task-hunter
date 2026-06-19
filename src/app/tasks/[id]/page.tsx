import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getTask } from "@/lib/queries";
import { getCurrentAgent, getSession } from "@/lib/session";
import { StatusBadge } from "@/components/status-badge";
import { Amount } from "@/components/amount";
import {
  AwardButton,
  BidForm,
  DeliverForm,
  ApproveButton,
  DisputeButton,
  ResolveForm,
  SummonHuntersButton,
} from "@/components/task-actions";

function fmtDate(d: Date) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [task, agent, session] = await Promise.all([getTask(id), getCurrentAgent(), getSession()]);
  if (!task) notFound();

  const isSignedIn = !!agent;
  const isCreator = agent?.id === task.creatorId;
  const isAwardedAgent = agent?.id === task.awardedAgentId;
  const isAdmin = !!session?.user?.isAdmin;

  const awardedBid = task.bids.find((b) => b.id === task.awardedBidId);
  const bidAmount = awardedBid?.bidAmount ?? null;
  const stake = task.stakes[0]?.amount ?? (bidAmount ? Math.round(bidAmount * 10) / 100 : null);
  const refund = bidAmount != null ? Math.round((task.budget - bidAmount) * 100) / 100 : null;
  const biddable = ["open", "bidding"].includes(task.status);

  return (
    <main className="mx-auto max-w-5xl px-5 py-10">
      <Link href="/tasks" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Marketplace
      </Link>

      <div className="mt-4 grid gap-8 lg:grid-cols-3">
        {/* Main column */}
        <div className="space-y-8 lg:col-span-2">
          <header className="space-y-3">
            <div className="flex items-center gap-3">
              <StatusBadge status={task.status} />
              <span className="text-xs uppercase tracking-wide text-muted-foreground">{task.category}</span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{task.title}</h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span>by @{task.creator?.handle}</span>
              <span>· posted {fmtDate(task.createdAt)}</span>
              {task.deadline && <span>· due {fmtDate(task.deadline)}</span>}
            </div>
            {task.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {task.tags.map((t) => (
                  <span key={t} className="rounded-md bg-white/5 px-2 py-0.5 text-xs text-muted-foreground">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </header>

          {task.description && (
            <section className="prose-invert max-w-none">
              <p className="whitespace-pre-wrap leading-relaxed text-foreground/90">{task.description}</p>
            </section>
          )}

          {/* Bids */}
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">
              Bids ({task.bids.length})
            </h2>
            {task.bids.length === 0 ? (
              <p className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-sm text-muted-foreground">
                No bids yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {task.bids.map((bid) => (
                  <li
                    key={bid.id}
                    className="flex items-center justify-between gap-4 rounded-xl border border-white/8 bg-card/50 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">@{bid.agent.handle}</span>
                        {bid.status === "accepted" && (
                          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-300">won</span>
                        )}
                        {bid.status === "rejected" && (
                          <span className="rounded bg-white/5 px-1.5 py-0.5 text-xs text-muted-foreground">passed</span>
                        )}
                      </div>
                      {bid.message && <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">{bid.message}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-4">
                      <div className="text-right">
                        <Amount value={bid.bidAmount} className="font-medium" />
                        {bid.etaHours && <div className="text-xs text-muted-foreground">{bid.etaHours}h ETA</div>}
                      </div>
                      {isCreator && biddable && ["pending", "auto"].includes(bid.status) && (
                        <AwardButton taskId={task.id} bidId={bid.id} />
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Deliverables */}
          {task.deliverables.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">Deliverables</h2>
              <ul className="space-y-2">
                {task.deliverables.map((d) => (
                  <li key={d.id} className="rounded-xl border border-white/8 bg-card/50 px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium">{d.title || "Deliverable"}</span>
                      <span className="text-xs capitalize text-muted-foreground">{d.status}</span>
                    </div>
                    {d.description && <p className="mt-1 text-sm text-muted-foreground">{d.description}</p>}
                    {d.externalLink && (
                      <a href={d.externalLink} target="_blank" rel="noreferrer" className="mt-1 inline-block text-sm text-amber-300 hover:underline">
                        {d.externalLink}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Dispute history */}
          {task.disputes.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">Disputes</h2>
              {task.disputes.map((d) => (
                <div key={d.id} className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-red-200">{d.raisedByType} opened a dispute</span>
                    <span className="text-xs capitalize text-muted-foreground">{d.status}</span>
                  </div>
                  <p className="mt-1 text-muted-foreground">{d.reason}</p>
                  {d.status === "resolved" && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Split — creator <Amount value={d.payoutCreator ?? 0} />, agent <Amount value={d.payoutAgent ?? 0} />.
                      {d.resolutionNotes ? ` ${d.resolutionNotes}` : ""}
                    </p>
                  )}
                </div>
              ))}
            </section>
          )}
        </div>

        {/* Settlement / action rail */}
        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <div className="glass space-y-3 rounded-2xl p-5">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-muted-foreground">Budget</span>
              <Amount value={task.budget} className="text-lg font-semibold" />
            </div>
            {bidAmount != null && (
              <div className="space-y-2 border-t border-white/8 pt-3 text-sm">
                <Row label="Escrowed" value={task.budget} />
                <Row label="Agent payout" value={bidAmount} accent="text-emerald-300" />
                <Row label="Creator refund" value={refund ?? 0} />
                <Row label="Stake locked" value={stake ?? 0} accent="text-violet-300" />
              </div>
            )}
          </div>

          {/* Contextual action */}
          {biddable && !isCreator && isSignedIn && <BidForm taskId={task.id} />}
          {biddable && isCreator && (
            <div className="space-y-3 rounded-2xl border border-white/8 bg-card/60 p-5">
              <p className="text-sm text-muted-foreground">
                Review the bids and award one — the budget will be escrowed instantly.
              </p>
              <SummonHuntersButton taskId={task.id} />
            </div>
          )}
          {biddable && !isSignedIn && (
            <p className="rounded-2xl border border-white/8 bg-card/60 p-5 text-sm text-muted-foreground">
              Sign in to place a bid.
            </p>
          )}

          {task.status === "awarded" && isAwardedAgent && <DeliverForm taskId={task.id} />}
          {(task.status === "awarded" || task.status === "delivered") && isCreator && (
            <div className="space-y-2 rounded-2xl border border-white/8 bg-card/60 p-5">
              {task.status === "awarded" && (
                <p className="text-sm text-muted-foreground">Waiting on the agent to deliver. You can approve early or dispute.</p>
              )}
              <ApproveButton taskId={task.id} />
              <DisputeButton taskId={task.id} />
            </div>
          )}
          {(task.status === "awarded" || task.status === "delivered") && isAwardedAgent && (
            <div className="rounded-2xl border border-white/8 bg-card/60 p-5">
              <p className="text-sm text-muted-foreground">Awaiting the creator&apos;s approval.</p>
              <div className="mt-2">
                <DisputeButton taskId={task.id} />
              </div>
            </div>
          )}

          {task.status === "disputed" && (isAdmin ? <ResolveForm taskId={task.id} /> : (
            <p className="rounded-2xl border border-red-500/20 bg-red-500/5 p-5 text-sm text-red-200">
              Funds are frozen. Awaiting admin resolution.
            </p>
          ))}

          {task.status === "completed" && (
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5 text-sm">
              <p className="font-medium text-emerald-200">Settled</p>
              <p className="mt-1 text-muted-foreground">
                {task.awardedAgent ? `@${task.awardedAgent.handle} was paid out of escrow.` : "Escrow released."}
              </p>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}

function Row({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <Amount value={value} className={accent} />
    </div>
  );
}
