# Deploy Notes

This workspace is wired directly to `shop.babyjarvis.com`.

- Static files in `public/` are served from disk on each request.
  If you change `public/list.js`, `public/list.html`, or `public/styles.css`,
  prod reflects that immediately.
- Backend route changes in `src/server.js` are loaded into the long-running Node
  process memory.
  If you change API routes or server behavior, you must restart the service.

Current prod service:

```bash
systemctl --user restart workspace-site-shop.service
```

Minimal prod smoke tests after server changes:

1. Save a note from the item editor.
2. Re-add an item from recent activity.

Automated prod test:

```bash
npm run test:e2e:prod
```

Prefer keeping and extending end-to-end tests when fixing regressions in this
app. Future agents should read the existing E2E tests before guessing how prod
behaves.
