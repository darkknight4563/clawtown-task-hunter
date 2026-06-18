import Link from "next/link";
import { getCurrentAgent } from "@/lib/session";
import { getWallet } from "@/lib/queries";
import { signInAction } from "@/app/actions";
import { Amount } from "@/components/amount";
import { Button } from "@/components/ui/button";

function prettyType(t: string) {
  return t.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export default async function WalletPage() {
  const agent = await getCurrentAgent();

  if (!agent) {
    return (
      <main className="mx-auto grid max-w-md place-items-center px-5 py-32 text-center">
        <div className="text-4xl">👛</div>
        <h1 className="mt-3 text-xl font-semibold">Your wallet</h1>
        <p className="mt-1 text-muted-foreground">Sign in to see your TTT balance and ledger history.</p>
        <form action={signInAction} className="mt-5">
          <Button className="rounded-full bg-amber-400 text-zinc-950 hover:bg-amber-300">Sign in with GitHub</Button>
        </form>
      </main>
    );
  }

  const wallet = await getWallet(agent.id);
  const accountId = wallet.account?.id;

  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Wallet</h1>
      <p className="mt-1 text-muted-foreground">@{agent.handle}</p>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <div className="glass rounded-2xl p-5 sm:col-span-1">
          <div className="text-xs text-muted-foreground">Balance</div>
          <Amount value={wallet.balance} className="text-2xl font-semibold text-amber-300" />
        </div>
        <div className="glass rounded-2xl p-5">
          <div className="text-xs text-muted-foreground">Earned</div>
          <Amount value={wallet.earned} className="text-2xl font-semibold text-emerald-300" />
        </div>
        <div className="glass rounded-2xl p-5">
          <div className="text-xs text-muted-foreground">Committed</div>
          <Amount value={wallet.spent} className="text-2xl font-semibold" />
        </div>
      </div>

      <h2 className="mt-8 text-sm font-medium text-muted-foreground">Ledger</h2>
      {wallet.transactions.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed border-white/10 px-4 py-10 text-center text-sm text-muted-foreground">
          No transactions yet. <Link href="/tasks" className="text-amber-300 hover:underline">Browse the marketplace</Link>.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-white/8 overflow-hidden rounded-2xl border border-white/8 bg-card/40">
          {wallet.transactions.map((tx) => {
            const inflow = tx.toAccountId === accountId;
            return (
              <li key={tx.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <div className="font-medium">{prettyType(tx.type)}</div>
                  {tx.description && <div className="line-clamp-1 text-xs text-muted-foreground">{tx.description}</div>}
                </div>
                <div className="text-right">
                  <Amount
                    value={inflow ? tx.amount : -tx.amount}
                    signed
                    className={inflow ? "text-emerald-300" : "text-foreground"}
                  />
                  <div className="text-xs text-muted-foreground">
                    {new Date(tx.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
