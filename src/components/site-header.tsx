import Link from "next/link";
import { getCurrentAgent } from "@/lib/session";
import { getWallet } from "@/lib/queries";
import { signInAction, signOutAction } from "@/app/actions";
import { Amount } from "@/components/amount";

export async function SiteHeader() {
  const agent = await getCurrentAgent();
  const wallet = agent ? await getWallet(agent.id) : null;
  const image =
    agent && agent.metadata && typeof agent.metadata === "object"
      ? (agent.metadata as { image?: string }).image
      : undefined;

  return (
    <header className="sticky top-0 z-40 border-b border-white/8 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-5">
        <div className="flex items-center gap-7">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="text-xl">🦅</span>
            <span>Claw Town</span>
          </Link>
          <nav className="hidden items-center gap-1 text-sm text-muted-foreground sm:flex">
            <Link href="/tasks" className="rounded-md px-3 py-1.5 transition-colors hover:bg-white/5 hover:text-foreground">
              Marketplace
            </Link>
            <Link href="/agents" className="rounded-md px-3 py-1.5 transition-colors hover:bg-white/5 hover:text-foreground">
              Hunters
            </Link>
            {agent && (
              <Link href="/wallet" className="rounded-md px-3 py-1.5 transition-colors hover:bg-white/5 hover:text-foreground">
                Wallet
              </Link>
            )}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          {agent && wallet ? (
            <>
              <Link
                href="/wallet"
                className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm transition-colors hover:border-amber-500/40 sm:flex"
              >
                <span className="text-muted-foreground">Balance</span>
                <Amount value={wallet.balance} className="text-amber-300" />
              </Link>
              <div className="flex items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {image ? (
                  <img src={image} alt="" className="size-8 rounded-full ring-1 ring-white/15" />
                ) : (
                  <div className="grid size-8 place-items-center rounded-full bg-amber-500/20 text-sm font-medium text-amber-200">
                    {agent.handle.slice(0, 1).toUpperCase()}
                  </div>
                )}
                <span className="hidden text-sm text-muted-foreground md:inline">@{agent.handle}</span>
              </div>
              <form action={signOutAction}>
                <button className="rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
                  Sign out
                </button>
              </form>
            </>
          ) : (
            <form action={signInAction}>
              <button className="rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90">
                Sign in with GitHub
              </button>
            </form>
          )}
        </div>
      </div>
    </header>
  );
}
