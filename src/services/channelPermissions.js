// Centralizes "is this bot actually usable in this channel" logic so every
// place that checks admin status (channels scene, watchdog, watchdog alert
// handlers, the scheduled-post worker's pre-send check) agrees on the same
// definition. Previously each of those four places did its own
// `['administrator', 'creator'].includes(status)` check, which is true even
// when every individual permission has been stripped - "admin OK" could be
// shown while the bot literally cannot post. can_post_messages is the one
// permission that actually matters for this bot to function.

const RELEVANT_PERMISSIONS = [
  { key: 'can_post_messages', label: '📝 Post messages', critical: true },
  { key: 'can_edit_messages', label: '✏️ Edit messages' },
  { key: 'can_delete_messages', label: '🗑 Delete messages' },
  { key: 'can_pin_messages', label: '📌 Pin messages' },
  { key: 'can_invite_users', label: '🔗 Invite users' },
  { key: 'can_change_info', label: 'ℹ️ Change channel info' },
  { key: 'can_manage_chat', label: '🛠 Manage chat' },
  { key: 'can_promote_members', label: '⬆️ Add new admins' },
];

// True only if the bot can actually publish - creator always can; an
// administrator needs can_post_messages explicitly true (channels default
// new admin rights to *off* for this, unlike groups).
function isEffectivelyAdmin(member) {
  if (!member) return false;
  if (member.status === 'creator') return true;
  if (member.status !== 'administrator') return false;
  return member.can_post_messages === true;
}

function describeIssue(member) {
  if (!member) return 'unknown';
  if (member.status === 'creator') return null;
  if (member.status !== 'administrator') return `not an admin (status: ${member.status})`;
  if (member.can_post_messages !== true) return 'admin, but missing "Post Messages" permission';
  return null;
}

// Multi-line, human-readable permission breakdown for the "Re-check Rights"
// screen - shows exactly which permissions are on/off instead of a single
// pass/fail boolean.
function formatPermissions(member) {
  if (!member) return '🔴 Could not read permissions.';

  if (member.status === 'creator') {
    return "👑 You're the owner of this channel — full permissions, always able to post.";
  }

  if (member.status !== 'administrator') {
    return `🔴 Not an admin here (status: ${member.status}).\n\nPromote the bot to admin with at least "Post Messages" rights, then re-check.`;
  }

  const lines = RELEVANT_PERMISSIONS.map(({ key, label, critical }) => {
    const has = member[key] === true;
    const icon = has ? '✅' : critical ? '🔴' : '⚪️';
    return `${icon} ${label}`;
  });

  const canPost = member.can_post_messages === true;
  const header = canPost
    ? '🟢 Admin — the bot CAN post here.'
    : '🟡 Admin, but the bot CANNOT post here — "Post Messages" is off.';

  return `${header}\n\n${lines.join('\n')}`;
}

module.exports = { isEffectivelyAdmin, describeIssue, formatPermissions, RELEVANT_PERMISSIONS };
