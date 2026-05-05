# Shopping Manager

Reusable shopping-list manager for chat workspaces.

This repo contains two reusable surfaces:

- `skills/shopping-list-chat/`: the chat skill and authoritative chat CLI.
- `src/server.js` plus `public/`: an optional website/API for viewing and editing the same list.

Runtime data is not part of this repo. Each installed workspace keeps its own local data under `.shopping-list/`.

## Data Layout

Default runtime data:

```text
.shopping-list/
  shopping-lists.sqlite
```

The database is created automatically on first use:

```bash
npm run init
```

Override the database path when needed:

```bash
SHOPPING_LIST_DB=/path/to/shopping-lists.sqlite npm run init
```

## Skill Install

From a target chat workspace, symlink the skill and initialize local data:

```bash
mkdir -p .agents/skills .shopping-list
ln -s "/path/to/shopping-manager/skills/shopping-list-chat" .agents/skills/shopping-list-chat
node .agents/skills/shopping-list-chat/scripts/shopping-list.mjs init
```

The skill code comes from this repo. The database is created in the target workspace.

## Website

The website is optional. Run it from the target workspace when you want a web UI over that workspace's local DB:

```bash
cd /path/to/target-chat-workspace
node "/path/to/shopping-manager/src/server.js"
```

Or run it with an explicit DB:

```bash
SHOPPING_LIST_DB=/path/to/target-chat-workspace/.shopping-list/shopping-lists.sqlite \
  node "/path/to/shopping-manager/src/server.js"
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

## Local Aliases

List and item aliases are runtime data. Add them with the CLI instead of hardcoding them in the skill:

```bash
node skills/shopping-list-chat/scripts/shopping-list.mjs add-list-alias dunnes supermercado
```
