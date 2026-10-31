'use strict';
const { atTime, dayBounds } = require('./time');

// Statuts possibles d'un conseiller. "off" = déconnecté.
const STATUTS = {
  production: 'Production',
  pause: 'Pause',
  dejeuner: 'Déjeuner',
  brief: 'Brief / formation',
  off: 'Déconnecté',
};
const ACTIFS = ['production', 'pause', 'dejeuner', 'brief'];
// Statuts comptés comme "présent au poste" pour l'adhérence au planning.
const EN_POSTE = ['production', 'pause', 'brief'];

const MIN = 60000;
const toMin = (ms) => Math.round(ms / MIN);

/**
 * Calcule la journée d'un conseiller.
 * events   : [{ts, statut}] triés par ts croissant, uniquement ceux de la journée
 * planning : {debut:'09:00', fin:'18:00', dejeuner_min:60} ou null si repos
 * settings : {tolerance_retard_min, pause_autorisee_min}
 * now      : heure serveur (ms)
 */
function computeDay({ dateStr, events, planning, settings, now }) {
  const { start: dayStart, end: dayEnd } = dayBounds(dateStr);
  const tol = (settings.tolerance_retard_min || 0) * MIN;
  const isToday = now >= dayStart && now < dayEnd;
  const isPast = now >= dayEnd;

  const plan = planning && planning.debut && planning.fin
    ? {
        debut: planning.debut,
        fin: planning.fin,
        dejeuner_min: planning.dejeuner_min || 0,
        start: atTime(dateStr, planning.debut),
        end: atTime(dateStr, planning.fin),
      }
    : null;

  const totals = { production: 0, pause: 0, dejeuner: 0, brief: 0 };
  const segments = [];
  let deconnexionManquante = false;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.statut === 'off') continue;
    let end = i + 1 < events.length ? events[i + 1].ts : null;
    let ouvert = false;
    if (end === null) {
      if (isToday) {
        end = Math.max(now, ev.ts);
        ouvert = true;
      } else if (isPast) {
        // Oubli de déconnexion : on arrête le compteur à la fin prévue du
        // planning, sinon au dernier pointage. L'encadrement corrige ensuite.
        deconnexionManquante = true;
        end = plan && plan.end > ev.ts ? plan.end : ev.ts;
      } else {
        end = ev.ts;
      }
    }
    end = Math.min(end, dayEnd);
    if (end <= ev.ts) continue;
    segments.push({ statut: ev.statut, start: ev.ts, end, ouvert });
    totals[ev.statut] += end - ev.ts;
  }

  const presenceMs = totals.production + totals.pause + totals.dejeuner + totals.brief;
  const firstIn = events.find((e) => e.statut !== 'off');
  const last = events[events.length - 1];
  const statutActuel = isToday && last ? last.statut : 'off';
  const lastOff = last && last.statut === 'off' ? last.ts : null;

  const r = {
    date: dateStr,
    statut_actuel: statutActuel,
    depuis: isToday && last ? last.ts : null,
    premiere_connexion: firstIn ? firstIn.ts : null,
    derniere_deconnexion: lastOff,
    presence_min: toMin(presenceMs),
    heures_log_min: toMin(presenceMs - totals.dejeuner),
    production_min: toMin(totals.production),
    pause_min: toMin(totals.pause),
    dejeuner_min: toMin(totals.dejeuner),
    brief_min: toMin(totals.brief),
    depassement_pause_min: Math.max(0, toMin(totals.pause) - (settings.pause_autorisee_min || 0)),
    planning: plan ? { debut: plan.debut, fin: plan.fin, dejeuner_min: plan.dejeuner_min } : null,
    planifie_min: plan ? Math.max(0, toMin(plan.end - plan.start) - plan.dejeuner_min) : 0,
    retard_min: 0,
    en_retard: false,
    depart_anticipe_min: 0,
    absent: false,
    adherence: null,
    deconnexion_manquante: deconnexionManquante,
    segments,
  };

  if (plan) {
    if (firstIn) {
      r.retard_min = Math.max(0, toMin(firstIn.ts - plan.start));
      r.en_retard = firstIn.ts - plan.start > tol;
    } else if ((isPast || (isToday && now > plan.start + tol))) {
      r.absent = true;
    }
    if (lastOff && statutActuel === 'off' && firstIn && lastOff < plan.end - tol) {
      r.depart_anticipe_min = toMin(plan.end - lastOff);
    }
    // Adhérence : temps au poste (hors déjeuner) à l'intérieur de la plage
    // prévue, divisé par le temps prévu. Calculée une fois la plage terminée.
    if (now >= plan.end && r.planifie_min > 0) {
      let inWindow = 0;
      for (const s of segments) {
        if (!EN_POSTE.includes(s.statut)) continue;
        const a = Math.max(s.start, plan.start);
        const b = Math.min(s.end, plan.end);
        if (b > a) inWindow += b - a;
      }
      r.adherence = Math.min(1, toMin(inWindow) / r.planifie_min);
    }
  }
  return r;
}

// Cumul de plusieurs journées d'un même conseiller.
function aggregate(days) {
  const a = {
    jours_planifies: 0,
    jours_travailles: 0,
    absences: 0,
    presence_min: 0,
    heures_log_min: 0,
    production_min: 0,
    pause_min: 0,
    dejeuner_min: 0,
    brief_min: 0,
    depassement_pause_min: 0,
    planifie_min: 0,
    retards: 0,
    retard_total_min: 0,
    departs_anticipes: 0,
    oublis_deconnexion: 0,
    adherence: null,
  };
  let adhNum = 0;
  let adhDen = 0;
  for (const d of days) {
    if (d.planning) a.jours_planifies++;
    if (d.presence_min > 0) a.jours_travailles++;
    if (d.absent) a.absences++;
    for (const k of ['presence_min', 'heures_log_min', 'production_min', 'pause_min', 'dejeuner_min', 'brief_min', 'depassement_pause_min', 'planifie_min']) {
      a[k] += d[k];
    }
    if (d.en_retard) {
      a.retards++;
      a.retard_total_min += d.retard_min;
    }
    if (d.depart_anticipe_min > 0) a.departs_anticipes++;
    if (d.deconnexion_manquante) a.oublis_deconnexion++;
    if (d.adherence !== null) {
      adhNum += d.adherence * d.planifie_min;
      adhDen += d.planifie_min;
    }
  }
  a.adherence = adhDen > 0 ? adhNum / adhDen : null;
  return a;
}

module.exports = { STATUTS, ACTIFS, computeDay, aggregate };
