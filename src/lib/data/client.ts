import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import { collection, deleteDoc, doc, getDocFromServer, getDocsFromServer, limit, orderBy, query, runTransaction, startAfter, where, writeBatch, type Query, type QueryConstraint } from "firebase/firestore";
import { getFirebase } from "../firebase/client";
import { exceptionId, normalizeRecord, safeId, type CollectionName, type Row, type TableRows } from "./schema";
import { eventInput, exceptionInput } from "../schedule/mutations";
import type { ScheduleEvent, ScheduleEventException } from "../schedule/types";
export { cloudConfigured } from "../firebase/client";

type Result<Value> = { data: Value; error: null } | { data: null; error: Error };
type DateRange = { start: Date; end: Date };
function sameRecord(left: Record<string, unknown> | undefined, right: Record<string, unknown> | undefined) {
  if (!left || !right) return left === right;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => JSON.stringify(left[key]) === JSON.stringify(right[key]));
}
async function result<Value>(operation: () => Promise<Value>): Promise<Result<Value>> {
  try { return { data: await operation(), error: null }; }
  catch (error) { return { data: null, error: error instanceof Error ? error : new Error(String(error)) }; }
}
async function context() {
  const { auth, store } = getFirebase();
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in to access your schedule.");
  return { store, user, uid: user.uid };
}
async function readRows<Collection extends CollectionName>(source: Query): Promise<TableRows[Collection][]> {
  const rows: TableRows[Collection][] = [];
  let page = await getDocsFromServer(query(source, limit(250)));
  while (page.size) {
    rows.push(...page.docs.map(snapshot => snapshot.data() as TableRows[Collection]));
    if (page.size < 250) break;
    page = await getDocsFromServer(query(source, startAfter(page.docs[page.size - 1]), limit(250)));
  }
  return rows;
}
async function list<Collection extends Exclude<CollectionName, "profiles">>(name: Collection, constraints: QueryConstraint[] = []) {
  const { store, uid } = await context();
  return readRows<Collection>(query(collection(store, "users", uid, name), ...constraints));
}
async function save<Collection extends CollectionName>(name: Collection, input: Record<string, unknown>, requireExisting = false) {
  const { store, uid } = await context();
  const id = name === "profiles" ? uid : name === "eventExceptions" ? exceptionId(String(input.event_id), String(input.original_starts_at)) : safeId(input.id ?? crypto.randomUUID());
  const reference = name === "profiles" ? doc(store, "users", uid) : doc(store, "users", uid, name, id);
  return runTransaction(store, async transaction => {
    const existing = await transaction.get(reference);
    const parentReference = name === "eventExceptions" ? doc(store, "users", uid, "events", safeId(input.event_id)) : null;
    const parent = parentReference ? await transaction.get(parentReference) : null;
    if (requireExisting && !existing.exists()) throw new Error("The record no longer exists. Reload before editing.");
    if (parent && !parent.exists()) throw new Error("The recurring event no longer exists. Reload before editing.");
    const record = normalizeRecord(name, { ...existing.data(), ...input, id, updated_at: new Date().toISOString() }, uid);
    transaction.set(reference, record);
    if (parentReference && parent) transaction.set(parentReference, { ...parent.data(), updated_at: record.updated_at });
    return record;
  });
}
async function remove(name: Exclude<CollectionName, "profiles">, id: string) {
  const { store, uid } = await context();
  await deleteDoc(doc(store, "users", uid, name, safeId(id)));
}
async function eventsInRange(range?: DateRange) {
  if (!range) return list("events", [orderBy("starts_at")]);
  const { store, uid } = await context();
  const [events, moved] = await Promise.all([
    list("events", [where("starts_at", "<", range.end.toISOString()), where("range_end", ">=", range.start.toISOString()), orderBy("starts_at"), orderBy("range_end")]),
    list("eventExceptions", [where("starts_at", "<", range.end.toISOString()), where("ends_at", ">", range.start.toISOString()), orderBy("starts_at"), orderBy("ends_at")]),
  ]);
  const byId = new Map(events.map(event => [event.id, event]));
  for (const id of new Set(moved.map(exception => exception.event_id))) {
    if (byId.has(id)) continue;
    const snapshot = await getDocFromServer(doc(store, "users", uid, "events", id));
    if (snapshot.exists()) byId.set(id, snapshot.data() as TableRows["events"]);
  }
  return [...byId.values()].sort((left, right) => left.starts_at.localeCompare(right.starts_at));
}

