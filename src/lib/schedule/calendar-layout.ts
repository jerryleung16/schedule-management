import type { ScheduleOccurrence } from "./types";

// Sequential lessons use the full column; only overlapping groups share horizontal lanes.
export function calendarEventLanes(events: ScheduleOccurrence[]) {
  const sorted = [...events].sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt) || Date.parse(right.endsAt) - Date.parse(left.endsAt));
  const results: { event: ScheduleOccurrence; lane: number; lanes: number }[] = [];
  let group: typeof results = [];
  let laneEnds: number[] = [];
  let groupEnd = -Infinity;
  const finish = () => { group.forEach(item => { item.lanes = laneEnds.length; }); results.push(...group); group = []; laneEnds = []; };
  for (const event of sorted) {
    const start = Date.parse(event.startsAt);
    const end = Date.parse(event.endsAt);
    if (start >= groupEnd) finish();
    let lane = laneEnds.findIndex(value => value <= start);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = end;
    groupEnd = group.length ? Math.max(groupEnd, end) : end;
    group.push({ event, lane, lanes: 1 });
  }
  finish();
  return results;
}
