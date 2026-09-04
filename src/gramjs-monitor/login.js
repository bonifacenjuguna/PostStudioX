// One-time interactive script to generate a GramJS session string.
// Run locally with `npm run gramjs-login` (NOT on Railway - it needs
// interactive stdin for the login code/2FA prompt). Paste the resulting
// string into GRAMJS_SESSION_STRING on Railway afterward.

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const readline = require('readline');
const config = require('../config/env');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function main() {
  const apiId = parseInt(config.gramjsApiId || (await ask('TELEGRAM_API_ID: ')), 10);
  const apiHash = config.gramjsApiHash || (await ask('TELEGRAM_API_HASH: '));

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });

  await client.start({
    phoneNumber: async () => ask('Phone number (with country code): '),
    password: async () => ask('2FA password (leave blank if none): '),
    phoneCode: async () => ask('Login code sent to your Telegram: '),
    onError: (err) => console.error(err),
  });

  console.log('\n✅ Logged in. Your session string (copy this into GRAMJS_SESSION_STRING):\n');
  console.log(client.session.save());
  console.log('\nKeep this secret - it is equivalent to a login credential for this account.');

  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Login failed:', err);
  process.exit(1);
});
