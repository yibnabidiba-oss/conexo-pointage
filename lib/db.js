'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_SETTINGS = {
  nom_centre: 'Conexo',
  tolerance_retard_min: '5',
  pause_autorisee_min: '30',
  activites: 'B2C France,B2C Belgique,B2B,Kidonk',
};

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'pointage.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS agents (
      matricule   TEXT PRIMARY KEY,
      nom         TEXT NOT NULL,
      prenom      TEXT NOT NULL DEFAULT '',
      activite    TEXT NOT NULL DEFAULT '',
      pin_hash    TEXT NOT NULL,
      pin_salt    TEXT NOT NULL,
      actif       INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL
    );

    -- Planning hebdomadaire type : un horaire par jour de la semaine (0 = dimanche).
    CREATE TABLE IF NOT EXISTS planning (
      matricule    TEXT NOT NULL REFERENCES agents(matricule) ON DELETE CASCADE,
      weekday      INTEGER NOT NULL,
      debut        TEXT NOT NULL,
      fin          TEXT NOT NULL,
      dejeuner_min INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (matricule, weekday)
    );

    -- Chaque changement de statut. L'heure est TOUJOURS celle du serveur.
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      matricule   TEXT NOT NULL REFERENCES agents(matricule) ON DELETE CASCADE,
      ts          INTEGER NOT NULL,
      statut      TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'conseiller',
      auteur      TEXT,
      motif       TEXT,
      supprime    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_agent_ts ON events (matricule, ts);
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);

    CREATE TABLE IF NOT EXISTS managers (
      login       TEXT PRIMARY KEY,
      nom         TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'superviseur',
      pass_hash   TEXT NOT NULL,
      pass_salt   TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,
      subject     TEXT NOT NULL,
      expires     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      INTEGER NOT NULL,
      auteur  TEXT NOT NULL,
      action  TEXT NOT NULL,
      details TEXT
    );
  `);
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  return db;
}

module.exports = { open };
