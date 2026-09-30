import type { WeeklyWorkingPlace, WorkingPlacesByWeekday } from "./types";

export const workingPlaceStorageKey = "daylight-weekly-working-places";

export function normalizeWeeklyWorkingPlaces(places: WeeklyWorkingPlace[]) {
  const normalized = new Map<number, WeeklyWorkingPlace>();
  for (const place of places) {
    const weekday = Number(place.weekday);
    const value = String(place.place ?? "").trim();
    if (weekday < 0 || weekday > 6 || !value) continue;
    normalized.set(weekday, { ...place, weekday, place: value });
  }
  return [...normalized.values()].sort((left, right) => left.weekday - right.weekday);
}

export function workingPlacesToMap(places: WeeklyWorkingPlace[]) {
  return normalizeWeeklyWorkingPlaces(places).reduce<WorkingPlacesByWeekday>((result, place) => {
    result[place.weekday] = place.place;
    return result;
  }, {});
}

export function workingPlaceForWeekday(places: WorkingPlacesByWeekday, weekday: number) {
  const place = places[weekday];
  return place?.trim() || "";
}