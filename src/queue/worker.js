// Standalone worker process. Runs BullMQ workers for all queues. Deployed
// as its own Railway service (separate from the main webhook bot process)
// so a stuck job or crash here doesn't take down message-handling, and vice
// versa - matches the "separate services" resilience decision in the spec.

const { Worker } = require('bullmq');
const { Telegraf } = require('telegraf');
const { getRedis } = require('./redisClient');
const config = require('../config/env');
const savedItems = require('../db/models/savedItems');
const channelsModel = require('../db/models/channels');
const { publishSavedItem } = require('../services/publisher');
const { scheduleAutoDelete } = require('./queues');
const watchdogLog = require('../db/models/watchdogLog');

const bot = new Telegraf(config.botToken());

const connection = getRedis();

const scheduledPostWorker = new Worker(
  'scheduled-posts',
  async (job) => {
    const { savedItemId } = job.data;
    const item = await savedItems.findById(savedItemId);

    if (!item) {
      console.warn(`[worker] Scheduled post ${savedItemId} no longer exists - skipping (idempotent no-op).`);
      return;
    }
    if (item.status !== 'scheduled') {
      // Idempotency guard: if this job already ran (e.g. after a restart
      // re-delivered it) or the post was cancelled/edited away, don't resend.
      console.warn(`[worker] Post ${savedItemId} is not in 'scheduled' status (is '${item.status}') - skipping.`);
      return;
    }

    // Live permission re-check right before sending, not just relying on
    // the periodic channel health poll.
    for (const chatId of item.channel_ids) {
      try {
        const member = await bot.telegram.getChatMember(chatId, (await bot.telegram.getMe()).id);
        if (!['administrator', 'creator'].includes(member.status)) {
          throw new Error('not an admin');
        }
      } catch (err) {
        await channelsModel.setAdminStatus(chatId, false, err.message);
        await watchdogLog.record({
          level: 'warning',
          category: 'channel',
          message: `Lost admin rights in ${chatId} - scheduled post ${savedItemId} could not be sent.`,
        });
        throw err; // let BullMQ retry/backoff handle it
      }
    }

    const results = await publishSavedItem(bot, item);

    if (item.auto_delete_at) {
      const refs = results.flatMap((r) => r.messages.map((m) => ({ chat_id: r.chatId, message_id: m.message_id })));
      await scheduleAutoDelete(savedItemId, item.auto_delete_at, refs);
    }
  },
  { connection, concurrency: 2 }
);

const autoDeleteWorker = new Worker(
  'auto-delete',
  async (job) => {
    const { savedItemId, messageRefs } = job.data;
    for (const ref of messageRefs || []) {
      try {
        await bot.telegram.deleteMessage(ref.chat_id, ref.message_id);
      } catch (err) {
        // Message may already be gone - not a failure worth retrying hard.
        console.warn(`[worker] Auto-delete failed for ${ref.chat_id}/${ref.message_id}: ${err.message}`);
      }
    }
    await savedItems.updateWithVersion(savedItemId, { status: 'deleted' }).catch(() => {});
  },
  { connection, concurrency: 2 }
);

const autoRepostWorker = new Worker(
  'auto-repost',
  async (job) => {
    const { savedItemId, targetChannelId } = job.data;
    const item = await savedItems.findById(savedItemId);
    if (!item) return;
    const clone = await savedItems.create({
      kind: 'post',
      status: 'draft',
      channelIds: [targetChannelId],
      mediaType: item.media_type,
      mediaItems: item.media_items,
      caption: item.caption,
      entities: item.entities,
      buttons: item.buttons,
      options: item.options,
    });
    await publishSavedItem(bot, { ...clone, channel_ids: [targetChannelId] });
  },
  { connection, concurrency: 1 }
);

for (const worker of [scheduledPostWorker, autoDeleteWorker, autoRepostWorker]) {
  worker.on('failed', (job, err) => {
    console.error(`[worker] Job ${job?.id} in queue ${job?.queueName} failed:`, err.message);
    watchdogLog
      .record({ level: 'warning', category: 'queue', message: `Job ${job?.id} failed: ${err.message}` })
      .catch(() => {});
  });
}

console.log('[worker] Queue workers started.');

process.on('SIGTERM', async () => {
  console.log('[worker] SIGTERM received, closing workers gracefully...');
  await Promise.all([scheduledPostWorker.close(), autoDeleteWorker.close(), autoRepostWorker.close()]);
  process.exit(0);
});
