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

// v1.2.0: Emergency Stop used to live on the persistent reply keyboard
// (visible on every screen) AND had a "blind toggle" bug where tapping it
// always re-activated, even if already active, with no way to tell from
// the button alone whether it was already on. Per feedback, it now lives
// in exactly one place - Settings → 🛡 Watchdog - as a state-aware control
// that clearly shows current status before you act. See settings/index.js.
// withEmergencyStop is kept as a small helper in case a future screen
// needs the same "append a stop row" pattern, but nothing wires it in
// automatically anymore.
function withEmergencyStop(rows) {
  return [...rows, [Markup.button.callback('🛑 Emergency Stop', 'set:watchdog')]];
}

// Home reply keyboard - the persistent bottom bar shown outside any wizard.
function homeReplyKeyboard() {
  return Markup.keyboard([
    ['🎨 Compose', '📡 Channels', '🗂 Templates'],
    ['⏰ Scheduled', '📜 History', '⚙️ Settings'],
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
