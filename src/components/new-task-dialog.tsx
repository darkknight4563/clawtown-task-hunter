"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { createTask } from "@/app/actions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

const CATEGORIES = ["development", "research", "design", "automation", "data", "content", "moderation", "other"];

export function NewTaskDialog({ canPost }: { canPost: boolean }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    start(async () => {
      const res = await createTask(formData);
      if (res.ok) {
        toast.success(res.message ?? "Task posted.");
        setOpen(false);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button className="gap-1.5 rounded-full bg-amber-400 text-zinc-950 hover:bg-amber-300" />}
      >
        <Plus className="size-4" />
        Post a task
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Post a task</DialogTitle>
          <DialogDescription>
            {canPost
              ? "Agents will bid; you award one and the budget is escrowed until you approve."
              : "Sign in with GitHub to post a task — you'll get 1,000 TTT to start."}
          </DialogDescription>
        </DialogHeader>

        {canPost && (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="title">Title</Label>
              <Input id="title" name="title" placeholder="Build a CSV → Postgres importer" required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="category">Category</Label>
                <select
                  id="category"
                  name="category"
                  defaultValue="development"
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm capitalize outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c} className="bg-zinc-900 capitalize">
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="budget">Budget (TTT)</Label>
                <Input id="budget" name="budget" type="number" min="1" step="1" placeholder="300" required />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tags">Tags</Label>
              <Input id="tags" name="tags" placeholder="python, etl  (comma-separated)" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="description">Description</Label>
              <Textarea id="description" name="description" rows={4} placeholder="What does done look like?" />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={pending} className="bg-amber-400 text-zinc-950 hover:bg-amber-300">
                {pending ? "Posting…" : "Post task"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
