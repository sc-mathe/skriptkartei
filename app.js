(() => {
"use strict";

const APP_VERSION = "1.3.0";
const SUPABASE_URL = "https://bdzqbwfgofulcbcprzwt.supabase.co";
const SUPABASE_KEY = "sb_publishable_ReY8EG0t4YvPpIvL6xC_NA_tVY_Q7NJ";   // öffentlicher Schlüssel; Schutz über Zugriffsregeln in der Datenbank

/* ============================================================
   Wiederholungs-Algorithmus: FSRS-5 (Standardparameter, wie in Anki)
   ============================================================ */
const W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
           1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
const DECAY = -0.5, FACTOR = 19 / 81;
const LEARN_STEPS = [1, 10];     // Minuten
const RELEARN_STEPS = [10];      // Minuten
const MIN = 60000, DAY = 86400000, LEARN_AHEAD = 20 * MIN;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const initD = g => clamp(W[4] - Math.exp(W[5] * (g - 1)) + 1, 1, 10);
// Startstabilität. Für „Einfach“ bei einer neuen Karte so gewählt, dass der erste Abstand
// genau cfg.easyDays Tage beträgt (FSRS-Standard wären gut zwei Wochen).
function initS(g, cfg) {
  if (g === 4 && cfg && cfg.easyDays) return cfg.easyDays * FACTOR / (Math.pow(cfg.retention, 1 / DECAY) - 1);
  return Math.max(W[g - 1], 0.1);
}
function nextD(d, g) {
  const d1 = d + (-W[6] * (g - 3)) * (10 - d) / 9;
  return clamp(W[7] * initD(4) + (1 - W[7]) * d1, 1, 10);
}
const retrievability = (t, s) => Math.pow(1 + FACTOR * t / s, DECAY);
function recallS(d, s, r, g) {
  const hard = g === 2 ? W[15] : 1, easy = g === 4 ? W[16] : 1;
  return s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp((1 - r) * W[10]) - 1) * hard * easy);
}
function forgetS(d, s, r) {
  const f = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]);
  return Math.min(f, s);
}
const shortS = (s, g) => s * Math.exp(W[17] * (g - 3 + W[18]));

// Tagesgrenze 4 Uhr morgens (wie Anki), lokale Zeit
function dayIndex(ms) {
  const off = new Date(ms).getTimezoneOffset() * MIN;
  return Math.floor((ms - off - 4 * 3600000) / DAY);
}
function ivlDays(s, cfg) {
  const ivl = s / FACTOR * (Math.pow(cfg.retention, 1 / DECAY) - 1);
  return clamp(Math.round(ivl), 1, cfg.maxIvl);
}
// kleine, reproduzierbare Streuung, damit nicht alle Karten am selben Tag fällig werden
function fuzz(ivl, seed) {
  if (ivl < 7) return ivl;          // kurze Abstände bleiben exakt
  let h = 2166136261;
  for (const ch of seed) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  const u = ((h >>> 0) % 10000) / 10000;
  const span = Math.max(1, Math.round(ivl * 0.05));
  return ivl + Math.round((u * 2 - 1) * span);
}

/** Pure Funktion: neuer Kartenzustand nach Bewertung g (1 Nochmal … 4 Einfach). */
function schedule(prev, g, now, cfg, seed) {
  const st = prev && prev.s && prev.s !== "new" ? { ...prev } : { s: "new", reps: 0, lapses: 0 };
  const today = dayIndex(now);
  const out = { ...st, reps: (st.reps || 0) + 1, last: now };
  if (!st.first) out.first = now;

  const toReview = (S, minDays) => {
    let d = Math.max(ivlDays(S, cfg), minDays || 1);
    d = clamp(fuzz(d, seed + ":" + out.reps), 1, cfg.maxIvl);
    out.s = "review"; out.step = 0; out.ivl = d; out.dueDay = today + d; delete out.due;
  };
  const toStep = (steps, i, minutes) => {
    out.step = i; out.due = now + (minutes ?? steps[Math.min(i, steps.length - 1)]) * MIN; delete out.dueDay;
  };

  if (st.s === "new") {
    out.S = initS(g, cfg); out.D = initD(g);
    if (g === 4) {
      // „Einfach“ soll nie früher wiederkommen als „Gut“ nach den Lernschritten
      const goodGrad = ivlDays(shortS(initS(3, cfg), 3), cfg);
      toReview(out.S, goodGrad + 1); return out;
    }
    out.s = "learning";
    if (g === 1) toStep(LEARN_STEPS, 0);
    else if (g === 2) toStep(LEARN_STEPS, 0, (LEARN_STEPS[0] + LEARN_STEPS[1]) / 2);
    else if (LEARN_STEPS.length > 1) toStep(LEARN_STEPS, 1);
    else toReview(out.S);
    return out;
  }

  if (st.s === "learning" || st.s === "relearning") {
    const steps = st.s === "learning" ? LEARN_STEPS : RELEARN_STEPS;
    out.S = shortS(st.S, g); out.D = nextD(st.D, g);
    if (g === 1) { toStep(steps, 0); return out; }
    if (g === 2) { toStep(steps, st.step || 0, st.step === 0 && steps.length > 1 ? (steps[0] + steps[1]) / 2 : undefined); return out; }
    if (g === 4) { toReview(out.S, st.s === "relearning" ? 1 : 2); return out; }
    const next = (st.step || 0) + 1;
    if (next < steps.length) toStep(steps, next);
    else toReview(out.S);
    return out;
  }

  // Wiederholung (review)
  const elapsed = Math.max(0, today - dayIndex(st.last || now));
  const r = retrievability(elapsed, st.S);
  out.D = nextD(st.D, g);
  if (g === 1) {
    out.S = forgetS(st.D, st.S, r); out.lapses = (st.lapses || 0) + 1;
    out.s = "relearning"; toStep(RELEARN_STEPS, 0);
    return out;
  }
  // Intervalle für Schwer < Gut < Einfach erzwingen
  const sH = recallS(st.D, st.S, r, 2), sG = recallS(st.D, st.S, r, 3), sE = recallS(st.D, st.S, r, 4);
  let iH = ivlDays(sH, cfg), iG = ivlDays(sG, cfg), iE = ivlDays(sE, cfg);
  iH = Math.min(iH, iG); iG = Math.max(iG, iH + 1); iE = Math.max(iE, iG + 1);
  const pick = { 2: [sH, iH], 3: [sG, iG], 4: [sE, iE] }[g];
  out.S = pick[0];
  const d = clamp(fuzz(Math.min(pick[1], cfg.maxIvl), seed + ":" + out.reps), 1, cfg.maxIvl);
  out.s = "review"; out.step = 0; out.ivl = d; out.dueDay = today + d; delete out.due;
  return out;
}

