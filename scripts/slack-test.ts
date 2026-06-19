// Verify the app's own notifyChannel() path posts to Slack.
// Run: node --env-file=.env --import tsx scripts/slack-test.ts
import { notifyChannel, slackConfigured } from "../src/lib/slack";

async function main() {
  console.log("slackConfigured:", slackConfigured());
  await notifyChannel("✅ notifyChannel() from the Claw Town app is working.");
  console.log("sent");
}

main();
