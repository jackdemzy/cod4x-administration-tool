# COD4X CONTROL — Version Manager / Installer

## Components

- `cod4x-control-improved.jsx` — React/JSX frontend
- `installer-server.mjs` — Node.js installer API
- `package.json` — backend dependencies
- `.env.example` — optional operator-supplied artifact configuration

## Important release-source status

The installer does **not** invent release URLs or checksums.

### CoD4x

The backend resolves the requested server release dynamically from the official
`callofduty4x/CoD4x_Server` GitHub Releases API and selects a suitable server asset.
The GitHub asset's SHA-256 digest is used when the release provides one.

The UI still exposes 21.2–21.5 as profiles, but the live availability endpoint
marks versions that are not present in the official server release feed as unavailable.

### Bot Warfare

The backend queries the archived `Kianda/cod4x_bot_warfare` releases and prefers
release 2.0.1. It requires a release asset and a SHA-256 digest before installation.

### FPS Promod 2.85

No unambiguous, authoritative downloadable FPSChallenge.eu artifact + checksum
was found during verification. Therefore the installer refuses to download it
until the operator supplies:

- `FPS_285_URL`
- `FPS_285_SHA256`

This is deliberate: no guessed or third-party executable is silently installed.

## Install

```bash
npm install
```

Copy `.env.example` to `.env` and fill the FPS Promod artifact if desired.

Start:

```bash
npm start
```

Default API:

```text
http://127.0.0.1:8787
```

## API

### Health

`GET /api/installer/health`

### Release availability

`GET /api/installer/releases`

Returns live availability for CoD4x 21.2–21.5 and Bot Warfare.

### Prepare/install

`POST /api/installer`

Example:

```json
{
  "dryRun": true,
  "profile": {
    "cod4x": "21.2",
    "fps": "custom",
    "mod": "mods/mp_bots",
    "path": "my-server"
  }
}
```

Set `dryRun` to `false` only after verifying the release sources.

### Start server

`POST /api/server/start`

Example:

```json
{
  "path": "my-server"
}
```

Run the service under a dedicated OS user. Do not run the game server as root.

## Security

The installer includes:

- path traversal protection
- controlled installation root
- HTTP(S) artifact restriction
- SHA-256 verification
- no browser-side API credentials
- dry-run by default
- no arbitrary frontend-supplied download URL

The operator should additionally put the API behind local/admin authentication
before exposing it to a network.


## Anti-Cheat profiles

The Version Manager exposes:

1. **FPSChallenge Anti-Cheat (FPSAC)** — FPSChallenge's tournament platform states
   that FPSAC is mandatory for applicable matches.
2. **CoD4x Anti-Cheat Settings** — a CoD4x security/anti-cheat profile.
3. **RUSCOD Anti-Cheat** — a RUSCOD profile.

The installer does **not** invent undocumented proprietary RUSCOD or FPSAC
console variables. It records the selected profile and mode in the installation
manifest. Actual client/server components must be installed according to the
respective provider's documentation.
