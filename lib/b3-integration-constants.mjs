// Browser-safe constants of the B3 <-> CoD4x integration (Block 16), shared by
// the backend plan (b3-integration.mjs) and the UI.
export const B3_HIDE_LEVELS = Object.freeze([1, 2, 20, 40, 60, 80, 100]);
// eBc-B3 default group names (b3/sql/*/b3.sql "groups").
export const B3_LEVEL_NAMES = Object.freeze({ 1: 'User', 2: 'Regular', 20: 'Moderator', 40: 'Admin', 60: 'Full admin', 80: 'Senior admin', 100: 'Super admin' });
export const B3_PREFIX_CHARS = '!@#$%&*.,:?=~-';
// Official CoD4x 21.2 release packages (GitHub Actions build 2022-05-01). A hint
// for the operator only; approval of the file stays manual.
export const KNOWN_B3HIDE_HASHES = Object.freeze({
  linux: 'f277087c8817c927ca28e96171c8a729ad319f3739cc360c8d3d74899b918a30',
  windows: '51fadd9ae0be0bb8855d37a56b53a04b289be775c9fdc38fe256e1f7cb8969bb',
});
export const B3_INTEGRATION_DEFAULTS = Object.freeze({ hideCommands: false, prefix: '!', hideLevel: 20 });
