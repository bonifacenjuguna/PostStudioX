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
  // Emergency Stop is appended to *every* inline keyboard bot-wide so it's
  // reachable regardless of navigation depth, per the locked navigation contract.
  return [...rows, [Markup.button.callback('🛑 STOP ALL', 'nav:emergency_stop')]];
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
  homeReplyKeyboard,
  flowReplyKeyboard,
  subScreenReplyKeyboard,
};
