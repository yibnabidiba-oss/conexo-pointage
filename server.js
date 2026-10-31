'use strict';
// Fuseau horaire de référence pour tous les calculs (heures, journées).
process.env.TZ = process.env.APP_TZ || 'Africa/Casablanca';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { open } = require('./lib/db');
const { STATUTS, computeDay, aggregate } = require('./lib/calc');
const T = require('./lib/time');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const AGENT_SESSION_H = 14;
const ADMIN_SESSION_H = 12;
const MAX_RANGE_DAYS = 93;

const db = open(DATA_DIR);

// ---------------------------------------------------------------- outils

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => { throw new HttpError(status, message); };

function hashSecret(secret, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(secret), salt, 32).toString('hex');
  return { hash, salt };
}
function checkSecret(secret, hash, salt) {
  const h = crypto.scryptSync(String(secret), salt, 32);
  const ref = Buffer.from(hash, 'hex');
  return ref.length === h.length && crypto.timingSafeEqual(h, ref);
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    nom_centre: s.nom_centre || 'Conexo',
    tolerance_retard_min: Number(s.tolerance_retard_min) || 0,
    pause_autorisee_min: Number(s.pause_autorisee_min) || 0,
    activites: (s.activites || '').split(',').map((x) => x.trim()).filter(Boolean),
  };
}

function audit(auteur, action, details) {
  db.prepare('INSERT INTO audit (ts, auteur, action, details) VALUES (?, ?, ?, ?)')
    .run(Date.now(), auteur, action, details ? JSON.stringify(details) : null);
}

// Limiteur simple contre les essais de PIN / mot de passe en série.
const attempts = new Map();
function checkRate(key) {
  const a = attempts.get(key);
  if (a && a.until > Date.now()) {
    const min = Math.ceil((a.until - Date.now()) / 60000);
    fail(429, `Trop d'essais. Réessayez dans ${min} min.`);
  }
}
function noteFailure(key) {
  const a = attempts.get(key) || { count: 0, until: 0 };
  a.count++;
  if (a.count >= 5) {
    a.until = Date.now() + 5 * 60000;
    a.count = 0;
  }
  attempts.set(key, a);
}
const clearFailures = (key) => attempts.delete(key);

// ---------------------------------------------------------------- sessions

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isHttps(req) {
  return process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
}
function setCookie(req, res, name, value, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (isHttps(req)) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...prev, parts.join('; ')]);
}
function createSession(req, res, kind, subject, hours) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, kind, subject, expires) VALUES (?, ?, ?, ?)')
    .run(sha256(token), kind, subject, Date.now() + hours * 3600000);
  setCookie(req, res, kind === 'agent' ? 'cx_agent' : 'cx_admin', token, hours * 3600);
}
function readSession(req, kind) {
  const token = parseCookies(req)[kind === 'agent' ? 'cx_agent' : 'cx_admin'];
  if (!token) return null;
  const row = db.prepare('SELECT subject, expires FROM sessions WHERE token_hash = ? AND kind = ?').get(sha256(token), kind);
  if (!row || row.expires < Date.now()) return null;
  return row.subject;
}
function endSession(req, res, kind) {
  const name = kind === 'agent' ? 'cx_agent' : 'cx_admin';
  const token = parseCookies(req)[name];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  setCookie(req, res, name, '', 0);
}

function requireAgent(req) {
  const mat = readSession(req, 'agent');
  if (!mat) fail(401, 'Session expirée. Reconnectez-vous.');
  const agent = db.prepare('SELECT * FROM agents WHERE matricule = ?').get(mat);
  if (!agent || !agent.actif) fail(401, 'Compte désactivé. Voyez votre superviseur.');
  return agent;
}
function requireManager(req, role) {
  const login = readSession(req, 'admin');
  if (!login) fail(401, 'Session expirée. Reconnectez-vous.');
  const m = db.prepare('SELECT login, nom, role FROM managers WHERE login = ?').get(login);
  if (!m) fail(401, 'Compte encadrement introuvable.');
  if (role === 'admin' && m.role !== 'admin') fail(403, 'Réservé aux administrateurs.');
  return m;
}

