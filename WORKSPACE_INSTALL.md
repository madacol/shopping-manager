# Workspace Install

Use this app from another chat workspace by linking the reusable app code into
that workspace and keeping the workspace data local.

## Layout

In the target workspace, keep shopping manager files under `.agents/`:

```text
.agents/
  apps/shopping-manager
  skills/shopping-list-chat
.shopping-list/
```

- `.agents/apps/shopping-manager` points to this repo.
- `.agents/skills/shopping-list-chat` points to this repo's shopping skill.
- `.shopping-list/` belongs only to the target workspace.

## Agent Instructions

The target workspace's `AGENTS.md` should only route shopping requests to the
skill:

```md
For shopping-list, grocery, supermarket, purchase-list, or item-tracking
requests, read and follow:

`.agents/skills/shopping-list-chat/SKILL.md`

Run shopping commands from the workspace root.
```

Do not put store aliases, item aliases, or workspace-specific shopping data in
`AGENTS.md`. Add that data through the shopping CLI so it stays in the local
database.

## Setup

Follow the `Skill Install` section in `README.md` from the target workspace.
After setup, initialize the target workspace database before using the skill.

For the optional browser UI, follow `DEPLOY_NOTES.md`.

## Use

When the user asks for shopping-list work, the agent should read
`.agents/skills/shopping-list-chat/SKILL.md` and use the CLI documented there.

For unrelated workspace tasks, ignore the shopping skill.
