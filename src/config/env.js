// Centralized environment variable loading + validation.
// Every other module should read config from here, not process.env directly,
// so a missing/malformed var fails fast at boot with a clear message.

require('dotenv').config();

function required(name) {
  const val = process.env[name];
  if (!val || val.trim() === '') {
    throw new Error(`[config] Missing required environment variable: ${name}`);
  }
  return val;
}

function optional(name, fallback = undefined) {
  const val = process.env[name];
  if (val === undefined || val.trim() === '') return fallback;
  return val;
}

function optionalInt(name, fallback) {
  const val = process.env[name];
  if (val === undefined || val.trim() === '') return fallback;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? fallback : n;
}

// Core bot settings are required for the bot to run at all.
// GramJS / watchdog-specific vars are validated lazily by the services
// that actually need them, so the main bot can boot without the
// stats-monitor being configured yet.
const config = {
  botToken: () => required('BOT_TOKEN'),
  ownerId: () => parseInt(required('OWNER_ID'), 10),
  botVersion: optional('BOT_VERSION', '1.0.0'),
  nodeEnv: optional('NODE_ENV', 'production'),
  isProduction: optional('NODE_ENV', 'production') === 'production',

  webhookUrl: () => required('WEBHOOK_URL'),
  webhookSecretToken: () => required('WEBHOOK_SECRET_TOKEN'),
  port: optionalInt('PORT', 3000),

  databaseUrl: () => required('DATABASE_URL'),
  redisUrl: () => required('REDIS_URL'),

  defaultChannelId: optional('DEFAULT_CHANNEL_ID', null),
  defaultTimezone: optional('DEFAULT_TIMEZONE', 'UTC'),

  gramjsApiId: optional('TELEGRAM_API_ID', null),
  gramjsApiHash: optional('TELEGRAM_API_HASH', null),
  gramjsSessionString: optional('GRAMJS_SESSION_STRING', null),
  gramjsEncryptionKey: optional('GRAMJS_ENCRYPTION_KEY', null),

  watchdogAlertThreshold: optionalInt('WATCHDOG_ALERT_THRESHOLD', 5),
  watchdogWindowMinutes: optionalInt('WATCHDOG_WINDOW_MINUTES', 10),
  watchdogQuietHoursStart: optionalInt('WATCHDOG_QUIET_HOURS_START', 23),
  watchdogQuietHoursEnd: optionalInt('WATCHDOG_QUIET_HOURS_END', 7),
  watchdogMemoryWarnMb: optionalInt('WATCHDOG_MEMORY_WARN_MB', 360),
  watchdogMemoryCriticalMb: optionalInt('WATCHDOG_MEMORY_CRITICAL_MB', 435),
  watchdogPollIntervalMinutes: optionalInt('WATCHDOG_POLL_INTERVAL_MINUTES', 5),

  stagingBotToken: optional('STAGING_BOT_TOKEN', null),
  stagingChannelId: optional('STAGING_CHANNEL_ID', null),
};

module.exports = config;
