# Workspace persistence

The Vite process exposes same-origin `GET /workspace` and `PUT /workspace`.
The database row is keyed by a server-issued, opaque `sj-pro-install-id` HttpOnly
cookie. This repository currently has no authenticated web-session identity to
reuse, so persistence is scoped to one browser/install cookie and is not portable
between browsers, devices, or users. The request body cannot select the identity.

The API stores workspace and named profiles together in the additive
`002_workspace_persistence.sql` migration. PUT uses `expectedRevision`; stale
writes return `409` with the authoritative row. The frontend keeps localStorage
as the immediate/offline fallback, hydrates asynchronously, lets server data win,
and only creates the server row after GET reports `404`.
