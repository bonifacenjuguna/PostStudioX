// Previously every place that asked for a schedule time (New Post's finish
// step, Edit Post's Reschedule) required an exact "yyyy-MM-dd HH:mm" string
// in UTC - genuinely hard to use day to day, and the direct cause of the
// "I have to convert my own time to UTC in my head" complaint this rebuild
// exists to fix. This module is now the ONE place that turns "what the
// owner typed" into an actual UTC instant, so Schedule and Timezone stay in
// sync everywhere instead of each screen rolling its own parsing.
//
// Everything here is interpreted in the caller-supplied IANA zone (the
// owner's configured timezone from Settings), NOT UTC - the whole point is
// the owner never has to think in UTC again.

const { DateTime } = require('luxon');

const RELATIVE_PATTERN = /^\s*(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)\s*$/i;
const UNIT_TO_LUXON = {
  m: 'minutes', min: 'minutes', mins: 'minutes', minute: 'minutes', minutes: 'minutes',
  h: 'hours', hr: 'hours', hrs: 'hours', hour: 'hours', hours: 'hours',
  d: 'days', day: 'days', days: 'days',
  w: 'weeks', week: 'weeks', weeks: 'weeks',
};

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Quick-pick presets shown as buttons alongside the free-type option, per
// the "10min, 30min, hour, day, week... plus type it myself" requirement.
function quickPickPresets() {
  return [
    { label: '⏱ 10 min', minutes: 10 },
    { label: '⏱ 30 min', minutes: 30 },
    { label: '🕐 1 hour', minutes: 60 },
    { label: '🕒 3 hours', minutes: 180 },
    { label: '📅 Tomorrow (same time)', minutes: 24 * 60 },
    { label: '📆 1 week', minutes: 7 * 24 * 60 },
  ];
}

