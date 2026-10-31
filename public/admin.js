'use strict';
/* Espace encadrement : suivi en direct, rapports, corrections, conseillers. */

let me = null;
let settings = null;
let agents = [];
let liveData = null;
let currentTab = 'live';

const AUDIT_LABELS = {
  creation_admin: 'Création du compte administrateur',
  ajout_pointage: 'Ajout de pointage',
  suppression_pointage: 'Suppression de pointage',
  creation_conseiller: 'Nouveau conseiller',
  modification_conseiller: 'Modification conseiller',
  reinitialisation_pin: 'Nouveau code PIN',
  parametres: 'Paramètres',
  creation_encadrant: 'Nouveau compte encadrement',
  suppression_encadrant: 'Suppression compte encadrement',
  changement_mot_de_passe: 'Changement de mot de passe',
};

function show(view) {
  for (const v of ['setup', 'login', 'app']) $(`#view-${v}`).hidden = v !== view;
}
function note(el, text, kind = 'err') {
  el.textContent = text;
  el.className = `msg ${kind}`;
  el.hidden = !text;
  if (kind === 'ok' && text) setTimeout(() => { el.hidden = true; }, 4000);
}
const appMsg = (text, kind) => note($('#app-msg'), text, kind);

function handleAuthError(e) {
  if (e.status === 401) {
    show('login');
    return true;
  }
  appMsg(e.message);
  return false;
}

function activiteOptions(selected, withAll = true) {
  const list = settings.activites;
  return (withAll ? `<option value="">Toutes les activités</option>` : `<option value="">—</option>`)
    + list.map((a) => `<option value="${esc(a)}"${a === selected ? ' selected' : ''}>${esc(a)}</option>`).join('');
}

// ------------------------------------------------------------ démarrage

async function boot() {
  try {
    const t = await api('GET', '/api/time');
    clock.set(t.now);
    $('#centre').textContent = t.nom_centre;
  } catch { /* horloge locale en attendant */ }
  startClock($('#clock-time'), $('#clock-date'));
  try {
    const s = await api('GET', '/api/admin/setup');
    if (s.needed) return show('setup');
  } catch (e) {
    return appMsg(e.message);
  }
  await enterApp();
}

async function enterApp() {
  try {
    const r = await api('GET', '/api/admin/me');
    me = r.manager;
    settings = r.settings;
    clock.set(r.now);
  } catch (e) {
    if (e.status === 401) return show('login');
    return appMsg(e.message);
  }
  $('#me-line').textContent = `${me.nom} · ${me.role === 'admin' ? 'Administrateur' : 'Superviseur'}`;
  $$('.admin-only').forEach((el) => { el.hidden = me.role !== 'admin'; });
  $('#centre').textContent = settings.nom_centre;
  $('#live-activite').innerHTML = activiteOptions('');
  $('#rep-activite').innerHTML = activiteOptions('');
  show('app');
  await loadAgents();
  const hash = location.hash.slice(1);
  openTab(['live', 'report', 'day', 'agents', 'settings'].includes(hash) ? hash : 'live');
}

function openTab(tab) {
  currentTab = tab;
  $$('#tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false'));
  $$('.tab').forEach((s) => { s.hidden = s.id !== `tab-${tab}`; });
  if (location.hash.slice(1) !== tab) history.replaceState(null, '', `#${tab}`);
  if (tab === 'live') loadLive();
  if (tab === 'report' && !$('#rep-from').value) { applyPreset('semaine'); loadReport(); }
  if (tab === 'day') initDay();
  if (tab === 'agents') renderAgents();
  if (tab === 'settings') loadSettings();
}
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) openTab(b.dataset.tab);
});

// ------------------------------------------------------------ connexion

$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/api/admin/setup', {
      nom: $('#setup-nom').value, login: $('#setup-login').value, password: $('#setup-password').value,
    });
    await enterApp();
  } catch (err) { note($('#setup-msg'), err.message); }
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/api/admin/login', { login: $('#login-login').value, password: $('#login-password').value });
    $('#login-password').value = '';
    $('#login-msg').hidden = true;
    await enterApp();
  } catch (err) { note($('#login-msg'), err.message); }
});

