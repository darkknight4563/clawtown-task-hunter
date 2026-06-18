import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      isAdmin: boolean;
      agentId: string | null;
      handle: string | null;
    } & DefaultSession["user"];
  }
}