// ---------------------------------------------------------------- données

function planningOf(matricule) {
  const rows = db.prepare('SELECT weekday, debut, fin, dejeuner_min FROM planning WHERE matricule = ?').all(matricule);
  const out = {};
  for (const r of rows) out[r.weekday] = { debut: r.debut, fin: r.fin, dejeuner_min: r.dejeuner_min };
  return out;
}

function eventsBetween(matricule, from, to) {
  return db.prepare(
    `SELECT id, ts, statut, source, auteur, motif FROM events
     WHERE matricule = ? AND supprime = 0 AND ts >= ? AND ts < ? ORDER BY ts, id`
  ).all(matricule, from, to);
}

function dayFor(agent, dateStr, settings, now, planning) {
  const { start, end } = T.dayBounds(dateStr);
  const events = eventsBetween(agent.matricule, start, end);
  const plan = (planning || planningOf(agent.matricule))[T.weekday(dateStr)] || null;
  const day = computeDay({ dateStr, events, planning: plan, settings, now });
  day.events = events;
  return day;
}

function agentPublic(a) {
  return { matricule: a.matricule, nom: a.nom, prenom: a.prenom, activite: a.activite, actif: !!a.actif };
}

function validPin(pin) {
  return /^\d{4,6}$/.test(String(pin || ''));
}

function cleanPlanning(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [wd, p] of Object.entries(input)) {
    const w = Number(wd);
    if (!(w >= 0 && w <= 6) || !p) continue;
    if (!T.isTime(p.debut) || !T.isTime(p.fin)) continue;
    if (p.fin <= p.debut) fail(400, 'Planning : l\'heure de fin doit être après l\'heure de début.');
    const dej = Math.max(0, Math.min(240, Number(p.dejeuner_min) || 0));
    out[w] = { debut: p.debut, fin: p.fin, dejeuner_min: dej };
  }
  return out;
}
function savePlanning(matricule, planning) {
  db.prepare('DELETE FROM planning WHERE matricule = ?').run(matricule);
  const ins = db.prepare('INSERT INTO planning (matricule, weekday, debut, fin, dejeuner_min) VALUES (?, ?, ?, ?, ?)');
  for (const [w, p] of Object.entries(planning)) ins.run(matricule, Number(w), p.debut, p.fin, p.dejeuner_min);
}

function readRange(q) {
  const from = q.get('from');
  const to = q.get('to');
  if (!T.parseDate(from) || !T.parseDate(to)) fail(400, 'Dates invalides.');
  if (to < from) fail(400, 'La date de fin est avant la date de début.');
  const days = T.dateRange(from, to);
  if (days.length > MAX_RANGE_DAYS) fail(400, `Période limitée à ${MAX_RANGE_DAYS} jours.`);
  return days;
}

