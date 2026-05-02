---
name: shopping-list-chat
description: Manage this chat's shopping list in a local SQLite database from natural-language requests. Use when the user wants to add, remove, correct, buy, inspect, or alias grocery or shopping-list items for this workspace, and persist those changes reliably across turns.
---

# Shopping List Chat

Use the bundled script to persist shopping-list changes in `shopping-lists.sqlite` in the current workspace.

This is the documentation to read before handling shopping-list requests in this workspace.

Track metadata per requester, not just per item:

- `item.qty`: total pending quantity
- `orders[]`: per-person breakdown
- `orders[].image_ref`: local path or other reference to that person's associated image
- `orders[].note`: optional note for that person's request

## Workflow

1. Translate the user's message into one or more explicit operations.
2. If the request is ambiguous, ask before writing.
3. Run the script from the workspace root.
4. Reply with the resulting mutation or list contents.

## Commands

Use `node skills/shopping-list-chat/scripts/shopping-list.mjs ...`.

- Add an item:
  `node skills/shopping-list-chat/scripts/shopping-list.mjs add-item "rice cakes" 5 supermercado`
- Add an item with requester and media at creation time:
  `node skills/shopping-list-chat/scripts/shopping-list.mjs add-item "maternity pads" 2 supermercado --by "Quoted from 47790185013373" --media "/path/to/image.jpg"`
- Add an item directly from a screenshot/photo/audio reference:
  `node skills/shopping-list-chat/scripts/shopping-list.mjs add-item "Pregnacare Breastfeeding" 1 farmacia --media "/path/to/screenshot.jpg" --note "Holland & Barrett; €20.63"`
- Attach an image or note to one person's order after the fact:
  `node skills/shopping-list-chat/scripts/shopping-list.mjs annotate-order "maternity pads" supermercado --by "Quoted from 47790185013373" --media "/path/to/image.jpg" --note "exact brand from photo"`
- Reopen an item as pending without changing quantity:
  `node skills/shopping-list-chat/scripts/shopping-list.mjs mark-pending "rice cakes" supermercado`
- Remove an item:
  `node skills/shopping-list-chat/scripts/shopping-list.mjs remove-item "coca cola" supermercado`
- Mark an item as bought:
  `node skills/shopping-list-chat/scripts/shopping-list.mjs mark-bought "maternity pads" supermercado`
- Show one list:
  `node skills/shopping-list-chat/scripts/shopping-list.mjs show-list supermercado`
- Show known lists:
  `node skills/shopping-list-chat/scripts/shopping-list.mjs show-lists`
- Add an item alias:
  `node skills/shopping-list-chat/scripts/shopping-list.mjs add-alias coke "coca cola"`
- Add a list alias:
  `node skills/shopping-list-chat/scripts/shopping-list.mjs add-list-alias dunnes supermercado`
- Show recent history:
  `node skills/shopping-list-chat/scripts/shopping-list.mjs show-events 20`

## Rules

- Default list is `supermercado` unless the user clearly specifies another one.
- Resolve list aliases before any read or write.
- Resolve item aliases before any write.
- Append an `events` row on every mutation.
- Persist per-person quantities in `item_orders`.
- Persist optional per-person notes in `item_orders.note`.
- Do not block insertion just because the sender is uncertain.
- Build a richer requester label from any useful sender hints available in the artifact or message. Combine multiple hints when helpful, such as quoted metadata, names mentioned in the content, relationship clues, media type, phone-like identifiers, or other contextual descriptors that make the source easier to recognize later.
- Default missing requester names to `unknown` only when there is no better hint at all.
- Keep `unknown` in storage if needed, but omit it from user-facing list displays unless it is necessary to explain a discrepancy or answer a direct question about provenance.
- When adding a new item from media, prefer `add-item ... --media ...` so the item and its order media are created in one mutation.
- Use `annotate-order ... --media ...` only when the item/order already exists and the media arrives afterward.
- Store media on the matching per-person order.
- Use soft delete via `status = "removed"` instead of hard delete.
- Normalize obvious whitespace and casing, but do not silently rewrite meaningful product names.

## Media Association

- Media is attached per requester order, not directly on the aggregate item.
- The legacy field is `item_orders.image_ref`; the web app reads the normalized `order_media` rows.
- The practical active-order key is `(list, canonical item, ordered_by, status=pending)`.
- `add-item ... --by ... --media ...` creates or updates that person's pending order row and writes the matching `order_media` row.
- `annotate-order ... --by ... --media ...` updates an existing pending order for that same requester and writes the matching `order_media` row.
- Supported media is inferred from file extension: images (`.jpg`, `.png`, `.webp`), audio (`.ogg`, `.mp3`, `.wav`, `.m4a`), and video (`.mp4`, `.mov`, `.webm`).
- `items.qty` is the sum of pending `item_orders.qty` for the current grouped item.
- Bought/removed orders keep their own media in history and must not leak into a new pending order for the same item.

## Current Architecture

- `skills/shopping-list-chat/scripts/shopping-list.mjs` is the authoritative CLI for chat requests, per-person provenance, and media association.
- `src/server.js` and `public/list.js` expose the grouped web view from `item_orders.status`.
- If the request is about chat operations, prefer the skill script, not the simpler CLI.

## Current Chat Convention

Treat `dunnes` as an alias of `supermercado`.
