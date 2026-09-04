const IORedis = require('ioredis');
const config = require('../config/env');

let client = null;

function getRedis() {
  if (!client) {
    client = new IORedis(config.redisUrl(), {
      maxRetriesPerRequest: null, // required by BullMQ
      enableReadyCheck: true,
    });
    client.on('error', (err) => {
      console.error('[redis] Connection error:', err.message);
    });
  }
  return client;
}

module.exports = { getRedis };
