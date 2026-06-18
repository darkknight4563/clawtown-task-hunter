/**
 * dispatch_slack_event  v7
 *
 * New in v7:
 *   - Stamps slack_channel_last_verified_at on every clean sweep
 *   - Increments slack_channel_version whenever any channel ID is healed
 *   - Stale-outbox invariant: if pending EventOutbox > threshold AND oldest > stale_minutes → INVARIANT_FAIL alert
 *     PlatformSetting keys: outbox_pending_alert_threshold (default 10), outbox_pending_stale_minutes (default 30)
 *
 * Channel IDs loaded at runtime from PlatformSetting.
 * Self-healing: channel_not_found → resolve by name, save ID, bump version, retry (no attempt increment).
 *
 * is_test:
 *   - is_test=true → [TEST] prefix, _test idempotency suffix
 *   - Alert events always go to ALERTS regardless of test_channel_override
 */

'use strict';

// ── REST helpers ──────────────────────────────────────────────────────────────
const API_BASE    = () => `${process.env.VITE_BASE44_BACKEND_URL || 'https://base44.app'}/api/apps/${process.env.VITE_BASE44_APP_ID || process.env.BASE44_APP_ID}`;
const AUTH_HEADER = () => ({ 'Authorization': `Bearer ${process.env.BASE44_SERVICE_TOKEN}`, 'Content-Type': 'application/json' });

async function apiGet(entity, query = {}) {
  const url = new URL(`${API_BASE()}/entities/${entity}`);
  if (Object.keys(query).length) url.searchParams.set('q', JSON.stringify(query));
  const r = await fetch(url.toString(), { headers: AUTH_HEADER() });
  const d = await r.json();
  return Array.isArray(d) ? d : (d.records || d.data || []);
}

async function apiPost(entity, body) {
  const r = await fetch(`${API_BASE()}/entities/${entity}`, {
    method: 'POST', headers: AUTH_HEADER(), body: JSON.stringify(body),
  });
  return (await r.json()).data || {};
}

async function apiPut(entity, id, body) {
  const r = await fetch(`${API_BASE()}/entities/${entity}/${id}`, {
    method: 'PUT', headers: AUTH_HEADER(), body: JSON.stringify(body),
  });
  return (await r.json()).data || {};
}

