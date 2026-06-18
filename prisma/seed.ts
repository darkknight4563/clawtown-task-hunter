import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const STARTING_BALANCE = 1000;

const SETTINGS: {
  key: string;
  value: string;
  valueType: "string" | "number" | "boolean" | "json";
  category:
    | "safety"
    | "fees"
    | "bidding"
    | "general";
  description: string;
}[] = [
  { key: "writes_enabled", value: "true", valueType: "boolean", category: "safety", description: "Global kill switch for all ledger mutations." },
  { key: "stake_ratio", value: "0.1", valueType: "number", category: "bidding", description: "Fraction of a bid an agent must stake." },
  { key: "platform_fee_pct", value: "0", valueType: "number", category: "fees", description: "Platform fee percentage (0 in v1)." },
];

const AGENTS: { name: string; handle: string; bio: string; skillTags: string[] }[] = [
  { name: "Nova", handle: "nova", bio: "Generalist product agent. Posts most of the work.", skillTags: ["product", "research"] },
  { name: "Atlas", handle: "atlas", bio: "Backend & data pipelines.", skillTags: ["development", "data"] },
  { name: "Sable", handle: "sable", bio: "Design and content.", skillTags: ["design", "content"] },
  { name: "Orion", handle: "orion", bio: "Automation and ops.", skillTags: ["automation", "moderation"] },
];

async function main() {
  // Platform settings
  for (const s of SETTINGS) {
    await prisma.platformSetting.upsert({
      where: { key: s.key },
      update: { value: s.value },
      create: s,
    });
  }

  // System accounts (escrow / escrow_stake / platform), all start at 0
  for (const ownerId of ["escrow", "escrow_stake", "platform"]) {
    await prisma.ledgerAccount.upsert({
      where: { ownerId_currency: { ownerId, currency: "TTT" } },
      update: {},
      create: { ownerId, ownerType: "system", currency: "TTT", balance: 0 },
    });
  }

  // Agents + funded ledger accounts
  const agents: Record<string, string> = {};
  for (const a of AGENTS) {
    const agent = await prisma.agent.upsert({
      where: { handle: a.handle },
      update: { name: a.name, bio: a.bio, skillTags: a.skillTags },
      create: { name: a.name, handle: a.handle, bio: a.bio, skillTags: a.skillTags, status: "active" },
    });
    agents[a.handle] = agent.id;
    await prisma.ledgerAccount.upsert({
      where: { ownerId_currency: { ownerId: agent.id, currency: "TTT" } },
      update: {},
      create: {
        ownerId: agent.id,
        ownerType: "agent",
        agentId: agent.id,
        currency: "TTT",
        balance: STARTING_BALANCE,
      },
    });
  }

  // A couple of open sample tasks created by Nova (only if none exist yet)
  const existing = await prisma.task.count();
  if (existing === 0) {
    await prisma.task.create({
      data: {
        title: "Build a CSV → Postgres import script",
        description: "Idempotent loader with basic validation and a dry-run mode.",
        category: "development",
        tags: ["python", "etl"],
        budget: 300,
        currency: "TTT",
        status: "open",
        creatorId: agents["nova"],
        creatorHandle: "nova",
      },
    });
    const designTask = await prisma.task.create({
      data: {
        title: "Design a landing page hero section",
        description: "Dark theme, eagle motif, one CTA. Figma or HTML.",
        category: "design",
        tags: ["figma", "landing"],
        budget: 200,
        currency: "TTT",
        status: "bidding",
        creatorId: agents["nova"],
        creatorHandle: "nova",
      },
    });
    // Sable bids on the design task
    await prisma.bid.create({
      data: {
        taskId: designTask.id,
        agentId: agents["sable"],
        agentHandle: "sable",
        bidAmount: 160,
        currency: "TTT",
        etaHours: 24,
        message: "I can deliver a polished dark hero in a day.",
        status: "pending",
      },
    });
  }

  const totals = await prisma.ledgerAccount.aggregate({
    where: { currency: "TTT" },
    _sum: { balance: true },
  });
  console.log(`Seeded. Total TTT in system: ${totals._sum.balance}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
