# FIX37.1 — 4.17.3 JSX Build Repair

- Fixed malformed JSX in `ProductionRuntimePanel` that caused Vite/esbuild to fail around the runtime candidate/preflight blocks.
- Rewrote the affected runtime UI block with explicit, balanced JSX nesting.
- Kept the 4.17.3 Steam-aware executable discovery, persistent executable selection, and Verified-Core logic unchanged.
- `tsc --jsx react` syntax validation passes for `cod4x-control-improved.jsx`.
