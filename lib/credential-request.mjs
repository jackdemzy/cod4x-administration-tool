// Routes that carry a secret in the request or the response. The backend keeps them
// local-only, sends Cache-Control: no-store and never reflects a parser error for them.
// Security audit 4.18.26 (A3-8, A5-6): the B3 !auth password route and the credential
// routes of remote servers were missing.
// Audit 4.18.31 (W-2): Express routes ignore letter case, so these patterns must too;
// otherwise /API/Credentials/... reached the handlers without the guard.
const CREDENTIAL_PATHS = [
  /^\/api\/credentials\//i,
  /^\/api\/instances\/[^/]+\/credentials(?:\/|$)/i,
  /^\/api\/remote-hosts\/[^/]+\/credentials(?:\/|$)/i,
  /^\/api\/remote-instances\/[^/]+\/credentials(?:\/|$)/i,
  /^\/api\/instances\/[^/]+\/b3\/integration\/auth-password\/?$/i,
];

export function isCredentialPath(path) {
  return typeof path === 'string' && CREDENTIAL_PATHS.some(pattern => pattern.test(path));
}
