import { getApp, getApps, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { connectFirestoreEmulator, initializeFirestore } from "firebase/firestore";

export const cloudConfigured = process.env.NEXT_PUBLIC_DATA_MODE !== "local";
const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};
export const firebaseConfigurationError = Object.values(config).every(Boolean) ? "" : "Firebase is not configured. Add the four NEXT_PUBLIC_FIREBASE_* settings and rebuild. Local demo mode must be explicitly enabled with NEXT_PUBLIC_DATA_MODE=local.";
let services: { auth: ReturnType<typeof getAuth>; store: ReturnType<typeof initializeFirestore> } | undefined;

export function getFirebase() {
  if (typeof window === "undefined") throw new Error("Firebase browser services cannot run on the server.");
  if (firebaseConfigurationError) throw new Error(firebaseConfigurationError);
  if (!services) {
    const app = getApps().length ? getApp() : initializeApp(config);
    const auth = getAuth(app);
    // Some browser networks buffer Firestore's streaming responses for tens of seconds.
    const store = initializeFirestore(app, { experimentalForceLongPolling: true });
    if (process.env.NEXT_PUBLIC_FIREBASE_EMULATORS === "true") {
      if (!config.projectId?.startsWith("demo-")) throw new Error("Emulators require a demo- project ID.");
      connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
      connectFirestoreEmulator(store, "127.0.0.1", 8080);
    }
    services = { auth, store };
  }
  return services;
}