function buildReport(days, activite) {
  const settings = getSettings();
  const now = Date.now();
  let agents = db.prepare('SELECT * FROM agents ORDER BY nom, prenom').all();
  if (activite) agents = agents.filter((a) => a.activite === activite);
  const { start } = T.dayBounds(days[0]);
  const { end } = T.dayBounds(days[days.length - 1]);
  const all = db.prepare(
    'SELECT matricule, ts, statut FROM events WHERE supprime = 0 AND ts >= ? AND ts < ? ORDER BY ts, id'
  ).all(start, end);
  const byAgentDay = new Map();
  for (const e of all) {
    const key = `${e.matricule}|${T.localDateStr(e.ts)}`;
    if (!byAgentDay.has(key)) byAgentDay.set(key, []);
    byAgentDay.get(key).push(e);
  }
  const rows = [];
  for (const a of agents) {
    const planning = planningOf(a.matricule);
    const perDay = days.map((d) => {
      const day = computeDay({
        dateStr: d,
        events: byAgentDay.get(`${a.matricule}|${d}`) || [],
        planning: planning[T.weekday(d)] || null,
        settings,
        now,
      });
      delete day.segments;
      return day;
    });
    const total = aggregate(perDay);
    // Un conseiller désactivé sans aucune activité sur la période n'apparaît pas.
    if (!a.actif && total.presence_min === 0) continue;
    rows.push({ agent: agentPublic(a), total, jours: perDay });
  }
  return { from: days[0], to: days[days.length - 1], settings, rows };
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const dec = (min) => (Math.round((min / 60) * 100) / 100).toString().replace('.', ',');
const pct = (x) => (x === null ? '' : `${Math.round(x * 100)}`);
const hm = (ts) => (ts ? T.localTimeStr(ts) : '');

function reportCsv(report, detail) {
  const lines = [];
  if (!detail) {
    lines.push([
      'Matricule', 'Nom', 'Prénom', 'Activité', 'Jours planifiés', 'Jours travaillés', 'Absences',
      'Heures de log (h:mm)', 'Heures de log (décimal)', 'Production (h:mm)', 'Pauses (h:mm)',
      'Dépassement pause (min)', 'Déjeuner (h:mm)', 'Brief/formation (h:mm)', 'Heures planifiées (h:mm)',
      'Retards (nb)', 'Retard cumulé (min)', 'Départs anticipés (nb)', 'Oublis de déconnexion', 'Adhérence (%)',
    ]);
    for (const r of report.rows) {
      const t = r.total;
      lines.push([
        r.agent.matricule, r.agent.nom, r.agent.prenom, r.agent.activite, t.jours_planifies, t.jours_travailles, t.absences,
        T.fmtHM(t.heures_log_min), dec(t.heures_log_min), T.fmtHM(t.production_min), T.fmtHM(t.pause_min),
        t.depassement_pause_min, T.fmtHM(t.dejeuner_min), T.fmtHM(t.brief_min), T.fmtHM(t.planifie_min),
        t.retards, t.retard_total_min, t.departs_anticipes, t.oublis_deconnexion, pct(t.adherence),
      ]);
    }
  } else {
    lines.push([
      'Date', 'Matricule', 'Nom', 'Prénom', 'Activité', 'Planning', 'Première connexion', 'Dernière déconnexion',
      'Heures de log (h:mm)', 'Heures de log (décimal)', 'Production (h:mm)', 'Pauses (h:mm)', 'Déjeuner (h:mm)',
      'Brief/formation (h:mm)', 'Retard (min)', 'Départ anticipé (min)', 'Absent', 'Oubli de déconnexion', 'Adhérence (%)',
    ]);
    for (const r of report.rows) {
      for (const d of r.jours) {
        if (!d.planning && d.presence_min === 0) continue;
        lines.push([
          d.date, r.agent.matricule, r.agent.nom, r.agent.prenom, r.agent.activite,
          d.planning ? `${d.planning.debut}-${d.planning.fin}` : 'Repos',
          hm(d.premiere_connexion), hm(d.derniere_deconnexion),
          T.fmtHM(d.heures_log_min), dec(d.heures_log_min), T.fmtHM(d.production_min), T.fmtHM(d.pause_min),
          T.fmtHM(d.dejeuner_min), T.fmtHM(d.brief_min), d.en_retard ? d.retard_min : 0, d.depart_anticipe_min,
          d.absent ? 'Oui' : '', d.deconnexion_manquante ? 'Oui' : '', pct(d.adherence),
        ]);
      }
    }
  }
  // BOM + ";" : s'ouvre directement dans Excel en français.
  return '﻿' + lines.map((l) => l.map(csvCell).join(';')).join('\r\n');
}

// ---------------------------------------------------------------- routes

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/time', () => {
  const now = Date.now();
  return { now, date: T.localDateStr(now), tz: process.env.TZ, nom_centre: getSettings().nom_centre };
});

// --- Conseiller

route('POST', '/api/agent/login', ({ req, res, body }) => {
  const matricule = String(body.matricule || '').trim().toUpperCase();
  const key = `agent:${matricule}`;
  checkRate(key);
  const agent = db.prepare('SELECT * FROM agents WHERE UPPER(matricule) = ?').get(matricule);
  if (!agent || !checkSecret(String(body.pin || ''), agent.pin_hash, agent.pin_salt)) {
    noteFailure(key);
    fail(401, 'Matricule ou code PIN incorrect.');
  }
  if (!agent.actif) fail(403, 'Compte désactivé. Voyez votre superviseur.');
  clearFailures(key);
  createSession(req, res, 'agent', agent.matricule, AGENT_SESSION_H);
  return { ok: true };
});

