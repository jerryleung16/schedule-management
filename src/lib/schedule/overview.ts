import type { CalendarRange, EventKind, EventStatus, StaminaState } from "./types";

type TeachingBlock = { kind: EventKind; status: EventStatus; startsAt: string; endsAt: string };
type PayableBlock = TeachingBlock & { hourlyRate: number; fixedFee: number | null };

export type EarningsSummary = {
  expected: number;
  completed: number;
  expectedCount: number;
  completedCount: number;
};

export const emptyEarningsSummary: EarningsSummary = { expected: 0, completed: 0, expectedCount: 0, completedCount: 0 };

function scheduledLesson(block: TeachingBlock) {
  return block.kind === "lesson" && (block.status === "scheduled" || block.status === "completed");
}

export function summarizeLessonEarnings(blocks: PayableBlock[], range?: CalendarRange): EarningsSummary {
  const summary = { ...emptyEarningsSummary };
  for (const block of blocks) {
    const start = Date.parse(block.startsAt);
    const end = Date.parse(block.endsAt);
    if (!scheduledLesson(block) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    // Attribute a lesson's whole fee to its start date so a month boundary never charges it twice.
    if (range && (start < range.start.getTime() || start >= range.end.getTime())) continue;
    const amount = block.fixedFee ?? ((end - start) / 3_600_000) * block.hourlyRate;
    if (!Number.isFinite(amount) || amount < 0) continue;
    summary.expected += amount;
    summary.expectedCount += 1;
    if (block.status === "completed") {
      summary.completed += amount;
      summary.completedCount += 1;
    }
  }
  return summary;
}

export function teachingHoursInRange(blocks: TeachingBlock[], range?: CalendarRange): number {
  return blocks.reduce((hours, block) => {
    if (!scheduledLesson(block)) return hours;
    const start = Math.max(Date.parse(block.startsAt), range?.start.getTime() ?? -Infinity);
    const end = Math.min(Date.parse(block.endsAt), range?.end.getTime() ?? Infinity);
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? hours + (end - start) / 3_600_000 : hours;
  }, 0);
}

// The saved workload limits are teaching hours; intensity, prep, and travel do not change this unit.
export function teachingCapacity(hours: number, limit: number): { percent: number; state: StaminaState; overLimit: boolean } {
  const ratio = limit > 0 ? hours / limit : hours > 0 ? Infinity : 0;
  return {
    percent: Math.min(100, Math.max(0, ratio * 100)),
    state: ratio > 1 ? "overload" : ratio > 0.8 ? "high" : ratio > 0.6 ? "mid" : "low",
    overLimit: ratio > 1,
  };
}

export function validTeachingHourLimit(value: unknown, fallback: number): number {
  const limit = Number(value);
  return value !== null && value !== undefined && Number.isFinite(limit) && limit >= 0 ? limit : fallback;
}
