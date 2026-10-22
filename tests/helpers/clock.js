export function createClock(initial = Date.now()) {
  let time = initial;
  return { now: () => time, advance: (milliseconds) => { time += milliseconds; } };
}