route('POST', '/api/agent/logout', ({ req, res }) => {
  endSession(req, res, 'agent');
  return { ok: true };
});

route('GET', '/api/agent/me', ({ req }) => {
  const agent = requireAgent(req);
  const now = Date.now();
  const settings = getSettings();
  const day = dayFor(agent, T.localDateStr(now), settings, now);
  return {
    now,
    agent: agentPublic(agent),
    pause_autorisee_min: settings.pause_autorisee_min,
    jour: day,
  };
});

route('POST', '/api/agent/statut', ({ req, body }) => {
  const agent = requireAgent(req);
  const statut = String(body.statut || '');
  if (!STATUTS[statut]) fail(400, 'Statut inconnu.');
  const now = Date.now();
  const { start } = T.dayBounds(T.localDateStr(now));
  const last = db.prepare(
    'SELECT statut FROM events WHERE matricule = ? AND supprime = 0 AND ts >= ? AND ts <= ? ORDER BY ts DESC, id DESC LIMIT 1'
  ).get(agent.matricule, start, now);
  const current = last ? last.statut : 'off';
  if (current === statut) fail(409, `Vous êtes déjà en « ${STATUTS[statut]} ».`);
  if (current === 'off' && (statut === 'pause' || statut === 'dejeuner')) {
    fail(400, 'Commencez votre journée (Production ou Brief) avant de prendre une pause.');
  }
  db.prepare('INSERT INTO events (matricule, ts, statut, source, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(agent.matricule, now, statut, 'conseiller', now);
  return { ok: true, ts: now, statut };
});

// --- Encadrement : compte et accès

route('GET', '/api/admin/setup', () => {
  const n = db.prepare('SELECT COUNT(*) AS n FROM managers').get().n;
  return { needed: n === 0 };
});

route('POST', '/api/admin/setup', ({ req, res, body }) => {
  const n = db.prepare('SELECT COUNT(*) AS n FROM managers').get().n;
  if (n > 0) fail(409, 'Le compte administrateur existe déjà.');
  const login = String(body.login || '').trim().toLowerCase();
  const nom = String(body.nom || '').trim();
  if (!/^[a-z0-9._-]{3,40}$/.test(login)) fail(400, 'Identifiant : 3 à 40 caractères (lettres, chiffres, . _ -).');
  if (!nom) fail(400, 'Indiquez votre nom.');
  if (String(body.password || '').length < 8) fail(400, 'Mot de passe : 8 caractères minimum.');
  const { hash, salt } = hashSecret(body.password);
  db.prepare('INSERT INTO managers (login, nom, role, pass_hash, pass_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(login, nom, 'admin', hash, salt, Date.now());
  audit(login, 'creation_admin', { login });
  createSession(req, res, 'admin', login, ADMIN_SESSION_H);
  return { ok: true };
});

route('POST', '/api/admin/login', ({ req, res, body }) => {
  const login = String(body.login || '').trim().toLowerCase();
  const key = `admin:${login}`;
  checkRate(key);
  const m = db.prepare('SELECT * FROM managers WHERE login = ?').get(login);
  if (!m || !checkSecret(String(body.password || ''), m.pass_hash, m.pass_salt)) {
    noteFailure(key);
    fail(401, 'Identifiant ou mot de passe incorrect.');
  }
  clearFailures(key);
  createSession(req, res, 'admin', m.login, ADMIN_SESSION_H);
  return { ok: true };
});

route('POST', '/api/admin/logout', ({ req, res }) => {
  endSession(req, res, 'admin');
  return { ok: true };
});

route('GET', '/api/admin/me', ({ req }) => {
  const m = requireManager(req);
  return { manager: m, settings: getSettings(), now: Date.now(), statuts: STATUTS };
});

// --- Encadrement : suivi

route('GET', '/api/admin/live', ({ req }) => {
  requireManager(req);
  const now = Date.now();
  const today = T.localDateStr(now);
  const settings = getSettings();
  const agents = db.prepare('SELECT * FROM agents WHERE actif = 1 ORDER BY nom, prenom').all();
  const rows = agents.map((a) => {
    const d = dayFor(a, today, settings, now);
    delete d.events;
    return { agent: agentPublic(a), jour: d };
  });
  return { now, date: today, settings, rows };
});

route('GET', '/api/admin/report', ({ req, query }) => {
  requireManager(req);
  return buildReport(readRange(query), query.get('activite') || '');
});

route('GET', '/api/admin/report.csv', ({ req, res, query }) => {
  requireManager(req);
  const days = readRange(query);
  const detail = query.get('detail') === '1';
  const csv = reportCsv(buildReport(days, query.get('activite') || ''), detail);
  const name = `pointage_${detail ? 'detail' : 'cumul'}_${days[0]}_${days[days.length - 1]}.csv`;
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
  });
  res.end(csv);
  return undefined;
});

