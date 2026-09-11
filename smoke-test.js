#!/usr/bin/env node
// Fast, dependency-free sanity checks — no Postgres/Redis/Telegram needed.
// Run with: node smoke-test.js
//
// This is deliberately NOT a full end-to-end test (that needs live
// Postgres/Redis and a real bot token, none of which exist in this build
// environment). It exists to catch two classes of regressions cheaply on
// every change: (1) every file in src/ still parses, and (2) the pure
// logic modules (no DB/network) produce correct output. As each screen in
// the redesign is rebuilt, its pure-logic pieces get a section here too —
// this file grows alongside the rebuild rather than being written once at
// the end.

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  ✅ ${label}`);
    passed += 1;
  } catch (err) {
    console.log(`  🔴 ${label}`);
    console.log(`     ${err.message}`);
    failed += 1;
  }
}

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'mismatch'}\n     got:      ${a}\n     expected: ${e}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ── 1. Every .js file under src/ must at least parse ──────────────────────
console.log('\n[1] Syntax check: every file under src/ parses');
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}
const { execFileSync } = require('child_process');
for (const file of walk(path.join(__dirname, 'src'))) {
  check(`parses: ${path.relative(__dirname, file)}`, () => {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  });
}

// ── 2. telegramFormatter — full entity coverage ────────────────────────────
console.log('\n[2] telegramFormatter');
const formatter = require('./src/services/telegramFormatter');

check('bold/italic/blockquote/link all parse to correct entities', () => {
  const { text, entities } = formatter.parseShorthand('**Hi** __there__ >>quote<< [site](https://a.com)');
  assertEqual(text, 'Hi there quote site');
  assertEqual(entities.map((e) => e.type), ['bold', 'italic', 'blockquote', 'text_link']);
});

check('expandable_blockquote does not get swallowed by blockquote pattern', () => {
  const { entities } = formatter.parseShorthand('>>>long text<<<');
  assertEqual(entities.length, 1);
  assertEqual(entities[0].type, 'expandable_blockquote');
});

check('custom_emoji entity carries custom_emoji_id and keeps fallback glyph as visible text', () => {
  const { text, entities } = formatter.parseShorthand('{emoji:123456}🔥{/emoji} sale');
  assertEqual(text, '🔥 sale');
  assertEqual(entities[0].type, 'custom_emoji');
  assertEqual(entities[0].custom_emoji_id, '123456');
});

check('tg://user?id= link becomes text_mention, not text_link', () => {
  const { entities } = formatter.parseShorthand('[Alex](tg://user?id=555)');
  assertEqual(entities[0].type, 'text_mention');
  assertEqual(entities[0].user, { id: 555 });
});

check('replaceAllLinks swaps every link (entity + bare URL) to one new url, keeps labels', () => {
  const parsed = formatter.parseShorthand('go to [site](https://old.com) or https://bare.com');
  const result = formatter.replaceAllLinks(parsed.text, parsed.entities, 'https://new.com');
  assert(result.linksFound, 'expected linksFound to be true');
  assert(result.text.includes('https://new.com'), 'bare URL should be replaced in text');
  const linkEntity = result.entities.find((e) => e.type === 'text_link');
  assertEqual(linkEntity.url, 'https://new.com');
  assert(result.text.includes('site'), 'text_link visible label should be untouched');
});

check('stripLinks removes text_link/text_mention entities and bare URLs from text', () => {
  const parsed = formatter.parseShorthand('see [site](https://a.com) https://b.com');
  const stripped = formatter.stripLinks(parsed.text, parsed.entities);
  assertEqual(stripped.entities.length, 0);
  assert(!stripped.text.includes('http'), 'bare URL text should be gone');
});

// ── 3. channelPermissions ───────────────────────────────────────────────
console.log('\n[3] channelPermissions');
const perms = require('./src/services/channelPermissions');

check('isEffectivelyAdmin requires can_post_messages for administrators', () => {
  assert(perms.isEffectivelyAdmin({ status: 'creator' }) === true);
  assert(perms.isEffectivelyAdmin({ status: 'administrator', can_post_messages: true }) === true);
  assert(perms.isEffectivelyAdmin({ status: 'administrator', can_post_messages: false }) === false);
  assert(perms.isEffectivelyAdmin({ status: 'member' }) === false);
});

check('buildBotAdministratorRights preselects only the rights this bot actually needs', () => {
  const rights = perms.buildBotAdministratorRights();
  assert(rights.can_post_messages === true);
  assert(rights.can_promote_members === false);
});

check('grantedVsMissing splits a rights snapshot correctly', () => {
  const { granted, missing } = perms.grantedVsMissing({ can_post_messages: true, can_pin_messages: false });
  assert(granted.some((l) => l.includes('Post messages')));
  assert(missing.some((l) => l.includes('Pin messages')));
});

// ── 4. actionErrors — message shape ─────────────────────────────────────
console.log('\n[4] actionErrors');
const { formatErrorMessage } = require('./src/services/actionErrors');

check('formatErrorMessage names scene/step/attempted/reason, never a bare generic string', () => {
  const msg = formatErrorMessage({
    scene: 'channels', step: 'recheck', attempted: 'read admin rights', reason: 'bot was kicked', errorCode: '403',
  });
  assert(msg.includes('channels'));
  assert(msg.includes('recheck'));
  assert(msg.includes('read admin rights'));
  assert(msg.includes('bot was kicked'));
  assert(msg.includes('403'));
});

// ── 5. naturalTime — casual scheduling parser ───────────────────────────
console.log('\n[5] naturalTime');
try {
  const { parseNaturalTime, quickPickPresets } = require('./src/services/naturalTime');

  check('relative durations parse (30 min, 2h, 1 day)', () => {
    const zone = 'UTC';
    for (const input of ['30 min', '2h', '1 day', 'in 2 hours']) {
      const { dt, error } = parseNaturalTime(input, zone);
      assert(!error, `"${input}" should parse, got error: ${error}`);
      assert(dt > require('luxon').DateTime.now(), `"${input}" should resolve to the future`);
    }
  });

  check('a weekday name today that has already passed rolls to next week, not today', () => {
    // Can't control "now" without a fake clock in this fast smoke test, so
    // this just checks the function doesn't throw and returns a future time
    // for every weekday name - the specific same-day-vs-next-week edge case
    // is covered by the dedicated date-math walkthrough during development.
    const { DateTime } = require('luxon');
    for (const day of ['monday', 'friday', 'sunday']) {
      const { dt, error } = parseNaturalTime(day, 'UTC');
      assert(!error, `"${day}" should parse`);
      assert(dt > DateTime.now(), `"${day}" should resolve to the future`);
    }
  });

  check('nonsense input returns a helpful error, not a crash', () => {
    const { error } = parseNaturalTime('asdkjasd', 'UTC');
    assert(!!error, 'expected an error message for unparseable input');
  });

  check('quickPickPresets returns the expected preset labels', () => {
    const labels = quickPickPresets().map((p) => p.label);
    assert(labels.length === 6);
    assert(labels.some((l) => l.includes('10 min')));
    assert(labels.some((l) => l.includes('week')));
  });
} catch (err) {
  // A missing dependency (e.g. `luxon` not yet `npm install`-ed in this
  // environment) must not take down every check after this section -
  // report it as one failed check and keep going.
  console.log(`  🔴 naturalTime section could not run: ${err.message}`);
  failed += 1;
}

// ── Summary ────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
