// @ts-check

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * @typedef {import('node:sqlite').StatementSync} StatementSync
 */

/**
 * @typedef {object} ListRow
 * @property {number} id
 * @property {string} name
 */

/**
 * @typedef {object} ListNameRow
 * @property {string} name
 */

/**
 * @typedef {object} AliasRow
 * @property {string} canonical_name
 */

/**
 * @typedef {'image' | 'audio' | 'video'} MediaKind
 */

/**
 * @typedef {object} MediaRow
 * @property {number} id
 * @property {number} item_order_id
 * @property {MediaKind} kind
 * @property {string} path
 * @property {string | null} mime_type
 * @property {string} created_at
 */

/**
 * @typedef {object} OrderRow
 * @property {number} id
 * @property {number} item_id
 * @property {string} ordered_by
 * @property {number} qty
 * @property {string | null} note
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {object} ItemRow
 * @property {number} id
 * @property {number} list_id
 * @property {string} canonical_name
 * @property {string} status
 * @property {string | null} note
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {object} OrderMediaView
 * @property {number} id
 * @property {MediaKind} kind
 * @property {string} path
 * @property {string | null} mime_type
 * @property {string} created_at
 */

/**
 * @typedef {object} OrderView
 * @property {number} id
 * @property {string} ordered_by
 * @property {number} qty
 * @property {string | null} note
 * @property {string} created_at
 * @property {string} updated_at
 * @property {OrderMediaView[]} media
 */

/**
 * @typedef {object} ListItemRow
 * @property {string} name
 * @property {number} qty
 * @property {string} status
 * @property {string | null} note
 * @property {string} created_at
 * @property {string} updated_at
 * @property {OrderView[]} orders
 */

/**
 * @typedef {object} EventRow
 * @property {number} id
 * @property {number} list_id
 * @property {number | null} item_id
 * @property {string} action
 * @property {string | null} payload_json
 * @property {string} created_at
 */

/**
 * @typedef {object} ListVersionRow
 * @property {number} version
 */

/**
 * @typedef {object} SqliteRunResult
 * @property {number | bigint} lastInsertRowid
 * @property {number} changes
 */

/**
 * @typedef {object} Statements
 * @property {StatementSync} insertList
 * @property {StatementSync} getListByName
 * @property {StatementSync} getAllLists
 * @property {StatementSync} resolveAlias
 * @property {StatementSync} ensureItem
 * @property {StatementSync} getItemByCanonicalName
 * @property {StatementSync} getItemByCanonicalNameNoCase
 * @property {StatementSync} getItemById
 * @property {StatementSync} renameItem
 * @property {StatementSync} insertEvent
 * @property {StatementSync} markBought
 * @property {StatementSync} markPending
 * @property {StatementSync} markRemoved
 * @property {StatementSync} touchItem
 * @property {StatementSync} showAllItems
 * @property {StatementSync} getListVersion
 * @property {StatementSync} showList
 * @property {StatementSync} upsertAlias
 * @property {StatementSync} showEvents
 * @property {StatementSync} upsertOrder
 * @property {StatementSync} setOrderQty
 * @property {StatementSync} setOrderNote
 * @property {StatementSync} deleteOrder
 * @property {StatementSync} getOrdersForItem
 * @property {StatementSync} insertOrderMedia
 * @property {StatementSync} getMediaForOrder
 * @property {StatementSync} getMediaById
 * @property {StatementSync} legacyOrderMediaRows
 * @property {StatementSync} existingMigratedMedia
 * @property {StatementSync} backfillOrders
 */

/**
 * @typedef {object} AliasResult
 * @property {true} ok
 * @property {string} alias
 * @property {string} canonicalName
 */

/**
 * @typedef {object} ItemMutationResult
 * @property {true} ok
 * @property {string} list
 * @property {string} item
 * @property {number} qty
 * @property {string} status
 * @property {string | null} note
 * @property {OrderView[]} orders
 */

/**
 * @typedef {object} ShowListResult
 * @property {true} ok
 * @property {string} list
 * @property {string} status
 * @property {ListItemRow[]} items
 */

/**
 * @typedef {object} ShowEventsResult
 * @property {true} ok
 * @property {EventRow[]} events
 */