// ── Slack helpers ─────────────────────────────────────────────────────────────
async function slackAPI(endpoint, body, token) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(`https://slack.com/api/${endpoint}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: ctrl.signal,
    });
    clearTimeout(t);
    return r.json();
  } catch (e) {
    clearTimeout(t);
    throw e.name === 'AbortError' ? new Error(`Slack ${endpoint} timeout`) : e;
  }
}

async function slackPost(channelId, text, token) {
  return slackAPI('chat.postMessage', {
    channel: channelId, text, username: 'ClawTown Task Hunter', icon_emoji: ':eagle:',
  }, token);
}

async function slackDM(userId, text, token) {
  const d = await slackAPI('conversations.open', { users: userId }, token);
  if (!d.ok) return { ok: false, error: d.error };
  return slackPost(d.channel.id, text, token);
}

async function resolveChannelByName(name, token) {
  let cursor;
  do {
    const params = { types: 'public_channel,private_channel', limit: 200 };
    if (cursor) params.cursor = cursor;
    const r = await slackAPI('conversations.list', params, token);
    if (!r.ok) return null;
    const match = (r.channels || []).find(c => c.name === name);
    if (match) return match.id;
    cursor = r.response_metadata?.next_cursor;
  } while (cursor);
  return null;
}

// ── Settings loader ───────────────────────────────────────────────────────────
async function loadSettings() {
  const rows = await apiGet('PlatformSetting');
  const map  = {};
  for (const row of rows) {
    const d = row.data || row;
    let v = d.value;
    if (d.value_type === 'number')  v = parseFloat(v);
    if (d.value_type === 'boolean') v = v === 'true';
    if (d.value_type === 'json')    v = JSON.parse(v);
    map[d.key] = { id: row.id || d.id, value: v };
  }
  return map;
}

async function saveSetting(settings, key, value, valueType = 'string') {
  const existing = settings[key];
  const strVal   = String(value);
  if (existing?.id) {
    await apiPut('PlatformSetting', existing.id, { value: strVal });
  } else {
    await apiPost('PlatformSetting', { key, value: strVal, value_type: valueType, category: 'slack' });
  }
  if (!settings[key]) settings[key] = {};
  settings[key].value = value;
}

async function bumpChannelVersion(settings) {
  const current = parseFloat(settings['slack_channel_version']?.value || '1');
  await saveSetting(settings, 'slack_channel_version', current + 1, 'number');
}

async function stampVerifiedAt(settings) {
  await saveSetting(settings, 'slack_channel_last_verified_at', new Date().toISOString(), 'string');
}

// ── Channel builder with self-healing ────────────────────────────────────────
const CHANNEL_DEFS = [
  { slot: 'HUNTERS', idKey: 'slack_channel_hunters_id', nameKey: 'slack_channel_hunters_name', fallback: 'clawtown-task-hunters' },
  { slot: 'AUDIT',   idKey: 'slack_channel_audit_id',   nameKey: 'slack_channel_audit_name',   fallback: 'clawtown-audit'        },
  { slot: 'ALERTS',  idKey: 'slack_channel_alerts_id',  nameKey: 'slack_channel_alerts_name',  fallback: 'clawtown-alerts'       },
];

async function buildChannels(settings, token) {
  const channels = {};
  const healed   = [];
  for (const def of CHANNEL_DEFS) {
    let id = settings[def.idKey]?.value;
    if (!id) {
      const name     = settings[def.nameKey]?.value || def.fallback;
      const resolved = await resolveChannelByName(name, token);
      if (resolved) {
        id = resolved;
        await saveSetting(settings, def.idKey, id);
        healed.push({ slot: def.slot, id, name });
      }
    }
    channels[def.slot] = id || null;
  }
  if (healed.length > 0) {
    await bumpChannelVersion(settings);
    await stampVerifiedAt(settings);
  }
  return { channels, healed };
}

// Per-record self-heal (channel_not_found during dispatch)
async function selfHealChannel(slot, settings, token) {
  const def      = CHANNEL_DEFS.find(d => d.slot === slot);
  if (!def) return null;
  const name     = settings[def.nameKey]?.value || def.fallback;
  const resolved = await resolveChannelByName(name, token);
  if (resolved) {
    await saveSetting(settings, def.idKey, resolved);
    await bumpChannelVersion(settings);
    await stampVerifiedAt(settings);
    settings[def.idKey] = { ...(settings[def.idKey] || {}), value: resolved };
  }
  return resolved;
}

// ── Routing ───────────────────────────────────────────────────────────────────
function routeEvent(eventType) {
  const AUDIT_EVENTS    = ['ESCROW_LOCK','ESCROW_RELEASE','STAKE_LOCK','STAKE_RELEASE',
                           'STAKE_SLASH','LEDGER_TX','PAYOUT','REFUND','TASK_AWARDED'];
  const ALERT_EVENTS    = ['DISPUTE_OPENED','DEAD_LETTER','ERROR','SYSTEM_ALERT','BALANCE_LOW',
                           'INVARIANT_FAIL','AUTOMATION_ERROR','DUPLICATE_BID_DETECTED',
                           'NEGATIVE_BALANCE','SUSPICIOUS_ACTIVITY'];
  const DM_EVENTS       = ['CREATOR_DM','AGENT_DM','DM_SENT'];
  const HUNTERS_EVENTS  = ['MARKET_PULSE','NO_BID_RESCUE','NO_BID_RESCUE_SUMMARY','STALLED_CHASE','STALLED_CHASE_SUMMARY',
                           'TASK_CREATED','TASK_STATUS_CHANGED','BID_PLACED','TASK_COMPLETED','TASK_CANCELLED',
                           'DELIVERABLE_SUBMITTED','DELIVERABLE_APPROVED'];
  if (DM_EVENTS.includes(eventType))      return { slot: 'HUNTERS', isDM: true,  isAlert: false };
  if (ALERT_EVENTS.includes(eventType))   return { slot: 'ALERTS',  isDM: false, isAlert: true  };
  if (AUDIT_EVENTS.includes(eventType))   return { slot: 'AUDIT',   isDM: false, isAlert: false };
  if (HUNTERS_EVENTS.includes(eventType)) return { slot: 'HUNTERS', isDM: false, isAlert: false };
  return { slot: 'HUNTERS', isDM: false, isAlert: false };
}

function resolveChannel(record, routed, channels, settings) {
  if (routed.isDM)    return { channelId: null,             isDM: true  };
  if (routed.isAlert) return { channelId: channels['ALERTS'], isDM: false }; // always ALERTS, even for tests
  if (record.is_test && settings['test_channel_override']?.value)
    return { channelId: settings['test_channel_override'].value, isDM: false };
  return { channelId: channels[routed.slot], isDM: false };
}

// ── Formatting ────────────────────────────────────────────────────────────────
const EMOJI = {
  TASK_CREATED:'🧾', BID_PLACED:'🤖', TASK_AWARDED:'🏆', TASK_STATUS_CHANGED:'✅', PAYOUT:'💰', REFUND:'↩️',
  ESCROW_LOCK:'🏦', ESCROW_RELEASE:'💸', STAKE_LOCK:'🔒', STAKE_RELEASE:'🔓', STAKE_SLASH:'⚡',
  DISPUTE_OPENED:'⚠️', DELIVERABLE_SUBMITTED:'📦', DELIVERABLE_APPROVED:'✅',
  CREATOR_DM:'📬', AGENT_DM:'📬', DEAD_LETTER:'💀', PAYOUT:'💰', ERROR:'🚨', INVARIANT_FAIL:'🚨',
  MARKET_PULSE:'📈', NO_BID_RESCUE:'🆘', NO_BID_RESCUE_SUMMARY:'🆘', STALLED_CHASE:'⏳', STALLED_CHASE_SUMMARY:'⏳',
};

function formatMessage(record) {
  const { event_type, payload, reference_id, reference_type } = record;
  const p = payload || {};
  const e = EMOJI[event_type] || '📌';
  let body;
  switch (event_type) {
    case 'TASK_CREATED':
      body = `${e} *TASK_CREATED* | \`${reference_id}\`\n*${p.title||'Untitled'}*\nBudget: ${p.budget_ttt||'?'} TTT | Category: ${p.category||'unknown'} | Tags: ${(p.tags||[]).join(', ')}`;
      break;
    case 'BID_PLACED':
      body = `${e} *BID_PLACED* | Task \`${p.task_id||reference_id}\`\n${p.is_auto_bid?'🤖 Auto-bid':'Manual bid'} by *@${p.agent_handle}*: ${p.bid_amount} ${p.currency||'TTT'}, ETA ${p.eta_hours}h\n_"${p.title||''}"_`;
      break;
    case 'TASK_AWARDED':
      body = `${e} *TASK_AWARDED* | Task \`${p.task_id||reference_id}\`\nAwarded to *@${p.agent_handle}* | Bid: ${p.bid_amount} TTT | Budget locked: ${p.budget_ttt} TTT`;
      break;
    case 'ESCROW_LOCK':
      body = `${e} *ESCROW_LOCK* | Task \`${p.task_id||reference_id}\`\nAmount: ${p.amount} TTT locked from ${p.from_handle||'creator'}`;
      break;
    case 'ESCROW_RELEASE':
      body = `${e} *ESCROW_RELEASE* | Task \`${p.task_id||reference_id}\`\nPaid ${p.agent_payout} TTT to @${p.agent_handle}, refunded ${p.creator_refund} TTT to creator`;
      break;
    case 'STAKE_LOCK':
      body = `${e} *STAKE_LOCK* | Task \`${p.task_id||reference_id}\`\n@${p.agent_handle} locked ${p.amount} TTT stake`;
      break;
    case 'DISPUTE_OPENED':
      body = `${e} *DISPUTE_OPENED* | Task \`${p.task_id||reference_id}\`\nRaised by ${p.raised_by_type} \`${p.raised_by_id}\` | Reason: ${p.reason||'none'}`;
      break;
    case 'DEAD_LETTER':
      body = `${e} *DEAD_LETTER* | EventOutbox \`${reference_id}\`\nEvent: ${p.original_event_type||'?'} | Error: ${p.error||'unknown'} | Attempts: ${p.attempts||3}`;
      break;
    case 'INVARIANT_FAIL':
      if (p.invariant === 'stalled_task_max_pings_reached') {
        body = `${e} *INVARIANT_FAIL* | Task \`${(p.task_id||reference_id||'').slice(-8)}\` hit max pings\n*${p.title||'?'}* (${p.status||'?'}) — ${p.age_hours||'?'}h idle, ${p.pings_sent||0}/${p.max_pings||2} pings\nNeeds manual review or dispute.`;
      } else {
        body = `${e} *INVARIANT_FAIL* | ${p.invariant||'unknown'}\n${p.detail||JSON.stringify(p).slice(0,300)}`;
      }
      break;
    case 'CREATOR_DM': case 'AGENT_DM': case 'DM_SENT':
      body = record.message || p.message || `${e} *${event_type}* | \`${reference_id}\`\n${p.summary||JSON.stringify(p).slice(0,300)}`;
      break;
    case 'MARKET_PULSE': {
      const d = p.details || {};
      const lines = [
        `${e} *MARKET PULSE* | ${p.event_time ? p.event_time.slice(0,10) : 'today'}`,
        ``,
        `*Tasks (24h)*  created: ${d.tasks_created||0}  awarded: ${d.tasks_awarded||0}  completed: ${d.tasks_completed||0}`,
        `*Live*         open: ${d.tasks_open||0}  bidding: ${d.tasks_bidding||0}  in_progress: ${d.tasks_in_progress||0}`,
        `*Bids (24h)*   placed: ${d.bids_placed||0}`,
        `*Disputes*     opened: ${d.disputes_opened||0}  resolved: ${d.disputes_resolved||0}`,
        ``,
        `*Ledger (24h)*`,
        `  escrow locked: ${d.escrow_lock_count||0}× — ${d.escrow_lock_sum||0} TTT`,
        `  payouts:       ${d.payout_count||0}× — ${d.payout_sum||0} TTT`,
        `  refunds:       ${d.refund_count||0}× — ${d.refund_sum||0} TTT`,
        `  stakes locked: ${d.stake_lock_count||0}×  released: ${d.stake_release_count||0}×`,
        ``,
        `*Outbox (24h)* sent: ${d.outbox_sent||0}  failed: ${d.outbox_failed||0}  dead-letters: ${d.outbox_dead||0}`,
      ];
      if (p.top_agents && p.top_agents.length) {
        lines.push(``, `*Top agents*  ` + p.top_agents.map(a => `@${a.handle} (${a.bids_24h} bids)`).join('  '));
      }
      if (p.hot_tasks && p.hot_tasks.length) {
        lines.push(``, `*Hot tasks*`);
        p.hot_tasks.forEach(t => lines.push(`  • \`${t.id.slice(-8)}\` ${t.title} — ${t.bids} bids, ${t.budget} TTT`));
      }
      if (p.summary) lines.push(``, `_${p.summary}_`);
      body = lines.join('\n');
      break;
    }
    case 'NO_BID_RESCUE': {
      const agents = (p.top_agents||[]).map(a => `@${a.handle}`).join(', ') || '—';
      body = [
        `${e} *NO_BID_RESCUE* | Task \`${(reference_id||'').slice(-8)}\` — reminder #${p.reminder_number||1}`,
        `*${p.title||'Untitled'}*`,
        `Budget: ${p.budget||'?'} TTT | Age: ${p.age_minutes||'?'}m | Category: ${p.category||'?'}`,
        `Tags: ${(p.tags||[]).join(', ')||'—'}`,
        `Suggested agents: ${agents}`,
      ].join('\n');
      break;
    }
    case 'NO_BID_RESCUE_SUMMARY': {
      const rescued = p.tasks_rescued||0;
      const skipped = p.tasks_skipped||0;
      if (rescued === 0) {
        body = `${e} *NO_BID_RESCUE* | No tasks needed rescue this run.`;
      } else {
        const lines = [
          `${e} *NO_BID_RESCUE* | ${rescued} task${rescued!==1?'s':''} nudged, ${skipped} skipped`,
        ];
        (p.rescued_tasks||[]).forEach(t => {
          lines.push(`  • \`${t.id.slice(-8)}\` ${t.title} — ${t.budget} TTT, reminder #${t.reminder_number}`);
        });
        body = lines.join('\n');
      }
      break;
    }
    case 'TASK_STATUS_CHANGED': {
      const old_s  = p.old_status || '?';
      const new_s  = p.new_status || 'completed';
      const isComp = new_s === 'completed';
      body = [
        `${e} *TASK ${new_s.toUpperCase()}* | Task \`${(reference_id||'').slice(-8)}\``,
        `*${p.title||'Untitled'}*`,
        isComp
          ? `@${p.agent_handle} paid *${p.bid_amount} ${p.currency||'TTT'}* | Refund: ${p.refund_amount||0} ${p.currency||'TTT'} to creator | Stake released: ${p.stake_amount||0} ${p.currency||'TTT'}`
          : `${old_s} → ${new_s}${p.agent_handle ? ` | @${p.agent_handle}` : ''}`,
        p.summary ? `_${p.summary}_` : '',
      ].filter(Boolean).join('\n');
      break;
    }
    case 'PAYOUT': {
      body = `${e} *PAYOUT* | Task \`${(p.task_id||reference_id||'').slice(-8)}\`\n@${p.agent_handle} received *${p.amount} ${p.currency||'TTT'}*  |  TX \`${(p.tx_id||'?').slice(-8)}\``;
      break;
    }
    case 'REFUND': {
      body = `${e} *REFUND* | Task \`${(p.task_id||reference_id||'').slice(-8)}\`\n${p.creator_handle||'creator'} refunded *${p.amount} ${p.currency||'TTT'}*  |  TX \`${(p.tx_id||'?').slice(-8)}\``;
      break;
    }
    case 'MARKET_PULSE': {
      const d = p.details || {};
      const lines = [
        `${e} *MARKET PULSE* | ${p.event_time ? p.event_time.slice(0,10) : 'today'}`,
        ``,
        `*Tasks (24h)*  created: ${d.tasks_created||0}  awarded: ${d.tasks_awarded||0}  completed: ${d.tasks_completed||0}`,
        `*Live*         open: ${d.tasks_open||0}  bidding: ${d.tasks_bidding||0}  in_progress: ${d.tasks_in_progress||0}`,
        `*Bids (24h)*   placed: ${d.bids_placed||0}`,
        `*Disputes*     opened: ${d.disputes_opened||0}  resolved: ${d.disputes_resolved||0}`,
        ``,
        `*Ledger (24h)*`,
        `  escrow locked: ${d.escrow_lock_count||0}× — ${d.escrow_lock_sum||0} TTT`,
        `  payouts:       ${d.payout_count||0}× — ${d.payout_sum||0} TTT`,
        `  refunds:       ${d.refund_count||0}× — ${d.refund_sum||0} TTT`,
        `  stakes locked: ${d.stake_lock_count||0}×  released: ${d.stake_release_count||0}×`,
        ``,
        `*Outbox (24h)* sent: ${d.outbox_sent||0}  failed: ${d.outbox_failed||0}  dead-letters: ${d.outbox_dead||0}`,
      ];
      if (p.top_agents && p.top_agents.length) {
        lines.push(``, `*Top agents*  ` + p.top_agents.map(a => `@${a.handle} (${a.bids_24h} bids)`).join('  '));
      }
      if (p.hot_tasks && p.hot_tasks.length) {
        lines.push(``, `*Hot tasks*`);
        p.hot_tasks.forEach(t => lines.push(`  • \`${t.id.slice(-8)}\` ${t.title} — ${t.bids} bids, ${t.budget} TTT`));
      }
      if (p.summary) lines.push(``, `_${p.summary}_`);
      body = lines.join('\n');
      break;
    }
    case 'NO_BID_RESCUE': {
      const agents = (p.top_agents||[]).map(a => `@${a.handle}`).join(', ') || '—';
      body = [
        `${e} *NO_BID_RESCUE* | Task \`${(reference_id||'').slice(-8)}\` — reminder #${p.reminder_number||1}`,
        `*${p.title||'Untitled'}*`,
        `Budget: ${p.budget||'?'} TTT | Age: ${p.age_minutes||'?'}m | Category: ${p.category||'?'}`,
        `Tags: ${(p.tags||[]).join(', ')||'—'}`,
        `Suggested agents: ${agents}`,
      ].join('\n');
      break;
    }
    case 'NO_BID_RESCUE_SUMMARY': {
      const rescued = p.tasks_rescued||0;
      const skipped = p.tasks_skipped||0;
      if (rescued === 0) {
        body = `${e} *NO_BID_RESCUE* | No tasks needed rescue this run.`;
      } else {
        const lines = [
          `${e} *NO_BID_RESCUE* | ${rescued} task${rescued!==1?'s':''} nudged, ${skipped} skipped`,
        ];
        (p.rescued_tasks||[]).forEach(t => {
          lines.push(`  • \`${t.id.slice(-8)}\` ${t.title} — ${t.budget} TTT, reminder #${t.reminder_number}`);
        });
        body = lines.join('\n');
      }
      break;
    }
    case 'TASK_STATUS_CHANGED': {
      const old_s  = p.old_status || '?';
      const new_s  = p.new_status || 'completed';
      const isComp = new_s === 'completed';
      body = [
        `${e} *TASK ${new_s.toUpperCase()}* | Task \`${(reference_id||'').slice(-8)}\``,
        `*${p.title||'Untitled'}*`,
        isComp
          ? `@${p.agent_handle} paid *${p.bid_amount} ${p.currency||'TTT'}* | Refund: ${p.refund_amount||0} ${p.currency||'TTT'} to creator | Stake released: ${p.stake_amount||0} ${p.currency||'TTT'}`
          : `${old_s} → ${new_s}${p.agent_handle ? ` | @${p.agent_handle}` : ''}`,
        p.summary ? `_${p.summary}_` : '',
      ].filter(Boolean).join('\n');
      break;
    }
    case 'PAYOUT': {
      body = `${e} *PAYOUT* | Task \`${(p.task_id||reference_id||'').slice(-8)}\`\n@${p.agent_handle} received *${p.amount} ${p.currency||'TTT'}*  |  TX \`${(p.tx_id||'?').slice(-8)}\``;
      break;
    }
    case 'REFUND': {
      body = `${e} *REFUND* | Task \`${(p.task_id||reference_id||'').slice(-8)}\`\n${p.creator_handle||'creator'} refunded *${p.amount} ${p.currency||'TTT'}*  |  TX \`${(p.tx_id||'?').slice(-8)}\``;
      break;
    }
    case 'MARKET_PULSE': {
      const d = p.details || {};
      const lines = [
        `${e} *MARKET PULSE* | ${p.event_time ? p.event_time.slice(0,10) : 'today'}`,
        ``,
        `*Tasks (24h)*  created: ${d.tasks_created||0}  awarded: ${d.tasks_awarded||0}  completed: ${d.tasks_completed||0}`,
        `*Live*         open: ${d.tasks_open||0}  bidding: ${d.tasks_bidding||0}  in_progress: ${d.tasks_in_progress||0}`,
        `*Bids (24h)*   placed: ${d.bids_placed||0}`,
        `*Disputes*     opened: ${d.disputes_opened||0}  resolved: ${d.disputes_resolved||0}`,
        ``,
        `*Ledger (24h)*`,
        `  escrow locked: ${d.escrow_lock_count||0}× — ${d.escrow_lock_sum||0} TTT`,
        `  payouts:       ${d.payout_count||0}× — ${d.payout_sum||0} TTT`,
        `  refunds:       ${d.refund_count||0}× — ${d.refund_sum||0} TTT`,
        `  stakes locked: ${d.stake_lock_count||0}×  released: ${d.stake_release_count||0}×`,
        ``,
        `*Outbox (24h)* sent: ${d.outbox_sent||0}  failed: ${d.outbox_failed||0}  dead-letters: ${d.outbox_dead||0}`,
      ];
      if (p.top_agents && p.top_agents.length) {
        lines.push(``, `*Top agents*  ` + p.top_agents.map(a => `@${a.handle} (${a.bids_24h} bids)`).join('  '));
      }
      if (p.hot_tasks && p.hot_tasks.length) {
        lines.push(``, `*Hot tasks*`);
        p.hot_tasks.forEach(t => lines.push(`  • \`${t.id.slice(-8)}\` ${t.title} — ${t.bids} bids, ${t.budget} TTT`));
      }
      if (p.summary) lines.push(``, `_${p.summary}_`);
      body = lines.join('\n');
      break;
    }
    case 'NO_BID_RESCUE': {
      const agents = (p.top_agents||[]).map(a => `@${a.handle}`).join(', ') || '—';
      body = [
        `${e} *NO_BID_RESCUE* | Task \`${(reference_id||'').slice(-8)}\` — reminder #${p.reminder_number||1}`,
        `*${p.title||'Untitled'}*`,
        `Budget: ${p.budget||'?'} TTT | Age: ${p.age_minutes||'?'}m | Category: ${p.category||'?'}`,
        `Tags: ${(p.tags||[]).join(', ')||'—'}`,
        `Suggested agents: ${agents}`,
      ].join('\n');
      break;
    }
    case 'NO_BID_RESCUE_SUMMARY': {
      const rescued = p.tasks_rescued||0;
      const skipped = p.tasks_skipped||0;
      if (rescued === 0) {
        body = `${e} *NO_BID_RESCUE* | No tasks needed rescue this run.`;
      } else {
        const lines = [
          `${e} *NO_BID_RESCUE* | ${rescued} task${rescued!==1?'s':''} nudged, ${skipped} skipped`,
        ];
        (p.rescued_tasks||[]).forEach(t => {
          lines.push(`  • \`${t.id.slice(-8)}\` ${t.title} — ${t.budget} TTT, reminder #${t.reminder_number}`);
        });
        body = lines.join('\n');
      }
      break;
    }
    case 'STALLED_CHASE': {
      const icon = p.status_icon || (p.status === 'in_progress' ? '⏳' : '📦');
      body = [
        `${e} *STALLED_CHASE* | Task \`${(reference_id||'').slice(-8)}\` ${icon} ${p.status}`,
        `*${p.title||'Untitled'}*`,
        `No activity: ${p.age_hours||'?'}h | Ping ${p.pings_sent||0}/${p.max_pings||2}`,
        p.pings_sent >= p.max_pings ? `⚠️ *Max pings reached — manual review needed*` : `Next escalation at ping ${p.max_pings}`,
      ].filter(Boolean).join('\n');
      break;
    }
    case 'STALLED_CHASE_SUMMARY': {
      const chased = p.tasks_chased||0;
      const escalated = p.tasks_escalated||0;
      if (chased === 0 && escalated === 0) {
        body = `${e} *STALLED_CHASE* | No tasks needed chasing this run.`;
      } else {
        const lines = [
          `${e} *STALLED_CHASE* | ${chased} task${chased!==1?'s':''} chased${escalated>0?` | ${escalated} escalated to alerts`:''}`
        ];
        if (chased > 0) {
          lines.push(``, `*Chased*`);
          (p.chased_tasks||[]).forEach(t => {
            const icon = t.status === 'in_progress' ? '⏳' : '📦';
            lines.push(`  • \`${t.id.slice(-8)}\` ${icon} ${t.title} — ${t.age_hours}h, ping ${t.ping_num}/${t.max_pings}`);
          });
        }
        if (escalated > 0) {
          lines.push(``, `*Escalated (manual review needed)*`);
          (p.escalated_tasks||[]).forEach(t => {
            const icon = t.status === 'in_progress' ? '⏳' : '📦';
            lines.push(`  • \`${t.id.slice(-8)}\` ${icon} ${t.title} — ${t.age_hours}h, ping ${t.pings_sent} (max reached)`);
          });
        }
        body = lines.join('\n');
      }
      break;
    }
    default:
      body = `${e} *${event_type}* | ${reference_type||'ref'} \`${reference_id}\`\n${p.summary||JSON.stringify(p).slice(0,200)}`;
  }
  return record.is_test ? `[TEST] ${body}` : body;
}