$('#logout-btn').addEventListener('click', async () => {
  try { await api('POST', '/api/admin/logout', {}); } catch { /* rien */ }
  show('login');
});

// ------------------------------------------------------------ en direct

async function loadLive() {
  try {
    liveData = await api('GET', '/api/admin/live');
    clock.set(liveData.now);
    renderLive();
  } catch (e) { handleAuthError(e); }
}

function alertsFor(j, pauseMax) {
  const out = [];
  if (j.absent) out.push(flag('bad', 'Non connecté'));
  if (j.en_retard) out.push(flag('warn', `Retard ${j.retard_min} min`));
  if (j.pause_min > pauseMax) out.push(flag('warn', `Pause +${j.pause_min - pauseMax} min`));
  if (j.depart_anticipe_min > 0) out.push(flag('warn', `Parti ${j.depart_anticipe_min} min avant`));
  return out.join(' ');
}

function renderLive() {
  const act = $('#live-activite').value;
  const rows = liveData.rows.filter((r) => !act || r.agent.activite === act);
  const pauseMax = liveData.settings.pause_autorisee_min;
  const count = { production: 0, pause: 0, dejeuner: 0, brief: 0, off: 0 };
  let absents = 0;
  let retards = 0;
  for (const r of rows) {
    count[r.jour.statut_actuel]++;
    if (r.jour.absent) absents++;
    if (r.jour.en_retard) retards++;
  }
  $('#live-counters').innerHTML = [
    ...['production', 'pause', 'dejeuner', 'brief', 'off'].map((k) => `<div class="counter"><b>${count[k]}</b>${chip(k)}</div>`),
    `<div class="counter"><b>${absents}</b>${flag('bad', 'Non connectés (attendus)')}</div>`,
    `<div class="counter"><b>${retards}</b>${flag('warn', 'Retards')}</div>`,
  ].join('');

  if (!rows.length) {
    $('#live-body').innerHTML = `<tr><td colspan="10" class="empty">Aucun conseiller actif. Ajoutez-les dans l'onglet Conseillers.</td></tr>`;
    return;
  }
  const order = { production: 0, brief: 1, pause: 2, dejeuner: 3, off: 4 };
  rows.sort((a, b) => order[a.jour.statut_actuel] - order[b.jour.statut_actuel] || a.agent.nom.localeCompare(b.agent.nom));
  $('#live-body').innerHTML = rows.map(({ agent, jour: j }) => `
    <tr class="click" data-mat="${esc(agent.matricule)}">
      <td><b>${esc(`${agent.prenom} ${agent.nom}`.trim())}</b> <span class="muted small">${esc(agent.matricule)}</span></td>
      <td>${esc(agent.activite || '—')}</td>
      <td>${chip(j.statut_actuel, j.statut_actuel === 'off' && j.presence_min > 0 ? 'Terminé' : undefined)}</td>
      <td class="num">${j.statut_actuel !== 'off' ? fmtTime(j.depuis) : '—'}</td>
      <td class="num">${j.planning ? `${esc(j.planning.debut)} – ${esc(j.planning.fin)}` : '<span class="muted">Repos</span>'}</td>
      <td class="num">${fmtTime(j.premiere_connexion)}</td>
      <td class="n">${fmtHM(j.heures_log_min)}</td>
      <td class="n">${fmtHM(j.production_min)}</td>
      <td class="n">${j.pause_min} min</td>
      <td class="alerts">${alertsFor(j, pauseMax)}</td>
    </tr>`).join('');
}
$('#live-activite').addEventListener('change', () => liveData && renderLive());
$('#live-body').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-mat]');
  if (!tr) return;
  $('#day-agent').value = tr.dataset.mat;
  $('#day-date').value = todayStr();
  openTab('day');
  loadDay();
});
setInterval(() => { if (me && currentTab === 'live' && !document.hidden) loadLive(); }, 30000);

// ------------------------------------------------------------ rapports