function fmtWhen(st, now) {
  if (st.s === "review") {
    const d = st.ivl;
    if (d < 30) return d === 1 ? "1 Tag" : d + " Tage";
    if (d < 365) return (d / 30).toFixed(1).replace(".", ",").replace(/,0$/, "") + " Mt.";
    return (d / 365).toFixed(1).replace(".", ",").replace(/,0$/, "") + " J.";
  }
  const m = Math.max(1, Math.round((st.due - now) / MIN));
  return m < 60 ? m + " Min" : Math.round(m / 60) + " Std";
}

/* ============================================================
   Lokaler Speicher (offline zuerst)
   ============================================================ */
const LS = {
  get(k, fallback) { try { const v = localStorage.getItem("sk." + k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem("sk." + k, JSON.stringify(v)); } catch { toast("Gerätespeicher voll: Änderungen werden nicht gespeichert."); } },
  del(k) { try { localStorage.removeItem("sk." + k); } catch {} },
};

// v2: kürzere Abstände (Ziel 95 % statt 90 %, „Einfach“ bei neuen Karten 4 statt 6 Tage)
const DEFAULTS = { retention: 0.95, newPerDay: 20, maxIvl: 180, easyDays: 4, v: 2 };
const S = {
  decks: LS.get("decks", {}),              // deckId -> {course, courseName, chapter, title, order, cards}
  progress: LS.get("progress", {}),        // cardId -> {deck, state, t, dirty}
  settings: LS.get("settings", { data: { ...DEFAULTS }, t: 0, dirty: false }),
  cursors: LS.get("cursors", { decks: null, progress: null }),
  uid: LS.get("uid", null),
  email: LS.get("email", ""),
  lastSync: LS.get("lastSync", 0),
  session: null, authChecked: false, syncing: false, syncAgain: false, syncError: null, noAccess: false,
  view: "home", study: null, undo: null,
  login: { step: "email", busy: false, err: "" },
};
const cfg = () => ({ ...DEFAULTS, ...S.settings.data });
// Ältere Einstellungen einmalig auf die kürzeren Abstände umstellen (nur Werte, die noch auf dem alten Standard stehen)
function migrateSettings() {
  const d = S.settings.data || {};
  if ((d.v || 1) >= 2) return false;
  const next = { ...d, v: 2 };
  if (d.retention == null || d.retention === 0.9) next.retention = 0.95;
  if (d.easyDays == null || d.easyDays === 6) next.easyDays = 4;
  S.settings = { data: next, t: Math.max(Date.now(), S.settings.t + 1), dirty: true };
  LS.set("settings", S.settings);
  return true;
}
migrateSettings();
const saveProgress = () => LS.set("progress", S.progress);
const saveDecks = () => LS.set("decks", S.decks);

function resetLocal(uid) {
  S.decks = {}; S.progress = {}; S.cursors = { decks: null, progress: null };
  S.settings = { data: { ...DEFAULTS }, t: 0, dirty: false };
  S.uid = uid;
  saveDecks(); saveProgress(); LS.set("cursors", S.cursors); LS.set("settings", S.settings); LS.set("uid", uid);
}

/* ============================================================
   Hilfen
   ============================================================ */
const app = document.getElementById("app");
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ALLOWED = new Set(["B", "I", "EM", "STRONG", "UL", "OL", "LI", "BR", "P", "DIV", "SPAN", "SUP", "SUB", "DETAILS", "SUMMARY", "CODE"]);
function clean(html) {
  const doc = new DOMParser().parseFromString("<div>" + (html || "") + "</div>", "text/html");
  const root = doc.body.firstChild;
  (function walk(node) {
    for (const el of [...node.children]) {
      walk(el);
      if (!ALLOWED.has(el.tagName)) { el.replaceWith(...el.childNodes); continue; }
      for (const a of [...el.attributes]) if (!(el.tagName === "OL" && a.name === "type")) el.removeAttribute(a.name);
    }
  })(root);
  return root.innerHTML;
}
let mjChain = Promise.resolve();
function typeset(el) {
  mjChain = mjChain.then(async () => {
    for (let i = 0; i < 150 && !(window.MathJax && MathJax.typesetPromise); i++) await new Promise(r => setTimeout(r, 100));
    if (!(window.MathJax && MathJax.typesetPromise)) return;
    if (MathJax.startup && MathJax.startup.promise) await MathJax.startup.promise;
    if (el.isConnected) await MathJax.typesetPromise([el]);
  }).catch(() => {});
}
let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3500);
}
function relTime(ms) {
  if (!ms) return "noch nie";
  const m = Math.round((Date.now() - ms) / MIN);
  if (m < 1) return "gerade eben";
  if (m < 60) return "vor " + m + " Min";
  const h = Math.round(m / 60);
  if (h < 24) return "vor " + h + " Std";
  return new Date(ms).toLocaleString("de-CH", { dateStyle: "short", timeStyle: "short" });
}

