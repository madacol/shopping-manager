// @ts-check

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDefaultShoppingListDbPath, ShoppingListDb } from './shopping-list-db.js';

const DEFAULT_DB_PATH = getDefaultShoppingListDbPath();
const DEFAULT_HOST = process.env.HOST ?? '127.0.0.1';
const DEFAULT_PORT = Number(process.env.PORT ?? 3000);
const MAX_BODY_BYTES = 8 * 1024;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.resolve(__dirname, '../public');
const WORKSPACE_ROOT = process.cwd();

/**
 * @typedef {object} ServerOptions
 * @property {string=} dbPath
 * @property {string=} publicDir
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} statusCode
 * @param {unknown} payload
 * @returns {void}
 */
function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJsonBody(request) {
  /** @type {Buffer[]} */
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;

    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error('Request body is too large');
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  const rawBody = Buffer.concat(chunks).toString('utf8');
  const parsedBody = JSON.parse(rawBody);

  if (!isRecord(parsedBody)) {
    throw new Error('JSON body must be an object');
  }

  return parsedBody;
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {{ item: string, qty: number | undefined, note: string | undefined }}
 */
function parseItemPayload(payload) {
  if (typeof payload.item !== 'string' || payload.item.trim() === '') {
    throw new Error('Item is required');
  }

  const note =
    payload.note === undefined
      ? undefined
      : typeof payload.note === 'string'
        ? payload.note
        : (() => {
            throw new Error('Note must be a string');
          })();

  if (payload.qty === undefined) {
    return {
      item: payload.item,
      qty: undefined,
      note
    };
  }

  const qty = Number(payload.qty);

  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error('Quantity must be a positive number');
  }

  return {
    item: payload.item,
    qty,
    note
  };
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {{ currentItem: string, item: string | undefined, qty: number | undefined, note: string | undefined }}
 */
function parseEditPayload(payload) {
  if (typeof payload.currentItem !== 'string' || payload.currentItem.trim() === '') {
    throw new Error('Current item is required');
  }

  const item =
    payload.item === undefined
      ? undefined
      : typeof payload.item === 'string' && payload.item.trim() !== ''
        ? payload.item
        : (() => {
            throw new Error('Item must be a non-empty string');
          })();

  const note =
    payload.note === undefined
      ? undefined
      : typeof payload.note === 'string'
        ? payload.note
        : (() => {
            throw new Error('Note must be a string');
          })();

  if (payload.qty === undefined) {
    return {
      currentItem: payload.currentItem,
      item,
      qty: undefined,
      note
    };
  }

  const qty = Number(payload.qty);

  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error('Quantity must be a positive number');
  }

  return {
    currentItem: payload.currentItem,
    item,
    qty,
    note
  };
}

/**
 * @param {string} pathname
 * @returns {{ listName: string, action: string | null } | null}
 */
function parseListRoute(pathname) {
  const segments = pathname.split('/').filter(Boolean);

  if (segments[0] !== 'api' || segments[1] !== 'lists' || segments.length < 3 || segments.length > 4) {
    return null;
  }

  return {
    listName: decodeURIComponent(segments[2]),
    action: segments[3] ?? null
  };
}

/**
 * @param {string} pathname
 * @returns {{ mediaId: number } | null}
 */
function parseMediaRoute(pathname) {
  const segments = pathname.split('/').filter(Boolean);

  if (segments[0] !== 'api' || segments[1] !== 'media' || segments.length !== 3) {
    return null;
  }

  const mediaId = Number(segments[2]);
  if (!Number.isInteger(mediaId) || mediaId <= 0) {
    return null;
  }

  return { mediaId };
}

/**
 * @param {string} pathname
 * @returns {{ filePath: string, contentType: string } | null}
 */
function resolveStaticAsset(pathname) {
  switch (pathname) {
    case '/':
      return { filePath: 'index.html', contentType: 'text/html; charset=utf-8' };
    case '/index.js':
      return { filePath: 'index.js', contentType: 'text/javascript; charset=utf-8' };
    case '/list.html':
      return { filePath: 'list.html', contentType: 'text/html; charset=utf-8' };
    case '/list.js':
      return { filePath: 'list.js', contentType: 'text/javascript; charset=utf-8' };
    case '/styles.css':
      return { filePath: 'styles.css', contentType: 'text/css; charset=utf-8' };
    default:
      return null;
  }
}

/**
 * @param {ReturnType<ShoppingListDb['getListSnapshot']>} snapshot
 * @returns {ReturnType<ShoppingListDb['getListSnapshot']>}
 */
function attachMediaUrls(snapshot) {
  if (!snapshot.changed || !Array.isArray(snapshot.items)) {
    return snapshot;
  }

  return {
    ...snapshot,
    items: snapshot.items.map((item) => ({
      ...item,
      orders: item.orders.map((order) => ({
        ...order,
        media: order.media.map((media) => ({
          ...media,
          url: `/api/media/${media.id}`
        }))
      }))
    }))
  };
}

/**
 * @param {string} storedPath
 * @returns {string}
 */
