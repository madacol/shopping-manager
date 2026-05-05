# Workspace Install

## Layout

In a target workspace, link the reusable app and skill under `.agents/`:

```text
.agents/
  apps/shopping-manager
  skills/shopping-list-chat
.shopping-list/
```

- `.agents/apps/shopping-manager` points to this repo.
- `.agents/skills/shopping-list-chat` points to this repo's shopping skill.
- `.shopping-list/` is local runtime data for the target workspace.

## Agent Instructions

When an agent needs the shopping-list capability, point it to:

```text
.agents/skills/shopping-list-chat/SKILL.md
```

Run the skill commands from the target workspace root so the local database is
used.

## Setup

From the target workspace:

```bash
mkdir -p .agents/apps .agents/skills .shopping-list

ln -s "/path/to/shopping-manager" .agents/apps/shopping-manager
ln -s "../apps/shopping-manager/skills/shopping-list-chat" .agents/skills/shopping-list-chat

node .agents/skills/shopping-list-chat/scripts/shopping-list.mjs init
```

The `init` command creates this workspace's local database.

For the optional browser UI, follow `DEPLOY_NOTES.md`.

## Use

Workspace-specific data, such as aliases, belongs in the local database, not in
the linked skill files.

Example:

```bash
node .agents/skills/shopping-list-chat/scripts/shopping-list.mjs add-list-alias dunnes supermercado
```