/* ============================================================
   Zählen & nächste Karte
   ============================================================ */
const isNew = st => !st || !st.s || st.s === "new";
const stateOf = id => (S.progress[id] ? S.progress[id].state : null);
function newIntroducedToday(now) {
  const today = dayIndex(now); let n = 0;
  for (const p of Object.values(S.progress)) if (p.state && p.state.first && dayIndex(p.state.first) === today) n++;
  return n;
}
function learnedToday(now) {
  const today = dayIndex(now); let n = 0;
  for (const p of Object.values(S.progress)) if (p.state && p.state.last && dayIndex(p.state.last) === today) n++;
  return n;
}
const sortedDecks = () => Object.entries(S.decks).sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0));

function stats(deckIds, now) {
  const today = dayIndex(now);
  const endOfDay = (today + 1) * DAY + new Date(now).getTimezoneOffset() * MIN + 4 * 3600000;
  let neu = 0, lern = 0, faellig = 0;
  for (const id of deckIds) {
    const deck = S.decks[id]; if (!deck) continue;
    for (const c of deck.cards || []) {
      const st = stateOf(c.id);
      if (isNew(st)) neu++;
      else if (st.s === "review") { if (st.dueDay <= today) faellig++; }
      else if (st.due <= endOfDay) lern++;
    }
  }
  const room = Math.max(0, cfg().newPerDay - newIntroducedToday(now));
  return { neu: Math.min(neu, room), lern, faellig };
}

function pickNext(sess, now) {
  const today = dayIndex(now);
  let learnNow = null, learnSoon = null, review = null, fresh = null, learnLater = null;
  for (const id of sess.deckIds) {
    const deck = S.decks[id]; if (!deck) continue;
    for (const c of deck.cards || []) {
      const st = stateOf(c.id);
      const item = { deckId: id, card: c };
      if (isNew(st)) { if (!fresh) fresh = item; continue; }
      if (st.s === "review") {
        if (st.dueDay <= today && (!review || st.dueDay < review.key)) review = { ...item, key: st.dueDay };
        continue;
      }
      if (st.due <= now) { if (!learnNow || st.due < learnNow.key) learnNow = { ...item, key: st.due }; }
      else if (st.due <= now + LEARN_AHEAD) { if (!learnSoon || st.due < learnSoon.key) learnSoon = { ...item, key: st.due }; }
      else if (!learnLater || st.due < learnLater.key) learnLater = { ...item, key: st.due };
    }
  }
  if (cfg().newPerDay - newIntroducedToday(now) <= 0) fresh = null;
  if (learnNow) return learnNow;
  if (review && fresh) return sess.answered % 4 === 3 ? fresh : review;
  if (review) return review;
  if (fresh) return fresh;
  if (learnSoon) return learnSoon;
  if (learnLater) return { wait: learnLater.key };
  return null;
}

/* ============================================================
   Synchronisation mit Supabase
   ============================================================ */
const sb = window.supabase && window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit", storageKey: "sk.auth" },
});

let syncTimer = null;
function scheduleSync(ms = 2500) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }

async function selectAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

