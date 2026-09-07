export type EventKind = "lesson" | "personal";
export type EventTone = "blue" | "coral" | "teal" | "yellow";
export type EventStatus = "scheduled" | "completed" | "cancelled" | "skipped";
export type CalendarView = "week" | "month";
export type DeleteScope = "occurrence" | "following" | "all";
export type StaminaState = "low" | "mid" | "high" | "overload";

export type ScheduleEvent = {
  id: string;
  userId: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  title: string;
  detail: string;
  kind: EventKind;
  tone: EventTone;
  intensity: number;
  prepMinutes: number;
  travelMinutes: number;
  hourlyRate: number;
  fixedFee: number | null;
  status: EventStatus;
  recurrenceWeekdays: number[];
  recurrenceUntil: string | null;
};

export type ScheduleOccurrence = ScheduleEvent & {
  occurrenceKey: string;
  originalStartsAt: string;
  isRecurring: boolean;
  exceptionId?: string;
};

export type ScheduleEventException = {
  id: string;
  eventId: string;
  originalStartsAt: string;
  startsAt: string | null;
  endsAt: string | null;
  status: EventStatus;
  title: string | null;
  detail: string | null;
  hourlyRate: number | null;
  fixedFee: number | null;
};

export type CalendarRange = {
  start: Date;
  end: Date;
};

export type SuggestedSlot = {
  date: string;
  starts: string;
  ends: string;
  durationMinutes: number;
  priority: "weekday-evening" | "weekend-midday" | "other";
};