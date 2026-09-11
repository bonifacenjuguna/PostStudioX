// The main bot talks to Telegram purely via the Bot API and has no MTProto
// session, so it can't call user-account-only methods (like toggling a
// channel's "Sign messages" setting - there's no Bot API endpoint for that,
// only the MTProto channels.toggleSignatures call). gramjs-monitor already
// runs a full MTProto user session for view-count polling, so it's the only
// process in this deployment that CAN make that call.
//
// Since bot <-> gramjs-monitor are separate Railway services with no direct
// RPC between them, commands are handed off via a Redis list: the bot
// pushes a JSON command, gramjs-monitor's poll loop pops and executes it on
// its next tick. This is deliberately fire-and-forget/best-effort - same
// spirit as the rest of this queue layer - and requires GramJS to actually
// be configured (TELEGRAM_API_ID/HASH + GRAMJS_SESSION_STRING) to do
// anything; if it isn't, the command just sits unread, which is why the
// bot-side caller always tells the owner this depends on GramJS being set
// up rather than assuming success.

const { safeRedis } = require('./redisClient');

const COMMAND_QUEUE_KEY = 'gramjs:commands';

async function queueToggleSignMessages(chatId, enabled) {
  const command = { type: 'toggle_signatures', chat_id: String(chatId), enabled: !!enabled, queued_at: Date.now() };
  await safeRedis.lpush(COMMAND_QUEUE_KEY, JSON.stringify(command));
  return command;
}

// Called from gramjs-monitor's own poll loop - pops everything currently
// queued (oldest first) so a burst of toggles doesn't get processed out of
// order.
async function drainCommands() {
  const commands = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const raw = await safeRedis.rpop(COMMAND_QUEUE_KEY);
    if (!raw) break;
    try {
      commands.push(JSON.parse(raw));
    } catch (_) {
      // malformed entry - skip rather than block the whole drain
    }
  }
  return commands;
}

module.exports = { queueToggleSignMessages, drainCommands, COMMAND_QUEUE_KEY };