async function sync() {
  if (!sb || !S.session || !navigator.onLine) { renderSync(); return; }
  if (S.syncing) { S.syncAgain = true; return; }
  S.syncing = true; S.syncError = null; renderSync();
  try {
    // 1. eigene Bewertungen hochladen
    const dirty = Object.entries(S.progress).filter(([, p]) => p.dirty);
    for (let i = 0; i < dirty.length; i += 200) {
      const chunk = dirty.slice(i, i + 200);
      const rows = chunk.map(([id, p]) => ({ card_id: id, deck_id: p.deck, state: p.state, t: p.t }));
      const { error } = await sb.rpc("push_progress", { rows });
      if (error) throw error;
      for (const [id, p] of chunk) if (S.progress[id] && S.progress[id].t === p.t) S.progress[id].dirty = false;
    }
    if (dirty.length) saveProgress();
    if (S.settings.dirty) {
      const sent = S.settings.t;
      const { error } = await sb.rpc("push_settings", { p_data: S.settings.data, p_t: sent });
      if (error) throw error;
      if (S.settings.t === sent) { S.settings.dirty = false; LS.set("settings", S.settings); }
    }

    // 2. Karten holen (nur geänderte), gelöschte Kapitel entfernen
    let decksChanged = false;
    const ids = await selectAll(() => sb.from("decks").select("id").order("id"));
    if (!ids.length) S.noAccess = true; else S.noAccess = false;
    const idSet = new Set(ids.map(r => r.id));
    for (const id of Object.keys(S.decks)) if (!idSet.has(id)) { delete S.decks[id]; decksChanged = true; }
    const missing = [...idSet].filter(id => !S.decks[id]);
    const deckQuery = () => {
      let q = sb.from("decks").select("id,data,updated_at").order("updated_at");
      if (S.cursors.decks && !missing.length) q = q.gt("updated_at", S.cursors.decks);
      return q;
    };
    const deckRows = idSet.size ? await selectAll(deckQuery) : [];
    for (const r of deckRows) {
      S.decks[r.id] = r.data; decksChanged = true;
      if (!S.cursors.decks || r.updated_at > S.cursors.decks) S.cursors.decks = r.updated_at;
    }
    if (decksChanged) saveDecks();

    // 3. Lernstand der anderen Geräte holen (neuere Bewertung gewinnt)
    const since = S.cursors.progress ? new Date(new Date(S.cursors.progress).getTime() - 120000).toISOString() : null;
    const prog = await selectAll(() => {
      let q = sb.from("progress").select("card_id,deck_id,state,t,updated_at").order("updated_at");
      if (since) q = q.gt("updated_at", since);
      return q;
    });
    let progChanged = false;
    for (const r of prog) {
      const local = S.progress[r.card_id];
      if (!local || Number(r.t) > local.t) { S.progress[r.card_id] = { deck: r.deck_id, state: r.state, t: Number(r.t), dirty: false }; progChanged = true; }
      if (!S.cursors.progress || r.updated_at > S.cursors.progress) S.cursors.progress = r.updated_at;
    }
    if (progChanged) saveProgress();

    const { data: set, error: setErr } = await sb.from("settings").select("data,t").maybeSingle();
    if (setErr) throw setErr;
    if (set && Number(set.t) > S.settings.t) { S.settings = { data: { ...S.settings.data, ...set.data }, t: Number(set.t), dirty: false }; LS.set("settings", S.settings); }
    if (migrateSettings()) scheduleSync(500);

    LS.set("cursors", S.cursors);
    S.lastSync = Date.now(); LS.set("lastSync", S.lastSync);
    if (decksChanged || progChanged) { if (S.view === "home") render(); else if (S.study && !S.study.current) nextCard(); }
  } catch (e) {
    S.syncError = (e && (e.message || e.code)) || "Unbekannter Fehler";
    if (/JWT|token|auth/i.test(S.syncError)) { const { data } = await sb.auth.getSession(); S.session = data.session; }
  } finally {
    S.syncing = false; renderSync();
    if (S.view === "home") render();
    if (S.syncAgain) { S.syncAgain = false; scheduleSync(500); }
  }
}

/* ============================================================
   Anmeldung (Link per E-Mail, einmal pro Gerät)
   ============================================================ */
