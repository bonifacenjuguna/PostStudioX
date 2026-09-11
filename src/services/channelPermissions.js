// Centralizes "is this bot actually usable in this channel" logic so every
// place that checks admin status (channels scene, watchdog, watchdog alert
// handlers, the scheduled-post worker's pre-send check) agrees on the same
// definition. Previously each of those four places did its own
// `['administrator', 'creator'].includes(status)` check, which is true even
// when every individual permission has been stripped - "admin OK" could be
// shown while the bot literally cannot post. can_post_messages is the one
// permission that actually matters for this bot to function.

const RELEVANT_PERMISSIONS = [
  { key: 'can_post_messages', label: '📝 Post messages', critical: true, preselect: true },
  { key: 'can_edit_messages', label: '✏️ Edit messages', preselect: true },
  { key: 'can_delete_messages', label: '🗑 Delete messages', preselect: true },
  { key: 'can_pin_messages', label: '📌 Pin messages', preselect: true },
  { key: 'can_invite_users', label: '🔗 Invite users (for loop/repost links)', preselect: true },
  { key: 'can_change_info', label: 'ℹ️ Change channel info', preselect: false },
  { key: 'can_manage_chat', label: '🛠 Manage chat', preselect: false },
  { key: 'can_promote_members', label: '⬆️ Add new admins', preselect: false },
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

// Plain snapshot of { can_post_messages: true, ... } for every permission we
// track, to persist on the channels row (admin_rights column) so Manage
// Channels can render "granted vs missing" without an extra live API call
// on every screen view.
function snapshotRights(member) {
  const snapshot = {};
  for (const { key } of RELEVANT_PERMISSIONS) {
    snapshot[key] = member ? member[key] === true : false;
  }
  return snapshot;
}

// Short "granted / missing" two-line summary, for compact display (e.g. the
// channel list row or a card) rather than the full breakdown above.
function grantedVsMissing(rightsSnapshot) {
  const granted = [];
  const missing = [];
  for (const { key, label } of RELEVANT_PERMISSIONS) {
    (rightsSnapshot?.[key] ? granted : missing).push(label);
  }
  return { granted, missing };
}

// Builds the ChatAdministratorRights object Telegram's native chat picker
// (request_chat button) uses to PRESELECT which admin toggles are already
// switched on when the owner is asked to confirm - this is what makes the
// picker feel like "Add Bot to a Channel" instead of a blank permissions
// form. Anything not listed defaults to off.
function buildBotAdministratorRights() {
  const rights = { is_anonymous: false };
  for (const { key, preselect } of RELEVANT_PERMISSIONS) {
    rights[key] = !!preselect;
  }
  return rights;
}

module.exports = {
  isEffectivelyAdmin,
  describeIssue,
  formatPermissions,
  snapshotRights,
  grantedVsMissing,
  buildBotAdministratorRights,
  RELEVANT_PERMISSIONS,
};