const PRESETS = [
  ['jour', 'Aujourd\'hui'], ['hier', 'Hier'], ['semaine', 'Cette semaine'],
  ['semaine-1', 'Semaine dernière'], ['mois', 'Ce mois'], ['mois-1', 'Mois dernier'],
];
function presetRange(key) {
  const n = new Date(clock.now());
  const d = (y, m, day) => todayStr(new Date(y, m, day).getTime());
  const Y = n.getFullYear();
  const M = n.getMonth();
  const D = n.getDate();
  const dow = (n.getDay() + 6) % 7; // lundi = 0
  switch (key) {
    case 'jour': return [d(Y, M, D), d(Y, M, D)];
    case 'hier': return [d(Y, M, D - 1), d(Y, M, D - 1)];
    case 'semaine': return [d(Y, M, D - dow), d(Y, M, D)];
    case 'semaine-1': return [d(Y, M, D - dow - 7), d(Y, M, D - dow - 1)];
    case 'mois': return [d(Y, M, 1), d(Y, M, D)];
    case 'mois-1': return [d(Y, M - 1, 1), d(Y, M, 0)];
    default: return [d(Y, M, D), d(Y, M, D)];
  }
}
function applyPreset(key) {
  const [f, t] = presetRange(key);
  $('#rep-from').value = f;
  $('#rep-to').value = t;
}
$('#rep-presets').innerHTML = PRESETS.map(([k, l]) => `<button class="small" type="button" data-preset="${k}">${l}</button>`).join('');
$('#rep-presets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-preset]');
  if (!b) return;
  applyPreset(b.dataset.preset);
  loadReport();
});
$('#rep-go').addEventListener('click', loadReport);

function reportQuery() {
  const p = new URLSearchParams({ from: $('#rep-from').value, to: $('#rep-to').value });
  if ($('#rep-activite').value) p.set('activite', $('#rep-activite').value);
  return p;
}

let reportData = null;
async function loadReport() {
  const q = reportQuery();
  $('#rep-csv').href = `/api/admin/report.csv?${q}`;
  $('#rep-csv-detail').href = `/api/admin/report.csv?${q}&detail=1`;
  $('#rep-body').innerHTML = `<tr><td colspan="15" class="empty">Calcul en cours…</td></tr>`;
  try {
    reportData = await api('GET', `/api/admin/report?${q}`);
    renderReport();
  } catch (e) {
    $('#rep-body').innerHTML = `<tr><td colspan="15" class="empty">${esc(e.message)}</td></tr>`;
    handleAuthError(e);
  }
}