route('GET', '/api/admin/day', ({ req, query }) => {
  requireManager(req);
  const date = query.get('date');
  if (!T.parseDate(date)) fail(400, 'Date invalide.');
  const a = db.prepare('SELECT * FROM agents WHERE matricule = ?').get(String(query.get('matricule') || ''));
  if (!a) fail(404, 'Conseiller introuvable.');
  return { agent: agentPublic(a), jour: dayFor(a, date, getSettings(), Date.now()) };
});

// --- Encadrement : corrections de pointage

route('POST', '/api/admin/events', ({ req, body }) => {
  const m = requireManager(req);
  const a = db.prepare('SELECT matricule FROM agents WHERE matricule = ?').get(String(body.matricule || ''));
  if (!a) fail(404, 'Conseiller introuvable.');
  if (!T.parseDate(body.date) || !T.isTime(body.heure)) fail(400, 'Date ou heure invalide.');
  if (!STATUTS[body.statut]) fail(400, 'Statut inconnu.');
  const motif = String(body.motif || '').trim();
  if (motif.length < 3) fail(400, 'Indiquez le motif de la correction.');
  const ts = T.atTime(body.date, body.heure);
  if (ts > Date.now()) fail(400, 'Impossible d\'ajouter un pointage dans le futur.');
  const now = Date.now();
  const r = db.prepare(
    'INSERT INTO events (matricule, ts, statut, source, auteur, motif, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(a.matricule, ts, body.statut, 'correction', m.login, motif, now);
  audit(m.login, 'ajout_pointage', { id: Number(r.lastInsertRowid), matricule: a.matricule, date: body.date, heure: body.heure, statut: body.statut, motif });
  return { ok: true };
});

route('POST', '/api/admin/events/:id/delete', ({ req, body, params }) => {
  const m = requireManager(req);
  const ev = db.prepare('SELECT * FROM events WHERE id = ? AND supprime = 0').get(Number(params.id));
  if (!ev) fail(404, 'Pointage introuvable.');
  const motif = String(body.motif || '').trim();
  if (motif.length < 3) fail(400, 'Indiquez le motif de la suppression.');
  db.prepare('UPDATE events SET supprime = 1 WHERE id = ?').run(ev.id);
  audit(m.login, 'suppression_pointage', { id: ev.id, matricule: ev.matricule, ts: ev.ts, statut: ev.statut, motif });
  return { ok: true };
});

// --- Encadrement : conseillers

route('GET', '/api/admin/agents', ({ req }) => {
  requireManager(req);
  const agents = db.prepare('SELECT * FROM agents ORDER BY actif DESC, nom, prenom').all();
  return { agents: agents.map((a) => ({ ...agentPublic(a), planning: planningOf(a.matricule) })) };
});

route('POST', '/api/admin/agents', ({ req, body }) => {
  const m = requireManager(req);
  const matricule = String(body.matricule || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,20}$/.test(matricule)) fail(400, 'Matricule : lettres et chiffres, 20 caractères maximum.');
  if (db.prepare('SELECT 1 FROM agents WHERE matricule = ?').get(matricule)) fail(409, 'Ce matricule existe déjà.');
  const nom = String(body.nom || '').trim();
  if (!nom) fail(400, 'Indiquez le nom.');
  if (!validPin(body.pin)) fail(400, 'Le code PIN doit faire 4 à 6 chiffres.');
  const planning = cleanPlanning(body.planning);
  const { hash, salt } = hashSecret(body.pin);
  db.prepare('INSERT INTO agents (matricule, nom, prenom, activite, pin_hash, pin_salt, actif, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
    .run(matricule, nom, String(body.prenom || '').trim(), String(body.activite || '').trim(), hash, salt, Date.now());
  savePlanning(matricule, planning);
  audit(m.login, 'creation_conseiller', { matricule, nom });
  return { ok: true };
});

route('PUT', '/api/admin/agents/:mat', ({ req, body, params }) => {
  const m = requireManager(req);
  const a = db.prepare('SELECT * FROM agents WHERE matricule = ?').get(decodeURIComponent(params.mat));
  if (!a) fail(404, 'Conseiller introuvable.');
  const nom = body.nom !== undefined ? String(body.nom).trim() : a.nom;
  if (!nom) fail(400, 'Indiquez le nom.');
  db.prepare('UPDATE agents SET nom = ?, prenom = ?, activite = ?, actif = ? WHERE matricule = ?').run(
    nom,
    body.prenom !== undefined ? String(body.prenom).trim() : a.prenom,
    body.activite !== undefined ? String(body.activite).trim() : a.activite,
    body.actif !== undefined ? (body.actif ? 1 : 0) : a.actif,
    a.matricule
  );
  if (body.planning !== undefined) savePlanning(a.matricule, cleanPlanning(body.planning));
  if (body.actif === false) db.prepare("DELETE FROM sessions WHERE kind = 'agent' AND subject = ?").run(a.matricule);
  audit(m.login, 'modification_conseiller', { matricule: a.matricule });
  return { ok: true };
});

route('POST', '/api/admin/agents/:mat/pin', ({ req, body, params }) => {
  const m = requireManager(req);
  const a = db.prepare('SELECT matricule FROM agents WHERE matricule = ?').get(decodeURIComponent(params.mat));
  if (!a) fail(404, 'Conseiller introuvable.');
  if (!validPin(body.pin)) fail(400, 'Le code PIN doit faire 4 à 6 chiffres.');
  const { hash, salt } = hashSecret(body.pin);
  db.prepare('UPDATE agents SET pin_hash = ?, pin_salt = ? WHERE matricule = ?').run(hash, salt, a.matricule);
  db.prepare("DELETE FROM sessions WHERE kind = 'agent' AND subject = ?").run(a.matricule);
  audit(m.login, 'reinitialisation_pin', { matricule: a.matricule });
  return { ok: true };
});

// --- Administration : paramètres, comptes encadrement, journal

route('PUT', '/api/admin/settings', ({ req, body }) => {
  const m = requireManager(req, 'admin');
  const set = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
  if (body.nom_centre !== undefined) set.run(String(body.nom_centre).trim() || 'Conexo', 'nom_centre');
  if (body.tolerance_retard_min !== undefined) set.run(String(Math.max(0, Math.min(60, Number(body.tolerance_retard_min) || 0))), 'tolerance_retard_min');
  if (body.pause_autorisee_min !== undefined) set.run(String(Math.max(0, Math.min(180, Number(body.pause_autorisee_min) || 0))), 'pause_autorisee_min');
  if (body.activites !== undefined) {
    const list = String(body.activites).split(',').map((x) => x.trim()).filter(Boolean);
    set.run(list.join(','), 'activites');
  }
  audit(m.login, 'parametres', body);
  return { ok: true, settings: getSettings() };
});

route('GET', '/api/admin/managers', ({ req }) => {
  requireManager(req, 'admin');
  return { managers: db.prepare('SELECT login, nom, role, created_at FROM managers ORDER BY role, nom').all() };
});

route('POST', '/api/admin/managers', ({ req, body }) => {
  const m = requireManager(req, 'admin');
  const login = String(body.login || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(login)) fail(400, 'Identifiant : 3 à 40 caractères (lettres, chiffres, . _ -).');
  if (db.prepare('SELECT 1 FROM managers WHERE login = ?').get(login)) fail(409, 'Cet identifiant existe déjà.');
  const nom = String(body.nom || '').trim();
  if (!nom) fail(400, 'Indiquez le nom.');
  if (String(body.password || '').length < 8) fail(400, 'Mot de passe : 8 caractères minimum.');
  const role = body.role === 'admin' ? 'admin' : 'superviseur';
  const { hash, salt } = hashSecret(body.password);
  db.prepare('INSERT INTO managers (login, nom, role, pass_hash, pass_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(login, nom, role, hash, salt, Date.now());
  audit(m.login, 'creation_encadrant', { login, role });
  return { ok: true };
});

route('POST', '/api/admin/managers/:login/delete', ({ req, params }) => {
  const m = requireManager(req, 'admin');
  const login = decodeURIComponent(params.login);
  if (login === m.login) fail(400, 'Vous ne pouvez pas supprimer votre propre compte.');
  db.prepare('DELETE FROM managers WHERE login = ?').run(login);
  db.prepare("DELETE FROM sessions WHERE kind = 'admin' AND subject = ?").run(login);
  audit(m.login, 'suppression_encadrant', { login });
  return { ok: true };
});

route('POST', '/api/admin/password', ({ req, body }) => {
  const m = requireManager(req);
  const row = db.prepare('SELECT * FROM managers WHERE login = ?').get(m.login);
  if (!checkSecret(String(body.actuel || ''), row.pass_hash, row.pass_salt)) fail(400, 'Mot de passe actuel incorrect.');
  if (String(body.nouveau || '').length < 8) fail(400, 'Nouveau mot de passe : 8 caractères minimum.');
  const { hash, salt } = hashSecret(body.nouveau);
  db.prepare('UPDATE managers SET pass_hash = ?, pass_salt = ? WHERE login = ?').run(hash, salt, m.login);
  audit(m.login, 'changement_mot_de_passe', null);
  return { ok: true };
});

route('GET', '/api/admin/audit', ({ req }) => {
  requireManager(req, 'admin');
  const rows = db.prepare('SELECT ts, auteur, action, details FROM audit ORDER BY id DESC LIMIT 200').all();
  return { rows: rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null })) };
});

