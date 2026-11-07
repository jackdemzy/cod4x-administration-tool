// Block 17: operator text for a master token / RCON password that another
// instance also holds. Only instance IDs are shown, never a value. A shared
// value is a warning, not an error; the save has already succeeded.
const TEXT = Object.freeze({
  master: [
    id => `Master-Token wird auch von ${id} verwendet. Empfohlen: pro Server ein eigener Token.`,
    id => `Master token is also used by ${id}. Recommended: one token per server.`,
  ],
  rcon: [
    id => `RCON-Passwort wird auch von ${id} verwendet: Wer es für einen Server kennt, kann alle diese Server steuern.`,
    id => `RCON password is also used by ${id}: anyone who knows it for one server can control all of them.`,
  ],
});

export function sharedCredentialWarning(kind, instances, de) {
  if (!Object.hasOwn(TEXT, kind) || !Array.isArray(instances) || !instances.length) return '';
  return TEXT[kind][de ? 0 : 1](instances.join(', '));
}