function renderReport() {
  const { rows, settings: s } = reportData;
  $('#rep-note').textContent = `Heures de log = temps connecté hors déjeuner (production + pauses + brief). Retard compté au-delà de ${s.tolerance_retard_min} min. Pause autorisée : ${s.pause_autorisee_min} min par jour. Adhérence = temps au poste pendant l'horaire prévu ÷ temps prévu (calculée une fois la journée terminée). Cliquez sur un conseiller pour le détail par jour.`;
  if (!rows.length) {
    $('#rep-body').innerHTML = `<tr><td colspan="15" class="empty">Aucune donnée sur cette période.</td></tr>`;
    return;
  }
  const tot = { heures_log_min: 0, planifie_min: 0, production_min: 0, pause_min: 0, depassement_pause_min: 0, dejeuner_min: 0, brief_min: 0, absences: 0, retards: 0 };
  let html = '';
  for (const r of rows) {
    const t = r.total;
    for (const k of Object.keys(tot)) tot[k] += t[k];
    const adhCls = t.adherence === null ? '' : t.adherence < 0.85 ? 'flag-bad' : t.adherence < 0.95 ? 'flag-warn' : 'flag-ok';
    html += `
      <tr class="click" data-mat="${esc(r.agent.matricule)}">
        <td><b>${esc(`${r.agent.prenom} ${r.agent.nom}`.trim())}</b> <span class="muted small">${esc(r.agent.matricule)}</span>${r.agent.actif ? '' : ' <span class="chip plain">Inactif</span>'}</td>
        <td>${esc(r.agent.activite || '—')}</td>
        <td class="n">${t.jours_travailles}/${t.jours_planifies}</td>
        <td class="n">${t.absences || '—'}</td>
        <td class="n"><b>${fmtHM(t.heures_log_min)}</b></td>
        <td class="n">${fmtHM(t.planifie_min)}</td>
        <td class="n">${fmtHM(t.production_min)}</td>
        <td class="n">${fmtHM(t.pause_min)}</td>
        <td class="n">${t.depassement_pause_min ? `${t.depassement_pause_min} min` : '—'}</td>
        <td class="n">${fmtHM(t.dejeuner_min)}</td>
        <td class="n">${fmtHM(t.brief_min)}</td>
        <td class="n">${t.retards ? `${t.retards} (${t.retard_total_min} min)` : '—'}</td>
        <td class="n">${t.departs_anticipes || '—'}</td>
        <td class="n">${t.oublis_deconnexion || '—'}</td>
        <td class="n">${t.adherence === null ? '—' : `<span class="chip plain ${adhCls}">${pct(t.adherence)}</span>`}</td>
      </tr>`;
    html += r.jours.filter((d) => d.planning || d.presence_min > 0).map((d) => `
      <tr class="sub" data-sub="${esc(r.agent.matricule)}" hidden>
        <td class="num">${esc(fmtDateShort(d.date))}</td>
        <td>${d.planning ? `${esc(d.planning.debut)} – ${esc(d.planning.fin)}` : 'Repos'}</td>
        <td class="n">${fmtTime(d.premiere_connexion)} → ${fmtTime(d.derniere_deconnexion)}</td>
        <td class="n">${d.absent ? flag('bad', 'Absent') : '—'}</td>
        <td class="n">${fmtHM(d.heures_log_min)}</td>
        <td class="n">${fmtHM(d.planifie_min)}</td>
        <td class="n">${fmtHM(d.production_min)}</td>
        <td class="n">${fmtHM(d.pause_min)}</td>
        <td class="n">${d.depassement_pause_min ? `${d.depassement_pause_min} min` : '—'}</td>
        <td class="n">${fmtHM(d.dejeuner_min)}</td>
        <td class="n">${fmtHM(d.brief_min)}</td>
        <td class="n">${d.en_retard ? `${d.retard_min} min` : '—'}</td>
        <td class="n">${d.depart_anticipe_min ? `${d.depart_anticipe_min} min` : '—'}</td>
        <td class="n">${d.deconnexion_manquante ? flag('warn', 'À corriger') : '—'}</td>
        <td class="n">${pct(d.adherence)}</td>
      </tr>`).join('');
  }
  html += `
    <tr>
      <td><b>Total</b></td><td></td><td></td><td class="n">${tot.absences || '—'}</td>
      <td class="n"><b>${fmtHM(tot.heures_log_min)}</b></td><td class="n">${fmtHM(tot.planifie_min)}</td>
      <td class="n">${fmtHM(tot.production_min)}</td><td class="n">${fmtHM(tot.pause_min)}</td>
      <td class="n">${tot.depassement_pause_min ? `${tot.depassement_pause_min} min` : '—'}</td>
      <td class="n">${fmtHM(tot.dejeuner_min)}</td><td class="n">${fmtHM(tot.brief_min)}</td>
      <td class="n">${tot.retards || '—'}</td><td></td><td></td><td></td>
    </tr>`;
  $('#rep-body').innerHTML = html;
}
$('#rep-body').addEventListener('click', (e) => {
  const tr = e.target.closest('tr.click[data-mat]');
  if (!tr) return;
  $$(`#rep-body tr[data-sub="${CSS.escape(tr.dataset.mat)}"]`).forEach((s) => { s.hidden = !s.hidden; });
});

// ------------------------------------------------------------ corrections

function initDay() {
  if (!$('#day-date').value) $('#day-date').value = todayStr();
  if (!$('#day-agent').value && agents.length) loadDay();
}
function fillAgentSelect() {
  const cur = $('#day-agent').value;
  $('#day-agent').innerHTML = agents.map((a) => `<option value="${esc(a.matricule)}">${esc(`${a.nom} ${a.prenom}`.trim())} · ${esc(a.matricule)}${a.actif ? '' : ' (inactif)'}</option>`).join('');
  if (cur) $('#day-agent').value = cur;
}
$('#day-go').addEventListener('click', loadDay);
$('#day-agent').addEventListener('change', loadDay);
$('#day-date').addEventListener('change', loadDay);

