# TODO

## Deferred

- **Session JSONL cleanup**: Track session IDs created during a pi session. On
  `session_shutdown`, delete the JSONL files from `~/.claude/projects/`. Consider
  `persistSession: false` on `query()` to prevent CC from writing its own JSONL
  (we only need the cc-session-io one for seeding resume). Currently sessions
  accumulate indefinitely with no cleanup or reuse.

- **Case 4 session reuse**: `syncSharedSession` Case 4 creates a fresh session
  every time there are missed messages (e.g., user switched providers mid-conversation).
  Ideally we'd overwrite the existing JSONL with new contents under the same session
  ID, but cc-session-io's API is append-only with auto-generated UUIDs. Would need
  either a `clear()` method upstream or manual file deletion + reconstruction.
  Low priority — the cleanup task above is more impactful.
