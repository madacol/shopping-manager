# Deploy Notes

The website/API is optional. Deploy it only for workspaces that need a browser UI.

Run the server from the workspace whose `.shopping-list/` data should be served:

```bash
cd /path/to/chat-workspace
node /path/to/shopping-manager/src/server.js
```

Or set the database path explicitly:

```bash
SHOPPING_LIST_DB=/path/to/chat-workspace/.shopping-list/shopping-lists.sqlite \
  node /path/to/shopping-manager/src/server.js
```

Static files in `public/` are read from this repo. Runtime list data is read from the configured SQLite database.

Useful checks after deployment:

1. Add an item through the website.
2. Mark an item bought through the website.
3. Add an item through the chat CLI and refresh the website.
