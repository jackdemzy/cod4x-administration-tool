// Routes that carry a secret in the request or the response. The backend keeps them
// local-only, sends Cache-Control: no-store and never reflects a parser error for them.
// Security audit 4.18.26 (A3-8, A5-6): the B3 !auth password route and the credential
// routes of remote servers were missing.
const CREDENTIAL_PATHS = [
  /^\/api\/credentials\//,
  /^\/api\/instances\/[^/]+\/credentials(?:\/|$)/,
  /^\/api\/remote-hosts\/[^/]+\/credentials(?:\/|$)/,
  /^\/api\/remote-instances\/[^/]+\/credentials(?:\/|$)/,
  /^\/api\/instances\/[^/]+\/b3\/integration\/auth-password\/?$/,
];

export function isCredentialPath(path) {
  return typeof path === 'string' && CREDENTIAL_PATHS.some(pattern => pattern.test(path));
}
