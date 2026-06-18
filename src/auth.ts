import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { provisionAgent } from "@/lib/agents";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: [GitHub],
  session: { strategy: "database" },
  trustHost: true,
  events: {
    // Provision + fund the marketplace Agent once, off the render path.
    async signIn({ user }) {
      if (user?.id) await provisionAgent({ id: user.id, name: user.name, email: user.email, image: user.image });
    },
  },
  callbacks: {
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
        // Surface admin + linked agent so the UI can gate actions.
        const u = await prisma.user.findUnique({
          where: { id: user.id },
          select: { isAdmin: true, agent: { select: { id: true, handle: true } } },
        });
        session.user.isAdmin = u?.isAdmin ?? false;
        session.user.agentId = u?.agent?.id ?? null;
        session.user.handle = u?.agent?.handle ?? null;
      }
      return session;
    },
  },
});
