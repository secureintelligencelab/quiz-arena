/* ---------------------------------------------------------------------------
   db.js — one small API over two backends.

   "cloud"  Firestore, so the teacher's laptop, the projector and every
            student phone see the same quiz at the same moment.
   "local"  localStorage in one browser, for setting up questions on a train
            or running a class when the wifi is down.

   Paths are slash-separated, Firestore style:
     classes/9A                      -> a document
     classes/9A/students             -> a collection
     classes/9A/students/9A-01       -> a document
--------------------------------------------------------------------------- */

import { FIREBASE_CONFIG, BOOTSTRAP_ADMIN_UIDS, SDK_VERSION, FIRESTORE_DATABASE_ID } from './config.js';

const SDK = `https://www.gstatic.com/firebasejs/${SDK_VERSION || '10.12.2'}`;
const LOCAL_KEY = 'quizarena:store';

export const db = {
  mode: 'local',
  uid: null,
  isAdmin: false,
  ready: false,
  /** Set when signed in with an email account rather than anonymously. */
  email: null,
  isAnonymous: true,
  /** Set when the cloud start fails, so the interface can say what went wrong
      instead of quietly pretending nothing happened. */
  lastError: null
};

/** Turns a Firebase error into something a teacher can act on. */
export function explain(err) {
  const code = err?.code || '';
  const hints = {
    'auth/operation-not-allowed': 'Anonymous sign-in is switched off. Firebase console: Authentication, Sign-in method, Anonymous, Enable.',
    'auth/configuration-not-found': 'This project has no Authentication set up yet. Open Authentication in the Firebase console and click Get started, then enable Anonymous.',
    'auth/api-key-not-valid': 'The apiKey in js/config.js does not match this project. Copy the config again from Project settings.',
    'auth/invalid-api-key': 'The apiKey in js/config.js is not valid. Copy the config again from Project settings.',
    'auth/network-request-failed': 'The browser could not reach Firebase. Check the connection, and any blocker or school firewall.',
    'permission-denied': 'Firestore rules refused that. Either the rules in firestore.rules are not published, or this device is not a teacher yet.',
    'unavailable': 'Firestore could not be reached. Most often the database has not been created yet, or a blocker is stopping the connection.',
    'not-found': 'That Firestore database does not exist. Create one in the console, or set FIRESTORE_DATABASE_ID in js/config.js if you named it something other than (default).',
    'failed-precondition': 'Firestore rejected the request. If you created the database in Datastore mode, it needs to be Native mode.'
  };
  return {
    code: code || 'unknown',
    message: err?.message || String(err),
    hint: hints[code] || null
  };
}

let fs = null;          // firestore module namespace
let store = null;       // firestore instance
let authMod = null;     // auth module namespace
let authInst = null;    // auth instance
let local = null;       // { [path]: data }
const listeners = new Set();
let channel = null;

/* ---------- boot ----------------------------------------------------- */

export function hasCloudConfig() {
  return Boolean(FIREBASE_CONFIG && FIREBASE_CONFIG.projectId && FIREBASE_CONFIG.apiKey);
}