function idempotencyKey(record) {
  const base = record.payload?.idempotency_key || `outbox_${record.id}`;
  return record.is_test ? `${base}_test` : base;
}

// ── Stale-outbox invariant ────────────────────────────────────────────────────
async function checkStaleOutboxInvariant(records, settings, channels, token) {
  const threshold    = settings['outbox_pending_alert_threshold']?.value ?? 10;
  const staleMinutes = settings['outbox_pending_stale_minutes']?.value   ?? 30;
  const staleMs      = staleMinutes * 60 * 1000;
  const now          = Date.now();

  // Filter to genuinely pending (not just fetched — still status=pending, no slack_ts)
  const stale = records.filter(row => {
    const r          = row.data || row;
    const createdAt  = new Date(r.created_date || 0).getTime();
    const hasSlackTs = r.metadata?.slack_ts;
    return !hasSlackTs && (now - createdAt) > staleMs;
  });

  if (stale.length <= threshold) return;  // all good

  const oldestAge = Math.round((now - Math.min(...stale.map(r => new Date((r.data||r).created_date||0).getTime()))) / 60000);
  const detail    = `${stale.length} pending records (threshold: ${threshold}), oldest ~${oldestAge} min. Sweep may be failing.`;

  console.error(`INVARIANT_FAIL: stale_outbox_backlog — ${detail}`);

  // Emit INVARIANT_FAIL to alerts channel
  if (channels['ALERTS']) {
    await slackPost(channels['ALERTS'],
      `🚨 *INVARIANT_FAIL* | stale_outbox_backlog\n${detail}`, token);
  }

  await apiPost('EventOutbox', {
    event_type:    'INVARIANT_FAIL',
    reference_id:  'system',
    reference_type:'system',
    channel:       'slack',
    status:        'pending',
    attempts:      0,
    payload: {
      invariant:    'stale_outbox_backlog',
      detail,
      stale_count:  stale.length,
      threshold,
      stale_minutes: staleMinutes,
      oldest_age_minutes: oldestAge,
      sample_ids:   stale.slice(0, 5).map(r => (r.data||r).id || r.id),
    },
  });

  await apiPost('AuditLog', {
    run_type:    'invariant_check',
    triggered_by:'dispatch:stale_outbox',
    summary:     `INVARIANT_FAIL stale_outbox_backlog: ${detail}`,
    status:      'error',
    errors:      [{ code: 'STALE_OUTBOX_BACKLOG', detail }],
    raw_payload: { stale_count: stale.length, threshold, oldest_age_minutes: oldestAge },
  });
}

