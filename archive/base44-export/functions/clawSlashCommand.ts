/**
 * functions/clawSlashCommand.ts
 * Deno Deploy-safe: NO subprocesses, just enqueue + ACK.
 *
 * Requires env:
 * - SLACK_SIGNING_SECRET (optional but recommended)
 * - BASE44_APP_ID
 * - BASE44_SERVICE_TOKEN
 *
 * Expects EventOutbox entity supports:
 * - event_type: "SLACK_COMMAND_REQUEST"
 * - status: "pending" | "sent" | "failed"
 * - attempts: number
 * - idempotency_key: string
 * - payload: object (must store response_url, user_id, text, channel_id, trigger_id)
 */

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function verifySlack(secret: string, rawBody: string, ts: string, sig: string) {
  // 5 min replay window
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const base = `v0:${ts}:${rawBody}`;
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(base));
  const hex = "v0=" + [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");

  // constant-time compare
  if (hex.length !== sig.length) return false;
  let d = 0;
  for (let i = 0; i < hex.length; i++) d |= hex.charCodeAt(i) ^ sig.charCodeAt(i);
  return d === 0;
}

function makeApi(appId: string, tok: string) {
  const B = `https://base44.app/api/apps/${appId}`;
  const H = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };

  const norm = (d: unknown) => {
    const a = d as Record<string, unknown>;
    return Array.isArray(a) ? a : ((a?.records ?? a?.data ?? []) as unknown[]);
  };

  return {
    get: async (entity: string, q: Record<string, unknown> = {}) => {
      const u = new URL(`${B}/entities/${entity}`);
      if (Object.keys(q).length) u.searchParams.set("q", JSON.stringify(q));
      const res = await fetch(u.toString(), { headers: H });
      const data = await res.json().catch(() => ({}));
      return norm(data);
    },
    post: async (entity: string, body: unknown) => {
      const res = await fetch(`${B}/entities/${entity}`, {
        method: "POST",
        headers: H,
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      return (data as Record<string, unknown>).data ?? data;
    },
    patch: async (entity: string, id: string, body: unknown) => {
      const res = await fetch(`${B}/entities/${entity}/${id}`, {
        method: "PATCH",
        headers: H,
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      return (data as Record<string, unknown>).data ?? data;
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "GET") return new Response("ok", { status: 200 });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const rawBody = await req.text();

  // Slack signature (recommended)
  const secret = Deno.env.get("SLACK_SIGNING_SECRET") ?? "";
  if (secret) {
    const ts = req.headers.get("x-slack-request-timestamp") ?? "";
    const sig = req.headers.get("x-slack-signature") ?? "";
    const ok = await verifySlack(secret, rawBody, ts, sig);
    if (!ok) return new Response("Forbidden", { status: 403 });
  }

  // Parse x-www-form-urlencoded
  const f = new URLSearchParams(rawBody);
  const userId = f.get("user_id") ?? "";
  const channelId = f.get("channel_id") ?? "";
  const triggerId = f.get("trigger_id") ?? "";
  const responseUrl = f.get("response_url") ?? "";
  const text = (f.get("text") ?? "").trim();

  const cmd = (text.split(/\s+/)[0] ?? "help").toLowerCase();

  // Inline fast replies
  if (cmd === "ping") {
    return json({ response_type: "ephemeral", text: "📍 pong" }, 200);
  }
  if (cmd === "help" || cmd === "?") {
    return json({
      response_type: "ephemeral",
      text:
        "*ClawTown /claw commands*\n" +
        "`/claw ping`\n" +
        "`/claw status <task_id>`\n" +
        "`/claw deliver <task_id> <link-or-text>`\n" +
        "`/claw approve <task_id>`\n" +
        "`/claw dispute <task_id> <reason...>`\n" +
        "`/claw resolve <task_id> <cp>/<ap> [slash=true] [notes...]`\n",
    }, 200);
  }

  // Base44 auth
  const appId = Deno.env.get("BASE44_APP_ID") ?? "";
  const svcTok = Deno.env.get("BASE44_SERVICE_TOKEN") ?? "";
  if (!appId || !svcTok) {
    return json({ response_type: "ephemeral", text: "❌ Missing BASE44_APP_ID or BASE44_SERVICE_TOKEN in Base44 env." }, 200);
  }
  const api = makeApi(appId, svcTok);

  const idemKey = `slash_claw_${userId}_${triggerId || Date.now()}`;

  // Idempotency guard
  const dup = await api.get("EventOutbox", { idempotency_key: idemKey });
  if (dup.length) {
    return json({ response_type: "ephemeral", text: "⚠️ Already processed." }, 200);
  }

  // Enqueue command request
  await api.post("EventOutbox", {
    event_type: "SLACK_COMMAND_REQUEST",
    status: "pending",
    attempts: 0,
    idempotency_key: idemKey,
    is_test: false,
    recipient_id: userId,
    channel: "dm",
    payload: {
      user_id: userId,
      channel_id: channelId,
      trigger_id: triggerId,
      response_url: responseUrl,
      text,
      received_at: new Date().toISOString(),
    },
  });

  // ACK immediately (Slack 3s rule)
  return json({ response_type: "ephemeral", text: `✅ Got it: ${text || "(empty)"} (processing…)` }, 200);
});