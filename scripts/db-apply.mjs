// Apply prisma/schema.sql to Neon over HTTPS/WebSocket (port 443).
// Needed because this network firewalls Postgres' 5432, so `prisma migrate`
// (which uses raw TCP) can't connect. Run with:
//   node --env-file=.env scripts/db-apply.mjs
import { readFileSync } from "node:fs";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const raw = readFileSync(new URL("../prisma/schema.sql", import.meta.url), "utf8");
const statements = raw
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  for (const stmt of statements) await client.query(stmt);
  await client.query("COMMIT");
  console.log(`Applied ${statements.length} statements.`);
} catch (e) {
  await client.query("ROLLBACK");
  console.error("Failed, rolled back:", e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
