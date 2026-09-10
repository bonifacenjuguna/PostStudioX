// Single shared source for navigation buttons so every screen in the bot
// looks and behaves identically - same emoji, same position, same rule:
// Back bottom-left, Cancel/Home bottom-right, never omitted.

const { Markup } = require('telegraf');

function backCancelRow(backData, cancelData = 'nav:cancel') {
  return [
    Markup.button.callback('⬅️ Back', backData),
    Markup.button.callback('❌ Cancel', cancelData),
  ];
}

function backHomeRow(backData) {
  return [
    Markup.button.callback('⬅️ Back', backData),
    Markup.button.callback('🏠 Home', 'nav:home'),
  ];
}

function homeOnlyRow() {
  return [Markup.button.callback('🏠 Home', 'nav:home')];
}

function withEmergencyStop(rows) {
  // Emergency Stop is appended to every top-level screen's inline keyboard
  // (list/menu screens for each section) so it's reachable no matter how
  // deep you are, without needing to back out to Home first.
  return [...rows, [Markup.button.callback('🛑 STOP ALL', 'nav:emergency_stop')]];
}

// Lets you jump sideways to another section without returning Home first.
// Rendered as a compact 3-per-row grid of the sections other than the one
// you're currently in. `currentSection` is skipped so you're never shown a
// button back to the screen you're already on.
const SECTIONS = [
  ['channels', '📡', 'Channels'],
  ['createPost', '📝', 'New Post'],
  ['templates', '🗂', 'Templates'],
  ['folders', '📁', 'Folders'],
  ['scheduled', '⏰', 'Scheduled'],
  ['history', '📜', 'History'],
  ['settings', '⚙️', 'Settings'],
];

function quickNavRow(currentSection = null) {
  const buttons = SECTIONS.filter(([key]) => key !== currentSection).map(([key, emoji, label]) =>
    Markup.button.callback(`${emoji} ${label}`, `nav:goto:${key}`)
  );
  // Chunk into rows of 3 so it doesn't dominate the screen.
  const rows = [];
  for (let i = 0; i < buttons.length; i += 3) {
    rows.push(buttons.slice(i, i + 3));
  }
  return rows;
}

// Home reply keyboard - the persistent bottom bar shown outside any wizard.
function homeReplyKeyboard() {
  return Markup.keyboard([
    ['📝 New Post', '📡 Channels', '🗂 Templates'],
    ['📁 My Folders', '⏰ Scheduled', '📜 History'],
    ['⚙️ Settings'],
  ]).resize();
}

// Reply keyboard shown while inside any wizard/flow.
function flowReplyKeyboard() {
  return Markup.keyboard([['⬅️ Back', '❌ Cancel']]).resize();
}

// Reply keyboard shown inside a sub-screen (Settings, Templates list, etc.)
function subScreenReplyKeyboard() {
  return Markup.keyboard([['⬅️ Back to Home']]).resize();
}

module.exports = {
  backCancelRow,
  backHomeRow,
  homeOnlyRow,
  withEmergencyStop,
  quickNavRow,
  homeReplyKeyboard,
  flowReplyKeyboard,
  subScreenReplyKeyboard,
};