async function loadDay() {
  const mat = $('#day-agent').value;
  const date = $('#day-date').value;
  if (!mat || !date) return;
  try {
    const r = await api('GET', `/api/admin/day?${new URLSearchParams({ matricule: mat, date })}`);
    renderDay(r, date);
  } catch (e) {
    $('#day-content').innerHTML = `<p class="msg err">${esc(e.message)}</p>`;
    handleAuthError(e);
  }
}

function renderDay({ agent, jour: j }, date) {
  const statutOptions = Object.entries(STATUTS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  const issues = [];
  if (j.deconnexion_manquante) issues.push(flag('warn', 'Pas de fin de journée : ajoutez un pointage « Déconnecté » à l\'heure réelle de départ'));
  if (j.absent) issues.push(flag('bad', 'Aucun pointage alors qu\'un horaire était prévu'));
  if (j.en_retard) issues.push(flag('warn', `Retard de ${j.retard_min} min`));
  $('#day-content').innerHTML = `
    <div class="grid-2" style="align-items:start">
      <div><h3>${esc(`${agent.prenom} ${agent.nom}`.trim())}</h3><p class="muted small">${esc(agent.matricule)} · ${esc(agent.activite || 'sans activité')} · ${esc(fmtDateLong(new Date(date + 'T12:00').getTime()))}</p></div>
      <div class="muted small">${j.planning ? `Horaire prévu ${esc(j.planning.debut)} – ${esc(j.planning.fin)}, déjeuner ${j.planning.dejeuner_min} min` : 'Pas d\'horaire prévu ce jour'}</div>
    </div>
    ${issues.length ? `<div class="row">${issues.join(' ')}</div>` : ''}
    <div class="stats">
      <div class="stat"><span class="k">Heures de log</span><span class="v">${fmtHM(j.heures_log_min)}</span></div>
      <div class="stat"><span class="k">Production</span><span class="v">${fmtHM(j.production_min)}</span></div>
      <div class="stat"><span class="k">Pauses</span><span class="v ${j.depassement_pause_min ? 'bad' : ''}">${j.pause_min} min</span></div>
      <div class="stat"><span class="k">Déjeuner</span><span class="v">${fmtHM(j.dejeuner_min)}</span></div>
      <div class="stat"><span class="k">Brief / formation</span><span class="v">${fmtHM(j.brief_min)}</span></div>
      <div class="stat"><span class="k">Adhérence</span><span class="v">${pct(j.adherence)}</span></div>
    </div>
    ${timelineHtml(j, date)}
    <h3>Pointages</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Heure</th><th>Statut</th><th>Origine</th><th></th></tr></thead>
        <tbody>
          ${j.events.length ? j.events.map((ev) => `
            <tr>
              <td class="num">${fmtTime(ev.ts)}</td>
              <td>${chip(ev.statut)}</td>
              <td class="small">${ev.source === 'correction' ? `Correction par ${esc(ev.auteur)} : ${esc(ev.motif)}` : 'Conseiller'}</td>
              <td>
                <span class="row" style="flex-wrap:nowrap">
                  <input class="small" placeholder="Motif de suppression" data-motif="${ev.id}" style="min-width:180px">
                  <button class="small danger" type="button" data-del="${ev.id}">Supprimer</button>
                </span>
              </td>
            </tr>`).join('') : `<tr><td colspan="4" class="empty">Aucun pointage ce jour.</td></tr>`}
        </tbody>
      </table>
    </div>
    <h3>Ajouter un pointage</h3>
    <form class="row" id="add-ev">
      <label class="field"><span>Heure</span><input type="time" id="ev-heure" required></label>
      <label class="field"><span>Nouveau statut</span><select id="ev-statut">${statutOptions}</select></label>
      <label class="field" style="flex:3 1 260px"><span>Motif (obligatoire)</span><input id="ev-motif" required placeholder="ex. oubli de déconnexion, confirmé par le TL"></label>
      <button class="primary" type="submit">Ajouter</button>
    </form>
    <div id="day-msg" class="msg" hidden></div>
  `;
  $('#ev-statut').value = j.deconnexion_manquante ? 'off' : 'production';
  $('#add-ev').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/admin/events', {
        matricule: agent.matricule, date, heure: $('#ev-heure').value, statut: $('#ev-statut').value, motif: $('#ev-motif').value,
      });
      await loadDay();
      note($('#day-msg'), 'Pointage ajouté.', 'ok');
    } catch (err) { note($('#day-msg'), err.message); }
  });
  $$('[data-del]', $('#day-content')).forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.del;
    const motif = $(`[data-motif="${id}"]`).value;
    try {
      await api('POST', `/api/admin/events/${id}/delete`, { motif });
      await loadDay();
      note($('#day-msg'), 'Pointage supprimé.', 'ok');
    } catch (err) { note($('#day-msg'), err.message); }
  }));
}

