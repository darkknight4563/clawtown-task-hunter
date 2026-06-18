import { useState, useEffect, useCallback } from "react";
import { EventOutbox, PlatformSetting, AuditLog } from "../api/entities";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function ageMinutes(dateStr) {
  if (!dateStr) return null;
  const ms = Date.now() - new Date(dateStr).getTime();
  return ms < 0 ? 0 : Math.round(ms / 60000);
}

function fmtAge(minutes, suffix = " ago") {
  if (minutes === null || minutes === undefined) return "—";
  if (minutes < 1) return `< 1 min${suffix}`;
  if (minutes < 60) return `${minutes} min${suffix}`;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return `${h}h ${m > 0 ? `${m}m ` : ""}${suffix}`.trim();
}

function fmtTs(dateStr) {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleString("en-GB", {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Health state machine
// Returns: { state, cause, label, reasons[] }
//
// cause tags (used verbatim in headline):
//   "Sweep stale" | "Backlog stale" | "Delivery failures" | "Dead letters" | null
//
// Priority order when multiple triggers fire: dead letters > delivery failures
//   > backlog stale > sweep stale  (worst first)
// ─────────────────────────────────────────────────────────────────────────────
function computeHealth({
  dispatchEnabled, lastSweepAge, sweepIntervalMinutes,
  pendingCount, oldestPendingAge, staleMinutes, threshold,
  lastSweepStatus, deadLetterTotal, lastFailedAge,
}) {
  if (dispatchEnabled === false || dispatchEnabled === "false")
    return { state: "halted", cause: null, label: "Halted by operator", reasons: ["dispatch_enabled = false"] };

  if (lastSweepAge === null)
    return { state: "unknown", cause: null, label: "Unknown — no sweep data", reasons: ["No sweep recorded yet"] };

  // Collect all active triggers, tagged by cause
  const triggers = [];   // { cause, reason }
  const maxAge = sweepIntervalMinutes * 2;

  if (deadLetterTotal > 0)
    triggers.push({ cause: "Dead letters",       reason: `${deadLetterTotal} dead-letter${deadLetterTotal > 1 ? "s" : ""} (max_attempts_reached)` });

  if (lastFailedAge !== null && lastFailedAge < 60)
    triggers.push({ cause: "Delivery failures",  reason: `Last failed send ${lastFailedAge}m ago` });

  if (pendingCount > threshold && oldestPendingAge >= staleMinutes)
    triggers.push({ cause: "Backlog stale",      reason: `${pendingCount} pending, oldest ${oldestPendingAge}m (alert at ${staleMinutes}m)` });

  if (lastSweepAge > maxAge)
    triggers.push({ cause: "Sweep stale",        reason: `Last sweep ${lastSweepAge}m ago (expected ≤ ${maxAge}m)` });

  if (lastSweepStatus === "halted" && (dispatchEnabled === "true" || dispatchEnabled === true))
    triggers.push({ cause: "Sweep stale",        reason: "Last recorded sweep status was halted" });

  if (triggers.length === 0)
    return { state: "ok", cause: null, label: "All systems operational", reasons: [] };

  // Primary cause = first (highest priority) trigger
  const primary = triggers[0];
  return {
    state:   "degraded",
    cause:   primary.cause,
    label:   `Degraded: ${primary.cause}`,
    reasons: triggers.map(t => t.reason),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Static style map — labels are now dynamic, pulled from computeHealth
// ─────────────────────────────────────────────────────────────────────────────
const HEALTH_STYLES = {
  ok:       { border: "border-emerald-500/30 bg-emerald-950/20",                         icon: "✅", text: "text-emerald-400" },
  degraded: { border: "border-yellow-500/30 bg-yellow-950/20",                           icon: "⚠️", text: "text-yellow-400"  },
  halted:   { border: "border-red-500/40 bg-red-950/25 ring-1 ring-red-500/20",          icon: "🛑", text: "text-red-400"     },
  unknown:  { border: "border-zinc-700/40 bg-zinc-900/20",                               icon: "❓", text: "text-zinc-400"    },
};

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, sub2, accent, large, mono = true }) {
  const borders = {
    green:  "border-emerald-500/30 bg-emerald-950/20",
    yellow: "border-yellow-500/30 bg-yellow-950/20",
    red:    "border-red-500/40 bg-red-950/25",
    blue:   "border-blue-500/30 bg-blue-950/20",
    gray:   "border-zinc-700/40 bg-zinc-900/20",
    purple: "border-purple-500/30 bg-purple-950/20",
  };
  const values = {
    green: "text-emerald-400", yellow: "text-yellow-400", red: "text-red-400",
    blue: "text-blue-400", gray: "text-zinc-300", purple: "text-purple-400",
  };
  return (
    <div className={`rounded-xl border p-4 flex flex-col gap-1 ${borders[accent] || borders.gray}`}>
      <span className="text-xs text-zinc-500 uppercase tracking-widest leading-tight">{label}</span>
      <span className={`${mono ? "font-mono" : ""} font-bold leading-tight ${large ? "text-2xl" : "text-lg"} ${values[accent] || values.gray}`}>
        {value ?? "—"}
      </span>
      {sub  && <span className="text-xs text-zinc-500 leading-snug">{sub}</span>}
      {sub2 && <span className="text-xs text-zinc-600 leading-snug">{sub2}</span>}
    </div>
  );
}

function KillSwitch({ label, description, settingKey, value, id, onToggle, saving }) {
  const enabled = value === true || value === "true";
  return (
    <div className={`rounded-xl border p-4 flex flex-col gap-2 transition-all
      ${enabled ? "border-emerald-500/30 bg-emerald-950/20"
                : "border-red-500/40 bg-red-950/25 ring-1 ring-red-500/20"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full shrink-0 ${enabled ? "bg-emerald-400" : "bg-red-400 animate-pulse"}`} />
            <span className="font-semibold text-zinc-100 text-sm truncate">{label}</span>
          </div>
          <p className="text-xs text-zinc-500 mt-1 leading-relaxed">{description}</p>
          <code className="text-xs text-zinc-700 mt-0.5 block">{settingKey}</code>
        </div>
        <button
          onClick={() => onToggle(id, settingKey, !enabled)}
          disabled={saving === settingKey}
          className={`shrink-0 relative inline-flex h-6 w-11 items-center rounded-full
            transition-colors focus:outline-none disabled:opacity-50 cursor-pointer
            ${enabled ? "bg-emerald-600" : "bg-red-600"}`}>
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform
            ${enabled ? "translate-x-6" : "translate-x-1"}`} />
        </button>
      </div>
      {!enabled && (
        <div className="text-xs font-medium text-red-300 bg-red-950/60 rounded-lg px-3 py-1.5 border border-red-500/20">
          ⚠️ DISABLED — this system is halted
        </div>
      )}
    </div>
  );
}

const KILL_META = {
  dispatch_enabled:   { label: "EventOutbox Dispatcher",  description: "Master switch for the Slack dispatch sweep. Disabling halts all outbound Slack within 5 min." },
  auto_bid_enabled:   { label: "Auto-Bidding",            description: "Stop all automatic bids on new tasks. Manual bids still work." },
  auto_award_enabled: { label: "Auto-Award",              description: "Require manual AWARD commands. Disabling this prevents any automated task awarding." },
  writes_enabled:     { label: "Writes / Mutations",      description: "Freeze all ledger mutations (award, payout, escrow). Reads and status remain live. Last-resort integrity lever." },
};

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────
const SWEEP_INTERVAL_MINUTES = 5;

export default function SystemStatus() {
  const [loading,   setLoading]   = useState(true);
  const [refreshed, setRefreshed] = useState(null);
  const [saving,    setSaving]    = useState(null);
  const [error,     setError]     = useState(null);

  // Outbox metrics
  const [pendingNow,       setPendingNow]       = useState(null);
  const [pendingHourAgo,   setPendingHourAgo]   = useState(null);
  const [oldestPendingAge, setOldestPendingAge] = useState(null);
  const [oldestPendingTs,  setOldestPendingTs]  = useState(null);
  const [deadLetterTotal,  setDeadLetterTotal]  = useState(null);
  const [deadLetter24h,    setDeadLetter24h]    = useState(null);

  // Sweep metrics
  const [lastSweepTs,     setLastSweepTs]     = useState(null);
  const [lastSweepStatus, setLastSweepStatus] = useState(null);
  const [lastSentTs,      setLastSentTs]      = useState(null);
  const [lastFailedTs,    setLastFailedTs]    = useState(null);
  const [lastVerifiedAt,  setLastVerifiedAt]  = useState(null);
  const [channelVersion,  setChannelVersion]  = useState(null);

  // Settings
  const [threshold,       setThreshold]       = useState(10);
  const [staleMinutes,    setStaleMinutes]     = useState(30);
  const [killSwitches,    setKillSwitches]     = useState([]);
  const [dispatchEnabled, setDispatchEnabled]  = useState("true");
  const [writesEnabled,   setWritesEnabled]    = useState("true");

  // Heal events
  const [healEvents, setHealEvents] = useState([]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [pending, allOutbox, settings, sweepLogs, healLogs] = await Promise.all([
        EventOutbox.filter({ status: "pending" }),
        EventOutbox.filter({ status: "failed" }),
        PlatformSetting.list(),
        AuditLog.filter({ run_type: "outbox_dispatch" }),
        AuditLog.filter({ run_type: "channel_self_heal" }),
      ]);

      // ── Outbox ───────────────────────────────────────────────────────────
      setPendingNow(pending.length);
      if (pending.length > 0) {
        const sorted = [...pending].sort((a, b) => new Date(a.created_date) - new Date(b.created_date));
        setOldestPendingTs(sorted[0].created_date);
        setOldestPendingAge(ageMinutes(sorted[0].created_date));
      } else {
        setOldestPendingTs(null);
        setOldestPendingAge(null);
      }

      const deadAll = allOutbox.filter(r => r.error === "max_attempts_reached");
      setDeadLetterTotal(deadAll.length);
      const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
      setDeadLetter24h(deadAll.filter(r => new Date(r.created_date).getTime() > cutoff24h).length);

      // Backlog 1h-ago proxy
      const oneHourAgo   = Date.now() - 60 * 60 * 1000;
      const sortedSweeps = [...sweepLogs].sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
      const sweepHourAgo = sortedSweeps.find(s => new Date(s.created_date).getTime() <= oneHourAgo);
      if (sweepHourAgo?.raw_payload) {
        const p = sweepHourAgo.raw_payload;
        setPendingHourAgo(p.processed != null ? `${p.processed} processed, ${p.sent} sent` : null);
      } else {
        setPendingHourAgo(null);
      }

      // ── Sweep logs ───────────────────────────────────────────────────────
      if (sortedSweeps.length > 0) {
        const latest = sortedSweeps[0];
        setLastSweepTs(latest.created_date);
        setLastSweepStatus(latest.status);
      }

      // ── Platform settings ────────────────────────────────────────────────
      const byKey = {};
      settings.forEach(s => { byKey[s.key] = s; });

      setLastVerifiedAt(byKey["slack_channel_last_verified_at"]?.value || null);
      setChannelVersion(byKey["slack_channel_version"]?.value ?? null);
      setThreshold(parseFloat(byKey["outbox_pending_alert_threshold"]?.value ?? 10));
      setStaleMinutes(parseFloat(byKey["outbox_pending_stale_minutes"]?.value ?? 30));
      setDispatchEnabled(byKey["dispatch_enabled"]?.value ?? "true");
      setWritesEnabled(byKey["writes_enabled"]?.value ?? "true");
      setLastSentTs(byKey["last_successful_send_at"]?.value || null);
      setLastFailedTs(byKey["last_failed_send_at"]?.value || null);

      // Kill switches
      const ksKeys = ["dispatch_enabled", "auto_bid_enabled", "auto_award_enabled", "writes_enabled"];
      setKillSwitches(ksKeys.map(key => ({
        key,
        id:    byKey[key]?.id || null,
        value: byKey[key]?.value ?? "true",
        ...KILL_META[key],
      })));

      // Heal events (most recent 5)
      setHealEvents(
        [...healLogs]
          .sort((a, b) => new Date(b.created_date) - new Date(a.created_date))
          .slice(0, 5)
      );

    } catch (e) {
      setError(e.message || "Failed to load status data");
    } finally {
      setLoading(false);
      setRefreshed(new Date());
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [load]);

  const handleToggle = async (id, key, newValue) => {
    setSaving(key);
    try {
      if (id) {
        await PlatformSetting.update(id, { value: String(newValue) });
      } else {
        await PlatformSetting.create({
          key, value: String(newValue), value_type: "boolean",
          category: "kill_switch", description: KILL_META[key]?.description || "",
        });
      }
      await load();
    } catch (e) {
      setError(`Failed to update ${key}: ${e.message}`);
    } finally {
      setSaving(null);
    }
  };

  // ── Derived ───────────────────────────────────────────────────────────────
  const lastSweepAge  = ageMinutes(lastSweepTs);
  const lastFailedAge = ageMinutes(lastFailedTs);
  const lastSentAge   = ageMinutes(lastSentTs);
  const verifiedAge   = ageMinutes(lastVerifiedAt);

  const health = computeHealth({
    dispatchEnabled,
    lastSweepAge,
    sweepIntervalMinutes: SWEEP_INTERVAL_MINUTES,
    pendingCount:     pendingNow   ?? 0,
    oldestPendingAge: oldestPendingAge ?? 0,
    staleMinutes,
    threshold,
    lastSweepStatus,
    deadLetterTotal:  deadLetterTotal ?? 0,
    lastFailedAge,
  });

  const hs           = HEALTH_STYLES[health.state];
  const writesFrozen = writesEnabled === false || writesEnabled === "false";
  const anyKillActive = killSwitches.some(k => k.value === false || k.value === "false");

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans">

      {/* Header */}
      <div className="border-b border-zinc-800 bg-zinc-900/80 sticky top-0 z-10 backdrop-blur">
        <div className="max-w-5xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-lg">🦅</span>
            <div>
              <h1 className="font-bold text-base leading-tight">ClawTown System Status</h1>
              <p className="text-xs text-zinc-500">Marketplace health &amp; controls</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {refreshed && (
              <span className="text-xs text-zinc-600 hidden sm:block">
                Updated {fmtTs(refreshed.toISOString())}
              </span>
            )}
            <button
              onClick={load}
              disabled={loading}
              className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700
                border border-zinc-700 text-zinc-300 transition disabled:opacity-50 cursor-pointer">
              {loading ? "…" : "↺ Refresh"}
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-6 space-y-6">

        {error && (
          <div className="rounded-xl border border-red-500/40 bg-red-950/30 px-4 py-3 text-sm text-red-300">
            ⚠️ {error}
          </div>
        )}

        {/* ── Writes Frozen banner — shown independently of health state ── */}
        {writesFrozen && (
          <div className="rounded-xl border border-orange-500/40 bg-orange-950/25 ring-1 ring-orange-500/20 px-5 py-3 flex items-center gap-3">
            <span className="text-xl shrink-0">🧊</span>
            <div>
              <p className="font-semibold text-sm text-orange-300">Writes Frozen</p>
              <p className="text-xs text-orange-400/70 mt-0.5">
                <code className="text-orange-300/80">writes_enabled = false</code> — all ledger mutations
                (award, payout, escrow) are blocked. Reads and status are live.
                Toggle the kill switch below to resume.
              </p>
            </div>
          </div>
        )}

        {/* ── Health banner ── */}
        <div className={`rounded-xl border px-5 py-4 ${hs.border}`}>
          <div className="flex items-start gap-4">
            <span className="text-2xl mt-0.5 shrink-0">{hs.icon}</span>
            <div className="flex-1 min-w-0">
              <p className={`font-semibold text-sm ${hs.text}`}>{health.label}</p>
              {health.reasons.length > 0
                ? health.reasons.map((r, i) => (
                    <p key={i} className="text-xs text-zinc-400 mt-0.5 leading-snug">• {r}</p>
                  ))
                : <p className="text-xs text-zinc-500 mt-0.5">Dispatcher running, queue clear, channels verified</p>
              }
            </div>
            <div className="text-right shrink-0">
              <span className={`font-mono font-bold text-xs uppercase tracking-wider px-2 py-1 rounded-md
                ${health.state === "ok"       ? "bg-emerald-900/60 text-emerald-400"
                : health.state === "degraded" ? "bg-yellow-900/60 text-yellow-400"
                : health.state === "halted"   ? "bg-red-900/60 text-red-400"
                                              : "bg-zinc-800 text-zinc-400"}`}>
                {health.state}
              </span>
              <p className="text-xs text-zinc-600 mt-1">auto-refresh 60s</p>
            </div>
          </div>
        </div>

        {/* ── Outbox metrics ── */}
        <section>
          <SectionHeader icon="📬" title="EventOutbox" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              label="Pending now"
              value={pendingNow ?? "…"}
              sub={`threshold: ${threshold}`}
              sub2={pendingNow > 0 && oldestPendingTs ? `oldest: ${fmtTs(oldestPendingTs)}` : undefined}
              accent={
                pendingNow === null ? "gray"
                : pendingNow === 0 ? "green"
                : oldestPendingAge >= staleMinutes ? "red"
                : "yellow"
              }
              large
            />
            <StatCard
              label="Oldest pending"
              value={oldestPendingAge !== null ? fmtAge(oldestPendingAge, "") : "—"}
              sub={oldestPendingAge === null ? "queue clear" : `${oldestPendingAge}m (alert at ${staleMinutes}m)`}
              accent={
                oldestPendingAge === null ? "green"
                : oldestPendingAge >= staleMinutes ? "red"
                : oldestPendingAge >= 15 ? "yellow"
                : "green"
              }
            />
            <StatCard
              label="Dead letters (total)"
              value={deadLetterTotal ?? "…"}
              sub={`${deadLetter24h ?? "—"} in last 24h`}
              accent={deadLetterTotal > 0 ? "red" : "green"}
            />
            <StatCard
              label="Backlog 1h ago"
              value="—"
              sub={pendingHourAgo ?? "no sweep in last 1h"}
              accent="gray"
            />
          </div>
        </section>

        {/* ── Sweep & send timeline ── */}
        <section>
          <SectionHeader icon="🔁" title="Dispatcher Timeline" />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatCard
              label="Last sweep"
              value={lastSweepAge !== null ? fmtAge(lastSweepAge, "") : "—"}
              sub={lastSweepTs ? fmtTs(lastSweepTs) : "no sweep recorded"}
              sub2={lastSweepStatus ? `status: ${lastSweepStatus}` : undefined}
              accent={
                lastSweepAge === null ? "gray"
                : lastSweepAge > SWEEP_INTERVAL_MINUTES * 2 ? "red"
                : lastSweepAge > SWEEP_INTERVAL_MINUTES ? "yellow"
                : "green"
              }
            />
            <StatCard
              label="Last successful send"
              value={lastSentAge !== null ? fmtAge(lastSentAge, "") : "—"}
              sub={lastSentTs ? fmtTs(lastSentTs) : "no successful sends yet"}
              accent={lastSentAge === null ? "gray" : lastSentAge > 60 ? "yellow" : "green"}
            />
            <StatCard
              label="Last failed send"
              value={lastFailedAge !== null ? fmtAge(lastFailedAge, "") : "—"}
              sub={lastFailedTs ? fmtTs(lastFailedTs) : "no failures recorded"}
              accent={
                lastFailedAge === null ? "green"
                : lastFailedAge < 15 ? "red"
                : lastFailedAge < 60 ? "yellow"
                : "gray"
              }
            />
          </div>
        </section>

        {/* ── Slack routing health ── */}
        <section>
          <SectionHeader icon="📡" title="Slack Channel Routing" />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
            <StatCard
              label="Channels verified"
              value={verifiedAge !== null ? fmtAge(verifiedAge, "") : "—"}
              sub={lastVerifiedAt ? fmtTs(lastVerifiedAt) : "never verified"}
              accent={verifiedAge === null ? "yellow" : verifiedAge > 1440 ? "yellow" : "green"}
            />
            <StatCard
              label="Channel version"
              value={channelVersion ?? "—"}
              sub={
                channelVersion == null ? "unknown"
                : channelVersion == 1  ? "no heals yet"
                : `healed ${Number(channelVersion) - 1}×`
              }
              accent={channelVersion > 1 ? "yellow" : "green"}
            />
            <StatCard
              label="Self-heals logged"
              value={healEvents.length > 0 ? healEvents.length : "0"}
              sub={healEvents.length > 0 ? `latest: ${fmtTs(healEvents[0]?.created_date)}` : "no heals recorded"}
              accent={healEvents.length > 0 ? "yellow" : "green"}
            />
          </div>

          <ChannelTable />

          {healEvents.length > 0 && (
            <div className="mt-3 rounded-xl border border-yellow-500/20 bg-yellow-950/10 overflow-hidden">
              <div className="px-4 py-2 border-b border-yellow-500/20">
                <span className="text-xs font-semibold text-yellow-400 uppercase tracking-widest">Recent Heal Events</span>
              </div>
              <div className="divide-y divide-zinc-800/50">
                {healEvents.map(e => (
                  <div key={e.id} className="px-4 py-2.5 flex items-start gap-3">
                    <span className="text-yellow-400 text-sm shrink-0 mt-0.5">⚡</span>
                    <div className="min-w-0">
                      <p className="text-xs text-zinc-300 leading-snug">{e.summary || "Channel self-heal"}</p>
                      <p className="text-xs text-zinc-600 mt-0.5">{fmtTs(e.created_date)} · {fmtAge(ageMinutes(e.created_date))}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* ── Kill switches ── */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <SectionHeader icon="🛑" title="Kill Switches" noMargin />
            {anyKillActive && (
              <span className="text-xs font-medium text-red-400 bg-red-950/50 px-2 py-1 rounded-full border border-red-500/30">
                {killSwitches.filter(k => k.value === false || k.value === "false").length} disabled
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {killSwitches.length === 0
              ? [1,2,3,4].map(i => (
                  <div key={i} className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 animate-pulse h-24" />
                ))
              : killSwitches.map(ks => (
                  <KillSwitch
                    key={ks.key}
                    settingKey={ks.key}
                    label={ks.label}
                    description={ks.description}
                    value={ks.value}
                    id={ks.id}
                    onToggle={handleToggle}
                    saving={saving}
                  />
                ))
            }
          </div>

          <p className="text-xs text-zinc-600 mt-3 leading-relaxed">
            Toggles take effect on the next automation run (~5 min).{" "}
            <code className="text-zinc-500">dispatch_enabled=false</code> halts all Slack posting.{" "}
            <code className="text-zinc-500">writes_enabled=false</code> freezes ledger mutations only.
          </p>
        </section>

      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section header
// ─────────────────────────────────────────────────────────────────────────────
function SectionHeader({ icon, title, noMargin }) {
  return (
    <h2 className={`text-xs uppercase tracking-widest text-zinc-500 flex items-center gap-1.5 ${noMargin ? "" : "mb-3"}`}>
      <span>{icon}</span><span>{title}</span>
    </h2>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel routing table
// ─────────────────────────────────────────────────────────────────────────────
function ChannelTable() {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    PlatformSetting.filter({ category: "slack" }).then(settings => {
      const byKey = {};
      settings.forEach(s => { byKey[s.key] = s.value; });
      setRows([
        { slot: "HUNTERS", id: byKey["slack_channel_hunters_id"] || null, name: byKey["slack_channel_hunters_name"] || "clawtown-task-hunters" },
        { slot: "AUDIT",   id: byKey["slack_channel_audit_id"]   || null, name: byKey["slack_channel_audit_name"]   || "clawtown-audit"        },
        { slot: "ALERTS",  id: byKey["slack_channel_alerts_id"]  || null, name: byKey["slack_channel_alerts_name"]  || "clawtown-alerts"       },
      ]);
    }).catch(() => setRows([]));
  }, []);

  return (
    <div className="rounded-xl border border-zinc-800 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 bg-zinc-900/60">
            <th className="text-left px-4 py-2 text-xs text-zinc-500 font-medium w-24">Slot</th>
            <th className="text-left px-4 py-2 text-xs text-zinc-500 font-medium">Channel</th>
            <th className="text-left px-4 py-2 text-xs text-zinc-500 font-medium hidden sm:table-cell">ID</th>
            <th className="text-left px-4 py-2 text-xs text-zinc-500 font-medium w-20">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows === null
            ? [1,2,3].map(i => (
                <tr key={i} className="border-b border-zinc-800/50">
                  <td colSpan={4} className="px-4 py-3">
                    <div className="h-4 bg-zinc-800 rounded animate-pulse w-48" />
                  </td>
                </tr>
              ))
            : rows.map((r, i) => (
                <tr key={r.slot} className={i < rows.length - 1 ? "border-b border-zinc-800/40" : ""}>
                  <td className="px-4 py-2.5">
                    <span className="font-mono text-xs font-bold text-zinc-400">{r.slot}</span>
                  </td>
                  <td className="px-4 py-2.5 text-zinc-300 text-sm">#{r.name}</td>
                  <td className="px-4 py-2.5 hidden sm:table-cell">
                    <code className="text-xs text-zinc-500 bg-zinc-800/50 px-2 py-0.5 rounded">
                      {r.id || "missing"}
                    </code>
                  </td>
                  <td className="px-4 py-2.5">
                    {r.id
                      ? <span className="text-xs text-emerald-400 flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />OK</span>
                      : <span className="text-xs text-red-400 flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse shrink-0" />Missing</span>
                    }
                  </td>
                </tr>
              ))
          }
        </tbody>
      </table>
      <div className="px-4 py-2 border-t border-zinc-800/50 bg-zinc-900/30">
        <p className="text-xs text-zinc-600">IDs loaded from PlatformSetting at runtime. Dispatcher self-heals missing IDs by name lookup and bumps channel version.</p>
      </div>
    </div>
  );
}
