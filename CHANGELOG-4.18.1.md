# COD4X CONTROL 4.18.1

## Runtime verification and UI consistency fix

- Fixed the Verified-Core path contract: runtime verification now accepts the selected executable path and resolves its parent directory before reading the manifest/registry.
- Fixed preflight, adoption and Windows runtime start to use the same platform-aware Verified-Core verifier.
- Restored the visible **Dedicated-Core übernehmen & verifizieren** action when the real executable exists but is not yet verified.
- Persisted the selected CoD4x version in runtime state.
- Candidate selection now applies the discovered Windows/Linux platform before saving.
- Discovery results now show the candidate platform.
- Corrected stale `4.17.2` UI version labels to `4.18.1`.
- Added focused runtime regression checks to the source preflight.
- Kept Linux runtime start intentionally deferred; Linux core discovery and verification remain available.