const APP_URL = location.origin + location.pathname;
async function sendLink(email) {
  S.login.busy = true; S.login.err = ""; render();
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: APP_URL } });
  S.login.busy = false;
  if (error) {
    S.login.err = /rate|limit|seconds/i.test(error.message)
      ? "Es wurden gerade zu viele Mails verschickt. Warte ein paar Minuten und versuch es nochmal."
      : "Die Mail konnte nicht verschickt werden: " + error.message;
  } else { S.email = email; LS.set("email", email); S.login.step = "sent"; }
  render();
}
// Fehler aus einem abgelaufenen oder schon benutzten Anmelde-Link anzeigen
(function readLinkError() {
  const h = new URLSearchParams(location.hash.slice(1));
  const err = h.get("error_description") || h.get("error");
  if (err) {
    S.login.err = /expired|invalid/i.test(err)
      ? "Der Anmelde-Link ist abgelaufen oder wurde schon benutzt. Fordere einen neuen an."
      : "Anmeldung fehlgeschlagen: " + err.replace(/\+/g, " ");
    history.replaceState(null, "", APP_URL);
  }
})();
function onSession(session) {
  S.session = session; S.authChecked = true;
  if (session) {
    if (S.uid && S.uid !== session.user.id) resetLocal(session.user.id);
    else if (!S.uid) { S.uid = session.user.id; LS.set("uid", S.uid); }
    S.login = { step: "email", busy: false, err: "" }; S.forceLogin = false;
    sync();
  }
  render();
}
async function logout() {
  const unsynced = Object.values(S.progress).some(p => p.dirty) || S.settings.dirty;
  if (unsynced && !navigator.onLine) { toast("Erst online gehen: Es gibt noch nicht synchronisierte Bewertungen."); return; }
  if (unsynced) await sync();
  await sb.auth.signOut();
  resetLocal(null); S.session = null; S.view = "home"; S.study = null;
  document.getElementById("settings").close();
  render();
}

/* ============================================================
   Ansichten
   ============================================================ */
function renderSync() {
  const el = document.getElementById("sync"); if (!el) return;
  const dirty = Object.values(S.progress).filter(p => p.dirty).length + (S.settings.dirty ? 1 : 0);
  let dot = "", text = "";
  if (!navigator.onLine) { dot = "off"; text = dirty ? `Offline · ${dirty} warten` : "Offline"; }
  else if (!S.session) { dot = "off"; text = "Nicht angemeldet"; }
  else if (S.syncing) { dot = "busy"; text = "Synchronisiert …"; }
  else if (S.syncError) { dot = "busy"; text = "Sync-Fehler"; }
  else if (dirty) { dot = "busy"; text = `${dirty} warten`; }
  else { text = "Synchronisiert"; }
  el.innerHTML = `<span class="dot ${dot}"></span>${esc(text)}`;
  el.title = "Letzte Synchronisation: " + relTime(S.lastSync) + (S.syncError ? " · Fehler: " + S.syncError : "");
}

function render() {
  if (!S.authChecked) { app.innerHTML = ""; return; }
  if (!S.session && (S.forceLogin || !Object.keys(S.decks).length)) return renderLogin();
  if (S.view === "study" && S.study) return renderStudy();
  renderHome();
}

function renderLogin() {
  const L = S.login;
  const offline = !navigator.onLine;
  app.innerHTML = `<div class="wrap"><div class="login">
    <h1>Karteikarten</h1>
    ${L.step === "email" ? `
      <p>Melde dich einmal auf diesem Gerät an. Du bekommst einen Anmelde-Link per E-Mail, ein Passwort gibt es nicht. Danach bleibst du angemeldet und kannst auch offline lernen.</p>
      <form id="f-email"><label for="in-email">E-Mail-Adresse</label>
        <input id="in-email" type="email" autocomplete="email" required value="${esc(S.email)}" placeholder="name@beispiel.ch">
        <button class="primary" type="submit" ${L.busy || offline ? "disabled" : ""}>${L.busy ? "Wird gesendet …" : "Anmelde-Link senden"}</button></form>
      ${offline ? `<p class="small">Für die erste Anmeldung braucht das Gerät Internet.</p>` : ""}` : `
      <p>Wir haben eine Mail an <b>${esc(S.email)}</b> geschickt (Absender Supabase, Betreff „Confirm your email address“ oder „Your Magic Link“). Die Mail kann ein, zwei Minuten brauchen; schau auch im Spam-Ordner.</p>
      <p><b>Öffne den Link auf diesem Gerät.</b> Er öffnet die Karteikarten-App, und du bist angemeldet.</p>
      <button class="primary" type="button" id="reload">Ich habe den Link geöffnet</button>
      <p class="small"><button class="linkbtn" type="button" id="back-email">Neue Mail anfordern oder andere Adresse</button></p>`}
    ${L.err ? `<div class="err">${esc(L.err)}</div>` : ""}
    ${S.forceLogin && Object.keys(S.decks).length ? `<p class="small"><button class="linkbtn" type="button" id="cancel-login">Ohne Anmeldung weiterlernen</button></p>` : ""}
  </div></div>`;
  const f1 = document.getElementById("f-email");
  if (f1) f1.onsubmit = e => { e.preventDefault(); sendLink(document.getElementById("in-email").value.trim()); };
}

function countsHtml(c) {
  const cell = (n, cls) => `<span class="${n ? cls : "zero"}">${n}</span>`;
  return `<div class="counts">${cell(c.neu, "c-neu")}${cell(c.lern, "c-lern")}${cell(c.faellig, "c-faellig")}</div>`;
}

