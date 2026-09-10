// Single source of truth for "can the bot actually post in this channel".
//
// Previously four different places each did their own check, and all four
// only looked at member.status === 'administrator' / 'creator'. That's true
// even when every individual permission (post/edit/delete/etc.) has been
// stripped by another admin - Telegram happily keeps you listed as
// "administrator" with zero rights. Result: the bot would confidently
// report "🟢 Admin rights confirmed" right up until an actual send failed.
//
// This is the one place that does the real check. Everything else
// (channels scene recheck, watchdog alert recheck, the watchdog's periodic
// sweep, the worker's pre-send guard) should call this instead of
// telegram.getChatMember() directly.

// [key on Telegram's ChatMemberAdministrator, label, is this the one that
// actually matters for "can this bot post at all"]
const PERMISSION_CHECKS = [
  ['can_post_messages', '📮 Post messages', true],
  ['can_edit_messages', '✏️ Edit messages', false],
  ['can_delete_messages', '🗑 Delete messages', false],
  ['can_invite_users', '🔗 Invite via link', false],
  ['can_change_info', '⚙️ Change channel info', false],
  ['can_manage_chat', '🛠 Manage channel', false],
  ['can_manage_video_chats', '🎥 Manage video chats', false],
  ['can_promote_members', '👑 Promote other admins', false],
];

let cachedBotId = null;

async function getBotId(telegram) {
  if (cachedBotId) return cachedBotId;
  const me = await telegram.getMe();
  cachedBotId = me.id;
  return cachedBotId;
}

/**
 * Returns:
 *  {
 *    ok: boolean,              // true only if bot can actually post
 *    status: string,           // raw Telegram member status
 *    isAdmin: boolean,         // status is administrator/creator
 *    permissions: {            // only populated when isAdmin
 *      can_post_messages: bool, ...
 *    },
 *    reason: string|null,      // human-readable summary of what's wrong
 *  }
 */
async function checkChannelPermissions(telegram, chatId, botId = null) {
  const resolvedBotId = botId || (await getBotId(telegram));

  let member;
  try {
    member = await telegram.getChatMember(chatId, resolvedBotId);
  } catch (err) {
    return {
      ok: false,
      status: 'unknown',
      isAdmin: false,
      permissions: {},
      reason: `Could not check (${err.message}) - the bot may have been removed from the channel entirely.`,
    };
  }

  const isAdmin = member.status === 'administrator' || member.status === 'creator';
  // The creator/owner of a channel implicitly has every right there is,
  // even though Telegram doesn't echo individual can_* fields for them.
  const isCreator = member.status === 'creator';

  if (!isAdmin) {
    return {
      ok: false,
      status: member.status,
      isAdmin: false,
      permissions: {},
      reason: `Not an admin (current status: ${member.status}).`,
    };
  }

  const permissions = {};
  for (const [key] of PERMISSION_CHECKS) {
    permissions[key] = isCreator ? true : !!member[key];
  }

  const canPost = permissions.can_post_messages;

  return {
    ok: canPost,
    status: member.status,
    isAdmin: true,
    permissions,
    reason: canPost
      ? null
      : 'Listed as admin, but the "Post messages" permission has been removed - the bot cannot actually send here.',
  };
}

/**
 * Renders the well-formatted breakdown the channel screen and recheck
 * actions show: overall status first, then every individual permission,
 * critical one first.
 */
function formatPermissionReport(result) {
  const lines = [];

  if (!result.isAdmin) {
    lines.push(`🔴 Not an admin (status: ${result.status})`);
    lines.push('The bot needs to be re-added as admin with "Post Messages" enabled.');
    return lines.join('\n');
  }

  lines.push(result.ok ? '🟢 Can post — full admin check below:' : '🟡 Admin, but cannot post — see below:');
  lines.push('');

  const sorted = [...PERMISSION_CHECKS].sort((a, b) => (b[2] ? 1 : 0) - (a[2] ? 1 : 0));
  for (const [key, label] of sorted) {
    const granted = result.permissions[key];
    lines.push(`${granted ? '✅' : '❌'} ${label}`);
  }

  return lines.join('\n');
}

module.exports = { checkChannelPermissions, formatPermissionReport, PERMISSION_CHECKS };
