import { cache } from "react";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { provisionAgent } from "@/lib/agents";
import type { Agent } from "@prisma/client";

/**
 * The signed-in user's marketplace Agent. Read-only on the hot path; cached
 * per-request so concurrent server components (header + page) share one lookup.
 * Provisioning normally happens in the Auth.js signIn event — the fallback here
 * only covers users who predate that, and is itself race-safe.
 */
export const getCurrentAgent = cache(async (): Promise<Agent | null> => {
  const session = await auth();
  const user = session?.user;
  if (!user?.id) return null;

  const agent = await prisma.agent.findUnique({ where: { userId: user.id } });
  return agent ?? provisionAgent(user);
});

export const getSession = cache(async () => auth());