function renderHome() {
  const now = Date.now();
  const decks = sortedDecks();
  const all = stats(decks.map(d => d[0]), now);
  const totalDue = all.neu + all.lern + all.faellig;
  let banner = "";
  if (!S.session) banner = `<div class="banner">Auf diesem Gerät bist du abgemeldet. Lernen geht weiter, synchronisiert wird erst nach der Anmeldung. <button type="button" id="relogin">Anmelden</button></div>`;
  else if (S.noAccess && navigator.onLine) banner = `<div class="banner">Dieses Konto (${esc(S.session.user.email)}) hat keinen Zugriff auf die Karten. Melde dich mit der freigeschalteten E-Mail-Adresse an.</div>`;

  let body = "";
  if (!decks.length) {
    body = `<div class="empty"><h3>${S.syncing || !S.lastSync ? "Karten werden geladen …" : "Noch keine Karten"}</h3>
      <p>Hier erscheinen deine Fächer, z.B. „Analysis 1“ mit „Kapitel 3 – Konvergenz von Folgen“, jeweils mit neuen, gerade gelernten und fälligen Karten.</p>
      <p>Neue Karten kommen dazu, wenn du Claude ein Skript schickst und darum bittest, die Karten in die Karteikarten-App einzufügen.</p></div>`;
  } else {
    const byCourse = new Map();
    for (const [id, d] of decks) {
      if (!byCourse.has(d.courseName)) byCourse.set(d.courseName, []);
      byCourse.get(d.courseName).push([id, d]);
    }
    for (const [course, list] of byCourse) {
      body += `<section class="course"><div class="coursehead"><h2>${esc(course)}</h2>${countsHtml(stats(list.map(x => x[0]), now))}</div>
        <div class="rows">${list.map(([id, d]) => `<button class="row" type="button" data-study="${esc(id)}">
            <span class="name">${esc(d.title)}<small>${(d.cards || []).length} Karten</small></span>${countsHtml(stats([id], now))}</button>`).join("")}</div>
        <button class="linkbtn" type="button" data-study-course="${esc(course)}">Ganzes Fach lernen →</button></section>`;
    }
    body += `<div class="legend"><span><b class="c-neu">■</b> Neu (heute noch erlaubt)</span><span><b class="c-lern">■</b> Gerade in Lernschritten</span><span><b class="c-faellig">■</b> Zur Wiederholung fällig</span></div>`;
  }

  app.innerHTML = `<div class="wrap">
    <header class="top"><div class="topline"><div class="brand">Karteikarten</div>
      <button class="sync" type="button" id="sync"></button><button class="iconbtn" type="button" id="open-settings" aria-label="Einstellungen" title="Einstellungen">⚙</button></div>
      ${banner}</header>
    <div class="today">
      <div class="nums">
        <div class="num"><b class="c-neu">${all.neu}</b><span>Neu</span></div>
        <div class="num"><b class="c-lern">${all.lern}</b><span>Lernen</span></div>
        <div class="num"><b class="c-faellig">${all.faellig}</b><span>Fällig</span></div>
        <div class="num"><b>${learnedToday(now)}</b><span>Heute gelernt</span></div>
      </div>
      <button class="primary" type="button" id="study-all" ${totalDue ? "" : "disabled"}>${totalDue ? "Alles lernen" : "Heute nichts mehr fällig"}</button>
    </div>
    ${body}
    <footer class="note">Wiederholungen nach FSRS (wie Anki): Je nach Bewertung kommt eine Karte nach Minuten, Tagen oder Monaten wieder.
      Funktioniert auch offline; Bewertungen werden synchronisiert, sobald wieder Internet da ist.
      Tastatur: Leertaste = Antwort zeigen / Gut, 1–4 = bewerten, Z = rückgängig.</footer>
  </div>`;
  renderSync();
}

function startStudy(deckIds, label) {
  S.study = { deckIds, label, current: null, shown: false, answered: 0 };
  S.view = "study"; S.undo = null;
  nextCard();
}
function nextCard() {
  const s = S.study; if (!s) return;
  const pick = pickNext(s, Date.now());
  s.current = pick && !pick.wait ? pick : null;
  s.wait = pick && pick.wait ? pick.wait : null;
  s.shown = false;
  render();
  const sc = document.querySelector(".scroll"); if (sc) sc.scrollTop = 0;
}