// ------------------------------------------------------------ conseillers

async function loadAgents() {
  try {
    agents = (await api('GET', '/api/admin/agents')).agents;
    fillAgentSelect();
  } catch (e) { handleAuthError(e); }
}

function planningSummary(pl) {
  const days = Object.keys(pl).map(Number).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  if (!days.length) return '<span class="muted">Aucun</span>';
  const groups = new Map();
  for (const d of days) {
    const k = `${pl[d].debut}–${pl[d].fin}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(JOURS[d].slice(0, 3));
  }
  return [...groups].map(([h, ds]) => `${esc(ds.join(' '))} <span class="num">${esc(h)}</span>`).join('<br>');
}

function renderAgents() {
  $('#agents-body').innerHTML = agents.length ? agents.map((a) => `
    <tr>
      <td class="num">${esc(a.matricule)}</td>
      <td><b>${esc(`${a.prenom} ${a.nom}`.trim())}</b></td>
      <td>${esc(a.activite || '—')}</td>
      <td class="small">${planningSummary(a.planning)}</td>
      <td>${a.actif ? flag('ok', 'Actif') : '<span class="chip plain">Inactif</span>'}</td>
      <td><button class="small" type="button" data-edit="${esc(a.matricule)}">Modifier</button></td>
    </tr>`).join('') : `<tr><td colspan="6" class="empty">Aucun conseiller. Ajoutez-les un par un ou avec l'import en masse.</td></tr>`;
}
$('#agents-body').addEventListener('click', (e) => {
  const b = e.target.closest('[data-edit]');
  if (b) openAgentForm(agents.find((a) => a.matricule === b.dataset.edit));
});
$('#agent-new').addEventListener('click', () => openAgentForm(null));

function planningRows(pl) {
  return [1, 2, 3, 4, 5, 6, 0].map((d) => {
    const p = pl[d];
    return `
      <div class="pl-row" data-wd="${d}">
        <label><input type="checkbox" data-on${p ? ' checked' : ''}> ${JOURS[d]}</label>
        <input type="time" data-debut value="${esc(p ? p.debut : '09:00')}" aria-label="Début ${JOURS[d]}">
        <input type="time" data-fin value="${esc(p ? p.fin : '18:00')}" aria-label="Fin ${JOURS[d]}">
        <input type="number" data-dej min="0" max="240" value="${p ? p.dejeuner_min : 60}" aria-label="Déjeuner ${JOURS[d]} en minutes" title="Déjeuner (min)">
      </div>`;
  }).join('');
}
function readPlanning(root) {
  const out = {};
  for (const row of $$('.pl-row', root)) {
    if (!$('[data-on]', row).checked) continue;
    out[row.dataset.wd] = { debut: $('[data-debut]', row).value, fin: $('[data-fin]', row).value, dejeuner_min: Number($('[data-dej]', row).value) || 0 };
  }
  return out;
}

function openAgentForm(a) {
  const f = $('#agent-form');
  const isNew = !a;
  f.hidden = false;
  $('#agent-import').hidden = true;
  f.innerHTML = `
    <div class="panel-head"><h3>${isNew ? 'Nouveau conseiller' : `Modifier ${esc(`${a.prenom} ${a.nom}`.trim())}`}</h3></div>
    <div class="row">
      <label class="field"><span>Matricule</span><input id="ag-mat" value="${esc(a ? a.matricule : '')}" ${isNew ? 'required' : 'disabled'}></label>
      <label class="field"><span>Nom</span><input id="ag-nom" value="${esc(a ? a.nom : '')}" required></label>
      <label class="field"><span>Prénom</span><input id="ag-prenom" value="${esc(a ? a.prenom : '')}"></label>
      <label class="field"><span>Activité</span><select id="ag-act">${activiteOptions(a ? a.activite : '', false)}</select></label>
      ${isNew ? '<label class="field"><span>Code PIN (4 à 6 chiffres)</span><input id="ag-pin" inputmode="numeric" pattern="[0-9]{4,6}" required></label>' : ''}
    </div>
    <div>
      <div class="panel-head">
        <span class="label">Horaire de la semaine · début, fin, déjeuner (min)</span>
        <button class="small" type="button" id="pl-copy">Copier le lundi sur lundi–vendredi</button>
      </div>
      <div class="planning-grid" id="pl-grid">${planningRows(a ? a.planning : { 1: { debut: '09:00', fin: '18:00', dejeuner_min: 60 }, 2: { debut: '09:00', fin: '18:00', dejeuner_min: 60 }, 3: { debut: '09:00', fin: '18:00', dejeuner_min: 60 }, 4: { debut: '09:00', fin: '18:00', dejeuner_min: 60 }, 5: { debut: '09:00', fin: '18:00', dejeuner_min: 60 } })}</div>
    </div>
    ${isNew ? '' : `
    <div class="row">
      <label class="field"><span>Nouveau code PIN</span><input id="ag-newpin" inputmode="numeric" placeholder="4 à 6 chiffres"></label>
      <button type="button" id="ag-pin-btn">Changer le PIN</button>
      <button type="button" id="ag-toggle" class="${a.actif ? 'danger' : ''}">${a.actif ? 'Désactiver (départ)' : 'Réactiver'}</button>
    </div>`}
    <div id="ag-msg" class="msg" hidden></div>
    <div class="row">
      <button class="primary" type="submit">${isNew ? 'Créer' : 'Enregistrer'}</button>
      <button type="button" id="ag-cancel">Fermer</button>
    </div>`;
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#pl-copy').addEventListener('click', () => {
    const mon = $('.pl-row[data-wd="1"]', f);
    for (const wd of [2, 3, 4, 5]) {
      const row = $(`.pl-row[data-wd="${wd}"]`, f);
      $('[data-on]', row).checked = $('[data-on]', mon).checked;
      for (const k of ['debut', 'fin', 'dej']) $(`[data-${k}]`, row).value = $(`[data-${k}]`, mon).value;
    }
  });
  $('#ag-cancel').addEventListener('click', () => { f.hidden = true; });
  if (!isNew) {
    $('#ag-pin-btn').addEventListener('click', async () => {
      try {
        await api('POST', `/api/admin/agents/${encodeURIComponent(a.matricule)}/pin`, { pin: $('#ag-newpin').value.trim() });
        $('#ag-newpin').value = '';
        note($('#ag-msg'), 'Code PIN modifié. Communiquez-le au conseiller.', 'ok');
      } catch (err) { note($('#ag-msg'), err.message); }
    });
    $('#ag-toggle').addEventListener('click', async () => {
      try {
        await api('PUT', `/api/admin/agents/${encodeURIComponent(a.matricule)}`, { actif: !a.actif });
        await loadAgents();
        renderAgents();
        f.hidden = true;
      } catch (err) { note($('#ag-msg'), err.message); }
    });
  }
  f.onsubmit = async (e) => {
    e.preventDefault();
    const payload = {
      nom: $('#ag-nom').value, prenom: $('#ag-prenom').value, activite: $('#ag-act').value, planning: readPlanning(f),
    };
    try {
      if (isNew) await api('POST', '/api/admin/agents', { ...payload, matricule: $('#ag-mat').value, pin: $('#ag-pin').value.trim() });
      else await api('PUT', `/api/admin/agents/${encodeURIComponent(a.matricule)}`, payload);
      await loadAgents();
      renderAgents();
      f.hidden = true;
      appMsg(isNew ? 'Conseiller créé.' : 'Modifications enregistrées.', 'ok');
    } catch (err) { note($('#ag-msg'), err.message); }
  };
}

