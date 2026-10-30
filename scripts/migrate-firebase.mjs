import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { normalizeRecord, collections, safeId } from "../src/lib/data/schema.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { input: { type: "string" }, out: { type: "string" }, project: { type: "string" }, "confirm-project": { type: "string" }, "firebase-uid": { type: "string" }, help: { type: "boolean" } } });
const command = positionals[0];
const tableMap = { profiles: "profiles", students: "students", schedule_events: "events", schedule_event_exceptions: "eventExceptions", weekly_availability: "weeklyAvailability", weekly_availability_overrides: "availabilityOverrides", weekly_working_places: "workingPlaces" };
const requiredTables = [...Object.keys(tableMap), "lessons"];
function required(value, label) { if (!value) throw new Error(label + " is required."); return value; }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function digest(value) { return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }
function rowDigest(rows) { return digest([...rows].sort((left, right) => left.id.localeCompare(right.id))); }

async function exportSnapshot() {
  const origin = new URL(required(process.env.SUPABASE_URL, "SUPABASE_URL"));
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/") throw new Error("SUPABASE_URL must be an HTTPS project origin.");
  const key = required(process.env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY");
  const userId = safeId(required(process.env.SUPABASE_USER_ID, "SUPABASE_USER_ID"));
  const output = resolve(required(values.out, "--out"));
  const headers = { apikey: key, Authorization: "Bearer " + key };
  async function rows(table, filter) {
    const result = [];
    let total;
    for (let offset = 0; ; offset += 500) {
      const url = new URL("/rest/v1/" + table, origin);
      url.searchParams.set("select", "*");
      url.searchParams.set("order", "id.asc");
      Object.entries(filter).forEach(([name, value]) => url.searchParams.set(name, value));
      const response = await fetch(url, { headers: { ...headers, Range: offset + "-" + (offset + 499), Prefer: "count=exact" } });
      if (!response.ok) throw new Error("Export of " + table + " failed (HTTP " + response.status + "). Check credentials and applied migrations.");
      const count = Number(response.headers.get("content-range")?.split("/")[1]);
      if (!Number.isInteger(count) || count < 0) throw new Error("The source did not return an exact row count for " + table);
      if (total !== undefined && count !== total) throw new Error("Source data changed during export. Stop edits and retry.");
      total = count;
      const page = await response.json();
      if (!Array.isArray(page)) throw new Error("Unexpected export response.");
      result.push(...page);
      if (result.length >= total) break;
      if (page.length !== 500) throw new Error("Incomplete export page for " + table);
    }
    if (result.length !== total || new Set(result.map(row => row.id)).size !== result.length) throw new Error("Export count or ID mismatch for " + table);
    return result;
  }
  const userResponse = await fetch(new URL("/auth/v1/admin/users/" + userId, origin), { headers });
  if (!userResponse.ok) throw new Error("Cannot read the source account (HTTP " + userResponse.status + ").");
  const sourceUser = await userResponse.json();
  if (sourceUser.id !== userId || !sourceUser.email) throw new Error("Source account must have an email address.");
  const tables = {};
  for (const table of requiredTables.filter(name => name !== "schedule_event_exceptions")) {
    tables[table] = await rows(table, { [table === "profiles" ? "id" : "user_id"]: "eq." + userId });
    console.log(table + ": " + tables[table].length + " rows exported");
  }
  tables.schedule_event_exceptions = [];
  const eventIds = tables.schedule_events.map(row => safeId(row.id));
  for (let offset = 0; offset < eventIds.length; offset += 30) tables.schedule_event_exceptions.push(...await rows("schedule_event_exceptions", { event_id: "in.(" + eventIds.slice(offset, offset + 30).join(",") + ")" }));
  const snapshot = { version: 1, exportedAt: new Date().toISOString(), source: origin.origin, user: { id: userId, email: sourceUser.email, emailVerified: Boolean(sourceUser.email_confirmed_at) }, tables };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(snapshot, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log("Read-only export complete: " + output + " (SHA-256 " + digest(snapshot) + "). Store this private backup outside the repository too.");
}

async function buildPlan() {
  const snapshot = JSON.parse(await readFile(resolve(required(values.input, "--input")), "utf8"));
  if (snapshot.version !== 1 || !snapshot.user?.email || !snapshot.user?.id || !Number.isFinite(Date.parse(snapshot.exportedAt))) throw new Error("Invalid snapshot format.");
  requiredTables.forEach(table => { if (!Array.isArray(snapshot.tables?.[table])) throw new Error("Snapshot is missing " + table); });
  const uid = safeId(values["firebase-uid"] ?? snapshot.user.id);
  const sourceId = snapshot.user.id;
  for (const table of requiredTables) {
    const ids = new Set();
    for (const row of snapshot.tables[table]) {
      safeId(row.id);
      if (ids.has(row.id)) throw new Error("Duplicate source ID in " + table);
      ids.add(row.id);
      if (table !== "schedule_event_exceptions" && (table === "profiles" ? row.id : row.user_id) !== sourceId) throw new Error("Snapshot contains another user's data in " + table);
    }
  }
  if (snapshot.tables.profiles.length !== 1) throw new Error("Expected exactly one source profile.");
  const tables = Object.fromEntries(collections.map(name => [name, []]));
  const normalize = (collection, row) => normalizeRecord(collection, { ...row, user_id: uid, created_at: row.created_at ?? snapshot.exportedAt, updated_at: row.updated_at ?? row.created_at ?? snapshot.exportedAt }, uid);
  for (const [source, target] of Object.entries(tableMap)) tables[target] = snapshot.tables[source].map(row => normalize(target, row));
  for (const override of snapshot.tables.weekly_availability_overrides) {
    if (!Array.isArray(override.intervals)) throw new Error("An availability override has invalid intervals.");
    for (const interval of override.intervals) tables.overrideIntervals.push(normalize("overrideIntervals", { ...interval, week_start: override.week_start, created_at: override.created_at, updated_at: override.updated_at }));
  }
  const canonicalIds = new Set(tables.events.map(row => row.id));
  const duplicates = snapshot.tables.lessons.filter(row => canonicalIds.has(row.id)).length;
  for (const legacy of snapshot.tables.lessons) if (!canonicalIds.has(legacy.id)) tables.events.push(normalize("events", { ...legacy, timezone: snapshot.tables.profiles[0].timezone ?? "UTC" }));
  const studentIds = new Set(tables.students.map(row => row.id));
  const eventIds = new Set(tables.events.map(row => row.id));
  tables.events.forEach(row => { if (row.student_id && !studentIds.has(row.student_id)) throw new Error("Event " + row.id + " references a missing student. Repair the source before importing."); });
  tables.eventExceptions.forEach(row => { if (!eventIds.has(row.event_id)) throw new Error("An exception references a missing event."); });
  for (const [name, rows] of Object.entries(tables)) if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("Duplicate logical keys after normalization in " + name);
  return { uid, snapshot, tables, duplicates, hash: digest({ uid, tables }) };
}
function printPlan(plan) {
  console.log("Target UID: " + plan.uid);
  for (const [name, rows] of Object.entries(plan.tables)) console.log(name + ": " + rows.length + " documents; SHA-256 " + rowDigest(rows));
  console.log("Legacy lesson IDs already represented by canonical events: " + plan.duplicates + " (canonical events win; no duplicates imported)");
  console.log("Import fingerprint: " + plan.hash);
}
async function adminServices() {
  const projectId = required(values.project, "--project");
  if (values["confirm-project"] !== projectId) throw new Error("Pass --confirm-project with the same project ID. No remote action was taken.");
  const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST);
  if (emulator && (!projectId.startsWith("demo-") || !process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST)) throw new Error("Rehearsals require BOTH emulators and a demo- project ID.");
  const { initializeApp, cert } = await import("firebase-admin/app");
  let credential;
  if (!emulator) {
    const credentials = JSON.parse(await readFile(required(process.env.GOOGLE_APPLICATION_CREDENTIALS, "GOOGLE_APPLICATION_CREDENTIALS"), "utf8"));
    if (credentials.project_id !== projectId) throw new Error("The service account belongs to a different project.");
    credential = cert(credentials);
  }
  const app = initializeApp({ projectId, ...(credential ? { credential } : {}) });
  const { getAuth } = await import("firebase-admin/auth");
  const { getFirestore } = await import("firebase-admin/firestore");
  return { app, auth: getAuth(app), store: getFirestore(app) };
}
function reference(store, uid, name, id) { return name === "profiles" ? store.doc("users/" + uid) : store.doc("users/" + uid + "/" + name + "/" + id); }
async function remoteRows(store, uid, name) {
  if (name === "profiles") { const profile = await store.doc("users/" + uid).get(); return profile.exists ? [profile.data()] : []; }
  const snapshot = await store.collection("users/" + uid + "/" + name).get();
  return snapshot.docs.map(document => document.data());
}
async function verify(store, plan) {
  for (const name of collections) {
    const actual = await remoteRows(store, plan.uid, name);
    if (actual.length !== plan.tables[name].length || rowDigest(actual) !== rowDigest(plan.tables[name])) throw new Error("Verification failed for " + name + ". Source Supabase data is untouched; do not activate or delete it.");
    console.log("Verified " + name + ": " + actual.length);
  }
}
async function importPlan(services, plan) {
  const { store, auth } = services;
  const marker = store.doc("_migrations/" + plan.uid);
  const checkpoint = await marker.get();
  const access = await store.doc("access/" + plan.uid).get();
  if (access.data()?.enabled === true) throw new Error("Refusing to overwrite an active workspace.");
  if (checkpoint.exists && checkpoint.data().hash !== plan.hash) throw new Error("This target contains a different migration. Use a fresh target; do not overwrite it.");
  if (!checkpoint.exists) for (const name of collections) if ((await remoteRows(store, plan.uid, name)).length) throw new Error("Target workspace is not empty. Refusing to overwrite it.");
  let user;
  try { user = await auth.getUser(plan.uid); } catch (error) { if (error.code !== "auth/user-not-found") throw error; }
  if (user && (user.email?.toLowerCase() !== plan.snapshot.user.email.toLowerCase() || !user.disabled)) throw new Error("Existing target account must have the same email and be disabled before import.");
  if (!user) await auth.createUser({ uid: plan.uid, email: plan.snapshot.user.email, emailVerified: plan.snapshot.user.emailVerified === true, disabled: true });
  await marker.set({ hash: plan.hash, status: "importing", source_exported_at: plan.snapshot.exportedAt });
  const records = collections.flatMap(name => plan.tables[name].map(row => ({ name, row })));
  for (let offset = 0; offset < records.length; offset += 400) {
    const batch = store.batch();
    records.slice(offset, offset + 400).forEach(({ name, row }) => batch.set(reference(store, plan.uid, name, row.id), row));
    await batch.commit();
  }
  await verify(store, plan);
  await marker.update({ status: "verified" });
  console.log("Import verified. Account remains disabled and unapproved. Run activate only when ready to cut over.");
}
async function main() {
  if (values.help || !command) {
    console.log("Commands: export --out <new-file> | plan --input <snapshot> | import|verify|activate --input <snapshot> --project <id> --confirm-project <id> [--firebase-uid <uid>]. See docs/firebase-migration.md.");
    return;
  }
  if (command === "export") { await exportSnapshot(); return; }
  if (!["plan", "import", "verify", "activate"].includes(command)) throw new Error("Unknown command.");
  const plan = await buildPlan();
  printPlan(plan);
  if (command === "plan") { console.log("Dry run complete. No network calls or writes."); return; }
  const services = await adminServices();
  try {
    if (command === "import") await importPlan(services, plan);
    else {
      await verify(services.store, plan);
      if (command === "activate") {
        const marker = services.store.doc("_migrations/" + plan.uid);
        const checkpoint = await marker.get();
        if (checkpoint.data()?.hash !== plan.hash || !["verified", "activated"].includes(checkpoint.data()?.status)) throw new Error("This snapshot has not passed the import verification checkpoint.");
        await services.auth.updateUser(plan.uid, { disabled: false });
        await services.store.doc("access/" + plan.uid).set({ enabled: true });
        await marker.update({ status: "activated" });
        console.log("Account enabled and approved. Use Firebase Authentication to send a password-reset email; Supabase passwords and sessions were not copied.");
      }
    }
  } finally { const { deleteApp } = await import("firebase-admin/app"); await deleteApp(services.app); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
