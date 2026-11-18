// When a promise from a call is due, from the words said ("today", "by this Friday", "this week",
// "within 3 days", "next Monday", "the 25th", "month end"), counted from the day of the call. Words that
// name no day ("soon", "later") give no date. Dates are YYYY-MM-DD in the owner's time zone.
// Used by Today (follow-ups) and a person's page (commitments), so both say the same due day.

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const SHORT_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const weekdayOf = (ymd) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/** The due day of a promise said on `callYmd`, or null when the words name no day. */
export function dueFromWords(text, callYmd) {
  if (!callYmd || !text) return null;
  const t = ` ${String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()} `;
  const c = weekdayOf(callYmd);
  const nextMonday = addDays(callYmd, ((7 - c) % 7) + 1); // the Monday after the call's week
  if (/ day after tomorrow /.test(t)) return addDays(callYmd, 2);
  if (/ (today|tonight|now|inniku|innaiku|innaikku|indru) /.test(t)) return callYmd;
  if (/ (tomorrow|tmrw|tmr|naalaiku|nalaiku|naalaikku|nalaikku|naalai|nalai) /.test(t)) return addDays(callYmd, 1);
  const within = t.match(/ (?:in|within|after) (\d{1,2}) (days?|weeks?) /);
  if (within) return addDays(callYmd, Number(within[1]) * (within[2].startsWith("week") ? 7 : 1));
  const day = WEEKDAYS.findIndex((w, i) => t.includes(` ${w} `) || t.includes(` ${SHORT_DAYS[i]} `) || (i === 4 && t.includes(" thurs ")));
  if (day >= 0) return / next /.test(t) ? addDays(nextMonday, (day + 6) % 7) : addDays(callYmd, (day - c + 7) % 7);
  if (/ next week /.test(t)) return addDays(nextMonday, 4); // that week's Friday
  if (/ (this week|end of (the )?week|week end|weekend|by the week) /.test(t)) return addDays(callYmd, c >= 1 && c <= 5 ? 5 - c : (7 - c) % 7);
  if (/ (end of (the )?month|month end|this month) /.test(t)) {
    const [y, m] = callYmd.split("-").map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }
  const nth = t.match(/ (\d{1,2})(?:st|nd|rd|th) /);
  if (nth) {
    const n = Number(nth[1]);
    const [y, m, d] = callYmd.split("-").map(Number);
    if (n < 1 || n > 31) return null;
    const pick = (yy, mm) => {
      const v = new Date(Date.UTC(yy, mm - 1, n));
      return v.getUTCMonth() === mm - 1 ? v.toISOString().slice(0, 10) : null; // e.g. 31st in a 30-day month
    };
    return n >= d ? pick(y, m) : pick(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1);
  }
  return null;
}