$('#agent-import-open').addEventListener('click', () => {
  $('#agent-import').hidden = false;
  $('#agent-form').hidden = true;
});
$('#import-cancel').addEventListener('click', () => { $('#agent-import').hidden = true; });
$('#import-go').addEventListener('click', async () => {
  const lines = $('#import-text').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const plan = {};
  for (const wd of [1, 2, 3, 4, 5]) plan[wd] = { debut: $('#import-debut').value, fin: $('#import-fin').value, dejeuner_min: Number($('#import-dej').value) || 0 };
  let ok = 0;
  const errors = [];
  for (const line of lines) {
    const [matricule, nom, prenom, activite, pin] = line.split(/[;\t,]/).map((x) => (x || '').trim());
    try {
      await api('POST', '/api/admin/agents', { matricule, nom, prenom, activite, pin, planning: plan });
      ok++;
    } catch (err) {
      errors.push(`${matricule || line} : ${err.message}`);
    }
  }
  await loadAgents();
  renderAgents();
  note($('#import-msg'), `${ok} conseiller(s) importé(s).${errors.length ? ` Erreurs : ${errors.join(' · ')}` : ''}`, errors.length ? 'err' : 'ok');
  if (!errors.length) $('#import-text').value = '';
});

// ------------------------------------------------------------ paramètres

