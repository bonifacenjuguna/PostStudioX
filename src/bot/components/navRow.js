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

// Appends an inline "🛑 STOP ALL" row to a keyboard - used on a handful of
// higher-stakes inline menus (Settings, Channel view) in addition to the
// always-visible reply-keyboard button below, so it's reachable both ways.
function withEmergencyStop(rows) {
  return [...rows, [Markup.button.callback('🛑 STOP ALL', 'nav:emergency_stop')]];
}

// v1.1.0 FIX (#6): Emergency Stop used to only exist as an inline button
// that was never actually attached to any keyboard (dead promise - see
// withEmergencyStop above, which nothing called). Putting it on the
// *persistent reply keyboard* instead is strictly better: unlike an inline
// button, the reply keyboard stays visible and tappable no matter how deep
// in a flow you are or how old the message it was attached to is.

// Home reply keyboard - the persistent bottom bar shown outside any wizard.
function homeReplyKeyboard() {
  return Markup.keyboard([
    ['📝 New Post', '📡 Channels', '🗂 Templates'],
    ['📁 My Folders', '⏰ Scheduled', '📜 History'],
    ['⚙️ Settings', '🛑 STOP ALL'],
  ]).resize();
}

// Reply keyboard shown while inside any wizard/flow.
function flowReplyKeyboard() {
  return Markup.keyboard([['⬅️ Back', '❌ Cancel'], ['🛑 STOP ALL']]).resize();
}

// Reply keyboard shown inside a sub-screen (Settings, Templates list, etc.)
function subScreenReplyKeyboard() {
  return Markup.keyboard([['⬅️ Back to Home'], ['🛑 STOP ALL']]).resize();
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
