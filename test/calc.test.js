'use strict';
process.env.TZ = 'Africa/Casablanca';
const test = require('node:test');
const assert = require('node:assert');
const { computeDay, aggregate } = require('../lib/calc');
const { atTime } = require('../lib/time');

const settings = { tolerance_retard_min: 5, pause_autorisee_min: 30 };
const D = '2026-10-27'; // mardi
const at = (h) => atTime(D, h);
const plan = { debut: '09:00', fin: '18:00', dejeuner_min: 60 };
const after = atTime('2026-10-28', '08:00');

test('journée complète : heures de log hors déjeuner, retard, adhérence', () => {
  const events = [
    { ts: at('09:12'), statut: 'production' },
    { ts: at('11:00'), statut: 'pause' },
    { ts: at('11:20'), statut: 'production' },
    { ts: at('13:00'), statut: 'dejeuner' },
    { ts: at('14:00'), statut: 'production' },
    { ts: at('16:00'), statut: 'pause' },
    { ts: at('16:15'), statut: 'brief' },
    { ts: at('16:45'), statut: 'production' },
    { ts: at('18:00'), statut: 'off' },
  ];
  const d = computeDay({ dateStr: D, events, planning: plan, settings, now: after });
  assert.equal(d.presence_min, 8 * 60 + 48);
  assert.equal(d.dejeuner_min, 60);
  assert.equal(d.heures_log_min, 7 * 60 + 48);
  assert.equal(d.pause_min, 35);
  assert.equal(d.depassement_pause_min, 5);
  assert.equal(d.brief_min, 30);
  assert.equal(d.retard_min, 12);
  assert.equal(d.en_retard, true);
  assert.equal(d.planifie_min, 8 * 60);
  // au poste dans la plage 09:00-18:00 hors déjeuner : 7h48 sur 8h prévues
  assert.equal(Math.round(d.adherence * 1000) / 1000, Math.round((468 / 480) * 1000) / 1000);
  assert.equal(d.deconnexion_manquante, false);
});

test('oubli de déconnexion : compteur arrêté à la fin prévue et signalé', () => {
  const events = [{ ts: at('09:00'), statut: 'production' }];
  const d = computeDay({ dateStr: D, events, planning: plan, settings, now: after });
  assert.equal(d.deconnexion_manquante, true);
  assert.equal(d.heures_log_min, 9 * 60);
});

test('journée en cours : compteur jusqu\'à maintenant, pas d\'adhérence', () => {
  const events = [{ ts: at('09:03'), statut: 'production' }];
  const d = computeDay({ dateStr: D, events, planning: plan, settings, now: at('10:03') });
  assert.equal(d.heures_log_min, 60);
  assert.equal(d.en_retard, false);
  assert.equal(d.statut_actuel, 'production');
  assert.equal(d.adherence, null);
});

test('absence sur un jour planifié', () => {
  const d = computeDay({ dateStr: D, events: [], planning: plan, settings, now: after });
  assert.equal(d.absent, true);
  assert.equal(d.adherence, 0);
});

test('départ anticipé et cumul', () => {
  const events = [
    { ts: at('09:00'), statut: 'production' },
    { ts: at('16:30'), statut: 'off' },
  ];
  const d1 = computeDay({ dateStr: D, events, planning: plan, settings, now: after });
  assert.equal(d1.depart_anticipe_min, 90);
  const d2 = computeDay({ dateStr: D, events: [], planning: plan, settings, now: after });
  const a = aggregate([d1, d2]);
  assert.equal(a.jours_planifies, 2);
  assert.equal(a.jours_travailles, 1);
  assert.equal(a.absences, 1);
  assert.equal(a.heures_log_min, 450);
  assert.equal(a.departs_anticipes, 1);
});