async function loadSettings() {
  $('#set-nom').value = settings.nom_centre;
  $('#set-tol').value = settings.tolerance_retard_min;
  $('#set-pause').value = settings.pause_autorisee_min;
  $('#set-activites').value = settings.activites.join(', ');
  $('#settings-form button').disabled = me.role !== 'admin';
  if (me.role !== 'admin') return;
  try {
    const [m, a] = await Promise.all([api('GET', '/api/admin/managers'), api('GET', '/api/admin/audit')]);
    $('#managers-body').innerHTML = m.managers.map((x) => `
      <tr><td>${esc(x.nom)}</td><td class="num">${esc(x.login)}</td><td>${x.role === 'admin' ? 'Administrateur' : 'Superviseur'}</td>
      <td>${x.login === me.login ? '<span class="muted small">Vous</span>' : `<button class="small danger" type="button" data-rm="${esc(x.login)}">Retirer</button>`}</td></tr>`).join('');
    $('#audit-body').innerHTML = a.rows.length ? a.rows.map((r) => `
      <tr><td class="num">${esc(new Date(r.ts).toLocaleString('fr-FR'))}</td><td>${esc(r.auteur)}</td>
      <td>${esc(AUDIT_LABELS[r.action] || r.action)}</td>
      <td class="small">${esc(r.details ? Object.entries(r.details).map(([k, v]) => `${k}: ${v}`).join(', ') : '')}</td></tr>`).join('')
      : `<tr><td colspan="4" class="empty">Rien pour l'instant.</td></tr>`;
  } catch (e) { handleAuthError(e); }
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('PUT', '/api/admin/settings', {
      nom_centre: $('#set-nom').value,
      tolerance_retard_min: Number($('#set-tol').value),
      pause_autorisee_min: Number($('#set-pause').value),
      activites: $('#set-activites').value,
    });
    settings = r.settings;
    $('#centre').textContent = settings.nom_centre;
    $('#live-activite').innerHTML = activiteOptions('');
    $('#rep-activite').innerHTML = activiteOptions('');
    note($('#settings-msg'), 'Paramètres enregistrés.', 'ok');
  } catch (err) { note($('#settings-msg'), err.message); }
});

$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/api/admin/password', { actuel: $('#pw-old').value, nouveau: $('#pw-new').value });
    $('#pw-old').value = '';
    $('#pw-new').value = '';
    note($('#pw-msg'), 'Mot de passe changé.', 'ok');
  } catch (err) { note($('#pw-msg'), err.message); }
});

$('#manager-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/api/admin/managers', {
      nom: $('#mg-nom').value, login: $('#mg-login').value, password: $('#mg-password').value, role: $('#mg-role').value,
    });
    $('#manager-form').reset();
    note($('#manager-msg'), 'Compte créé.', 'ok');
    loadSettings();
  } catch (err) { note($('#manager-msg'), err.message); }
});
$('#managers-body').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-rm]');
  if (!b) return;
  if (b.dataset.confirm !== '1') {
    b.dataset.confirm = '1';
    b.textContent = 'Confirmer le retrait';
    return;
  }
  try {
    await api('POST', `/api/admin/managers/${encodeURIComponent(b.dataset.rm)}/delete`, {});
    loadSettings();
  } catch (err) { note($('#manager-msg'), err.message); }
});

boot();
