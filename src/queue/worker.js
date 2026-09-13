// v2.2.0 FIX (#10): this used to ALWAYS run as its own standalone process,
// requiring a separate Railway service pointed at `npm run worker` to ever
// process a single scheduled/auto-delete/loop job. If that second service
// was never actually deployed - very easy to miss, since railway.json only
// configures the main bot service - jobs got queued into Redis and just
// sat there forever: the bot would say "Scheduled!" truthfully (the job
// really was added to the queue), but nothing was ever listening to run
// it. That silence-instead-of-failure is exactly what was reported.
//
// Fix: this file's logic is now a start()/stop() pair that the main bot
// process (src/index.js) calls directly by default, using the SAME
// Telegram client - so a single deployed service does everything out of
// the box. Standalone-process deployment (for anyone who deliberately
// wants the original isolation-for-resilience architecture) still works
// unchanged via `npm run worker` - see the require.main guard at the
// bottom. Running both at once is safe: BullMQ guarantees each job is
// picked up by exactly one worker regardless of how many are listening.

const { Worker } = require('bullmq');
const { getQueueConnection } = require('./redisClient');
const savedItems = require('../db/models/savedItems');
const channelsModel = require('../db/models/channels');
const { publishSavedItem } = require('../services/publisher');
const { scheduleAutoDelete, schedulePost } = require('./queues');
const watchdogLog = require('../db/models/watchdogLog');
const { isEffectivelyAdmin, describeIssue } = require('../services/channelPermissions');

function buildWorkers(telegram, connection) {
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
          const member = await telegram.getChatMember(chatId, (await telegram.getMe()).id);
          if (!isEffectivelyAdmin(member)) {
            throw new Error(describeIssue(member) || 'not an admin');
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

      const results = await publishSavedItem(telegram, item);
      const refs = results.flatMap((r) => r.messages.map((m) => ({ chat_id: r.chatId, message_id: m.message_id })));

      // Loop mode's delete timing is dynamic (stay_seconds from now), so it
      // takes priority over the fixed auto_delete_at column - a looping post
      // defines its own rhythm rather than a one-off delete time.
      if (item.loop_config?.enabled) {
        const deleteAt = new Date(Date.now() + item.loop_config.stay_seconds * 1000).toISOString();
        // Cycle-suffixed jobId: BullMQ keeps completed job history around
        // (removeOnComplete keeps the last 100, see queues.js), so reusing
        // the plain autodelete:<id> jobId on every loop cycle would collide
        // with the still-remembered previous cycle's completed job and throw.
        // NOTE for the Scheduled-screen "cancel" UI: a looping item's active
        // job id is autodelete:<id>:c<cycles_done>, not the plain
        // autodelete:<id> - cancelAutoDelete() only knows the plain form, so
        // cancelling a loop mid-flight needs the cycle number.
        await scheduleAutoDelete(savedItemId, deleteAt, refs, `autodelete:${savedItemId}:c${item.loop_config.cycles_done || 0}`);
      } else if (item.auto_delete_at) {
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
          await telegram.deleteMessage(ref.chat_id, ref.message_id);
        } catch (err) {
          // Message may already be gone - not a failure worth retrying hard.
          console.warn(`[worker] Auto-delete failed for ${ref.chat_id}/${ref.message_id}: ${err.message}`);
        }
      }

      // Loop mode: post -> stay up -> delete (just happened above) -> wait
      // the gap -> repost, repeating per the cycle limit (or forever). Rather
      // than a brand new mechanism, this reuses the exact same
      // scheduled-posts queue/worker as a normal scheduled send - the item
      // just flips back to 'scheduled' with a future send time equal to the
      // gap, and scheduledPostWorker above picks it up exactly like any other
      // scheduled post would, loop_config included.
      const item = await savedItems.findById(savedItemId);
      const loop = item?.loop_config;
      if (loop?.enabled && loop.active) {
        const cyclesDone = (loop.cycles_done || 0) + 1;
        const exhausted = loop.max_cycles != null && cyclesDone >= loop.max_cycles;
        if (exhausted) {
          await savedItems.updateWithVersion(savedItemId, {
            status: 'deleted',
            loop_config: { ...loop, cycles_done: cyclesDone, active: false },
          }).catch(() => {});
        } else {
          const nextSendAt = new Date(Date.now() + loop.gap_seconds * 1000).toISOString();
          await savedItems.updateWithVersion(savedItemId, {
            status: 'scheduled',
            scheduled_for: nextSendAt,
            loop_config: { ...loop, cycles_done: cyclesDone },
          }).catch(() => {});
          // Same cycle-suffixed jobId reasoning as the auto-delete side above.
          await schedulePost(savedItemId, nextSendAt, `post:${savedItemId}:c${cyclesDone}`);
        }
        return;
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
      await publishSavedItem(telegram, { ...clone, channel_ids: [targetChannelId] });
    },
    { connection, concurrency: 1 }
  );

  return [scheduledPostWorker, autoDeleteWorker, autoRepostWorker];
}

let started = false;

// telegram: pass the main process's existing bot.telegram to run embedded
// (no second Telegraf instance, no duplicate long-lived connection). Omit
// it (standalone mode) and this creates its own from the bot token.
async function start({ telegram } = {}) {
  if (started) return { stop: async () => {} };
  started = true;

  const client = telegram || new (require('telegraf').Telegraf)(require('../config/env').botToken()).telegram;

  // Visibility only - a crash here (standalone mode) letting Railway
  // restart the process is the intended recovery path, but a silent
  // unhandled rejection with no log line makes that hard to diagnose later.
  process.on('unhandledRejection', (reason) => {
    console.error('[worker] Unhandled promise rejection:', reason);
  });

  // Dedicated BullMQ connection - see redisClient.js for why this can't be
  // the general-purpose client (Worker needs maxRetriesPerRequest: null for
  // its blocking commands, which must never be mixed with fail-fast calls).
  const connection = getQueueConnection();
  const workers = buildWorkers(client, connection);

  for (const worker of workers) {
    worker.on('failed', (job, err) => {
      console.error(`[worker] Job ${job?.id} in queue ${job?.queueName} failed:`, err.message);
      watchdogLog
        .record({ level: 'warning', category: 'queue', message: `Job ${job?.id} failed: ${err.message}` })
        .catch(() => {});
    });
  }

  console.log('[worker] Queue workers started.');

  const stop = async () => {
    console.log('[worker] Closing workers gracefully...');
    await Promise.all(workers.map((w) => w.close()));
    started = false;
  };

  return { stop };
}

module.exports = { start };

if (require.main === module) {
  // Standalone-process mode: `npm run worker` as its own deployed service.
  start()
    .then(({ stop }) => {
      process.on('SIGTERM', async () => {
        console.log('[worker] SIGTERM received, closing workers gracefully...');
        await stop();
        process.exit(0);
      });
    })
    .catch((err) => {
      console.error('[worker] Fatal error starting standalone worker:', err);
      process.exit(1);
    });
}