export const database = {
  auth: {
    async getUser() {
      try {
        const { store, user } = await context();
        const access = await getDocFromServer(doc(store, "access", user.uid));
        if (access.data()?.enabled !== true) throw new Error("This account has not been approved for this private workspace.");
        return { data: { user: { id: user.uid, email: user.email } }, error: null };
      } catch (error) {
        return { data: { user: null }, error: error instanceof Error ? error : new Error(String(error)) };
      }
    },
    async signInWithPassword(credentials: { email: string; password: string }) {
      return result(async () => {
        await signInWithEmailAndPassword(getFirebase().auth, credentials.email, credentials.password);
        const session = await database.auth.getUser();
        if (session.error) { await signOut(getFirebase().auth); throw session.error; }
        return session.data;
      });
    },
    async signOut() { return signOut(getFirebase().auth); },
  },
  getProfile: () => result(async () => {
    const { store, uid } = await context();
    const snapshot = await getDocFromServer(doc(store, "users", uid));
    return snapshot.exists() ? snapshot.data() as TableRows["profiles"] : save("profiles", { id: uid });
  }),
  saveProfile: (input: Record<string, unknown>) => result(() => save("profiles", input)),
  listStudents: (activeOnly = false) => result(async () => (await list("students", activeOnly ? [where("status", "==", "active")] : [])).sort((left, right) => left.name.localeCompare(right.name))),
  saveStudent: (input: Record<string, unknown>) => result(() => save("students", input)),
  updateStudent: (id: string, input: Record<string, unknown>) => result(() => save("students", { ...input, id }, true)),
  listEvents: (range?: DateRange) => result(() => eventsInRange(range)),
  listDailyEvents: (start: string, end: string) => result(() => list("events", [where("starts_at", ">=", start), where("starts_at", "<", end), orderBy("starts_at")])),
  saveEvent: (input: Record<string, unknown>) => result(() => save("events", input)),
  updateEvent: (id: string, input: Record<string, unknown>) => result(() => save("events", { ...input, id }, true)),
  updateEventSeries: (base: ScheduleEvent, input: Record<string, unknown>, previous: ScheduleEventException[], next: ScheduleEventException[]) => result(async () => {
    const { store, uid } = await context();
    const reference = doc(store, "users", uid, "events", safeId(base.id));
    const initial = await getDocFromServer(reference);
    if (!initial.exists()) throw new Error("The event no longer exists. Reload before editing.");
    const expectedEvent = eventInput(base);
    if (Object.entries(expectedEvent).some(([key, value]) => JSON.stringify(initial.data()[key]) !== JSON.stringify(value))) throw new Error("This event changed on another device. Reload before editing.");
    const current = await list("eventExceptions", [where("event_id", "==", base.id)]);
    const expected = new Map(previous.map(exception => [exception.id, exceptionInput(exception)]));
    if (current.length !== expected.size || current.some(row => !expected.has(row.id) || Object.entries(expected.get(row.id)!).some(([key, value]) => JSON.stringify(row[key]) !== JSON.stringify(value)))) throw new Error("The recurring occurrences changed. Reload before editing.");
    const now = new Date().toISOString();
    const event = normalizeRecord("events", { ...initial.data(), ...input, id: base.id, updated_at: now }, uid);
    const exceptions = next.map(exception => normalizeRecord("eventExceptions", { ...exceptionInput(exception), updated_at: now }, uid));
    if (exceptions.some(exception => exception.event_id !== base.id)) throw new Error("An occurrence belongs to another event.");
    const nextIds = new Set(exceptions.map(exception => exception.id));
    const removed = current.filter(row => !nextIds.has(row.id));
    if (1 + exceptions.length + removed.length > 500) throw new Error("This series has too many occurrence changes to update in one operation. Your schedule has not changed.");
    return runTransaction(store, async transaction => {
      const saved = await transaction.get(reference);
      const snapshots = await Promise.all(current.map(row => transaction.get(doc(store, "users", uid, "eventExceptions", row.id))));
      if (!saved.exists() || !sameRecord(saved.data(), initial.data()) || snapshots.some((snapshot, index) => !snapshot.exists() || !sameRecord(snapshot.data(), current[index]))) throw new Error("The recurring series changed while saving. Reload and try again.");
      transaction.set(reference, event);
      removed.forEach(row => transaction.delete(doc(store, "users", uid, "eventExceptions", row.id)));
      exceptions.forEach(exception => transaction.set(doc(store, "users", uid, "eventExceptions", exception.id), exception));
      return { event, exceptions };
    });
  }),
  deleteEvent: (id: string) => result(async () => {
    const { store, uid } = await context();
    const reference = doc(store, "users", uid, "events", safeId(id));
    const initial = await getDocFromServer(reference);
    const exceptions = await list("eventExceptions", [where("event_id", "==", id)]);
    if (exceptions.length > 499) throw new Error("This series has too many occurrence changes to delete in one operation. Your schedule has not changed.");
    await runTransaction(store, async transaction => {
      const saved = await transaction.get(reference);
      const snapshots = await Promise.all(exceptions.map(row => transaction.get(doc(store, "users", uid, "eventExceptions", row.id))));
      if (!sameRecord(saved.data(), initial.data()) || snapshots.some((snapshot, index) => !sameRecord(snapshot.data(), exceptions[index]))) throw new Error("The event changed while deleting. Reload and try again.");
      transaction.delete(reference);
      exceptions.forEach(exception => transaction.delete(doc(store, "users", uid, "eventExceptions", exception.id)));
    });
    return { id };
  }),
  listExceptions: (eventIds: string[]) => result(async () => {
    const uniqueIds = [...new Set(eventIds)];
    const rows: TableRows["eventExceptions"][] = [];
    for (let offset = 0; offset < uniqueIds.length; offset += 30) rows.push(...await list("eventExceptions", [where("event_id", "in", uniqueIds.slice(offset, offset + 30))]));
    return rows;
  }),
  saveException: (input: Record<string, unknown>) => result(() => save("eventExceptions", input)),
  deleteException: (id: string) => result(() => remove("eventExceptions", id)),
  listAvailability: () => result(async () => (await list("weeklyAvailability")).sort((left, right) => left.weekday - right.weekday || left.starts.localeCompare(right.starts))),
  listAvailabilityOverrides: (start: string, end: string) => result(async () => {
    const constraints = [where("week_start", ">=", start), where("week_start", "<", end)];
    const [overrides, intervals] = await Promise.all([list("availabilityOverrides", constraints), list("overrideIntervals", constraints)]);
    return overrides.map(override => ({ ...override, intervals: intervals.filter(interval => interval.week_start === override.week_start).map(({ weekday, starts, ends }) => ({ weekday, starts, ends })) }));
  }),
  listWorkingPlaces: () => result(async () => (await list("workingPlaces")).sort((left, right) => left.weekday - right.weekday)),
  deleteAvailabilityOverride: (weekStart: string) => result(async () => {
    await remove("availabilityOverrides", weekStart);
    const { store, uid } = await context();
    const intervals = await list("overrideIntervals", [where("week_start", "==", weekStart)]);
    for (let offset = 0; offset < intervals.length; offset += 400) {
      const batch = writeBatch(store);
      intervals.slice(offset, offset + 400).forEach(interval => batch.delete(doc(store, "users", uid, "overrideIntervals", interval.id)));
      await batch.commit();
    }
  }),
  saveAvailability: (intervals: { weekday: number; starts: string; ends: string }[], places: { weekday: number; place: string }[], weekStart?: string) => result(async () => {
    const { store, uid } = await context();
    const name = weekStart ? "overrideIntervals" : "weeklyAvailability";
    const existingIntervals = weekStart ? await list("overrideIntervals", [where("week_start", "==", weekStart)]) : await list("weeklyAvailability");
    const existingPlaces = await list("workingPlaces");
    const rows: Row[] = intervals.map(interval => weekStart ? normalizeRecord("overrideIntervals", { ...interval, week_start: weekStart }, uid) : normalizeRecord("weeklyAvailability", interval, uid));
    const placeRows = places.map(place => normalizeRecord("workingPlaces", place, uid));
    const deletes = existingIntervals.filter(row => !rows.some(next => next.id === row.id));
    const placeDeletes = existingPlaces.filter(row => !placeRows.some(next => next.id === row.id));
    if (rows.length + placeRows.length + deletes.length + placeDeletes.length + (weekStart ? 1 : 0) > 450) throw new Error("Too many availability changes for one atomic save.");
    const batch = writeBatch(store);
    if (weekStart) batch.set(doc(store, "users", uid, "availabilityOverrides", weekStart), normalizeRecord("availabilityOverrides", { week_start: weekStart }, uid));
    deletes.forEach(row => batch.delete(doc(store, "users", uid, name, row.id)));
    placeDeletes.forEach(row => batch.delete(doc(store, "users", uid, "workingPlaces", row.id)));
    rows.forEach(row => batch.set(doc(store, "users", uid, name, row.id), row));
    placeRows.forEach(row => batch.set(doc(store, "users", uid, "workingPlaces", row.id), row));
    await batch.commit();
    return null;
  }),
};
