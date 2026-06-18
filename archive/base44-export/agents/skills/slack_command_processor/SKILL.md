# slack_command_processor

Sweeps `EventOutbox` where `event_type=SLACK_COMMAND_REQUEST` and `status=pending`.

Routes to existing skills (submit_deliverable, approve_deliverable, open_dispute, resolve_dispute)
and posts ephemeral replies to Slack via `response_url`.

Stamps outbox records as `sent` or `failed`, with attempt tracking and `metadata.slack_ts` dedup.

Runs on a 5-minute schedule via automation.
