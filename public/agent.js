'use strict';
/* Écran du conseiller : connexion par matricule + PIN, changement de statut. */

let state = null; // réponse de /api/agent/me
let busy = false;

function show(view) {
  $('#view-login').hidden = view !== 'login';
  $('#view-session').hidden = view !== 'session';
}

function showMsg(el, text, kind = 'err') {
  el.textContent = text;
  el.className = `msg ${kind}`;
  el.hidden = !text;
}

async function boot() {
  try {
    const t = await api('GET', '/api/time');
    clock.set(t.now);
    $('#centre').textContent = t.nom_centre;
    document.title = `Pointage ${t.nom_centre}`;
  } catch { /* l'horloge du poste servira en attendant */ }
  startClock($('#clock-time'), $('#clock-date'));
  await refresh();
  setInterval(() => { if (state) refresh(); }, 30000);
  setInterval(tickHero, 1000);
}

async function refresh() {
  try {
    state = await api('GET', '/api/agent/me');
    clock.set(state.now);
    render();
    show('session');
  } catch (e) {
    state = null;
    if (e.status === 401 || e.status === 403) {
      show('login');
      if (e.status === 403 || /désactivé/.test(e.message)) showMsg($('#login-msg'), e.message);
      setTimeout(() => $('#login-matricule').focus(), 50);
    } else {
      showMsg($('#action-msg'), e.message);
    }
  }
}

function render() {
  const { agent, jour, pause_autorisee_min: pauseMax } = state;
  $('#who-name').textContent = `Bonjour ${agent.prenom || agent.nom}`;
  $('#who-meta').textContent = [`${agent.prenom} ${agent.nom}`.trim(), agent.matricule, agent.activite].filter(Boolean).join(' · ');

  const st = jour.statut_actuel;
  const hero = $('#hero');
  hero.className = `status-hero st-${st}`;
  $('#hero-status').textContent = st === 'off'
    ? (jour.presence_min > 0 ? 'Journée terminée' : 'Pas encore connecté')
    : STATUTS[st];
  $('#hero-since').textContent = jour.depuis ? `depuis ${fmtTime(jour.depuis)}` : '';
  tickHero();

  for (const b of $$('#actions .act')) {
    const s = b.dataset.statut;
    const active = s === st;
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
    b.disabled = active || (st === 'off' && (s === 'pause' || s === 'dejeuner'));
  }
  const prod = $('#actions [data-statut="production"] .t');
  prod.textContent = st === 'off' && jour.presence_min === 0 ? 'Démarrer ma journée' : st === 'off' ? 'Reprendre' : st === 'production' ? 'Production' : 'Reprendre la production';

  const p = jour.planning;
  $('#plan-line').textContent = p
    ? `Horaire prévu : ${p.debut} – ${p.fin}${p.dejeuner_min ? ` · déjeuner ${p.dejeuner_min} min` : ''}`
    : 'Aucun horaire prévu aujourd\'hui';

  const pauseOver = jour.pause_min > pauseMax;
  const cells = [
    ['Heures de log', fmtHM(jour.heures_log_min), ''],
    ['Production', fmtHM(jour.production_min), ''],
    [`Pauses (max ${pauseMax} min)`, `${jour.pause_min} min`, pauseOver ? 'bad' : ''],
    ['Déjeuner', fmtHM(jour.dejeuner_min), ''],
    ['Brief / formation', fmtHM(jour.brief_min), ''],
    ['Arrivée', fmtTime(jour.premiere_connexion), jour.en_retard ? 'bad' : ''],
  ];
  $('#day-stats').innerHTML = cells.map(([k, v, cls]) => `
    <div class="stat"><span class="k">${esc(k)}</span><span class="v ${cls}">${esc(v)}</span></div>`).join('');
  $('#day-timeline').innerHTML = timelineHtml(jour, todayStr());
}

function tickHero() {
  if (!state) return;
  const j = state.jour;
  $('#hero-elapsed').textContent = j.statut_actuel !== 'off' && j.depuis ? fmtDuration(clock.now() - j.depuis) : fmtHM(j.heures_log_min);
}

async function changeStatut(statut) {
  if (busy) return;
  busy = true;
  $$('#actions .act').forEach((b) => { b.disabled = true; });
  try {
    await api('POST', '/api/agent/statut', { statut });
    showMsg($('#action-msg'), `${statut === 'off' ? 'Fin de journée' : STATUTS[statut]} enregistré à ${fmtTime(clock.now())}.`, 'ok');
    setTimeout(() => { $('#action-msg').hidden = true; }, 4000);
  } catch (e) {
    showMsg($('#action-msg'), e.message);
  } finally {
    busy = false;
    $('#confirm-off').hidden = true;
    await refresh();
  }
}

$('#actions').addEventListener('click', (e) => {
  const b = e.target.closest('.act');
  if (!b || b.disabled) return;
  if (b.dataset.statut === 'off') {
    $('#confirm-off').hidden = false;
    $('#confirm-off-yes').focus();
    return;
  }
  changeStatut(b.dataset.statut);
});
$('#confirm-off-yes').addEventListener('click', () => changeStatut('off'));
$('#confirm-off-no').addEventListener('click', () => { $('#confirm-off').hidden = true; });

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-btn');
  btn.disabled = true;
  $('#login-msg').hidden = true;
  try {
    await api('POST', '/api/agent/login', {
      matricule: $('#login-matricule').value.trim(),
      pin: $('#login-pin').value.trim(),
    });
    $('#login-pin').value = '';
    await refresh();
  } catch (err) {
    showMsg($('#login-msg'), err.message);
    $('#login-pin').value = '';
    $('#login-pin').focus();
  } finally {
    btn.disabled = false;
  }
});

$('#lock-btn').addEventListener('click', async () => {
  try { await api('POST', '/api/agent/logout', {}); } catch { /* on revient à l'écran de connexion */ }
  state = null;
  $('#login-matricule').value = '';
  show('login');
  $('#login-matricule').focus();
});

boot();
