# FIX21 – Security Path Validation Fix

## 4.10.8 follow-up

Fixed the Security Hardening path validator so the default relative installation path `./server` is accepted.

- `./server` is normalized to `server`
- benign `.` path segments are allowed and normalized away
- `..` path traversal remains rejected
- absolute paths remain rejected
- invalid path segments remain rejected
- installation-root boundary check remains active

No UI redesign and no version bump. App version remains 3.0.2 RC1.
