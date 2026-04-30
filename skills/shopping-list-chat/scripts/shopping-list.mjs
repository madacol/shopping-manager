// @ts-check

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

/**
 * @typedef {import('node:sqlite').StatementSync} StatementSync
 */

/**
 * @typedef {object} ListRow
 * @property {number} id
 * @property {string} name
 */

/**
 * @typedef {object} OrderRow
 * @property {number} id
 * @property {number} item_id
 * @property {string} ordered_by
 * @property {number} qty
 * @property {string | null} image_ref
 * @property {string | null} note
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {object} ItemRow
 * @property {number} id
 * @property {number} list_id
 * @property {string} canonical_name
 * @property {number} qty
 * @property {string} status
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {ItemRow & { orders: OrderRow[] }} ItemWithOrders
 */

/**
 * @typedef {object} ListedRow
 * @property {string} name
 * @property {number} pending_count
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
 * @typedef {object} MutationOptions
 * @property {string | null | undefined} [orderedBy]
 * @property {string | null | undefined} [imageRef]
 * @property {string | null | undefined} [note]
 * @property {boolean | undefined} [clearNote]
 */

/**
 * @typedef {object} Statements
 * @property {StatementSync} insertList
 * @property {StatementSync} getListByName
 * @property {StatementSync} resolveItemAlias
 * @property {StatementSync} resolveListAlias
 * @property {StatementSync} ensureItem
 * @property {StatementSync} getItem
 * @property {StatementSync} upsertOrder
 * @property {StatementSync} annotateOrder
 * @property {StatementSync} getOrdersForItem
 * @property {StatementSync} insertOrderMedia
 * @property {StatementSync} existingOrderMedia
 * @property {StatementSync} legacyOrderMediaRows
 * @property {StatementSync} syncItemQty
 * @property {StatementSync} insertEvent
 * @property {StatementSync} markPending
 * @property {StatementSync} markBought
 * @property {StatementSync} markRemoved
 * @property {StatementSync} showList
 * @property {StatementSync} showLists
 * @property {StatementSync} upsertItemAlias
 * @property {StatementSync} upsertListAlias
 * @property {StatementSync} showEvents
 * @property {StatementSync} backfillOrders
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

class ShoppingListDb {
  /** @type {DatabaseSync} */
  db;

  /** @type {Statements} */
  statements;

  /**
   * @param {string} dbPath
   */
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.#initSchema();
    this.#ensureItemColumn('ordered_by', 'TEXT');
    this.#ensureItemColumn('image_ref', 'TEXT');
    this.#ensureOrderColumn('note', 'TEXT');
    this.statements = this.#prepareStatements();
    this.#migrateSchema();
  }

  close() {
    this.db.close();
  }

  /**
   * @param {string} name
   * @returns {ListRow}
   */
  createList(name) {
    const canonicalName = this.resolveListName(name);
    this.statements.insertList.run(canonicalName);
    return /** @type {ListRow} */ (
      assertDefined(
        this.statements.getListByName.get(canonicalName),
        `List not found after create: ${canonicalName}`
      )
    );
  }

  /**
   * @param {string} rawName
   * @returns {string}
   */
  resolveListName(rawName) {
    const normalized = normalizeName(rawName);
    const row = /** @type {{ canonical_name: string } | undefined} */ (
      this.statements.resolveListAlias.get(normalized)
    );
    return row?.canonical_name ?? normalized;
  }

  /**
   * @param {string} rawName
   * @returns {string}
   */
  resolveItemName(rawName) {
    const normalized = normalizeName(rawName);
    const row = /** @type {{ canonical_name: string } | undefined} */ (
      this.statements.resolveItemAlias.get(normalized)
    );
    return row?.canonical_name ?? normalized;
  }

  /**
   * @param {string} alias
   * @param {string} canonicalName
   * @returns {{ ok: true, alias: string, canonicalName: string }}
   */
  addAlias(alias, canonicalName) {
    const normalizedAlias = normalizeName(alias);
    const normalizedCanonicalName = normalizeName(canonicalName);
    this.statements.upsertItemAlias.run(normalizedAlias, normalizedCanonicalName);
    return { ok: true, alias: normalizedAlias, canonicalName: normalizedCanonicalName };
  }

  /**
   * @param {string} alias
   * @param {string} canonicalName
   * @returns {{ ok: true, alias: string, canonicalName: string }}
   */
  addListAlias(alias, canonicalName) {
    const normalizedAlias = normalizeName(alias);
    const normalizedCanonicalName = normalizeName(canonicalName);
    this.createList(normalizedCanonicalName);
    this.statements.upsertListAlias.run(normalizedAlias, normalizedCanonicalName);
    return { ok: true, alias: normalizedAlias, canonicalName: normalizedCanonicalName };
  }

  /**
   * @param {string} listName
   * @param {string} rawItem
   * @param {number | string} [qty=1]
   * @param {MutationOptions} [options={}]
   * @returns {{ ok: true, list: string, item: string, qty: number, status: string, orders: OrderRow[] }}
   */
  addItem(listName, rawItem, qty = 1, options = {}) {
    const parsedQty = Number(qty);
    if (!Number.isFinite(parsedQty) || parsedQty <= 0) {
      throw new Error('Quantity must be a positive number');
    }

    const orderedBy = normalizeOptional(options.orderedBy) ?? 'unknown';
    const imageRef = normalizeOptional(options.imageRef);
    const note = normalizeOptional(options.note);

    return this.#transaction(() => {
      const list = this.createList(listName);
      const canonicalItem = this.resolveItemName(rawItem);

      this.statements.ensureItem.run(list.id, canonicalItem);

      const itemBeforeSync = /** @type {ItemRow} */ (
        assertDefined(
          this.statements.getItem.get(list.id, canonicalItem),
          `Item not found after ensure: ${canonicalItem}`
        )
      );

      this.statements.upsertOrder.run(itemBeforeSync.id, orderedBy, parsedQty, imageRef, note);
      this.#attachOrderMedia(itemBeforeSync.id, orderedBy, imageRef);
      this.statements.syncItemQty.run(itemBeforeSync.id, itemBeforeSync.id);

      const item = /** @type {ItemRow} */ (
        assertDefined(
          this.statements.getItem.get(list.id, canonicalItem),
          `Item not found after add: ${canonicalItem}`
        )
      );
      const orders = this.#getOrdersForItem(item.id);

      this.statements.insertEvent.run(
        list.id,
        item.id,
        'add_item',
        JSON.stringify({
          rawItem: normalizeName(rawItem),
          canonicalItem,
          qty: parsedQty,
          orderedBy,
          imageRef,
          note
        })
      );

      return {
        ok: true,
        list: list.name,
        item: canonicalItem,
        qty: item.qty,
        status: item.status,
        orders
      };
    });
  }

  /**
   * @param {string} listName
   * @param {string} rawItem
   * @param {MutationOptions} [options={}]
   * @returns {{ ok: true, list: string, item: string, qty: number, status: string, orders: OrderRow[] }}
   */
  annotateOrder(listName, rawItem, options = {}) {
    const orderedBy = normalizeOptional(options.orderedBy) ?? 'unknown';
    const imageRef = normalizeOptional(options.imageRef);
    const clearNote = options.clearNote === true;
    const note = clearNote ? null : normalizeOptional(options.note);

    if (imageRef === null && note === null && !clearNote) {
      throw new Error('annotate-order requires --image, --note, --clear-note, or a combination');
    }

    return this.#transaction(() => {
      const list = this.createList(listName);
      const canonicalItem = this.resolveItemName(rawItem);
      const item = /** @type {ItemRow} */ (
        assertDefined(
          this.statements.getItem.get(list.id, canonicalItem),
          `Item not found: ${canonicalItem}`
        )
      );

      const result = /** @type {{ changes: number }} */ (
        this.statements.annotateOrder.run(imageRef, clearNote ? 1 : 0, note, item.id, orderedBy)
      );

      if (result.changes === 0) {
        throw new Error(`Order not found for ${canonicalItem} / ${orderedBy}`);
      }

      const refreshedItem = /** @type {ItemRow} */ (
        assertDefined(
          this.statements.getItem.get(list.id, canonicalItem),
          `Item not found after annotate: ${canonicalItem}`
        )
      );
      this.#attachOrderMedia(refreshedItem.id, orderedBy, imageRef);
      const orders = this.#getOrdersForItem(refreshedItem.id);

      this.statements.insertEvent.run(
        list.id,
        refreshedItem.id,
        'annotate_order',
        JSON.stringify({
          rawItem: normalizeName(rawItem),
          canonicalItem,
          orderedBy,
          imageRef,
          note,
          clearNote
        })
      );

      return {
        ok: true,
        list: list.name,
        item: canonicalItem,
        qty: refreshedItem.qty,
        status: refreshedItem.status,
        orders
      };
    });
  }

  /**
   * @param {string} listName
   * @param {string} rawItem
   * @returns {{ ok: true, list: string, item: string, qty: number, status: string, orders: OrderRow[] }}
   */
  markPending(listName, rawItem) {
    return this.#transaction(() => {
      const list = this.createList(listName);
      const canonicalItem = this.resolveItemName(rawItem);
      const result = /** @type {{ changes: number }} */ (this.statements.markPending.run(list.id, canonicalItem));
      if (result.changes === 0) {
        throw new Error(`Item not found: ${canonicalItem}`);
      }

      const item = /** @type {ItemRow} */ (
        assertDefined(
          this.statements.getItem.get(list.id, canonicalItem),
          `Item not found after mark-pending: ${canonicalItem}`
        )
      );
      const orders = this.#getOrdersForItem(item.id);

      this.statements.insertEvent.run(
        list.id,
        item.id,
        'mark_pending',
        JSON.stringify({
          rawItem: normalizeName(rawItem),
          canonicalItem
        })
      );

      return {
        ok: true,
        list: list.name,
        item: canonicalItem,
        qty: item.qty,
        status: item.status,
        orders
      };
    });
  }

  /**
   * @param {string} listName
   * @param {string} rawItem
   * @returns {{ ok: true, list: string, item: string, qty: number, status: string, orders: OrderRow[] }}
   */
  markBought(listName, rawItem) {
    return this.#transaction(() => {
      const list = this.createList(listName);
      const canonicalItem = this.resolveItemName(rawItem);
      const result = /** @type {{ changes: number }} */ (this.statements.markBought.run(list.id, canonicalItem));
      if (result.changes === 0) {
        throw new Error(`Item not found: ${canonicalItem}`);
      }

      const item = /** @type {ItemRow} */ (
        assertDefined(
          this.statements.getItem.get(list.id, canonicalItem),
          `Item not found after mark-bought: ${canonicalItem}`
        )
      );
      const orders = this.#getOrdersForItem(item.id);

      this.statements.insertEvent.run(
        list.id,
        item.id,
        'mark_bought',
        JSON.stringify({
          rawItem: normalizeName(rawItem),
          canonicalItem
        })
      );

      return {
        ok: true,
        list: list.name,
        item: canonicalItem,
        qty: item.qty,
        status: item.status,
        orders
      };
    });
  }

  /**
   * @param {string} listName
   * @param {string} rawItem
   * @returns {{ ok: true, list: string, item: string, qty: number, status: string, orders: OrderRow[] }}
   */
  removeItem(listName, rawItem) {
    return this.#transaction(() => {
      const list = this.createList(listName);
      const canonicalItem = this.resolveItemName(rawItem);
      const result = /** @type {{ changes: number }} */ (this.statements.markRemoved.run(list.id, canonicalItem));
      if (result.changes === 0) {
        throw new Error(`Item not found: ${canonicalItem}`);
      }

      const item = /** @type {ItemRow} */ (
        assertDefined(
          this.statements.getItem.get(list.id, canonicalItem),
          `Item not found after remove: ${canonicalItem}`
        )
      );
      const orders = this.#getOrdersForItem(item.id);

      this.statements.insertEvent.run(
        list.id,
        item.id,
        'remove_item',
        JSON.stringify({
          rawItem: normalizeName(rawItem),
          canonicalItem
        })
      );

      return {
        ok: true,
        list: list.name,
        item: canonicalItem,
        qty: item.qty,
        status: item.status,
        orders
      };
    });
  }

  /**
   * @param {string} listName
   * @param {string} [status='pending']
   * @returns {{ ok: true, list: string, status: string, items: ItemWithOrders[] }}
   */
  showList(listName, status = 'pending') {
    const list = this.createList(listName);
    const items = /** @type {ItemRow[]} */ (this.statements.showList.all(list.id, status));
    return {
      ok: true,
      list: list.name,
      status,
      items: items.map((item) => ({
        ...item,
        orders: this.#getOrdersForItem(item.id)
      }))
    };
  }

  /**
   * @returns {{ ok: true, lists: ListedRow[] }}
   */
  showLists() {
    const lists = /** @type {ListedRow[]} */ (this.statements.showLists.all());
    return { ok: true, lists };
  }

  /**
   * @param {number | string} [limit=20]
   * @returns {{ ok: true, events: EventRow[] }}
   */
  showEvents(limit = 20) {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      throw new Error('Limit must be a positive integer');
    }
    const events = /** @type {EventRow[]} */ (this.statements.showEvents.all(parsedLimit));
    return { ok: true, events };
  }

  #initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS list_aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alias TEXT NOT NULL UNIQUE,
        canonical_name TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS item_aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alias TEXT NOT NULL UNIQUE,
        canonical_name TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        list_id INTEGER NOT NULL,
        canonical_name TEXT NOT NULL,
        qty REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        ordered_by TEXT,
        image_ref TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(list_id, canonical_name),
        FOREIGN KEY (list_id) REFERENCES lists(id)
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

  #migrateSchema() {
    this.statements.backfillOrders.run();
    this.#backfillOrderMedia();
  }

  /**
   * @param {string} columnName
   * @param {string} columnType
   */
  #ensureItemColumn(columnName, columnType) {
    const columns = /** @type {Array<{ name: string }>} */ (
      this.db.prepare('PRAGMA table_info(items)').all()
    );
    const exists = columns.some((column) => column.name === columnName);
    if (!exists) {
      this.db.exec(`ALTER TABLE items ADD COLUMN ${columnName} ${columnType}`);
    }
  }

  /**
   * @param {string} columnName
   * @param {string} columnType
   */
  #ensureOrderColumn(columnName, columnType) {
    const columns = /** @type {Array<{ name: string }>} */ (
      this.db.prepare('PRAGMA table_info(item_orders)').all()
    );
    const exists = columns.some((column) => column.name === columnName);
    if (!exists) {
      this.db.exec(`ALTER TABLE item_orders ADD COLUMN ${columnName} ${columnType}`);
    }
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
      resolveItemAlias: this.db.prepare(`
        SELECT canonical_name
        FROM item_aliases
        WHERE lower(alias) = lower(?)
      `),
      resolveListAlias: this.db.prepare(`
        SELECT canonical_name
        FROM list_aliases
        WHERE lower(alias) = lower(?)
      `),
      ensureItem: this.db.prepare(`
        INSERT INTO items(list_id, canonical_name, qty, status, updated_at)
        VALUES (?, ?, 0, 'pending', CURRENT_TIMESTAMP)
        ON CONFLICT(list_id, canonical_name)
        DO UPDATE SET
          status = 'pending',
          updated_at = CURRENT_TIMESTAMP
      `),
      getItem: this.db.prepare(`
        SELECT id, list_id, canonical_name, qty, status, created_at, updated_at
        FROM items
        WHERE list_id = ? AND canonical_name = ?
      `),
      upsertOrder: this.db.prepare(`
        INSERT INTO item_orders(item_id, ordered_by, qty, image_ref, note, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(item_id, ordered_by)
        DO UPDATE SET
          qty = item_orders.qty + excluded.qty,
          image_ref = COALESCE(excluded.image_ref, item_orders.image_ref),
          note = COALESCE(excluded.note, item_orders.note),
          updated_at = CURRENT_TIMESTAMP
      `),
      annotateOrder: this.db.prepare(`
        UPDATE item_orders
        SET image_ref = COALESCE(?, image_ref),
            note = CASE WHEN ? THEN NULL ELSE COALESCE(?, note) END,
            updated_at = CURRENT_TIMESTAMP
        WHERE item_id = ? AND ordered_by = ?
      `),
      getOrdersForItem: this.db.prepare(`
        SELECT id, item_id, ordered_by, qty, image_ref, note, created_at, updated_at
        FROM item_orders
        WHERE item_id = ?
        ORDER BY ordered_by
      `),
      insertOrderMedia: this.db.prepare(`
        INSERT INTO order_media(item_order_id, kind, path, mime_type)
        VALUES (?, ?, ?, ?)
      `),
      existingOrderMedia: this.db.prepare(`
        SELECT id
        FROM order_media
        WHERE item_order_id = ? AND path = ?
        LIMIT 1
      `),
      legacyOrderMediaRows: this.db.prepare(`
        SELECT id, image_ref
        FROM item_orders
        WHERE image_ref IS NOT NULL
          AND trim(image_ref) <> ''
      `),
      syncItemQty: this.db.prepare(`
        UPDATE items
        SET qty = COALESCE((SELECT SUM(qty) FROM item_orders WHERE item_id = ?), 0),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `),
      insertEvent: this.db.prepare(`
        INSERT INTO events(list_id, item_id, action, payload_json)
        VALUES (?, ?, ?, ?)
      `),
      markPending: this.db.prepare(`
        UPDATE items
        SET status = 'pending',
            updated_at = CURRENT_TIMESTAMP
        WHERE list_id = ? AND canonical_name = ?
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
      showList: this.db.prepare(`
        SELECT id, list_id, canonical_name, qty, status, created_at, updated_at
        FROM items
        WHERE list_id = ? AND status = ?
        ORDER BY canonical_name
      `),
      showLists: this.db.prepare(`
        SELECT lists.name, COALESCE(SUM(CASE WHEN items.status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_count
        FROM lists
        LEFT JOIN items ON items.list_id = lists.id
        GROUP BY lists.id, lists.name
        ORDER BY lists.name
      `),
      upsertItemAlias: this.db.prepare(`
        INSERT INTO item_aliases(alias, canonical_name)
        VALUES (?, ?)
        ON CONFLICT(alias)
        DO UPDATE SET canonical_name = excluded.canonical_name
      `),
      upsertListAlias: this.db.prepare(`
        INSERT INTO list_aliases(alias, canonical_name)
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
      backfillOrders: this.db.prepare(`
        INSERT INTO item_orders(item_id, ordered_by, qty, image_ref, note)
        SELECT items.id,
               'unknown',
               items.qty,
               NULL,
               NULL
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
   * @param {number} itemId
   * @param {string} orderedBy
   * @param {string | null} imageRef
   */
  #attachOrderMedia(itemId, orderedBy, imageRef) {
    if (imageRef === null) {
      return;
    }

    const order = this.#getOrdersForItem(itemId).find((itemOrder) => itemOrder.ordered_by === orderedBy);
    if (order === undefined) {
      throw new Error(`Order not found for media attachment: ${orderedBy}`);
    }

    this.#insertOrderMediaIfMissing(order.id, imageRef);
  }

  #backfillOrderMedia() {
    const rows = /** @type {Array<{ id: number, image_ref: string }>} */ (
      this.statements.legacyOrderMediaRows.all()
    );

    for (const row of rows) {
      this.#insertOrderMediaIfMissing(row.id, row.image_ref);
    }
  }

  /**
   * @param {number} orderId
   * @param {string} mediaPath
   */
  #insertOrderMediaIfMissing(orderId, mediaPath) {
    if (this.statements.existingOrderMedia.get(orderId, mediaPath) !== undefined) {
      return;
    }

    this.statements.insertOrderMedia.run(
      orderId,
      inferMediaKind(mediaPath),
      mediaPath,
      inferMimeType(mediaPath)
    );
  }

  /**
   * @param {number} itemId
   * @returns {OrderRow[]}
   */
  #getOrdersForItem(itemId) {
    return /** @type {OrderRow[]} */ (this.statements.getOrdersForItem.all(itemId));
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
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeName(value) {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    throw new Error('Name is required');
  }
  return normalized;
}

/**
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
function normalizeOptional(value) {
  if (value == null) {
    return null;
  }
  return normalizeName(value);
}

/**
 * @param {string} mediaPath
 * @returns {'image' | 'audio' | 'video'}
 */
function inferMediaKind(mediaPath) {
  const extension = path.extname(mediaPath).toLowerCase();
  if (['.mp3', '.m4a', '.ogg', '.oga', '.wav', '.webm'].includes(extension)) {
    return 'audio';
  }
  if (['.mp4', '.mov', '.m4v'].includes(extension)) {
    return 'video';
  }
  return 'image';
}

/**
 * @param {string} mediaPath
 * @returns {string}
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
    case '.mp3':
      return 'audio/mpeg';
    case '.m4a':
      return 'audio/mp4';
    case '.ogg':
    case '.oga':
      return 'audio/ogg';
    case '.wav':
      return 'audio/wav';
    case '.webm':
      return 'audio/webm';
    case '.mp4':
      return 'video/mp4';
    case '.mov':
      return 'video/quicktime';
    case '.m4v':
      return 'video/x-m4v';
    default:
      return 'application/octet-stream';
  }
}

/**
 * @param {string[]} args
 * @returns {{ positionals: string[], orderedBy: string | undefined, imageRef: string | undefined, note: string | undefined, clearNote: boolean }}
 */
function parseOptions(args) {
  /** @type {string[]} */
  const positionals = [];
  /** @type {string | undefined} */
  let orderedBy;
  /** @type {string | undefined} */
  let imageRef;
  /** @type {string | undefined} */
  let note;
  let clearNote = false;

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];

    if (value === '--by') {
      orderedBy = args[index + 1];
      index += 1;
      continue;
    }

    if (value === '--image') {
      imageRef = args[index + 1];
      index += 1;
      continue;
    }

    if (value === '--note') {
      note = args[index + 1];
      index += 1;
      continue;
    }

    if (value === '--clear-note') {
      clearNote = true;
      continue;
    }

    positionals.push(value);
  }

  return { positionals, orderedBy, imageRef, note, clearNote };
}

function printUsage() {
  console.log(`Usage:
  node skills/shopping-list-chat/scripts/shopping-list.mjs add-item <item> [qty] [list] [--by <name>] [--image <ref>] [--note <text>]
  node skills/shopping-list-chat/scripts/shopping-list.mjs annotate-order <item> [list] [--by <name>] [--image <ref>] [--note <text>] [--clear-note]
  node skills/shopping-list-chat/scripts/shopping-list.mjs mark-pending <item> [list]
  node skills/shopping-list-chat/scripts/shopping-list.mjs remove-item <item> [list]
  node skills/shopping-list-chat/scripts/shopping-list.mjs mark-bought <item> [list]
  node skills/shopping-list-chat/scripts/shopping-list.mjs show-list [list] [status]
  node skills/shopping-list-chat/scripts/shopping-list.mjs show-lists
  node skills/shopping-list-chat/scripts/shopping-list.mjs show-events [limit]
  node skills/shopping-list-chat/scripts/shopping-list.mjs add-alias <alias> <canonical-name>
  node skills/shopping-list-chat/scripts/shopping-list.mjs add-list-alias <alias> <canonical-list-name>`);
}

/**
 * @param {string[]} argv
 */
function main(argv) {
  const [command, ...rawArgs] = argv;
  const db = new ShoppingListDb(process.env.SHOPPING_LIST_DB || 'shopping-lists.sqlite');
  const defaultList = process.env.SHOPPING_LIST_DEFAULT_LIST || 'supermercado';
  const { positionals, orderedBy, imageRef, note, clearNote } = parseOptions(rawArgs);

  try {
    /** @type {unknown} */
    let result;

    switch (command) {
      case 'add-item':
        result = db.addItem(positionals[2] || defaultList, positionals[0], positionals[1] || 1, {
          orderedBy,
          imageRef,
          note
        });
        break;
      case 'annotate-order':
        result = db.annotateOrder(positionals[1] || defaultList, positionals[0], {
          orderedBy,
          imageRef,
          note,
          clearNote
        });
        break;
      case 'mark-pending':
        result = db.markPending(positionals[1] || defaultList, positionals[0]);
        break;
      case 'remove-item':
        result = db.removeItem(positionals[1] || defaultList, positionals[0]);
        break;
      case 'mark-bought':
        result = db.markBought(positionals[1] || defaultList, positionals[0]);
        break;
      case 'show-list':
        result = db.showList(positionals[0] || defaultList, positionals[1] || 'pending');
        break;
      case 'show-lists':
        result = db.showLists();
        break;
      case 'show-events':
        result = db.showEvents(positionals[0] || 20);
        break;
      case 'add-alias':
        result = db.addAlias(positionals[0], positionals[1]);
        break;
      case 'add-list-alias':
        result = db.addListAlias(positionals[0], positionals[1]);
        break;
      default:
        printUsage();
        process.exitCode = 1;
        return;
    }

    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}

main(process.argv.slice(2));