// ---------------------------------------------------------------- serveur HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
const PAGES = { '/': 'index.html', '/encadrement': 'admin.html' };

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  );
}

function serveStatic(req, res, pathname) {
  const file = PAGES[pathname] || pathname.slice(1);
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return false;
  let stat;
  try { stat = fs.statSync(full); } catch { return false; }
  if (!stat.isFile()) return false;
  const ext = path.extname(full);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  fs.createReadStream(full).pipe(res);
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100 * 1024) {
        reject(new HttpError(413, 'Requête trop volumineuse.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(new HttpError(400, 'Données illisibles.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  const url = new URL(req.url, 'http://local');
  const pathname = url.pathname;

  if (!pathname.startsWith('/api/')) {
    if (req.method === 'GET' && serveStatic(req, res, pathname)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Page introuvable');
    return;
  }

  try {
    const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
    if (!r) fail(404, 'Adresse inconnue.');
    if (req.method !== 'GET') {
      // Protection CSRF : les écritures doivent venir de l'application elle-même.
      if (!(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'Format non accepté.');
    }
    const match = pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, match[i + 1]]));
    const body = req.method === 'GET' ? {} : await readBody(req);
    const out = r.handler({ req, res, body, params, query: url.searchParams });
    if (out !== undefined) sendJson(res, 200, out);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    sendJson(res, 500, { error: 'Erreur interne. Réessayez ou prévenez l\'administrateur.' });
  }
});

// Ménage des sessions expirées toutes les heures.
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 3600000).unref();

server.listen(PORT, () => {
  console.log(`Pointage ${getSettings().nom_centre} en ligne sur http://localhost:${PORT} (fuseau ${process.env.TZ}, données dans ${DATA_DIR})`);
});

module.exports = { server };