function extractTimeOfDay(fragment) {
  const m = fragment.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[3]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

// Parses free-typed casual text ("tomorrow 9am", "friday 6pm", "in 2 hours",
// "18:30", "2026-09-20 14:00") into a UTC instant, interpreted in `zone`.
// Returns { dt } on success (dt is a luxon DateTime, already in UTC) or
// { error } with a message meant to be shown back to the owner as-is.
function parseNaturalTime(rawText, zone) {
  const text = rawText.trim();
  if (!text) return { error: 'Send a time, or tap one of the quick options above.' };

  const now = DateTime.now().setZone(zone);

  // 1. Relative duration: "30 min", "2h", "1 day", "1 week"
  const relMatch = text.match(RELATIVE_PATTERN);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = UNIT_TO_LUXON[relMatch[2].toLowerCase()];
    const dt = now.plus({ [unit]: amount });
    return { dt: dt.toUTC() };
  }

  // 2. "in 2 hours" / "in 30 minutes" phrasing
  const inMatch = text.match(/^in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/i);
  if (inMatch) {
    const amount = parseInt(inMatch[1], 10);
    const unit = UNIT_TO_LUXON[inMatch[2].toLowerCase()];
    return { dt: now.plus({ [unit]: amount }).toUTC() };
  }

  const lower = text.toLowerCase();

  // 3. "today" / "today 6pm" / "tonight"
  if (/^today\b/.test(lower) || /^tonight\b/.test(lower)) {
    const rest = lower.replace(/^today|^tonight/, '').trim();
    const tod = rest ? extractTimeOfDay(rest) : { hour: 21, minute: 0 }; // "tonight" alone -> 9pm
    if (rest && !tod) return { error: `Couldn't read the time in "${rawText}" - try something like "today 6pm".` };
    let dt = now.set({ hour: tod.hour, minute: tod.minute, second: 0, millisecond: 0 });
    if (dt <= now) return { error: 'That time today has already passed - try a time later today, or "tomorrow".' };
    return { dt: dt.toUTC() };
  }

  // 4. "tomorrow" / "tomorrow 9am"
  if (/^tomorrow\b/.test(lower)) {
    const rest = lower.replace(/^tomorrow/, '').trim();
    const tod = rest ? extractTimeOfDay(rest) : { hour: 9, minute: 0 };
    if (rest && !tod) return { error: `Couldn't read the time in "${rawText}" - try something like "tomorrow 9am".` };
    const dt = now.plus({ days: 1 }).set({ hour: tod.hour, minute: tod.minute, second: 0, millisecond: 0 });
    return { dt: dt.toUTC() };
  }

  // 5. Weekday name, optionally "next <weekday>", optionally + time
  const weekdayMatch = lower.match(/^(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b(.*)$/);
  if (weekdayMatch) {
    const wantNext = !!weekdayMatch[1];
    const idx = WEEKDAYS.indexOf(weekdayMatch[2]);
    const targetDow = idx === 0 ? 7 : idx; // luxon weekday: Mon=1..Sun=7
    const rest = weekdayMatch[3].trim();
    const tod = rest ? extractTimeOfDay(rest) : { hour: 9, minute: 0 };
    if (rest && !tod) return { error: `Couldn't read the time in "${rawText}".` };
    let daysAhead = (targetDow - now.weekday + 7) % 7;
    let dt = now.plus({ days: daysAhead }).set({ hour: tod.hour, minute: tod.minute, second: 0, millisecond: 0 });
    // Roll forward a full week if that lands in the past (the named day's
    // time already passed today) or if today IS that day and "next <day>"
    // was explicitly asked for (meaning: not today, the one after).
    if (dt <= now || (daysAhead === 0 && wantNext)) dt = dt.plus({ weeks: 1 });
    return { dt: dt.toUTC() };
  }

  // 6. Bare time of day: "6pm", "18:30", "9:15am" -> today if still ahead,
  // otherwise rolls to tomorrow automatically rather than erroring.
  const bareTime = text.match(/^\d{1,2}(:\d{2})?\s*(am|pm)?$/i);
  if (bareTime) {
    const tod = extractTimeOfDay(text);
    if (!tod) return { error: `Couldn't read "${rawText}" as a time.` };
    let dt = now.set({ hour: tod.hour, minute: tod.minute, second: 0, millisecond: 0 });
    if (dt <= now) dt = dt.plus({ days: 1 });
    return { dt: dt.toUTC() };
  }

  // 7. Explicit date formats - still supported for anyone who prefers them.
  const explicitFormats = ['yyyy-MM-dd HH:mm', 'yyyy-LL-dd HH:mm', 'MM/dd HH:mm', 'MMM d HH:mm', 'MMM d, HH:mm'];
  for (const fmt of explicitFormats) {
    const dt = DateTime.fromFormat(text, fmt, { zone });
    if (dt.isValid) return { dt: dt.toUTC() };
  }

  return {
    error:
      `Couldn't understand "${rawText}". Try something like "30 min", "tomorrow 9am", "friday 6pm", ` +
      'or an exact "2026-09-20 14:00".',
  };
}

// Parses a plain duration like "45m", "2h", "1 day", "1 week" into a whole
// number of minutes - used by Loop Mode's stay-up/repost-gap custom input,
// which needs a duration (not an absolute time like the functions above).
function parseDurationMinutes(rawText) {
  const text = rawText.trim();
  const match = text.match(RELATIVE_PATTERN);
  if (!match) return { error: `Couldn't read "${rawText}" as a duration — try something like "45m", "2h", or "1 day".` };
  const amount = parseInt(match[1], 10);
  const unit = UNIT_TO_LUXON[match[2].toLowerCase()];
  const minutesPerUnit = { minutes: 1, hours: 60, days: 1440, weeks: 10080 };
  return { minutes: amount * minutesPerUnit[unit] };
}

module.exports = { parseNaturalTime, quickPickPresets, parseDurationMinutes };
