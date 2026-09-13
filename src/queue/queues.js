const { Queue } = require('bullmq');
const { getQueueConnection } = require('./redisClient');

// removeOnComplete/removeOnFail limits are set deliberately per the memory
// budget concern: unbounded BullMQ job history in Redis is a known slow
// memory-creep cause on a 512MB instance.
const defaultJobOptions = {
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 200 },
  attempts: 5,
  backoff: { type: 'exponential', delay: 5000 },
};

function makeQueue(name) {
  // Dedicated BullMQ connection - never the general-purpose request-path
  // client (see redisClient.js for why this split matters).
  return new Queue(name, { connection: getQueueConnection(), defaultJobOptions });
}

const scheduledPostQueue = makeQueue('scheduled-posts');
const autoDeleteQueue = makeQueue('auto-delete');
const autoRepostQueue = makeQueue('auto-repost');
const statsPollQueue = makeQueue('stats-poll');

// BUGFIX: BullMQ rejects any custom Job Id containing ':' (it throws
// "Custom Id cannot contain :" - colons are reserved for BullMQ's own
// internal Redis key namespacing, e.g. bull:<queue>:<id>). These job ids
// used to be built as `post:${id}` / `autodelete:${id}` (and further
// suffixed `:c${cycle}` for loop mode), which crashed the very first time
// a scheduled send or an auto-delete/loop job actually tried to enqueue -
// this is what surfaced as "grace_period_send / Reason: Custom Id cannot
// contain :" right after a post with auto-delete (or any scheduled post)
// went out: the send itself had already succeeded, and this queueing step
// afterward is what threw. Switched the delimiter to '-', which BullMQ
// has no issue with. Old in-flight jobs (if any survived) used the old
// colon ids, but those never actually made it into Redis in the first
// place since .add() threw synchronously before enqueueing - so there's
// nothing to migrate.
function postJobId(savedItemId) {
  return `post-${savedItemId}`;
}

function autoDeleteJobId(savedItemId) {
  return `autodelete-${savedItemId}`;
}

async function schedulePost(savedItemId, sendAt, jobIdOverride) {
  const delay = Math.max(0, new Date(sendAt).getTime() - Date.now());
  const jobId = jobIdOverride || postJobId(savedItemId);
  return scheduledPostQueue.add('send', { savedItemId }, { jobId, delay });
}

async function cancelScheduledPost(savedItemId) {
  const job = await scheduledPostQueue.getJob(postJobId(savedItemId));
  if (job) await job.remove();
}

async function scheduleAutoDelete(savedItemId, deleteAt, messageRefs, jobIdOverride) {
  const delay = Math.max(0, new Date(deleteAt).getTime() - Date.now());
  const jobId = jobIdOverride || autoDeleteJobId(savedItemId);
  return autoDeleteQueue.add('delete', { savedItemId, messageRefs }, { jobId, delay });
}

async function cancelAutoDelete(savedItemId) {
  const job = await autoDeleteQueue.getJob(autoDeleteJobId(savedItemId));
  if (job) await job.remove();
}

module.exports = {
  scheduledPostQueue,
  autoDeleteQueue,
  autoRepostQueue,
  statsPollQueue,
  schedulePost,
  cancelScheduledPost,
  scheduleAutoDelete,
  cancelAutoDelete,
  postJobId,
  autoDeleteJobId,
};
