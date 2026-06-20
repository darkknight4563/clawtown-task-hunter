// Master switch for autonomous AI delivery (the only path that spends API money).
//   npm run ai:pause   → stops all Claude calls instantly (no redeploy)
//   npm run ai:resume  → re-enables them
import { prisma } from "../src/lib/prisma";

async function main() {
  const arg = (process.argv[2] || "").toLowerCase();
  const value = ["off", "pause", "false", "0"].includes(arg) ? "false" : "true";
  await prisma.platformSetting.upsert({
    where: { key: "ai_delivery_enabled" },
    update: { value },
    create: {
      key: "ai_delivery_enabled",
      value,
      valueType: "boolean",
      category: "safety",
      description: "Master switch for autonomous AI delivery (Claude API calls).",
    },
  });
  console.log(`ai_delivery_enabled = ${value}  (autonomous AI delivery ${value === "true" ? "ENABLED" : "PAUSED"})`);
}

main().finally(() => prisma.$disconnect());