let waitTimer = null;
function renderStudy() {
  const s = S.study, now = Date.now();
  const c = stats(s.deckIds, now);
  clearTimeout(waitTimer);
  let main, bar = "", kind = "";
  const cur = s.current;
  if (!cur) {
    if (s.wait) {
      const mins = Math.max(1, Math.round((s.wait - now) / MIN));
      waitTimer = setTimeout(nextCard, Math.min(60000, Math.max(5000, s.wait - now - LEARN_AHEAD)));
      main = `<div class="done"><h2>Kurze Pause</h2><p>Die nächste Karte aus deinen Lernschritten kommt in etwa ${mins} Minuten wieder dran. Du kannst die App offen lassen oder später zurückkommen.</p>
        <p><button class="primary" type="button" id="back">Zur Übersicht</button></p></div>`;
    } else {
      main = `<div class="done"><h2>Für heute geschafft</h2><p>In dieser Auswahl ist nichts mehr fällig. ${s.answered} Bewertungen in dieser Runde.</p>
        <p><button class="primary" type="button" id="back">Zur Übersicht</button></p></div>`;
    }
  } else {
    const deck = S.decks[cur.deckId], card = cur.card, st = stateOf(card.id);
    kind = isNew(st) ? "neu" : st.s === "review" ? "faellig" : "lern";
    main = `<article class="card t-${esc(card.typ)}" id="card">
      <div class="kopf"><b>${esc(card.typ)} ${esc(card.nr || "")}</b> <span class="where">· ${esc(deck.courseName)} › Kap. ${esc(deck.chapter)}</span></div>
      <div class="titel">${clean(card.titel)}</div>
      ${card.frage ? `<div class="frage">${clean(card.frage)}</div>` : ""}
      ${s.shown ? `<hr><div class="aussage">${clean(card.aussage)}</div>
        ${card.extra ? `<details><summary>Beweisidee / Bemerkungen</summary>${clean(card.extra)}</details>` : ""}
        <div class="seite">Skript S. ${esc(card.seite)} · Abschnitt ${esc(card.abschnitt)}</div>` : ""}
    </article>`;
    if (!s.shown) bar = `<button class="primary showbtn" type="button" id="show">Antwort zeigen</button><div class="hint">Leertaste</div>`;
    else {
      const labels = ["Nochmal", "Schwer", "Gut", "Einfach"];
      bar = `<div class="grades">${labels.map((l, i) => {
        const nx = schedule(st, i + 1, now, cfg(), card.id);
        return `<button class="grade g${i + 1}" type="button" data-grade="${i + 1}">${l}<small>${fmtWhen(nx, now)}</small></button>`;
      }).join("")}</div><div class="hint">1 Nochmal · 2 Schwer · 3 Gut (Leertaste) · 4 Einfach · Z rückgängig</div>`;
    }
  }
  const cell = (n, cls, key) => `<span class="${n ? cls : "zero"} ${kind === key ? "cur" : ""}">${n}</span>`;
  app.innerHTML = `<div class="study">
    <div class="studybar"><div class="wrap inner">
      <button class="iconbtn" type="button" id="back-top">← Übersicht</button>
      <div class="label">${esc(s.label)}</div>
      <div class="counts">${cell(c.neu, "c-neu", "neu")}${cell(c.lern, "c-lern", "lern")}${cell(c.faellig, "c-faellig", "faellig")}</div>
      ${S.undo ? `<button class="iconbtn" type="button" id="undo" title="Letzte Bewertung rückgängig (Z)" aria-label="Rückgängig">↶</button>` : ""}
    </div></div>
    <div class="scroll"><div class="wrap">${main}</div></div>
    ${bar ? `<div class="answerbar"><div class="wrap">${bar}</div></div>` : ""}
  </div>`;
  const el = document.getElementById("card");
  if (el) typeset(el);
}

/* ============================================================
   Aktionen
   ============================================================ */
function setCardState(deckId, cardId, state) {
  const prevT = S.progress[cardId] ? S.progress[cardId].t : 0;
  S.progress[cardId] = { deck: deckId, state, t: Math.max(Date.now(), prevT + 1), dirty: true };
  saveProgress();
  scheduleSync();
}
function grade(g) {
  const s = S.study; if (!s || !s.current || !s.shown) return;
  const { deckId, card } = s.current;
  const prev = stateOf(card.id);
  setCardState(deckId, card.id, schedule(prev, g, Date.now(), cfg(), card.id));
  S.undo = { deckId, cardId: card.id, prev };
  s.answered++;
  nextCard();
}
function undo() {
  const u = S.undo, s = S.study; if (!u || !s) return;
  setCardState(u.deckId, u.cardId, u.prev || { s: "new" });
  S.undo = null; s.answered = Math.max(0, s.answered - 1);
  s.current = { deckId: u.deckId, card: (S.decks[u.deckId].cards || []).find(c => c.id === u.cardId) };
  s.wait = null; s.shown = false;
  render();
}

document.addEventListener("click", e => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.id === "open-settings") return openSettings();
  if (t.id === "sync") { if (S.session) sync(); else toast("Zum Synchronisieren zuerst anmelden."); return; }
  if (t.id === "relogin") { S.forceLogin = true; return render(); }
  if (t.id === "back-email") { S.login.step = "email"; S.login.err = ""; return render(); }
  if (t.id === "cancel-login") { S.forceLogin = false; return render(); }
  if (t.id === "reload") { location.replace(APP_URL); return; }
  if (t.id === "study-all") return startStudy(sortedDecks().map(d => d[0]), "Alle Fächer");
  if (t.dataset.study) { const d = S.decks[t.dataset.study]; return startStudy([t.dataset.study], d.courseName + " › " + d.title); }
  if (t.dataset.studyCourse) return startStudy(sortedDecks().filter(([, d]) => d.courseName === t.dataset.studyCourse).map(x => x[0]), t.dataset.studyCourse);
  if (t.id === "back" || t.id === "back-top") { if (S.updateReady) return location.reload(); S.view = "home"; S.study = null; clearTimeout(waitTimer); return render(); }
  if (t.id === "show") { S.study.shown = true; return render(); }
  if (t.dataset.grade) return grade(+t.dataset.grade);
  if (t.id === "undo") return undo();
  if (t.id === "logout") return logout();
  if (t.id === "force-update") { if (!navigator.onLine) return toast("Für Updates braucht das Gerät Internet."); return forceUpdate(); }
});

