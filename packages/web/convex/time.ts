// Durations, in the milliseconds every timestamp in this schema is stored in.
//
// One home because four modules had grown their own private `MINUTE_MS` /
// `HOUR_MS` / `DAY_MS` and another eighteen sites open-coded the arithmetic. The
// values cannot drift - a day is a day - but the arithmetic is where a retention
// window quietly becomes a thousand times too short, and a reader checking
// "thirty days" against `30 * 24 * 60 * 60 * 1000` is counting zeroes rather
// than reading a policy.
export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