function resolveMediaPath(storedPath) {
  return path.isAbsolute(storedPath) ? storedPath : path.resolve(WORKSPACE_ROOT, storedPath);
}

/**
 * @param {'image' | 'audio' | 'video'} kind
 * @param {string} mediaPath
 * @returns {string | null}
 */
function inferContentType(kind, mediaPath) {
  switch (path.extname(mediaPath).toLowerCase()) {
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
    case '.oga':
      return 'audio/ogg';
    case '.opus':
      return 'audio/opus';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.m4a':
      return 'audio/mp4';
    case '.aac':
      return 'audio/aac';
    case '.flac':
      return 'audio/flac';
    case '.webm':
      return kind === 'video' ? 'video/webm' : 'audio/webm';
    case '.mp4':
      return 'video/mp4';
    case '.mov':
      return 'video/quicktime';
    default:
      return null;
  }
}

/**
 * @param {{ kind: 'image' | 'audio' | 'video', mime_type: string | null }} media
 * @param {string} mediaPath
 * @returns {string}
 */
function getContentType(media, mediaPath) {
  return media.mime_type ?? inferContentType(media.kind, mediaPath) ?? 'application/octet-stream';
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {ShoppingListDb} db
 * @param {string} publicDir
 * @returns {Promise<void>}
 */
async function handleRequest(request, response, db, publicDir) {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');

  const mediaRoute = parseMediaRoute(url.pathname);
  if (mediaRoute !== null) {
    if (method !== 'GET') {
      sendJson(response, 405, { ok: false, error: 'Method not allowed' });
      return;
    }

    const media = db.getMediaById(mediaRoute.mediaId);
    if (media === undefined) {
      sendJson(response, 404, { ok: false, error: 'Media not found' });
      return;
    }

    const mediaPath = resolveMediaPath(media.path);
    const body = await readFile(mediaPath);
    response.writeHead(200, {
      'content-type': getContentType(media, mediaPath),
      'cache-control': 'no-store',
      'content-length': body.byteLength
    });
    response.end(body);
    return;
  }

  if (method === 'GET' && url.pathname === '/api/lists') {
    sendJson(response, 200, {
      ok: true,
      lists: db.listLists()
    });
    return;
  }

  const listRoute = parseListRoute(url.pathname);
  if (listRoute !== null) {
    const listName = listRoute.listName;

    if (method === 'GET' && listRoute.action === null) {
      const since = url.searchParams.get('since');
      sendJson(response, 200, attachMediaUrls(db.getListSnapshot(listName, since)));
      return;
    }

    if (method !== 'POST' || listRoute.action === null) {
      sendJson(response, 405, { ok: false, error: 'Method not allowed' });
      return;
    }

    const payload = await readJsonBody(request);

    /** @type {unknown} */
    let mutation;

    switch (listRoute.action) {
      case 'add': {
        const { item, qty, note } = parseItemPayload(payload);
        mutation = db.addItem(listName, item, qty ?? 1, note);
        break;
      }
      case 'bought': {
        const { item } = parseItemPayload(payload);
        mutation = db.markBought(listName, item);
        break;
      }
      case 'pending': {
        const { item } = parseItemPayload(payload);
        mutation = db.markPending(listName, item);
        break;
      }
      case 'remove': {
        const { item, qty } = parseItemPayload(payload);
        mutation = db.removeItem(listName, item, qty);
        break;
      }
      case 'edit': {
        const { currentItem, item, qty, note } = parseEditPayload(payload);
        mutation = db.editItem(listName, currentItem, item, qty, note);
        break;
      }
      default:
        sendJson(response, 404, { ok: false, error: 'Route not found' });
        return;
    }

    sendJson(response, 200, {
      ok: true,
      mutation,
      snapshot: attachMediaUrls(db.getListSnapshot(listName))
    });
    return;
  }

  const asset = resolveStaticAsset(url.pathname);
  if (asset === null) {
    sendJson(response, 404, { ok: false, error: 'Route not found' });
    return;
  }

  const filePath = path.join(publicDir, asset.filePath);
  const body = await readFile(filePath);
  response.writeHead(200, {
    'content-type': asset.contentType,
    'cache-control': 'no-store',
    'content-length': body.byteLength
  });
  response.end(body);
}

/**
 * @param {ServerOptions} [options]
 * @returns {import('node:http').Server}
 */
export function createAppServer(options = {}) {
  const db = new ShoppingListDb(options.dbPath ?? DEFAULT_DB_PATH);
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;

  const server = createServer((request, response) => {
    handleRequest(request, response, db, publicDir).catch((error) => {
      const message = error instanceof Error ? error.message : 'Unexpected error';
      const statusCode = message === 'Request body is too large' ? 413 : 400;
      sendJson(response, statusCode, {
        ok: false,
        error: message
      });
    });
  });

  server.on('close', () => {
    db.close();
  });

  return server;
}

const currentFilePath = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  const server = createAppServer();
  server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
    console.log(`Shopping list app listening on http://${DEFAULT_HOST}:${DEFAULT_PORT}`);
  });
}
