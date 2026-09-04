// Deterministic duplicate detection - no ML. Caption similarity via a
// normalized hash, plus exact file_id matching for media reuse detection.

const crypto = require('crypto');
const db = require('../db/pool');

function normalizeCaption(text) {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function captionHash(text) {
  return crypto.createHash('sha256').update(normalizeCaption(text)).digest('hex');
}

// Simple similarity: exact-normalized-match, plus a cheap word-overlap ratio
// for "similar but not identical" captions - deterministic, explainable.
function wordOverlapRatio(a, b) {
  const wordsA = new Set(normalizeCaption(a).split(' ').filter(Boolean));
  const wordsB = new Set(normalizeCaption(b).split(' ').filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap += 1;
  return overlap / Math.max(wordsA.size, wordsB.size);
}

async function findSimilarRecent(caption, { withinDays = 14, threshold = 0.75 } = {}) {
  const res = await db.query(
    `SELECT id, caption, channel_ids, created_at FROM saved_items
     WHERE status = 'sent' AND created_at > now() - ($1 || ' days')::interval
     ORDER BY created_at DESC LIMIT 100`,
    [withinDays]
  );

  const matches = [];
  for (const row of res.rows) {
    const ratio = wordOverlapRatio(caption, row.caption);
    if (ratio >= threshold) {
      matches.push({ id: row.id, similarity: ratio, createdAt: row.created_at, channelIds: row.channel_ids });
    }
  }
  return matches;
}

module.exports = { captionHash, wordOverlapRatio, findSimilarRecent };
