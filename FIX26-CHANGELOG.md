# FIX26 — 4.11.1 Configuration Persistence & Profile Management

## Implemented

- Persistent configuration profile store: `config/config-profiles.json`
- Atomic profile writes via temporary file + rename
- Fixed profile-store path with environment override only
- Profile-name validation
- Maximum 20 profiles
- Basic configuration validation against the active policy
- List profiles
- Save / update profiles
- Activate a stored profile
- Delete profiles
- Audit events for save / activate / delete operations
- Configuration Profiles UI integrated into Audit
- Existing 4.11.0 Configuration & Policy Engine retained

## API

- `GET /api/config/profiles`
- `POST /api/config/profiles/save`
- `POST /api/config/profiles/activate`
- `POST /api/config/profiles/delete`
