'use strict';
/* Outils partagés par l'écran conseiller et l'espace encadrement. */

const STATUTS = {
  production: 'Production',
  pause: 'Pause',
  dejeuner: 'Déjeuner',
  brief: 'Brief / formation',
  off: 'Déconnecté',
};
const JOURS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw Object.assign(new Error('Serveur injoignable. Vérifiez la connexion internet du poste.'), { status: 0 });
  }
  let data = {};
  try { data = await res.json(); } catch { /* réponse vide */ }
  if (!res.ok) throw Object.assign(new Error(data.error || `Erreur ${res.status}`), { status: res.status });
  return data;
}

// Heure du serveur : on mesure l'écart avec l'horloge du poste, l'affichage
// suit le serveur même si le PC est mal réglé.
const clock = {
  offset: 0,
  set(serverNow) { this.offset = serverNow - Date.now(); },
  now() { return Date.now() + this.offset; },
};

const pad = (n) => String(n).padStart(2, '0');
function fmtHM(min) {
  const m = Math.max(0, Math.round(min || 0));
  return `${Math.floor(m / 60)}h${pad(m % 60)}`;
}
function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function todayStr(ts = clock.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fmtDateLong(ts) {
  return new Date(ts).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function fmtDateShort(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' });
}
const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)} %`);

function chip(statut, text) {
  return `<span class="chip st-${esc(statut)}">${esc(text || STATUTS[statut] || statut)}</span>`;
}
function flag(kind, text) {
  return `<span class="chip flag-${kind}">${esc(text)}</span>`;
}

function startClock(timeEl, dateEl) {
  const tick = () => {
    const n = clock.now();
    const d = new Date(n);
    timeEl.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    if (dateEl) dateEl.textContent = fmtDateLong(n);
  };
  tick();
  setInterval(tick, 1000);
}

/** Frise horaire d'une journée : segments colorés + plage prévue en pointillés. */
function timelineHtml(jour, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const at = (h, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
  const toMs = (hhmm) => at(...hhmm.split(':').map(Number));
  let startH = 8;
  let endH = 20;
  const segs = jour.segments || [];
  if (jour.planning) {
    startH = Math.min(startH, Number(jour.planning.debut.slice(0, 2)) - 1);
    endH = Math.max(endH, Number(jour.planning.fin.slice(0, 2)) + 2);
  }
  for (const s of segs) {
    startH = Math.min(startH, new Date(s.start).getHours());
    endH = Math.max(endH, new Date(s.end).getHours() + 1);
  }
  startH = Math.max(0, startH);
  endH = Math.min(24, endH);
  const t0 = at(startH);
  const t1 = at(endH);
  const span = t1 - t0;
  const x = (t) => `${(((Math.min(Math.max(t, t0), t1) - t0) / span) * 100).toFixed(3)}%`;
  const w = (a, b) => `${(((Math.min(b, t1) - Math.max(a, t0)) / span) * 100).toFixed(3)}%`;
  let inner = '';
  if (jour.planning) {
    const ps = toMs(jour.planning.debut);
    const pe = toMs(jour.planning.fin);
    inner += `<div class="tl-plan" style="left:${x(ps)};width:${w(ps, pe)}" title="Planning ${esc(jour.planning.debut)} – ${esc(jour.planning.fin)}"></div>`;
  }
  for (const s of segs) {
    inner += `<div class="tl-seg st-${esc(s.statut)}${s.ouvert ? ' ouvert' : ''}" style="left:${x(s.start)};width:${w(s.start, s.end)}" title="${esc(STATUTS[s.statut])} ${fmtTime(s.start)} – ${fmtTime(s.end)}"></div>`;
  }
  const now = clock.now();
  if (now > t0 && now < t1) inner += `<div class="tl-now" style="left:${x(now)}"></div>`;
  const ticks = [];
  const step = endH - startH > 12 ? 3 : 2;
  for (let h = startH; h <= endH; h += step) ticks.push(`<span>${pad(h)}h</span>`);
  return `
    <div class="timeline">
      <div class="tl-track" role="img" aria-label="Frise de la journée">${inner}</div>
      <div class="tl-scale">${ticks.join('')}</div>
      <div class="legend">
        ${['production', 'pause', 'dejeuner', 'brief'].map((k) => `<span class="st-${k}"><i></i>${STATUTS[k]}</span>`).join('')}
        <span>Pointillés : horaire prévu</span>
      </div>
    </div>`;
}
