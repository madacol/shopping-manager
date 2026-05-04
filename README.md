# Shopping List Workspace

This workspace already has a dedicated skill for shopping-list operations:

- Skill: `skills/shopping-list-chat/SKILL.md`

Read that skill before managing the shopping list from chat. It documents:

- which script to run
- how to add, remove, buy, and annotate items
- how requester attribution works
- how image association works
- the distinction between the chat script and the simpler web-app flow

The local workspace data lives under `.shopping-list/`.

- Default database: `.shopping-list/shopping-lists.sqlite`
- Override database path: `SHOPPING_LIST_DB=/path/to/shopping-lists.sqlite`
- Initialize a workspace database: `node skills/shopping-list-chat/scripts/shopping-list.mjs init`

The database is runtime data, not part of the reusable skill/app template. The skill, CLI, server, and web UI should be reusable; each chat workspace should keep its own `.shopping-list/` folder.

## Install Into Another Chat Workspace

From the target chat workspace:

```bash
mkdir -p .agents/skills .shopping-list
ln -s "/home/mada/chat-workspaces/Por comprar--120363164311953924@g.us/skills/shopping-list-chat" .agents/skills/shopping-list-chat
node .agents/skills/shopping-list-chat/scripts/shopping-list.mjs init
```

Run the website for that workspace with:

```bash
node "/home/mada/chat-workspaces/Por comprar--120363164311953924@g.us/src/server.js"
```

The server serves the reusable `public/` files from this workspace, but reads and writes the target workspace's `.shopping-list/shopping-lists.sqlite` because the DB path is resolved from the process working directory.
