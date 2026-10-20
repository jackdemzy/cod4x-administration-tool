import { B3_DATABASE_MESSAGES } from './b3-database-messages.mjs';

// Operator texts [German, English] for the B3 administration (Block 15).
export const B3_ADMIN_MESSAGES = Object.freeze({
  ...B3_DATABASE_MESSAGES,
  B3_DATABASE_NOT_READY: ['B3 nutzt noch keine bereite MySQL-Datenbank – erst den Datenbank-Wizard abschließen.', 'B3 does not use a ready MySQL database yet – finish the database wizard first.'],
  B3_ADMIN_INPUT_INVALID: ['Ungültige Eingabe (Suche, Seite, Dauer oder Grund).', 'Invalid input (search, page, duration or reason).'],
  B3_ADMIN_CLIENT_NOT_FOUND: ['Spieler ist in B3 nicht (mehr) bekannt.', 'Player is not (or no longer) known to B3.'],
  B3_ADMIN_GROUP_NOT_FOUND: ['Diese Gruppe gibt es in B3 nicht.', 'This group does not exist in B3.'],
  B3_ADMIN_PENALTY_NOT_FOUND: ['Keine aktive Warnung mit dieser Nummer.', 'No active warning with this number.'],
  B3_ADMIN_COMMANDS_UNAVAILABLE: ['plugin_admin.ini der eBc-B3-Quelle ist nicht lesbar.', 'plugin_admin.ini of the eBc-B3 source is not readable.'],
  B3_RUNNING: ['B3 läuft – Gruppen nur bei gestopptem B3 ändern.', 'B3 is running – change groups only with B3 stopped.'],
});
