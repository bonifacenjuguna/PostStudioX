const { getRedis } = require('../queue/redisClient');
const { scheduledPostQueue, autoDeleteQueue, autoRepostQueue } = require('../queue/queues');

const FLAG_KEY = 'emergency_stop:active';

async function isActive() {
  const val = await getRedis().get(FLAG_KEY);
  return val === '1';
}

async function activate() {
  await getRedis().set(FLAG_KEY, '1');
  await Promise.all([
    scheduledPostQueue.pause(),
    autoDeleteQueue.pause(),
    autoRepostQueue.pause(),
  ]);
}

async function deactivate() {
  await getRedis().del(FLAG_KEY);
  await Promise.all([
    scheduledPostQueue.resume(),
    autoDeleteQueue.resume(),
    autoRepostQueue.resume(),
  ]);
}

module.exports = { isActive, activate, deactivate };
