'use strict';
// Toutes les fonctions utilisent le fuseau du processus (process.env.TZ),
// fixé au démarrage dans server.js (par défaut Africa/Casablanca).

const pad = (n) => String(n).padStart(2, '0');

function localDateStr(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTimeStr(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return { y, m, d };
}

function isTime(hhmm) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm || '');
}

function atTime(dateStr, hhmm) {
  const p = parseDate(dateStr);
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(p.y, p.m - 1, p.d, h, mi, 0, 0).getTime();
}

function dayBounds(dateStr) {
  const p = parseDate(dateStr);
  return {
    start: new Date(p.y, p.m - 1, p.d).getTime(),
    end: new Date(p.y, p.m - 1, p.d + 1).getTime(),
  };
}

// 0 = dimanche ... 6 = samedi
function weekday(dateStr) {
  const p = parseDate(dateStr);
  return new Date(p.y, p.m - 1, p.d).getDay();
}

function addDays(dateStr, n) {
  const p = parseDate(dateStr);
  return localDateStr(new Date(p.y, p.m - 1, p.d + n).getTime());
}

function dateRange(from, to) {
  const out = [];
  let cur = from;
  while (cur <= to && out.length < 400) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

// 425 min -> "7h05"
function fmtHM(min) {
  const m = Math.max(0, Math.round(min || 0));
  return `${Math.floor(m / 60)}h${pad(m % 60)}`;
}

module.exports = { pad, localDateStr, localTimeStr, parseDate, isTime, atTime, dayBounds, weekday, addDays, dateRange, fmtHM };