document.addEventListener("keydown", e => {
  if (S.view !== "study" || !S.study || document.getElementById("settings").open) return;
  if (e.target.closest && e.target.closest("input, textarea")) return;
  const s = S.study;
  if (e.key === "z" || e.key === "Z") { e.preventDefault(); return undo(); }
  if (!s.current) return;
  if (!s.shown && (e.key === " " || e.key === "Enter")) { e.preventDefault(); s.shown = true; return render(); }
  if (s.shown) {
    if (["1", "2", "3", "4"].includes(e.key)) { e.preventDefault(); return grade(+e.key); }
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); return grade(3); }
  }
});

/* ---------- Einstellungen ---------- */
const dlg = document.getElementById("settings");
const rIn = document.getElementById("set-retention"), rVal = document.getElementById("set-retention-val");
rIn.addEventListener("input", () => (rVal.textContent = Math.round(rIn.value * 100) + " %"));
function openSettings() {
  const c = cfg();
  rIn.value = c.retention; rVal.textContent = Math.round(c.retention * 100) + " %";
  document.getElementById("set-new").value = c.newPerDay;
  document.getElementById("set-maxivl").value = c.maxIvl;
  document.getElementById("set-easy").value = c.easyDays;
  const cards = Object.values(S.decks).reduce((n, d) => n + (d.cards || []).length, 0);
  document.getElementById("set-meta").innerHTML = `
    <div>${S.session ? "Angemeldet als <b>" + esc(S.session.user.email) + "</b>" : "Nicht angemeldet"}</div>
    <div>${Object.keys(S.decks).length} Kapitel, ${cards} Karten auf diesem Gerät · Letzte Synchronisation: ${esc(relTime(S.lastSync))}</div>
    ${S.syncError ? `<div>Letzter Fehler: ${esc(S.syncError)}</div>` : ""}
    <div>Version ${APP_VERSION} <button class="linkbtn" type="button" id="force-update">Nach Updates suchen</button></div>
    ${S.session ? `<button class="ghost" type="button" id="logout">Auf diesem Gerät abmelden</button>` : ""}`;
  try { dlg.showModal(); } catch { dlg.setAttribute("open", ""); }
}
document.getElementById("set-cancel").onclick = () => dlg.close();
document.getElementById("set-save").onclick = () => {
  S.settings = {
    data: {
      retention: clamp(+rIn.value || 0.9, 0.8, 0.97),
      newPerDay: clamp(Math.round(+document.getElementById("set-new").value || 0), 0, 500),
      maxIvl: clamp(Math.round(+document.getElementById("set-maxivl").value || 180), 7, 3650),
      easyDays: clamp(Math.round(+document.getElementById("set-easy").value || 4), 1, 30),
      v: 2,
    },
    t: Math.max(Date.now(), S.settings.t + 1), dirty: true,
  };
  LS.set("settings", S.settings);
  dlg.close(); render(); scheduleSync(300);
  toast("Einstellungen gespeichert");
};

/* ============================================================
   Start
   ============================================================ */
window.addEventListener("online", () => { renderSync(); sync(); });
window.addEventListener("offline", renderSync);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { if (S.view === "home") render(); sync(); checkForUpdate(); } });
setInterval(() => { if (S.view === "home") render(); sync(); }, 120000);

// Offline-Speicher und Updates: neue Versionen werden beim Öffnen gesucht und sofort aktiviert
let swReg = null;
async function checkForUpdate() { try { if (swReg) await swReg.update(); } catch {} }
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // Eine neue Version hat übernommen: einmal neu laden, ausser mitten in einer Lernrunde
    if (!hadController || reloading) return;
    if (S.view === "study" && S.study && S.study.current) { S.updateReady = true; toast("Neue Version geladen. Sie startet beim nächsten Öffnen der Übersicht."); return; }
    reloading = true; location.reload();
  });
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
    .then(reg => { swReg = reg; checkForUpdate(); })
    .catch(() => {});
}
async function forceUpdate() {
  toast("Suche nach Updates …");
  try {
    if (swReg) await swReg.update();
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== "sk-fonts").map(k => caches.delete(k)));
  } catch {}
  location.reload();
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

(async () => {
  if (!sb) { S.authChecked = true; S.session = null; render(); return; }
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "TOKEN_REFRESHED" || event === "SIGNED_IN") S.session = session;
    if (event === "SIGNED_OUT") S.session = null;
  });
  const { data } = await sb.auth.getSession();
  onSession(data.session);
})();
})();
