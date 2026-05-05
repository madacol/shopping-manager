# Shopping Manager

Reusable shopping-list manager for chat workspaces.

This repo contains:

- `skills/shopping-list-chat/`: the chat skill and authoritative chat CLI.
- `src/server.js` plus `public/`: an optional website/API for viewing and editing the same list.

Runtime data is not part of this repo. Each installed workspace keeps its own local data under `.shopping-list/`.

## Docs

- `WORKSPACE_INSTALL.md`: install the app into another chat workspace.
- `skills/shopping-list-chat/SKILL.md`: runtime instructions for agents using the shopping-list skill.

## Runtime Data

Default workspace data:

```text
.shopping-list/
  shopping-lists.sqlite
```

Override the database path when needed:

```bash
SHOPPING_LIST_DB=/path/to/shopping-lists.sqlite npm run init
```

## Development

```bash
npm install
npm run check
npm test
```

The default web server listens on `127.0.0.1:3000`. Override with `HOST` and `PORT`.

Optional browser test:

```bash
npm run test:e2e
```
