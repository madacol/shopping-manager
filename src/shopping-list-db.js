// @ts-check

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
 * @typedef {object} ItemRow
 * @property {number} id
 * @property {number} list_id
 * @property {string} canonical_name
 * @property {number} qty
 * @property {string} status
 * @property {string | null} note
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {object} ListItemRow
 * @property {string} name
 * @property {number} qty
 * @property {string} status
 * @property {string | null} note
 * @property {string} created_at
 * @property {string} updated_at
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
 * @property {StatementSync} upsertItem
 * @property {StatementSync} getItemByCanonicalName
 * @property {StatementSync} setItemNote
 * @property {StatementSync} insertEvent
 * @property {StatementSync} markBought
 * @property {StatementSync} markRemoved
 * @property {StatementSync} updateItemQtyAndStatus
 * @property {StatementSync} showAllItems
 * @property {StatementSync} getListVersion
 * @property {StatementSync} showList
 * @property {StatementSync} upsertAlias
 * @property {StatementSync} showEvents
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
    this.#backfillItemNotesFromOrders();
    this.statements = this.#prepareStatements();
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
      const canonicalName = this.resolveCanonicalName(rawItem).toLowerCase();

      this.statements.upsertItem.run(list.id, canonicalName, parsedQty, normalizedNote);

      const item = /** @type {ItemRow} */ (
        assertDefined(
          this.statements.getItemByCanonicalName.get(list.id, canonicalName),
          `Item not found after upsert: ${canonicalName}`
        )
      );

      this.statements.insertEvent.run(
        list.id,
        item.id,
        'add_item',
        JSON.stringify({
          rawItem: this.#normalizeItemName(rawItem),
          canonicalName,
          qty: parsedQty,
          note: normalizedNote
        })
      );

      return {
        ok: true,
        list: list.name,
        item: canonicalName,
        qty: item.qty,
        status: item.status,
        note: item.note
      };
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
      const canonicalName = this.resolveCanonicalName(rawItem).toLowerCase();
      const item = /** @type {ItemRow | undefined} */ (
        this.statements.getItemByCanonicalName.get(list.id, canonicalName)
      );

      if (item === undefined) {
        throw new Error(`Item not found: ${canonicalName}`);
      }

      this.statements.setItemNote.run(normalizedNote, item.id);

      const updatedItem = /** @type {ItemRow} */ (
        assertDefined(
          this.statements.getItemByCanonicalName.get(list.id, canonicalName),
          `Item not found after set_note: ${canonicalName}`
        )
      );

      this.statements.insertEvent.run(
        list.id,
        item.id,
        'set_note',
        JSON.stringify({
          rawItem: this.#normalizeItemName(rawItem),
          canonicalName,
          note: normalizedNote
        })
      );

      return {
        ok: true,
        list: list.name,
        item: canonicalName,
        qty: updatedItem.qty,
        status: updatedItem.status,
        note: updatedItem.note
      };
    });
  }

  /**
   * @param {string} listName
   * @param {string} rawItem
   * @returns {ItemMutationResult}
   */
  markBought(listName, rawItem) {
    const normalizedListName = this.#normalizeListName(listName);

    return this.#transaction(() => {
      const list = this.createList(normalizedListName);
      const canonicalName = this.resolveCanonicalName(rawItem).toLowerCase();
      const result = /** @type {SqliteRunResult} */ (this.statements.markBought.run(list.id, canonicalName));

      if (result.changes === 0) {
        throw new Error(`Item not found: ${canonicalName}`);
      }

      const item = /** @type {ItemRow} */ (
        assertDefined(
          this.statements.getItemByCanonicalName.get(list.id, canonicalName),
          `Item not found after mark_bought: ${canonicalName}`
        )
      );

      this.statements.insertEvent.run(
        list.id,
        item.id,
        'mark_bought',
        JSON.stringify({
          rawItem: this.#normalizeItemName(rawItem),
          canonicalName
        })
      );

      return {
        ok: true,
        list: list.name,
        item: canonicalName,
        qty: item.qty,
        status: item.status,
        note: item.note
      };
    });
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
      const canonicalName = this.resolveCanonicalName(rawItem).toLowerCase();
      const item = /** @type {ItemRow | undefined} */ (
        this.statements.getItemByCanonicalName.get(list.id, canonicalName)
      );

      if (item === undefined) {
        throw new Error(`Item not found: ${canonicalName}`);
      }

      const parsedQty = qty === undefined ? item.qty : Number(qty);

      if (!Number.isFinite(parsedQty) || parsedQty <= 0) {
        throw new Error('Quantity must be a positive number');
      }

      const qtyRemoved = Math.min(item.qty, parsedQty);
      const remainingQty = item.qty - qtyRemoved;
      const nextStatus = remainingQty === 0 ? 'removed' : item.status;

      if (remainingQty === 0) {
        this.statements.markRemoved.run(list.id, canonicalName);
      } else {
        this.statements.updateItemQtyAndStatus.run(remainingQty, nextStatus, item.id);
      }

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

      return {
        ok: true,
        list: list.name,
        item: canonicalName,
        qty: remainingQty,
        status: nextStatus,
        note: item.note
      };
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
    const items = /** @type {ListItemRow[]} */ (this.statements.showList.all(list.id, status));

    return {
      ok: true,
      list: list.name,
      status,
      items
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
      items: /** @type {ListItemRow[]} */ (this.statements.showAllItems.all(list.id))
    };
  }

  /**
   * @param {number | string} [limit=50]
   * @returns {ShowEventsResult}
   */
  showEvents(limit = 50) {
    const parsedLimit = Number(limit);

    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      throw new Error('Limit must be a positive integer');
    }

    return {
      ok: true,
      events: /** @type {EventRow[]} */ (this.statements.showEvents.all(parsedLimit))
    };
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
        qty REAL NOT NULL DEFAULT 1,
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
      upsertItem: this.db.prepare(`
        INSERT INTO items(list_id, canonical_name, qty, status, note, updated_at)
        VALUES (?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(list_id, canonical_name)
        DO UPDATE SET
          qty = items.qty + excluded.qty,
          status = 'pending',
          note = COALESCE(excluded.note, items.note),
          updated_at = CURRENT_TIMESTAMP
      `),
      getItemByCanonicalName: this.db.prepare(`
        SELECT id, list_id, canonical_name, qty, status, note, created_at, updated_at
        FROM items
        WHERE list_id = ? AND canonical_name = ?
      `),
      setItemNote: this.db.prepare(`
        UPDATE items
        SET note = ?,
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
        WHERE list_id = ? AND canonical_name = ?
      `),
      markRemoved: this.db.prepare(`
        UPDATE items
        SET status = 'removed',
            updated_at = CURRENT_TIMESTAMP
        WHERE list_id = ? AND canonical_name = ?
      `),
      updateItemQtyAndStatus: this.db.prepare(`
        UPDATE items
        SET qty = ?,
            status = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `),
      showAllItems: this.db.prepare(`
        SELECT canonical_name AS name, qty, status, note, created_at, updated_at
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
        SELECT canonical_name AS name, qty, status, note, created_at, updated_at
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
      `)
    };
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
   * @returns {void}
   */
  #backfillItemNotesFromOrders() {
    const row = /** @type {{ name: string } | undefined} */ (
      this.db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'item_orders'
      `).get()
    );

    if (row === undefined) {
      return;
    }

    this.db.exec(`
      UPDATE items
      SET note = (
        SELECT item_orders.note
        FROM item_orders
        WHERE item_orders.item_id = items.id
          AND item_orders.note IS NOT NULL
          AND trim(item_orders.note) <> ''
        ORDER BY item_orders.updated_at DESC, item_orders.id DESC
        LIMIT 1
      )
      WHERE (items.note IS NULL OR trim(items.note) = '')
        AND EXISTS (
          SELECT 1
          FROM item_orders
          WHERE item_orders.item_id = items.id
            AND item_orders.note IS NOT NULL
            AND trim(item_orders.note) <> ''
        )
    `);
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
