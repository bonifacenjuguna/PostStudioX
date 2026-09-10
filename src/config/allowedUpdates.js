// Single source of truth for the webhook's allowed_updates list. Both
// src/index.js (initial registration) and src/watchdog/index.js (self-heal
// re-registration if the webhook ever gets wiped) must request the exact
// same set, or the watchdog's "fix" would silently narrow what the bot
// receives on the next redeploy. Previously this array was duplicated
// verbatim in both files - one edit here instead of two.
//
// message_reaction (singular, per-user reaction change) is deliberately
// NOT requested: nothing in this bot consumes it, message_reaction_count
// (aggregate totals) already covers every stat this bot displays, and
// requesting update types nothing handles just adds dead webhook traffic.
const ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'callback_query',
  'channel_post',
  'edited_channel_post',
  'message_reaction_count',
];

module.exports = { ALLOWED_UPDATES };
