const { Queue } = require('bullmq');
const { getRedis } = require('./redisClient');

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
  return new Queue(name, { connection: getRedis(), defaultJobOptions });
}

const scheduledPostQueue = makeQueue('scheduled-posts');
const autoDeleteQueue = makeQueue('auto-delete');
const autoRepostQueue = makeQueue('auto-repost');
const statsPollQueue = makeQueue('stats-poll');

async function schedulePost(savedItemId, sendAt, jobIdOverride) {
  const delay = Math.max(0, new Date(sendAt).getTime() - Date.now());
  const jobId = jobIdOverride || `post:${savedItemId}`;
  return scheduledPostQueue.add('send', { savedItemId }, { jobId, delay });
}

async function cancelScheduledPost(savedItemId) {
  const job = await scheduledPostQueue.getJob(`post:${savedItemId}`);
  if (job) await job.remove();
}

async function scheduleAutoDelete(savedItemId, deleteAt, messageRefs) {
  const delay = Math.max(0, new Date(deleteAt).getTime() - Date.now());
  const jobId = `autodelete:${savedItemId}`;
  return autoDeleteQueue.add('delete', { savedItemId, messageRefs }, { jobId, delay });
}

async function cancelAutoDelete(savedItemId) {
  const job = await autoDeleteQueue.getJob(`autodelete:${savedItemId}`);
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
};