export async function initDb({ preferLocal = false } = {}) {
  if (db.ready) return db;

  if (!preferLocal && hasCloudConfig()) {
    let stage = 'downloading the Firebase code';
    try {
      const [{ initializeApp }, auth, firestore] = await Promise.all([
        import(`${SDK}/firebase-app.js`),
        import(`${SDK}/firebase-auth.js`),
        import(`${SDK}/firebase-firestore.js`)
      ]);

      stage = 'starting Firebase';
      const app = initializeApp(FIREBASE_CONFIG);
      fs = firestore;
      store = FIRESTORE_DATABASE_ID
        ? firestore.getFirestore(app, FIRESTORE_DATABASE_ID)
        : firestore.getFirestore(app);

      stage = 'signing in';
      authMod = auth;
      authInst = auth.getAuth(app);

      // A teacher who signed in with an email address last time is still
      // signed in, so restore that session rather than replacing it with a
      // fresh anonymous one.
      const existing = await new Promise((resolve) => {
        const stop = auth.onAuthStateChanged(authInst, (u) => { stop(); resolve(u); });
      });
      const user = existing || (await auth.signInAnonymously(authInst)).user;

      db.uid = user.uid;
      db.email = user.email || null;
      db.isAnonymous = user.isAnonymous !== false;
      db.mode = 'cloud';
      db.ready = true;

      // A failure from here on is a Firestore problem, not a connection one.
      // Stay in cloud mode and report it rather than dropping to local, which
      // would silently hide a rules or database mistake.
      stage = 'reading the teacher list';
      db.isAdmin = await checkAdmin(db.uid);
      return db;
    } catch (err) {
      const info = explain(err);
      db.lastError = { stage, ...info };
      console.error(`Quiz Arena: failed while ${stage}.`, info.code, info.message, err);
      if (db.ready) return db;          // signed in, but Firestore misbehaved
    }
  }

  local = readLocal();
  db.mode = 'local';
  db.uid = localId();
  db.isAdmin = true;                      // single-device mode: you are the teacher
  db.ready = true;
  if ('BroadcastChannel' in window) {
    channel = new BroadcastChannel('quizarena');
    channel.onmessage = () => { local = readLocal(); fire(); };
  }
  window.addEventListener('storage', (e) => {
    if (e.key === LOCAL_KEY) { local = readLocal(); fire(); }
  });
  return db;
}

async function checkAdmin(uid) {
  if (BOOTSTRAP_ADMIN_UIDS.includes(uid)) return true;
  try {
    const snap = await fs.getDoc(fs.doc(store, 'admins', uid));
    db.lastError = null;
    return snap.exists();
  } catch (err) {
    db.lastError = { stage: 'reading the teacher list', ...explain(err) };
    console.error('Quiz Arena: could not read the teacher list.', err);
    return false;
  }
}

/* ---------- teacher sign-in ---------------------------------------------- */

/**
 * Signs in with an email account. This is the only route to the teacher
 * console: the account's UID must already be listed in `admins`, which can
 * only be done from the Firebase console.
 */
export async function signInTeacher(email, password) {
  if (db.mode !== 'cloud') throw new Error('Not connected to Firebase.');
  const cred = await authMod.signInWithEmailAndPassword(authInst, email.trim(), password);
  db.uid = cred.user.uid;
  db.email = cred.user.email;
  db.isAnonymous = false;
  db.isAdmin = await checkAdmin(db.uid);
  return db;
}

/** Drops back to an anonymous session. */
export async function signOutTeacher() {
  if (db.mode !== 'cloud') return;
  await authMod.signOut(authInst);
}

/** Everything the diagnostics page needs, without exposing the SDK itself. */
export const internals = {
  sdkBase: () => SDK,
  raw: () => ({ fs, store })
};

/** Re-read the teacher flag, e.g. after they add their UID in the console. */
export async function refreshRole() {
  if (db.mode === 'cloud') db.isAdmin = await checkAdmin(db.uid);
  return db.isAdmin;
}

function localId() {
  let id = localStorage.getItem('quizarena:device');
  if (!id) { id = 'device-' + Math.random().toString(36).slice(2, 10); localStorage.setItem('quizarena:device', id); }
  return id;
}

function readLocal() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || {}; }
  catch { return {}; }
}

function writeLocal() {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(local));
  if (channel) channel.postMessage(1);
  fire();
}

// Snapshot first: a listener may re-subscribe while we are notifying.
function fire() { [...listeners].forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); }

/* ---------- reads ---------------------------------------------------- */

export async function get(path) {
  if (db.mode === 'cloud') {
    const snap = await fs.getDoc(fs.doc(store, path));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  }
  const v = local[path];
  return v ? { id: lastSeg(path), ...v } : null;
}