// ── Main sweep ────────────────────────────────────────────────────────────────
async function main() {
  const runId     = `dispatch_${Date.now()}`;
  const startTime = Date.now();
  const token     = process.env.SLACKBOT_ACCESS_TOKEN;
  if (!token) { console.log(JSON.stringify({ ok: false, error: 'SLACKBOT_ACCESS_TOKEN not set' })); return; }

  const settings = await loadSettings();
  const { channels, healed } = await buildChannels(settings, token);

  // Notify and log any boot-time channel heals
  if (healed.length > 0) {
    const healMsg = `⚠️ *CHANNEL_HEALED* | ${healed.map(h=>`${h.slot}: ${h.name} → ${h.id}`).join(', ')} — re-resolved from name, saved. Version: ${settings['slack_channel_version']?.value}`;
    if (channels['ALERTS']) await slackPost(channels['ALERTS'], healMsg, token);
    await apiPost('AuditLog', {
      run_type:'channel_self_heal', triggered_by:'dispatch:boot',
      summary: healMsg, status:'ok',
      raw_payload:{ healed, run_id: runId, version: settings['slack_channel_version']?.value },
    });
  }

  // ── Kill switch: dispatch_enabled ───────────────────────────────────────────
  if (settings['dispatch_enabled']?.value === false || settings['dispatch_enabled']?.value === 'false') {
    console.log(JSON.stringify({ ok: true, halted: true, reason: 'dispatch_enabled=false', run_id: runId }));
    await apiPost('AuditLog', {
      run_type:    'outbox_dispatch',
      triggered_by:'automation:outbox_dispatcher',
      summary:     'Dispatch halted: dispatch_enabled=false (kill switch active).',
      status:      'halted',
      raw_payload: { run_id: runId, kill_switch: 'dispatch_enabled' },
    });
    return;
  }

  // Fetch all pending records
  const rows    = await apiGet('EventOutbox', { status: 'pending' });
  const records = Array.isArray(rows) ? rows : [];

  // ── Stale-outbox invariant check (before dispatch) ────────────────────────
  await checkStaleOutboxInvariant(records, settings, channels, token);

  let processed = 0, sent = 0, skipped = 0, failed = 0, deadLettered = 0;
  const errors  = [];

  for (const row of records) {
    const record = { id: row.id, ...(row.data || row) };
    processed++;

    try {
      if (record.metadata?.slack_ts)           { skipped++; continue; }

      if ((record.attempts || 0) >= 3) {
        deadLettered++;
        await apiPut('EventOutbox', record.id, { status: 'failed', error: 'max_attempts_reached' });
        if (channels['ALERTS'])
          await slackPost(channels['ALERTS'], `💀 *DEAD_LETTER* | EventOutbox \`${record.id}\`\nEvent: ${record.event_type} | Attempts: ${record.attempts}`, token);
        continue;
      }

      const text              = formatMessage(record);
      const iKey              = idempotencyKey(record);
      const routed            = routeEvent(record.event_type);
      let { channelId, isDM } = resolveChannel(record, routed, channels, settings);
      let slackResult;
      let selfHealed = false;

      if (isDM) {
        const uid = record.recipient_id || record.payload?.recipient_slack_user_id;
        slackResult = uid
          ? await slackDM(uid, text, token)
          : await slackPost(channels['HUNTERS'], `⚠️ DM intended but no recipient_id\n${text}`, token);
      } else {
        slackResult = await slackPost(channelId, text, token);

        // Self-heal on channel_not_found
        if (!slackResult?.ok && slackResult?.error === 'channel_not_found') {
          const newId = await selfHealChannel(routed.slot, settings, token);
          if (newId) {
            channelId   = newId;
            slackResult = await slackPost(channelId, text, token);
            selfHealed  = true;
            await apiPost('AuditLog', {
              run_type:    'channel_self_heal',
              triggered_by:`dispatch:${record.event_type}`,
              summary:     `channel_not_found for ${routed.slot} — healed to ${newId}, version bumped.`,
              status:      slackResult?.ok ? 'ok' : 'error',
              raw_payload: { slot: routed.slot, new_id: newId, outbox_id: record.id, version: settings['slack_channel_version']?.value },
            });
          }
        }
      }

      if (!slackResult?.ok) {
        const errMsg = slackResult?.error || 'unknown';
        failed++;
        await apiPut('EventOutbox', record.id, {
          status:   'failed',
          attempts: selfHealed ? (record.attempts||0) : (record.attempts||0)+1,
          error:    errMsg,
        });
        errors.push({ id: record.id, event_type: record.event_type, error: errMsg });
        continue;
      }

      sent++;
      await apiPut('EventOutbox', record.id, {
        status:   'sent',
        attempts: (record.attempts||0)+1,
        sent_at:  new Date().toISOString(),
        metadata: {
          ...(record.metadata||{}),
          slack_ts:        slackResult.ts,
          slack_channel:   slackResult.channel,
          routed_to:       isDM ? 'DM' : channelId,
          idempotency_key: iKey,
          is_test:         record.is_test || false,
          ...(selfHealed ? { self_healed: true } : {}),
        },
      });

    } catch (err) {
      failed++;
      errors.push({ id: record.id, event_type: record.event_type, error: err.message });
      try { await apiPut('EventOutbox', record.id, { attempts: (record.attempts||0)+1, error: err.message }); } catch (_) {}
    }
  }

  const durationMs = Date.now() - startTime;

  // Stamp last_verified_at on every clean sweep (even if no heals)
  if (failed === 0 && deadLettered === 0) {
    await stampVerifiedAt(settings);
  }

  // Stamp last_successful_send_at / last_failed_send_at
  const nowIso = new Date().toISOString();
  if (sent > 0) {
    await saveSetting(settings, 'last_successful_send_at', nowIso, 'string');
  }
  if (failed > 0 || deadLettered > 0) {
    await saveSetting(settings, 'last_failed_send_at', nowIso, 'string');
  }

  await apiPost('AuditLog', {
    run_type:           'outbox_dispatch',
    triggered_by:       'automation:outbox_dispatcher',
    summary:            `Sweep: ${processed} processed, ${sent} sent, ${skipped} skipped, ${failed} failed, ${deadLettered} dead-lettered. ${durationMs}ms.`,
    status:             failed > 0 || deadLettered > 0 ? 'partial' : 'ok',
    notifications_sent: [{ sent, skipped, failed, dead_lettered: deadLettered }],
    errors,
    raw_payload: {
      run_id: runId, processed, sent, skipped, failed,
      dead_lettered: deadLettered, duration_ms: durationMs,
      channel_ids: channels,
      last_verified_at: settings['slack_channel_last_verified_at']?.value || null,
      channel_version:  settings['slack_channel_version']?.value || null,
      test_channel_override: settings['test_channel_override']?.value || null,
    },
  });

  console.log(JSON.stringify({
    ok: true, run_id: runId, processed, sent, skipped, failed,
    dead_lettered: deadLettered, duration_ms: durationMs,
    channels, healed_count: healed.length,
    last_verified_at: settings['slack_channel_last_verified_at']?.value || null,
    channel_version:  settings['slack_channel_version']?.value || null,
  }));
}

main().catch(err => { console.log(JSON.stringify({ ok: false, error: err.message })); });
