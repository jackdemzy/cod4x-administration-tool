// Block 16b: route predicates and guards for the B3 plugin API. Express routes
// are case-insensitive and accept a trailing slash, so the predicates do too.
export const LOOPBACK_ADDRESSES = Object.freeze(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const isLoopbackAddress = address => LOOPBACK_ADDRESSES.includes(address);

// Config and code bodies (up to 256 KB of text) use the larger JSON parser.
export const isB3PluginTextPath = requestPath => /^\/api\/instances\/[^/]+\/b3\/plugins\/(?:custom(?:\/[^/]+\/code)?|[^/]+\/config)\/?$/i.test(requestPath);

// The four b3.plugins.code routes: create, read/write code, delete.
export const isB3PluginCodePath = requestPath => /^\/api\/instances\/[^/]+\/b3\/plugins\/custom(?:\/[^/]+(?:\/code)?)?\/?$/i.test(requestPath);

// Rejects a matching request from a non-loopback address with the same answer
// as the credential transport guard.
export function localOnlyGuard(matches) {
  return (req, res, next) => {
    if (!matches(req)) return next();
    if (!isLoopbackAddress(req.socket?.remoteAddress)) return res.status(403).json({ ok: false, code: 'CREDENTIAL_LOCAL_ONLY', error: 'Credential transport requires a local connection.' });
    next();
  };
}

// Start blockers for an error response: only the code and, for plugin
// blockers, the plugin name. Never any other field (values could be secret).
export function publicBlockers(error) {
  if (!Array.isArray(error?.blockers)) return null;
  return error.blockers
    .filter(entry => entry && typeof entry.code === 'string')
    .map(entry => ({ code: entry.code, ...(typeof entry.plugin === 'string' ? { plugin: entry.plugin } : {}) }));
}