export async function list(collPath) {
  if (db.mode === 'cloud') {
    const snap = await fs.getDocs(fs.collection(store, collPath));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  return localChildren(collPath);
}

function localChildren(collPath) {
  const prefix = collPath + '/';
  return Object.keys(local)
    .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
    .map((k) => ({ id: k.slice(prefix.length), ...local[k] }));
}

/* ---------- writes --------------------------------------------------- */

export async function set(path, data, { merge = true } = {}) {
  const clean = strip(data);
  if (db.mode === 'cloud') {
    await fs.setDoc(fs.doc(store, path), clean, { merge });
    return;
  }
  local[path] = merge ? { ...(local[path] || {}), ...clean } : clean;
  writeLocal();
}

export async function del(path) {
  if (db.mode === 'cloud') {
    await fs.deleteDoc(fs.doc(store, path));
    return;
  }
  delete local[path];
  // remove anything nested beneath it too
  Object.keys(local).forEach((k) => { if (k.startsWith(path + '/')) delete local[k]; });
  writeLocal();
}

export async function delCollection(collPath) {
  if (db.mode === 'cloud') {
    const snap = await fs.getDocs(fs.collection(store, collPath));
    await Promise.all(snap.docs.map((d) => fs.deleteDoc(d.ref)));
    return;
  }
  Object.keys(local).forEach((k) => { if (k.startsWith(collPath + '/')) delete local[k]; });
  writeLocal();
}

/** Write many documents at once. Each item needs an `id`. */
export async function bulkSet(collPath, items, { merge = true } = {}) {
  if (db.mode === 'cloud') {
    for (let i = 0; i < items.length; i += 400) {
      const batch = fs.writeBatch(store);
      items.slice(i, i + 400).forEach(({ id, ...rest }) => {
        batch.set(fs.doc(store, `${collPath}/${id}`), strip(rest), { merge });
      });
      await batch.commit();
    }
    return;
  }
  items.forEach(({ id, ...rest }) => {
    const p = `${collPath}/${id}`;
    local[p] = merge ? { ...(local[p] || {}), ...strip(rest) } : strip(rest);
  });
  writeLocal();
}

/* ---------- live updates --------------------------------------------- */

export function watchDoc(path, cb, onError) {
  if (db.mode === 'cloud') {
    return fs.onSnapshot(
      fs.doc(store, path),
      (s) => cb(s.exists() ? { id: s.id, ...s.data() } : null),
      (err) => reportWatchError(path, err, onError)
    );
  }
  const run = () => { const v = local[path]; cb(v ? { id: lastSeg(path), ...v } : null); };
  listeners.add(run); run();
  return () => listeners.delete(run);
}

export function watchList(collPath, cb, onError) {
  if (db.mode === 'cloud') {
    return fs.onSnapshot(
      fs.collection(store, collPath),
      (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (err) => reportWatchError(collPath, err, onError)
    );
  }
  const run = () => cb(localChildren(collPath));
  listeners.add(run); run();
  return () => listeners.delete(run);
}

/* A live read that fails just stops delivering, which looks exactly like
   "nobody has answered yet". Never let that happen quietly again. */
function reportWatchError(path, err, onError) {
  const info = explain(err);
  console.error(`Quiz Arena: live read of ${path} failed.`, info.code, info.message);
  db.lastError = { stage: `watching ${path}`, ...info };
  if (typeof onError === 'function') onError(info);
}

/* ---------- helpers --------------------------------------------------- */

function lastSeg(path) { return path.split('/').pop(); }
function round2(n) { return Math.round(n * 100) / 100; }

/** Firestore rejects undefined; drop those keys everywhere. */
function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = strip(v);
    return out;
  }
  return value;
}

/** Everything in local mode, for the backup/export button. */
export function dumpLocal() { return readLocal(); }
export function loadLocal(obj) { local = obj || {}; writeLocal(); }