/**
 * @typedef {object} ListSnapshotResult
 * @property {true} ok
 * @property {string} list
 * @property {number} version
 * @property {boolean} changed
 * @property {ListItemRow[]=} items
 */

/**
 * @template T
 * @param {T | undefined} value
 * @param {string} message
 * @returns {T}
 */
function assertDefined(value, message) {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

const UNKNOWN_ORDERED_BY = 'unknown';

export class ShoppingListDb {
  /** @type {DatabaseSync} */
  db;

  /** @type {Statements} */
  statements;

  /**
   * @param {string} [dbPath='shopping-lists.sqlite']
   */
  constructor(dbPath = 'shopping-lists.sqlite') {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.#initSchema();
    this.#ensureItemColumn('note', 'TEXT');
    this.#ensureOrderColumn('note', 'TEXT');
    this.#ensureOrderColumn('image_ref', 'TEXT');
    this.#ensureMediaColumn('mime_type', 'TEXT');
    this.statements = this.#prepareStatements();
    this.#backfillOrders();
    this.#migrateLegacyOrderMedia();
  }

  /**
   * @returns {void}
   */
  close() {
    this.db.close();
  }

  /**
   * @param {string} name
   * @returns {ListRow}
   */
  createList(name) {
    const normalizedName = this.#normalizeListName(name);
    this.statements.insertList.run(normalizedName);
    return /** @type {ListRow} */ (
      assertDefined(
        this.statements.getListByName.get(normalizedName),
        `List not found after create: ${normalizedName}`
      )
    );
  }

  /**
   * @returns {string[]}
   */
  listLists() {
    return /** @type {ListNameRow[]} */ (this.statements.getAllLists.all()).map((row) => row.name);
  }

  /**
   * @param {string} rawItem
   * @returns {string}
   */
  resolveCanonicalName(rawItem) {
    const normalizedItem = this.#normalizeItemName(rawItem);
    const alias = /** @type {AliasRow | undefined} */ (this.statements.resolveAlias.get(normalizedItem));
    return alias?.canonical_name ?? normalizedItem;
  }

  /**
   * @param {number} listId
   * @param {string} canonicalName
   * @returns {ItemRow | undefined}
   */
  #getItemByCanonicalName(listId, canonicalName) {
    return /** @type {ItemRow | undefined} */ (
      this.statements.getItemByCanonicalName.get(listId, canonicalName) ??
        this.statements.getItemByCanonicalNameNoCase.get(listId, canonicalName)
    );
  }

  /**
   * @param {string} alias
   * @param {string} canonicalName
   * @returns {AliasResult}
   */
  addAlias(alias, canonicalName) {
    const normalizedAlias = this.#normalizeItemName(alias).toLowerCase();
    const normalizedCanonicalName = this.#normalizeItemName(canonicalName).toLowerCase();

    this.statements.upsertAlias.run(normalizedAlias, normalizedCanonicalName);

    return {
      ok: true,
      alias: normalizedAlias,
      canonicalName: normalizedCanonicalName
    };
  }

  /**
   * @param {string} listName
   * @param {string} rawItem
   * @param {number | string} [qty=1]
   * @param {string | null | undefined} [note]
   * @returns {ItemMutationResult}
   */
  addItem(listName, rawItem, qty = 1, note) {
    const normalizedListName = this.#normalizeListName(listName);
    const parsedQty = Number(qty);
    const normalizedNote = this.#normalizeOptionalNote(note);

    if (!Number.isFinite(parsedQty) || parsedQty <= 0) {
      throw new Error('Quantity must be a positive number');
    }

    return this.#transaction(() => {
      const list = this.createList(normalizedListName);
      let canonicalName = this.resolveCanonicalName(rawItem).toLowerCase();
      let item = this.#getItemByCanonicalName(list.id, canonicalName);

      if (item === undefined) {
        this.statements.ensureItem.run(list.id, canonicalName);
        item = /** @type {ItemRow} */ (
          assertDefined(
            this.statements.getItemByCanonicalName.get(list.id, canonicalName),
            `Item not found after ensure: ${canonicalName}`
          )
        );
      } else {
        canonicalName = item.canonical_name;
        if (item.status !== 'pending') {
          this.statements.markPending.run(item.id);
        }
      }

      this.statements.upsertOrder.run(item.id, UNKNOWN_ORDERED_BY, parsedQty, normalizedNote);
      this.statements.touchItem.run(item.id);

      const updated = this.#getItemView(item.id);

      this.statements.insertEvent.run(
        list.id,
        item.id,
        'add_item',
        JSON.stringify({
          rawItem: this.#normalizeItemName(rawItem),
          canonicalName,
          qty: parsedQty,
          orderedBy: UNKNOWN_ORDERED_BY,
          note: normalizedNote
        })
      );

      return this.#toMutationResult(list.name, updated);
    });
  }

  /**
   * @param {string} listName
   * @param {string} rawItem
   * @param {string | null | undefined} note
   * @returns {ItemMutationResult}
   */
  setItemNote(listName, rawItem, note) {
    const normalizedListName = this.#normalizeListName(listName);
    const normalizedNote = this.#normalizeOptionalNote(note);

    return this.#transaction(() => {
      const list = this.createList(normalizedListName);
      const requestedCanonicalName = this.resolveCanonicalName(rawItem).toLowerCase();
      const item = this.#getItemByCanonicalName(list.id, requestedCanonicalName);

      if (item === undefined) {
        throw new Error(`Item not found: ${requestedCanonicalName}`);
      }

      const canonicalName = item.canonical_name;
      const orders = this.#getOrdersForItem(item.id);
      const editableOrder = this.#getEditableOrder(orders, canonicalName, 'update note');

      if (normalizedNote === null && orders.length === 1) {
        this.statements.setOrderNote.run(null, editableOrder.id);
      } else {
        this.statements.setOrderNote.run(normalizedNote, editableOrder.id);
      }

      this.statements.touchItem.run(item.id);
      const updated = this.#getItemView(item.id);

      this.statements.insertEvent.run(
        list.id,
        item.id,
        'set_note',
        JSON.stringify({
          rawItem: this.#normalizeItemName(rawItem),
          canonicalName,
          orderedBy: editableOrder.ordered_by,
          note: normalizedNote
        })
      );

      return this.#toMutationResult(list.name, updated);
    });
  }

  /**
   * @param {string} listName
   * @param {string} rawItem
   * @returns {ItemMutationResult}
   */
  markBought(listName, rawItem) {
    return this.#setItemStatus(listName, rawItem, 'bought', 'mark_bought');
  }

  /**
   * @param {string} listName
   * @param {string} rawItem
   * @returns {ItemMutationResult}
   */
  markPending(listName, rawItem) {
    return this.#setItemStatus(listName, rawItem, 'pending', 'mark_pending');
  }

  /**
   * @param {string} listName
   * @param {string} rawItem
   * @param {number | string} [qty]
   * @returns {ItemMutationResult}
   */
  removeItem(listName, rawItem, qty) {
    const normalizedListName = this.#normalizeListName(listName);

    return this.#transaction(() => {
      const list = this.createList(normalizedListName);
      const requestedCanonicalName = this.resolveCanonicalName(rawItem).toLowerCase();
      const item = this.#getItemByCanonicalName(list.id, requestedCanonicalName);

      if (item === undefined) {
        throw new Error(`Item not found: ${requestedCanonicalName}`);
      }

      const canonicalName = item.canonical_name;
      const orders = this.#getOrdersForItem(item.id);
      const currentQty = sumOrderQty(orders);
      const parsedQty = qty === undefined ? currentQty : Number(qty);

      if (!Number.isFinite(parsedQty) || parsedQty <= 0) {
        throw new Error('Quantity must be a positive number');
      }

      let qtyRemoved = 0;
      let remainingQty = currentQty;

      if (parsedQty >= currentQty) {
        this.statements.markRemoved.run(item.id);
        qtyRemoved = currentQty;
        remainingQty = currentQty;
      } else {
        let leftToRemove = parsedQty;
        for (const order of sortOrdersForRemoval(orders)) {
          if (leftToRemove <= 0) {
            break;
          }

          const removeFromOrder = Math.min(order.qty, leftToRemove);
          const nextQty = order.qty - removeFromOrder;

          if (nextQty <= 0) {
            this.statements.deleteOrder.run(order.id);
          } else {
            this.statements.setOrderQty.run(nextQty, order.id);
          }

          leftToRemove -= removeFromOrder;
          qtyRemoved += removeFromOrder;
        }

        remainingQty = currentQty - qtyRemoved;
        this.statements.touchItem.run(item.id);
      }

      const updated = this.#getItemView(item.id);

      this.statements.insertEvent.run(
        list.id,
        item.id,
        'remove_item',
        JSON.stringify({
          rawItem: this.#normalizeItemName(rawItem),
          canonicalName,
          requestedQty: parsedQty,
          qtyRemoved,
          remainingQty
        })
      );

      return this.#toMutationResult(list.name, updated);
    });
  }

  /**
   * @param {string} listName
   * @param {string} currentRawItem
   * @param {string | undefined} rawNextItem
   * @param {number | string | undefined} qty
   * @param {string | null | undefined} note
   * @returns {ItemMutationResult}
   */
  editItem(listName, currentRawItem, rawNextItem, qty, note) {
    const normalizedListName = this.#normalizeListName(listName);
    const normalizedNote = note === undefined ? undefined : this.#normalizeOptionalNote(note);

    return this.#transaction(() => {
      const list = this.createList(normalizedListName);
      const requestedCurrentCanonicalName = this.resolveCanonicalName(currentRawItem).toLowerCase();
      const item = this.#getItemByCanonicalName(list.id, requestedCurrentCanonicalName);

      if (item === undefined) {
        throw new Error(`Item not found: ${requestedCurrentCanonicalName}`);
      }

      const currentCanonicalName = item.canonical_name;
      const currentView = this.#getItemView(item.id);
      const nextCanonicalName =
        rawNextItem === undefined
          ? item.canonical_name
          : this.resolveCanonicalName(rawNextItem).toLowerCase();
      const nextQty = qty === undefined ? currentView.qty : Number(qty);

      if (!Number.isFinite(nextQty) || nextQty <= 0) {
        throw new Error('Quantity must be a positive number');
      }

      if (nextCanonicalName !== item.canonical_name) {
        this.statements.renameItem.run(nextCanonicalName, item.id);
      }

      const qtyChanged = nextQty !== currentView.qty;
      const noteChanged = normalizedNote !== undefined && normalizedNote !== currentView.note;

      if (qtyChanged || noteChanged) {
        const editableOrder = this.#getEditableOrder(currentView.orders, currentCanonicalName, 'edit aggregate item');

        if (qtyChanged) {
          this.statements.setOrderQty.run(nextQty, editableOrder.id);
        }

        if (noteChanged) {
          this.statements.setOrderNote.run(normalizedNote ?? null, editableOrder.id);
        }

        this.statements.touchItem.run(item.id);
      }

      const updated = this.#getItemView(item.id);

      this.statements.insertEvent.run(
        list.id,
        item.id,
        'edit_item',
        JSON.stringify({
          rawItem: this.#normalizeItemName(currentRawItem),
          canonicalName: currentCanonicalName,
          nextRawItem: rawNextItem === undefined ? undefined : this.#normalizeItemName(rawNextItem),
          nextCanonicalName,
          qty: nextQty,
          note: normalizedNote
        })
      );

      return this.#toMutationResult(list.name, updated);
    });
  }

  /**
   * @param {string} listName
   * @param {string} [status='pending']
   * @returns {ShowListResult}
   */
  showList(listName, status = 'pending') {
    const normalizedListName = this.#normalizeListName(listName);
    const list = this.createList(normalizedListName);
    const items = /** @type {ItemRow[]} */ (this.statements.showList.all(list.id, status));

    return {
      ok: true,
      list: list.name,
      status,
      items: items.map((item) => this.#buildItemView(item))
    };
  }

  /**
   * @param {string} listName
   * @param {number | string | null | undefined} [sinceVersion]
   * @returns {ListSnapshotResult}
   */
  getListSnapshot(listName, sinceVersion) {
    const normalizedListName = this.#normalizeListName(listName);
    const list = this.createList(normalizedListName);
    const versionRow = /** @type {ListVersionRow | undefined} */ (this.statements.getListVersion.get(list.id));
    const version = Number(versionRow?.version ?? 0);

    if (sinceVersion !== undefined && sinceVersion !== null) {
      const parsedSinceVersion = Number(sinceVersion);

      if (!Number.isInteger(parsedSinceVersion) || parsedSinceVersion < 0) {
        throw new Error('Version must be a non-negative integer');
      }

      if (parsedSinceVersion === version) {
        return {
          ok: true,
          list: list.name,
          version,
          changed: false
        };
      }
    }

    return {
      ok: true,
      list: list.name,
      version,
      changed: true,
      items: /** @type {ItemRow[]} */ (this.statements.showAllItems.all(list.id)).map((item) =>
        this.#buildItemView(item)
      )
    };
  }

  /**
   * @param {number | string} [limit=50]
   * @returns {ShowEventsResult}
   */
  showEvents(limit = 50) {
    const parsedLimit = Number(limit);

    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      throw new Error('Limit must be a positive number');
    }

    return {
      ok: true,
      events: /** @type {EventRow[]} */ (this.statements.showEvents.all(parsedLimit))
    };
  }

  /**
   * @param {number} mediaId
   * @returns {MediaRow | undefined}
   */
  getMediaById(mediaId) {
    return /** @type {MediaRow | undefined} */ (this.statements.getMediaById.get(mediaId));
  }

  /**
   * @returns {void}
   */
  #initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        list_id INTEGER NOT NULL,
        canonical_name TEXT NOT NULL,
        qty REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        note TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(list_id, canonical_name),
        FOREIGN KEY (list_id) REFERENCES lists(id)
      );

      CREATE TABLE IF NOT EXISTS item_aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alias TEXT NOT NULL UNIQUE,
        canonical_name TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS item_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        ordered_by TEXT NOT NULL,
        qty REAL NOT NULL DEFAULT 0,
        image_ref TEXT,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(item_id, ordered_by),
        FOREIGN KEY (item_id) REFERENCES items(id)
      );

      CREATE TABLE IF NOT EXISTS order_media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_order_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('image', 'audio', 'video')),
        path TEXT NOT NULL,
        mime_type TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (item_order_id) REFERENCES item_orders(id)
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        list_id INTEGER NOT NULL,
        item_id INTEGER,
        action TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (list_id) REFERENCES lists(id),
        FOREIGN KEY (item_id) REFERENCES items(id)
      );
    `);
  }

  /**
   * @returns {Statements}
   */
  #prepareStatements() {
    return {
      insertList: this.db.prepare(`
        INSERT INTO lists(name)
        VALUES (?)
        ON CONFLICT(name) DO NOTHING
      `),
      getListByName: this.db.prepare(`
        SELECT id, name
        FROM lists
        WHERE name = ?
      `),
      getAllLists: this.db.prepare(`
        SELECT name
        FROM lists
        ORDER BY name
      `),
      resolveAlias: this.db.prepare(`
        SELECT canonical_name
        FROM item_aliases
        WHERE lower(alias) = lower(?)
      `),
      ensureItem: this.db.prepare(`
        INSERT INTO items(list_id, canonical_name, status, updated_at)
        VALUES (?, ?, 'pending', CURRENT_TIMESTAMP)
        ON CONFLICT(list_id, canonical_name)
        DO UPDATE SET
          status = 'pending',
          updated_at = CURRENT_TIMESTAMP
      `),
      getItemByCanonicalName: this.db.prepare(`
        SELECT id, list_id, canonical_name, status, note, created_at, updated_at
        FROM items
        WHERE list_id = ? AND canonical_name = ?
      `),
      getItemByCanonicalNameNoCase: this.db.prepare(`
        SELECT id, list_id, canonical_name, status, note, created_at, updated_at
        FROM items
        WHERE list_id = ? AND lower(canonical_name) = lower(?)
        ORDER BY id
        LIMIT 1
      `),
      getItemById: this.db.prepare(`
        SELECT id, list_id, canonical_name, status, note, created_at, updated_at
        FROM items
        WHERE id = ?
      `),
      renameItem: this.db.prepare(`
        UPDATE items
        SET canonical_name = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `),
      insertEvent: this.db.prepare(`
        INSERT INTO events(list_id, item_id, action, payload_json)
        VALUES (?, ?, ?, ?)
      `),
      markBought: this.db.prepare(`
        UPDATE items
        SET status = 'bought',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `),
      markPending: this.db.prepare(`
        UPDATE items
        SET status = 'pending',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `),
      markRemoved: this.db.prepare(`
        UPDATE items
        SET status = 'removed',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `),
      touchItem: this.db.prepare(`
        UPDATE items
        SET updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `),
      showAllItems: this.db.prepare(`
        SELECT id, list_id, canonical_name, status, note, created_at, updated_at
        FROM items
        WHERE list_id = ?
        ORDER BY
          CASE status
            WHEN 'pending' THEN 0
            WHEN 'bought' THEN 1
            ELSE 2
          END,
          canonical_name
      `),
      getListVersion: this.db.prepare(`
        SELECT COALESCE(MAX(id), 0) AS version
        FROM events
        WHERE list_id = ?
      `),
      showList: this.db.prepare(`
        SELECT id, list_id, canonical_name, status, note, created_at, updated_at
        FROM items
        WHERE list_id = ? AND status = ?
        ORDER BY canonical_name
      `),
      upsertAlias: this.db.prepare(`
        INSERT INTO item_aliases(alias, canonical_name)
        VALUES (?, ?)
        ON CONFLICT(alias)
        DO UPDATE SET canonical_name = excluded.canonical_name
      `),
      showEvents: this.db.prepare(`
        SELECT id, list_id, item_id, action, payload_json, created_at
        FROM events
        ORDER BY id DESC
        LIMIT ?
      `),
      upsertOrder: this.db.prepare(`
        INSERT INTO item_orders(item_id, ordered_by, qty, note, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(item_id, ordered_by)
        DO UPDATE SET
          qty = item_orders.qty + excluded.qty,
          note = COALESCE(excluded.note, item_orders.note),
          updated_at = CURRENT_TIMESTAMP
      `),
      setOrderQty: this.db.prepare(`
        UPDATE item_orders
        SET qty = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `),
      setOrderNote: this.db.prepare(`
        UPDATE item_orders
        SET note = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `),
      deleteOrder: this.db.prepare(`
        DELETE FROM item_orders
        WHERE id = ?
      `),
      getOrdersForItem: this.db.prepare(`
        SELECT id, item_id, ordered_by, qty, note, created_at, updated_at
        FROM item_orders
        WHERE item_id = ?
          AND qty > 0
        ORDER BY lower(ordered_by), id
      `),
      insertOrderMedia: this.db.prepare(`
        INSERT INTO order_media(item_order_id, kind, path, mime_type)
        VALUES (?, ?, ?, ?)
      `),
      getMediaForOrder: this.db.prepare(`
        SELECT id, item_order_id, kind, path, mime_type, created_at
        FROM order_media
        WHERE item_order_id = ?
        ORDER BY id
      `),
      getMediaById: this.db.prepare(`
        SELECT id, item_order_id, kind, path, mime_type, created_at
        FROM order_media
        WHERE id = ?
      `),
      legacyOrderMediaRows: this.db.prepare(`
        SELECT id, image_ref
        FROM item_orders
        WHERE image_ref IS NOT NULL
          AND trim(image_ref) <> ''
      `),
      existingMigratedMedia: this.db.prepare(`
        SELECT id
        FROM order_media
        WHERE item_order_id = ?
          AND path = ?
        LIMIT 1
      `),
      backfillOrders: this.db.prepare(`
        INSERT INTO item_orders(item_id, ordered_by, qty, note)
        SELECT items.id,
               ?,
               items.qty,
               items.note
        FROM items
        WHERE items.qty > 0
          AND NOT EXISTS (
            SELECT 1
            FROM item_orders
            WHERE item_orders.item_id = items.id
          )
      `)
    };
  }

  /**
   * @param {string} listName
   * @param {string} rawItem
   * @param {'bought' | 'pending'} status
   * @param {'mark_bought' | 'mark_pending'} action
   * @returns {ItemMutationResult}
   */
  #setItemStatus(listName, rawItem, status, action) {
    const normalizedListName = this.#normalizeListName(listName);

    return this.#transaction(() => {
      const list = this.createList(normalizedListName);
      const requestedCanonicalName = this.resolveCanonicalName(rawItem).toLowerCase();
      const item = this.#getItemByCanonicalName(list.id, requestedCanonicalName);

      if (item === undefined) {
        throw new Error(`Item not found: ${requestedCanonicalName}`);
      }

      const canonicalName = item.canonical_name;
      const statusStatement = status === 'bought' ? this.statements.markBought : this.statements.markPending;
      const result = /** @type {SqliteRunResult} */ (statusStatement.run(item.id));

      if (result.changes === 0) {
        throw new Error(`Item not found: ${canonicalName}`);
      }

      const updated = this.#getItemView(item.id);

      this.statements.insertEvent.run(
        list.id,
        item.id,
        action,
        JSON.stringify({
          rawItem: this.#normalizeItemName(rawItem),
          canonicalName
        })
      );

      return this.#toMutationResult(list.name, updated);
    });
  }

  /**
   * @param {number} itemId
   * @returns {ListItemRow}
   */
  #getItemView(itemId) {
    const item = /** @type {ItemRow | undefined} */ (this.statements.getItemById.get(itemId));
    if (item === undefined) {
      throw new Error(`Item not found: ${itemId}`);
    }
    return this.#buildItemView(item);
  }

  /**
   * @param {ItemRow} item
   * @returns {ListItemRow}
   */
  #buildItemView(item) {
    const orders = this.#getOrdersForItem(item.id).map((order) => ({
      id: order.id,
      ordered_by: order.ordered_by,
      qty: order.qty,
      note: order.note,
      created_at: order.created_at,
      updated_at: order.updated_at,
      media: this.#getMediaForOrder(order.id)
    }));

    return {
      name: item.canonical_name,
      qty: sumOrderQty(orders),
      status: item.status,
      note: pickAggregateNote(item.note, orders),
      created_at: item.created_at,
      updated_at: item.updated_at,
      orders
    };
  }

  /**
   * @param {string} listName
   * @param {ListItemRow} item
   * @returns {ItemMutationResult}
   */
  #toMutationResult(listName, item) {
    return {
      ok: true,
      list: listName,
      item: item.name,
      qty: item.qty,
      status: item.status,
      note: item.note,
      orders: item.orders
    };
  }

  /**
   * @param {number} itemId
   * @returns {OrderRow[]}
   */
  #getOrdersForItem(itemId) {
    return /** @type {OrderRow[]} */ (this.statements.getOrdersForItem.all(itemId));
  }

  /**
   * @param {number} orderId
   * @returns {OrderMediaView[]}
   */
  #getMediaForOrder(orderId) {
    return /** @type {MediaRow[]} */ (this.statements.getMediaForOrder.all(orderId)).map((media) => ({
      id: media.id,
      kind: media.kind,
      path: media.path,
      mime_type: media.mime_type,
      created_at: media.created_at
    }));
  }

  /**
   * @param {Array<{ id: number, ordered_by: string }>} orders
   * @param {string} canonicalName
   * @param {string} action
   * @returns {{ id: number, ordered_by: string }}
   */
  #getEditableOrder(orders, canonicalName, action) {
    if (orders.length === 1) {
      return orders[0];
    }

    const unknownOrder = orders.find((order) => order.ordered_by === UNKNOWN_ORDERED_BY);
    if (unknownOrder !== undefined && orders.length === 1) {
      return unknownOrder;
    }

    throw new Error(`Cannot ${action} for ${canonicalName} because it has multiple orders`);
  }

  /**
   * @returns {void}
   */
  #backfillOrders() {
    this.statements.backfillOrders.run(UNKNOWN_ORDERED_BY);
  }

  /**
   * @returns {void}
   */
  #migrateLegacyOrderMedia() {
    const rows = /** @type {Array<{ id: number, image_ref: string }>} */ (this.statements.legacyOrderMediaRows.all());

    for (const row of rows) {
      const existing = this.statements.existingMigratedMedia.get(row.id, row.image_ref);
      if (existing !== undefined) {
        continue;
      }

      this.statements.insertOrderMedia.run(row.id, inferMediaKind(row.image_ref), row.image_ref, inferMimeType(row.image_ref));
    }
  }

  /**
   * @param {string} columnName
   * @param {string} columnType
   * @returns {void}
   */
  #ensureItemColumn(columnName, columnType) {
    const columns = /** @type {Array<{ name: string }>} */ (
      this.db.prepare('PRAGMA table_info(items)').all()
    );

    if (!columns.some((column) => column.name === columnName)) {
      this.db.exec(`ALTER TABLE items ADD COLUMN ${columnName} ${columnType}`);
    }
  }

  /**
   * @param {string} columnName
   * @param {string} columnType
   * @returns {void}
   */
  #ensureOrderColumn(columnName, columnType) {
    const columns = /** @type {Array<{ name: string }>} */ (
      this.db.prepare('PRAGMA table_info(item_orders)').all()
    );

    if (!columns.some((column) => column.name === columnName)) {
      this.db.exec(`ALTER TABLE item_orders ADD COLUMN ${columnName} ${columnType}`);
    }
  }

  /**
   * @param {string} columnName
   * @param {string} columnType
   * @returns {void}
   */
  #ensureMediaColumn(columnName, columnType) {
    const columns = /** @type {Array<{ name: string }>} */ (
      this.db.prepare('PRAGMA table_info(order_media)').all()
    );

    if (!columns.some((column) => column.name === columnName)) {
      this.db.exec(`ALTER TABLE order_media ADD COLUMN ${columnName} ${columnType}`);
    }
  }

  /**
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  #transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * @param {string} name
   * @returns {string}
   */
  #normalizeListName(name) {
    if (!name.trim()) {
      throw new Error('List name is required');
    }
    return name.trim();
  }

  /**
   * @param {string} name
   * @returns {string}
   */
  #normalizeItemName(name) {
    if (!name.trim()) {
      throw new Error('Item name is required');
    }
    return name.trim().replace(/\s+/g, ' ');
  }

  /**
   * @param {string | null | undefined} note
   * @returns {string | null}
   */
  #normalizeOptionalNote(note) {
    if (note == null) {
      return null;
    }

    const normalized = note.trim().replace(/\s+/g, ' ');
    return normalized === '' ? null : normalized;
  }
}

/**
 * @param {Array<{ qty: number }>} orders
 * @returns {number}
 */
function sumOrderQty(orders) {
  return orders.reduce((total, order) => total + order.qty, 0);
}

/**
 * @param {string | null} fallbackNote
 * @param {OrderView[]} orders
 * @returns {string | null}
 */
function pickAggregateNote(fallbackNote, orders) {
  const notedOrders = orders
    .filter((order) => order.note !== null && order.note.trim() !== '')
    .sort((left, right) => {
      const dateDiff = Date.parse(right.updated_at) - Date.parse(left.updated_at);
      return dateDiff === 0 ? right.id - left.id : dateDiff;
    });

  return notedOrders[0]?.note ?? fallbackNote ?? null;
}

/**
 * @param {OrderRow[]} orders
 * @returns {OrderRow[]}
 */
function sortOrdersForRemoval(orders) {
  return [...orders].sort((left, right) => {
    if (left.ordered_by === UNKNOWN_ORDERED_BY && right.ordered_by !== UNKNOWN_ORDERED_BY) {
      return -1;
    }

    if (right.ordered_by === UNKNOWN_ORDERED_BY && left.ordered_by !== UNKNOWN_ORDERED_BY) {
      return 1;
    }

    const updatedAtDiff = Date.parse(right.updated_at) - Date.parse(left.updated_at);
    return updatedAtDiff === 0 ? right.id - left.id : updatedAtDiff;
  });
}

/**
 * @param {string} mediaPath
 * @returns {MediaKind}
 */
function inferMediaKind(mediaPath) {
  const extension = path.extname(mediaPath).toLowerCase();

  if (['.ogg', '.mp3', '.wav', '.m4a', '.aac', '.flac'].includes(extension)) {
    return 'audio';
  }

  if (['.mp4', '.mov', '.webm', '.mkv', '.avi'].includes(extension)) {
    return 'video';
  }

  return 'image';
}

/**
 * @param {string} mediaPath
 * @returns {string | null}
 */
function inferMimeType(mediaPath) {
  const extension = path.extname(mediaPath).toLowerCase();

  switch (extension) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.ogg':
      return 'audio/ogg';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.m4a':
      return 'audio/mp4';
    case '.mp4':
      return 'video/mp4';
    case '.mov':
      return 'video/quicktime';
    case '.webm':
      return 'video/webm';
    default:
      return null;
  }
}
