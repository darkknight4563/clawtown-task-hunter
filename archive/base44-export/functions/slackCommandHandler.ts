/**
 * slackCommandHandler
 *
 * Two entry points:
 *   POST /functions/slackCommandHandler          — Slack Events API webhook (url_verification + message.im)
 *   POST /functions/slackCommandHandler?poll=1   — polling mode: called by scheduled automation every 5min
 *
 * Commands (DM to bot):
 *   DELIVER <task_id> <link-or-text>
 *   APPROVE <task_id>
 *   OPEN_DISPUTE <task_id> <reason...>
 *   RESOLVE_DISPUTE <task_id> <creator_pct>/<agent_pct> [slash=true] [notes...]
 *   STATUS <task_id>
 *   HELP
 *
 * Safety: writes_enabled guard, idempotency on slack_ts, AuditLog + EventOutbox per command.
 */

const SKILLS_BASE = '/app/.agents/skills';
const NODE_CMD    = 'node';

function shortId(s: string) { return (s || '').slice(-8); }

async function slackApiCall(method: string, body: Record<string, unknown>, token: string) {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function slackDM(userId: string, text: string, token: string) {
  const ch = await slackApiCall('conversations.open', { users: userId }, token);
  if (!ch.ok) return { ok: false, error: ch.error };
  return slackApiCall('chat.postMessage', {
    channel:    ch.channel.id,
    text,
    username:   'ClawTown Hunter 🦅',
    icon_emoji: ':eagle:',
  }, token);
}

async function runSkill(skillPath: string, args: string[]): Promise<Record<string, unknown>> {
  const cmd = new Deno.Command(NODE_CMD, {
    args,
    stdout: 'piped',
    stderr: 'piped',
    env: {
      ...Deno.env.toObject(),
      BASE44_APP_ID:           Deno.env.get('BASE44_APP_ID') || '',
      VITE_BASE44_APP_ID:      Deno.env.get('BASE44_APP_ID') || '',
      VITE_BASE44_BACKEND_URL: 'https://base44.app',
    },
  });
  // prepend the script path
  const fullCmd = new Deno.Command(NODE_CMD, {
    args:   [skillPath, ...args],
    stdout: 'piped',
    stderr: 'piped',
    env: {
      ...Deno.env.toObject(),
      BASE44_APP_ID:           Deno.env.get('BASE44_APP_ID') || '',
      VITE_BASE44_APP_ID:      Deno.env.get('BASE44_APP_ID') || '',
      VITE_BASE44_BACKEND_URL: 'https://base44.app',
    },
  });
  const { stdout, stderr } = await fullCmd.output();
  const out = new TextDecoder().decode(stdout).trim();
  try {
    const lines = out.split('\n').filter(l => l.startsWith('{'));
    return JSON.parse(lines.pop() || '{}');
  } catch {
    return { ok: false, error: 'PARSE_ERROR', raw: out, stderr: new TextDecoder().decode(stderr).trim() };
  }
}

// ── Entity helpers ─────────────────────────────────────────────────────────────
function makeEntityHelpers(appId: string, serviceToken: string) {
  const API_BASE = `https://base44.app/api/apps/${appId}`;
  const authH    = { 'Authorization': `Bearer ${serviceToken}`, 'Content-Type': 'application/json' };

  async function apiGet(entity: string, q: Record<string, unknown> = {}) {
    const url = new URL(`${API_BASE}/entities/${entity}`);
    if (Object.keys(q).length) url.searchParams.set('q', JSON.stringify(q));
    const r = await fetch(url.toString(), { headers: authH });
    const d = await r.json();
    return Array.isArray(d) ? d : (d.records || d.data || []);
  }
  async function apiPost(entity: string, payload: unknown) {
    const r = await fetch(`${API_BASE}/entities/${entity}`, {
      method: 'POST', headers: authH, body: JSON.stringify(payload),
    });
    return (await r.json()).data || {};
  }
  return { apiGet, apiPost };
}

// ── Command processor ──────────────────────────────────────────────────────────
async function processCommand(
  userId: string,
  rawText: string,
  slackTs: string,
  token: string,
  apiGet: Function,
  apiPost: Function,
) {
  const idemKey = `slack_cmd_${userId}_${slackTs}`;

  // Idempotency check
  const existing = await apiGet('EventOutbox', { reference_id: idemKey });
  if (existing.length) return { skipped: 'duplicate', idemKey };

  // Settings
  const settingsArr = await apiGet('PlatformSetting');
  const S: Record<string, string> = {};
  settingsArr.forEach((s: Record<string, string>) => { S[s.key] = s.value; });
  const writesEnabled = S['writes_enabled'] !== 'false';
  const adminSlackId  = S['default_creator_slack_user_id'] || '';

  const HELP_TEXT = [
    '*ClawTown commands* 🦅',
    '`DELIVER <task_id> <link-or-text>` — submit a deliverable',
    '`APPROVE <task_id>` — approve deliverable + release payment',
    '`OPEN_DISPUTE <task_id> <reason...>` — open a dispute',
    '`RESOLVE_DISPUTE <task_id> <creator_pct>/<agent_pct> [slash=true] [notes...]` — resolve dispute',
    '`STATUS <task_id>` — check task status',
    '`HELP` — show this message',
  ].join('\n');

  const parts = rawText.trim().split(/\s+/);
  const cmd   = parts[0].toUpperCase();

  let replyText    = '';
  let auditSummary = '';
  let auditStatus  = 'ok';
  let taskIdForLog = '';
  let skillResult: Record<string, unknown> = {};

  // ── HELP ─────────────────────────────────────────────────────────────────────
  if (['HELP', '?', 'COMMANDS'].includes(cmd)) {
    replyText    = HELP_TEXT;
    auditSummary = `HELP by ${userId}`;

  // ── STATUS ────────────────────────────────────────────────────────────────────
  } else if (cmd === 'STATUS') {
    const taskId = parts[1];
    taskIdForLog = taskId;
    if (!taskId) {
      replyText = '❌ Usage: `STATUS <task_id>`'; auditStatus = 'error';
    } else {
      const rows = await apiGet('Task', { id: taskId });
      if (!rows.length) {
        replyText = `❌ Task \`${shortId(taskId)}\` not found.`; auditStatus = 'error';
      } else {
        const t = rows[0].data || rows[0];
        replyText = [
          `📋 *Task \`${shortId(taskId)}\`*`,
          `*${t.title || 'Untitled'}*`,
          `Status: *${t.status}* | Budget: ${t.budget} ${t.currency || 'TTT'}`,
        ].join('\n');
        auditSummary = `STATUS for ${taskId} by ${userId}`;
      }
    }

  // ── DELIVER ───────────────────────────────────────────────────────────────────
  } else if (cmd === 'DELIVER') {
    const taskId  = parts[1];
    const content = parts.slice(2).join(' ');
    taskIdForLog  = taskId;

    if (!writesEnabled) {
      replyText = '🔴 *Writes frozen.* Try again later.'; auditStatus = 'skipped';
      auditSummary = `DELIVER blocked writes_disabled user=${userId} task=${taskId}`;
    } else if (!taskId || !content) {
      replyText = '❌ Usage: `DELIVER <task_id> <link-or-text>`'; auditStatus = 'error';
    } else {
      const agentRows = await apiGet('Agent', { slack_user_id: userId });
      if (!agentRows.length) {
        replyText = '❌ No agent linked to your Slack account. Contact admin.';
        auditStatus = 'error';
        auditSummary = `DELIVER no agent for ${userId}`;
      } else {
        const agent    = agentRows[0].data || agentRows[0];
        const taskRows = await apiGet('Task', { id: taskId });
        if (!taskRows.length) {
          replyText = `❌ Task \`${shortId(taskId)}\` not found.`; auditStatus = 'error';
        } else {
          const task = taskRows[0].data || taskRows[0];
          if (!['awarded', 'delivered'].includes(task.status)) {
            replyText = `❌ Task status *${task.status}* — must be \`awarded\` to submit.`; auditStatus = 'error';
          } else if (task.awarded_agent_id && task.awarded_agent_id !== agent.id) {
            replyText = `❌ Task not awarded to you (@${agent.handle}).`; auditStatus = 'error';
          } else {
            skillResult = await runSkill(`${SKILLS_BASE}/submit_deliverable/scripts/run.js`,
              [taskId, agent.id, 'Deliverable via Slack', content]);
            if (skillResult.ok) {
              replyText = [
                `✅ *Deliverable submitted* for \`${shortId(taskId)}\``,
                `*${task.title || 'Untitled'}*`,
                `Awaiting approval. Deliverable: \`${shortId(String(skillResult.deliverable_id || ''))}\``,
              ].join('\n');
              auditSummary = `DELIVER ok task=${taskId} agent=@${agent.handle} deliverable=${skillResult.deliverable_id}`;
            } else {
              replyText = `❌ *Submit failed:* ${skillResult.message || skillResult.error}`;
              auditStatus = 'error';
              auditSummary = `DELIVER error ${skillResult.error}`;
            }
          }
        }
      }
    }

  // ── APPROVE ───────────────────────────────────────────────────────────────────
  } else if (cmd === 'APPROVE') {
    const taskId = parts[1];
    taskIdForLog = taskId;

    if (!writesEnabled) {
      replyText = '🔴 *Writes frozen.* Try again later.'; auditStatus = 'skipped';
    } else if (!taskId) {
      replyText = '❌ Usage: `APPROVE <task_id>`'; auditStatus = 'error';
    } else {
      const taskRows = await apiGet('Task', { id: taskId });
      if (!taskRows.length) {
        replyText = `❌ Task \`${shortId(taskId)}\` not found.`; auditStatus = 'error';
      } else {
        const task      = taskRows[0].data || taskRows[0];
        const isCreator = task.creator_slack_user_id === userId;
        const isAdmin   = userId === adminSlackId;
        if (!isCreator && !isAdmin) {
          replyText = '❌ Only creator or admin can approve.'; auditStatus = 'error';
          auditSummary = `APPROVE denied ${userId} not creator/admin task=${taskId}`;
        } else {
          skillResult = await runSkill(`${SKILLS_BASE}/approve_deliverable/scripts/run.js`, [taskId]);
          if (skillResult.ok) {
            const cur = String(skillResult.currency || 'TTT');
            replyText = [
              `✅ *Approved!* Task \`${shortId(taskId)}\` → *completed*`,
              ``,
              `💰 *Settlement:*`,
              `• Agent payout:   *${skillResult.payout} ${cur}* → @${skillResult.agent_handle}`,
              `• Creator refund: *${skillResult.refund} ${cur}*`,
              `• Stake released: *${skillResult.stake_released} ${cur}*`,
              ``,
              `TX: payout \`${shortId(String(skillResult.payout_tx_id || ''))}\` | refund \`${shortId(String(skillResult.refund_tx_id || '?'))}\` | stake \`${shortId(String(skillResult.stake_release_tx_id || ''))}\``,
            ].join('\n');
            auditSummary = `APPROVE ok task=${taskId} payout=${skillResult.payout} refund=${skillResult.refund}`;
          } else {
            replyText = `❌ *Approval failed:* ${skillResult.message || skillResult.error}`;
            auditStatus = 'error';
            auditSummary = `APPROVE error ${skillResult.error}`;
          }
        }
      }
    }

  // ── OPEN_DISPUTE ──────────────────────────────────────────────────────────────
  } else if (cmd === 'OPEN_DISPUTE') {
    const taskId = parts[1];
    const reason = parts.slice(2).join(' ');
    taskIdForLog = taskId;

    if (!writesEnabled) {
      replyText = '🔴 *Writes frozen.* Try again later.'; auditStatus = 'skipped';
    } else if (!taskId || !reason) {
      replyText = '❌ Usage: `OPEN_DISPUTE <task_id> <reason...>`'; auditStatus = 'error';
    } else {
      skillResult = await runSkill(`${SKILLS_BASE}/open_dispute/scripts/run.js`, [taskId, userId, reason]);
      if (skillResult.ok) {
        replyText = [
          `⚠️ *Dispute opened* on \`${shortId(taskId)}\``,
          `ID: \`${shortId(String(skillResult.dispute_id || ''))}\``,
          `Reason: _${reason}_`,
          `Funds frozen. Admin will resolve.`,
          `Admin resolves with: \`RESOLVE_DISPUTE ${taskId} 50/50\``,
        ].join('\n');
        auditSummary = `OPEN_DISPUTE ok task=${taskId} dispute=${skillResult.dispute_id}`;
      } else {
        replyText = `❌ *Dispute failed:* ${skillResult.message || skillResult.error}`;
        auditStatus = 'error';
        auditSummary = `OPEN_DISPUTE error ${skillResult.error}`;
      }
    }

  // ── RESOLVE_DISPUTE ───────────────────────────────────────────────────────────
  } else if (cmd === 'RESOLVE_DISPUTE') {
    const taskId   = parts[1];
    const splitStr = parts[2] || '50/50';
    taskIdForLog   = taskId;

    const [cpStr, apStr] = splitStr.split('/');
    const creatorPct = parseFloat(cpStr);
    const agentPct   = parseFloat(apStr);

    let slashArg = 'false';
    const noteArgs: string[] = [];
    for (const p of parts.slice(3)) {
      if (p.toLowerCase().startsWith('slash=')) slashArg = p.split('=')[1];
      else noteArgs.push(p);
    }
    const notes = noteArgs.join(' ') || `Admin resolved ${splitStr}`;

    if (!writesEnabled) {
      replyText = '🔴 *Writes frozen.* Try again later.'; auditStatus = 'skipped';
    } else if (!taskId || isNaN(creatorPct) || isNaN(agentPct)) {
      replyText = '❌ Usage: `RESOLVE_DISPUTE <task_id> <creator_pct>/<agent_pct> [slash=true] [notes]`';
      auditStatus = 'error';
    } else if (userId !== adminSlackId) {
      replyText = '❌ Only admin can resolve disputes.'; auditStatus = 'error';
      auditSummary = `RESOLVE_DISPUTE denied ${userId} not admin`;
    } else {
      skillResult = await runSkill(`${SKILLS_BASE}/resolve_dispute/scripts/run.js`,
        [taskId, String(creatorPct), String(agentPct), slashArg, notes]);
      if (skillResult.ok) {
        const cur = String(skillResult.currency || 'TTT');
        replyText = [
          `⚖️ *Dispute resolved!* Task \`${shortId(taskId)}\` → *completed*`,
          ``,
          `Split: *${creatorPct}%/${agentPct}%*`,
          `• Creator: *${skillResult.creator_payout} ${cur}*`,
          `• Agent:   *${skillResult.agent_payout} ${cur}*`,
          skillResult.stake_slashed
            ? `• Stake *SLASHED* (${skillResult.stake_amount} ${cur} forfeited)`
            : `• Stake *returned* (${skillResult.stake_amount} ${cur})`,
          ``,
          `TX: \`${shortId(String(skillResult.creator_pay_tx_id || '?'))}\` / \`${shortId(String(skillResult.agent_pay_tx_id || '?'))}\``,
        ].join('\n');
        auditSummary = `RESOLVE_DISPUTE ok task=${taskId} split=${creatorPct}/${agentPct} slash=${slashArg}`;
      } else {
        replyText = `❌ *Resolve failed:* ${skillResult.message || skillResult.error}`;
        auditStatus = 'error';
        auditSummary = `RESOLVE_DISPUTE error ${skillResult.error}`;
      }
    }

  } else {
    replyText    = `🤔 Unknown: \`${cmd}\`\n\n${HELP_TEXT}`;
    auditSummary = `Unknown cmd '${cmd}' from ${userId}`;
  }

  // ── Reply + log ──────────────────────────────────────────────────────────────
  if (replyText) await slackDM(userId, replyText, token);

  await apiPost('EventOutbox', {
    event_type:    'SLACK_COMMAND_REPLY',
    reference_id:  idemKey,
    reference_type:'slack_command',
    channel:       'dm', status: 'sent', is_test: false,
    recipient_id:  userId, message: replyText, sent_at: new Date().toISOString(),
    payload: { idempotency_key: idemKey, command: cmd, raw_text: rawText,
      task_id: taskIdForLog, slack_user_id: userId, slack_ts: slackTs,
      skill_result: skillResult, event_time: new Date().toISOString() },
  });

  await apiPost('AuditLog', {
    task_id: taskIdForLog || undefined,
    run_type: 'slack_command', triggered_by: `slack:${userId}`,
    summary: auditSummary || `${cmd} by ${userId}`, status: auditStatus,
    raw_payload: { idem_key: idemKey, command: cmd, raw_text: rawText,
      user_id: userId, slack_ts: slackTs, skill_result: skillResult },
  });

  return { ok: true, command: cmd, replied: !!replyText, idemKey };
}

// ── HTTP Entry point ───────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  try {
    const token = Deno.env.get('SLACKBOT_ACCESS_TOKEN') || '';
    const appId = Deno.env.get('BASE44_APP_ID') || '';
    const svcToken = Deno.env.get('BASE44_SERVICE_TOKEN') || '';
    const { apiGet, apiPost } = makeEntityHelpers(appId, svcToken);

    const url  = new URL(req.url);
    const body = await req.json().catch(() => ({}));

    // ── Slack URL verification challenge ─────────────────────────────────────
    if (body.type === 'url_verification') {
      return new Response(body.challenge, {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // ── Slack Events API webhook ──────────────────────────────────────────────
    if (body.type === 'event_callback') {
      const event = body.event || {};
      // Only handle DMs (message.im), skip bots
      if (event.type !== 'message' || event.bot_id || event.subtype) {
        return Response.json({ ok: true, skipped: 'not_dm_or_bot' });
      }
      if (!token) return Response.json({ ok: false, error: 'SLACKBOT_ACCESS_TOKEN not set' }, { status: 500 });

      const result = await processCommand(
        event.user || '',
        event.text || '',
        event.ts   || `${Date.now()}`,
        token, apiGet, apiPost,
      );
      return Response.json({ ok: true, ...result });
    }

    // ── Poll mode: called by scheduled automation ─────────────────────────────
    // Payload: { events: [{ user, text, ts }] } — agent fetches and passes these
    if (url.searchParams.get('poll') === '1' || body.events) {
      if (!token) return Response.json({ ok: false, error: 'SLACKBOT_ACCESS_TOKEN not set' }, { status: 500 });
      const events = body.events || [];
      const results = [];
      for (const ev of events) {
        if (!ev.user || !ev.text || ev.bot_id) continue;
        const r = await processCommand(ev.user, ev.text, ev.ts || `${Date.now()}`, token, apiGet, apiPost);
        results.push(r);
      }
      return Response.json({ ok: true, processed: results.length, results });
    }

    // ── Direct test call ──────────────────────────────────────────────────────
    if (body.user && body.text) {
      if (!token) return Response.json({ ok: false, error: 'SLACKBOT_ACCESS_TOKEN not set' }, { status: 500 });
      const result = await processCommand(
        body.user, body.text, body.ts || `${Date.now()}`,
        token, apiGet, apiPost,
      );
      return Response.json({ ok: true, ...result });
    }

    return Response.json({ ok: true, message: 'ClawTown command handler ready. Send Slack events via event_callback.' });

  } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
});
