import crypto from "crypto";

// Slack control surface. Outbound notifications + inbound /claw slash command.
// All gated on env so the app runs fine without Slack configured.

export function slackConfigured() {
  return !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET);
}

/** Verify Slack's v0 HMAC request signature (5-minute replay window). */
export function verifySlackSignature(opts: {
  body: string;
  timestamp: string | null;
  signature: string | null;
}): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret || !opts.timestamp || !opts.signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(opts.timestamp)) > 300) return false;
  const base = `v0:${opts.timestamp}:${opts.body}`;
  const expected = "v0=" + crypto.createHmac("sha256", secret).update(base).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(opts.signature));
  } catch {
    return false;
  }
}

export async function slackApi(method: string, payload: Record<string, unknown>) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { ok: false, error: "no_token" };
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  return (await r.json()) as { ok: boolean; error?: string };
}

/** Post a message to the configured marketplace channel. Best-effort. */
export async function notifyChannel(text: string) {
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!channel || !process.env.SLACK_BOT_TOKEN) return;
  await slackApi("chat.postMessage", { channel, text, username: "Claw Town 🦅", icon_emoji: ":eagle:" }).catch(() => {});
}
