"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ShieldAlert, Sparkles } from "lucide-react";
import { placeBid, awardBid, deliver, approve, raiseDispute, settleDispute, summonHunters } from "@/app/actions";
import type { ActionResult } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

function useRun() {
  const [pending, start] = useTransition();
  const router = useRouter();
  function run(fn: () => Promise<ActionResult | void>, onOk?: () => void) {
    start(async () => {
      const res = await fn();
      if (!res || res.ok) {
        toast.success((res && res.message) || "Done.");
        onOk?.();
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }
  return { pending, run };
}

const panel = "rounded-2xl border border-white/8 bg-card/60 p-5 space-y-4";

export function AwardButton({ taskId, bidId }: { taskId: string; bidId: string }) {
  const { pending, run } = useRun();
  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() => run(() => awardBid(taskId, bidId))}
      className="rounded-full bg-amber-400 text-zinc-950 hover:bg-amber-300"
    >
      {pending ? "Awarding…" : "Award"}
    </Button>
  );
}

export function SummonHuntersButton({ taskId }: { taskId: string }) {
  const { pending, run } = useRun();
  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={() => run(() => summonHunters(taskId))}
      className="w-full gap-1.5 border-white/12"
    >
      <Sparkles className="size-4 text-amber-300" />
      {pending ? "Summoning…" : "Summon more hunters"}
    </Button>
  );
}

export function BidForm({ taskId }: { taskId: string }) {
  const { pending, run } = useRun();
  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    run(() => placeBid(taskId, new FormData(form)), () => form.reset());
  }
  return (
    <form onSubmit={onSubmit} className={panel}>
      <h3 className="font-medium">Place a bid</h3>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="bidAmount">Your price (TTT)</Label>
          <Input id="bidAmount" name="bidAmount" type="number" min="1" step="1" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="etaHours">ETA (hours)</Label>
          <Input id="etaHours" name="etaHours" type="number" min="1" step="1" />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="message">Pitch</Label>
        <Textarea id="message" name="message" rows={2} placeholder="Why you?" />
      </div>
      <Button type="submit" disabled={pending} className="w-full bg-amber-400 text-zinc-950 hover:bg-amber-300">
        {pending ? "Submitting…" : "Submit bid"}
      </Button>
      <p className="text-xs text-muted-foreground">
        Winning a task locks a stake of 10% of your bid until the work is approved.
      </p>
    </form>
  );
}

export function DeliverForm({ taskId }: { taskId: string }) {
  const { pending, run } = useRun();
  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    run(() => deliver(taskId, new FormData(form)), () => form.reset());
  }
  return (
    <form onSubmit={onSubmit} className={panel}>
      <h3 className="font-medium">Submit your deliverable</h3>
      <div className="space-y-1.5">
        <Label htmlFor="title">Title</Label>
        <Input id="title" name="title" placeholder="What you're handing off" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="externalLink">Link</Label>
        <Input id="externalLink" name="externalLink" type="url" placeholder="https://…" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="description">Notes</Label>
        <Textarea id="description" name="description" rows={3} />
      </div>
      <Button type="submit" disabled={pending} className="w-full bg-amber-400 text-zinc-950 hover:bg-amber-300">
        {pending ? "Submitting…" : "Submit for approval"}
      </Button>
    </form>
  );
}

export function ApproveButton({ taskId }: { taskId: string }) {
  const { pending, run } = useRun();
  return (
    <Button
      disabled={pending}
      onClick={() => run(() => approve(taskId))}
      className="w-full bg-emerald-500 text-emerald-950 hover:bg-emerald-400"
    >
      {pending ? "Releasing payment…" : "Approve & release payment"}
    </Button>
  );
}

export function DisputeButton({ taskId }: { taskId: string }) {
  const { pending, run } = useRun();
  const [open, setOpen] = useState(false);
  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    run(() => raiseDispute(taskId, new FormData(e.currentTarget)), () => setOpen(false));
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button variant="ghost" className="w-full text-red-300 hover:bg-red-500/10 hover:text-red-200" />}
      >
        <ShieldAlert className="size-4" /> Open a dispute
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open a dispute</DialogTitle>
          <DialogDescription>Funds stay frozen in escrow until an admin resolves the split.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="reason">What went wrong?</Label>
            <Textarea id="reason" name="reason" rows={4} required />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending} variant="destructive">
              {pending ? "Opening…" : "Open dispute"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ResolveForm({ taskId }: { taskId: string }) {
  const { pending, run } = useRun();
  const [creatorPct, setCreatorPct] = useState(50);
  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    run(() => settleDispute(taskId, new FormData(e.currentTarget)));
  }
  return (
    <form onSubmit={onSubmit} className={`${panel} ring-1 ring-red-500/20`}>
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-4 text-red-300" />
        <h3 className="font-medium">Resolve dispute (admin)</h3>
      </div>
      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <span>Creator {creatorPct}%</span>
          <span>Agent {100 - creatorPct}%</span>
        </div>
        <input
          name="creatorPct"
          type="range"
          min={0}
          max={100}
          step={5}
          value={creatorPct}
          onChange={(e) => setCreatorPct(Number(e.target.value))}
          className="w-full accent-amber-400"
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="slashStake" className="accent-red-500" />
        Slash the agent&apos;s stake (forfeit to platform)
      </label>
      <div className="space-y-1.5">
        <Label htmlFor="notes">Resolution notes</Label>
        <Textarea id="notes" name="notes" rows={2} />
      </div>
      <Button type="submit" disabled={pending} variant="destructive" className="w-full">
        {pending ? "Resolving…" : "Resolve & settle"}
      </Button>
    </form>
  );
}
