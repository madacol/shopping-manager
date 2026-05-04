// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { main as cliMain } from '../src/cli.js';
import { createAppServer } from '../src/server.js';
import { getDefaultShoppingListDbPath, ShoppingListDb } from '../src/shopping-list-db.js';

/**
 * @returns {string}
 */
function createDbPath() {
  return path.join(os.tmpdir(), `shopping-list-${Date.now()}-${Math.random()}.sqlite`);
}

/**
 * @param {string[]} args
 * @returns {void}
 */
function runCli(args) {
  const originalLog = console.log;
  console.log = () => {};

  try {
    cliMain(args);
  } finally {
    console.log = originalLog;
  }
}

/**
 * @param {string} dbPath
 * @param {string[]} args
 * @returns {any}
 */
function runSkillCli(dbPath, args) {
  return JSON.parse(
    execFileSync(process.execPath, ['skills/shopping-list-chat/scripts/shopping-list.mjs', ...args], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        SHOPPING_LIST_DB: dbPath
      },
      encoding: 'utf8'
    })
  );
}

/**
 * @param {string} workspacePath
 * @param {string[]} args
 * @returns {any}
 */
function runSkillCliWithDefaultDb(workspacePath, args) {
  const env = { ...process.env };
  delete env.SHOPPING_LIST_DB;
  delete env.SHOPPING_LIST_DATA_DIR;

  return JSON.parse(
    execFileSync(
      process.execPath,
      [path.resolve('skills/shopping-list-chat/scripts/shopping-list.mjs'), ...args],
      {
        cwd: workspacePath,
        env,
        encoding: 'utf8'
      }
    )
  );
}

/**
 * @param {string} dbPath
 * @returns {Promise<{ server: import('node:http').Server, baseUrl: string }>}
 */
async function startServer(dbPath) {
  const server = createAppServer({
    dbPath,
    publicDir: path.resolve('public')
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Failed to determine server address');
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

/**
 * @param {Response} response
 * @returns {Promise<any>}
 */
async function readResponseJson(response) {
  return response.json();
}

test('default database path is workspace-local data, not template data', () => {
  const originalDbPath = process.env.SHOPPING_LIST_DB;
  const originalDataDir = process.env.SHOPPING_LIST_DATA_DIR;

  try {
    delete process.env.SHOPPING_LIST_DB;
    delete process.env.SHOPPING_LIST_DATA_DIR;

    assert.equal(getDefaultShoppingListDbPath(), path.join('.shopping-list', 'shopping-lists.sqlite'));
  } finally {
    if (originalDbPath === undefined) {
      delete process.env.SHOPPING_LIST_DB;
    } else {
      process.env.SHOPPING_LIST_DB = originalDbPath;
    }
    if (originalDataDir === undefined) {
      delete process.env.SHOPPING_LIST_DATA_DIR;
    } else {
      process.env.SHOPPING_LIST_DATA_DIR = originalDataDir;
    }
  }
});

test('skill cli init creates the local workspace data directory and database', () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'shopping-workspace-'));
  const expectedDbPath = path.join(workspacePath, '.shopping-list', 'shopping-lists.sqlite');

  try {
    const result = runSkillCliWithDefaultDb(workspacePath, ['init']);

    assert.deepEqual(result, {
      ok: true,
      dbPath: path.join('.shopping-list', 'shopping-lists.sqlite')
    });
    assert.equal(fs.existsSync(expectedDbPath), true);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test('aliases resolve to canonical items and writes create events', () => {
  const dbPath = createDbPath();
  const db = new ShoppingListDb(dbPath);

  try {
    db.addAlias('coke', 'coca cola');

    const addResult = db.addItem('supermercado', 'coke', 2);
    assert.equal(addResult.item, 'coca cola');
    assert.equal(addResult.qty, 2);
    assert.equal(addResult.status, 'pending');

    const boughtResult = db.markBought('supermercado', 'coke');
    assert.equal(boughtResult.item, 'coca cola');
    assert.equal(boughtResult.status, 'bought');

    const pendingList = db.showList('supermercado');
    assert.equal(pendingList.items.length, 0);

    const boughtList = db.showList('supermercado', 'bought');
    assert.equal(boughtList.items.length, 1);
    assert.equal(boughtList.items[0]?.name, 'coca cola');

    const events = db.showEvents(10);
    assert.equal(events.events.length, 2);
    assert.equal(events.events[0]?.action, 'mark_bought');
    assert.equal(events.events[1]?.action, 'add_item');
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test('item notes persist on add and can be updated later', () => {
  const dbPath = createDbPath();
  const db = new ShoppingListDb(dbPath);

  try {
    const addResult = db.addItem('supermercado', 'mantequilla', 1, 'pidió Rosalba');
    assert.equal(addResult.note, 'pidió Rosalba');

    const updateResult = db.setItemNote('supermercado', 'mantequilla', 'Rosalba pidió añadir cosas extra');
    assert.equal(updateResult.note, 'Rosalba pidió añadir cosas extra');

    const pendingList = db.showList('supermercado');
    assert.deepEqual(
      pendingList.items.map((item) => ({ name: item.name, note: item.note })),
      [{ name: 'mantequilla', note: 'Rosalba pidió añadir cosas extra' }]
    );

    const snapshot = db.getListSnapshot('supermercado');
    assert.equal(
      snapshot.items?.find((item) => item.name === 'mantequilla')?.note,
      'Rosalba pidió añadir cosas extra'
    );

    const events = db.showEvents(5);
    assert.equal(events.events[0]?.action, 'set_note');
    assert.equal(events.events[1]?.action, 'add_item');
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test('items can be reactivated and edited through the db api', () => {
  const dbPath = createDbPath();
  const db = new ShoppingListDb(dbPath);

  try {
    db.addItem('supermercado', 'mantequilla', 1, 'sin sal');
    db.markBought('supermercado', 'mantequilla');

    const pendingResult = db.markPending('supermercado', 'mantequilla');
    assert.equal(pendingResult.status, 'pending');

    const editResult = db.editItem(
      'supermercado',
      'mantequilla',
      'mantequilla de maní',
      2,
      'gruesa'
    );
    assert.equal(editResult.item, 'mantequilla de maní');
    assert.equal(editResult.qty, 2);
    assert.equal(editResult.note, 'gruesa');

    const noteOnlyResult = db.editItem('supermercado', 'mantequilla de maní', undefined, undefined, 'cremosa');
    assert.equal(noteOnlyResult.item, 'mantequilla de maní');
    assert.equal(noteOnlyResult.qty, 2);
    assert.equal(noteOnlyResult.note, 'cremosa');

    assert.deepEqual(
      db.showList('supermercado').items.map((item) => ({
        name: item.name,
        qty: item.qty,
        note: item.note
      })),
      [{ name: 'mantequilla de maní', qty: 2, note: 'cremosa' }]
    );

    const events = db.showEvents(5);
    assert.equal(events.events[0]?.action, 'edit_item');
    assert.equal(events.events[1]?.action, 'edit_item');
    assert.equal(events.events[2]?.action, 'mark_pending');
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test('cli add-item accepts multiple items with the list first', () => {
  const dbPath = createDbPath();
  process.env.SHOPPING_LIST_DB = dbPath;

  try {
    runCli(['add-item', 'dunnes', 'azúcar morena=2', 'lemsip']);

    const db = new ShoppingListDb(dbPath);
    try {
      const pendingList = db.showList('dunnes');
      assert.deepEqual(
        pendingList.items.map((item) => ({ name: item.name, qty: item.qty })),
        [
          { name: 'azúcar morena', qty: 2 },
          { name: 'lemsip', qty: 1 }
        ]
      );
    } finally {
      db.close();
    }
  } finally {
    delete process.env.SHOPPING_LIST_DB;
    fs.rmSync(dbPath, { force: true });
  }
});

test('cli mark-bought and remove-item accept multiple items with the list first', () => {
  const dbPath = createDbPath();
  process.env.SHOPPING_LIST_DB = dbPath;

  try {
    const db = new ShoppingListDb(dbPath);
    try {
      db.addItem('supermercado', 'rice cakes', 1);
      db.addItem('supermercado', 'lemsip', 1);
      db.addItem('supermercado', 'mantequilla de maní', 1);
    } finally {
      db.close();
    }

    runCli(['mark-bought', 'supermercado', 'rice cakes', 'lemsip']);
    runCli(['remove-item', 'supermercado', 'mantequilla de maní']);

    const updatedDb = new ShoppingListDb(dbPath);
    try {
      assert.deepEqual(
        updatedDb.showList('supermercado').items.map((item) => item.name),
        []
      );
      assert.deepEqual(
        updatedDb.showList('supermercado', 'bought').items.map((item) => item.name),
        ['lemsip', 'rice cakes']
      );
      assert.deepEqual(
        updatedDb.showList('supermercado', 'removed').items.map((item) => item.name),
        ['mantequilla de maní']
      );
    } finally {
      updatedDb.close();
    }
  } finally {
    delete process.env.SHOPPING_LIST_DB;
    fs.rmSync(dbPath, { force: true });
  }
});

test('cli mark-pending can reactivate multiple items with the list first', () => {
  const dbPath = createDbPath();
  process.env.SHOPPING_LIST_DB = dbPath;

  try {
    const db = new ShoppingListDb(dbPath);
    try {
      db.addItem('supermercado', 'rice cakes', 1);
      db.addItem('supermercado', 'lemsip', 1);
      db.markBought('supermercado', 'rice cakes');
      db.removeItem('supermercado', 'lemsip');
    } finally {
      db.close();
    }

    runCli(['mark-pending', 'supermercado', 'rice cakes', 'lemsip']);

    const updatedDb = new ShoppingListDb(dbPath);
    try {
      assert.deepEqual(
        updatedDb.showList('supermercado').items.map((item) => item.name),
        ['lemsip', 'rice cakes']
      );
      assert.equal(updatedDb.showList('supermercado', 'bought').items.length, 0);
      assert.equal(updatedDb.showList('supermercado', 'removed').items.length, 0);
    } finally {
      updatedDb.close();
    }
  } finally {
    delete process.env.SHOPPING_LIST_DB;
    fs.rmSync(dbPath, { force: true });
  }
});

test('cli remove-item can subtract a specific quantity', () => {
  const dbPath = createDbPath();
  process.env.SHOPPING_LIST_DB = dbPath;

  try {
    const db = new ShoppingListDb(dbPath);
    try {
      db.addItem('supermercado', 'azúcar morena', 5);
    } finally {
      db.close();
    }

    runCli(['remove-item', 'supermercado', 'azúcar morena=2']);

    const updatedDb = new ShoppingListDb(dbPath);
    try {
      assert.deepEqual(
        updatedDb.showList('supermercado').items.map((item) => ({ name: item.name, qty: item.qty })),
        [{ name: 'azúcar morena', qty: 3 }]
      );
      assert.equal(updatedDb.showList('supermercado', 'removed').items.length, 0);
    } finally {
      updatedDb.close();
    }
  } finally {
    delete process.env.SHOPPING_LIST_DB;
    fs.rmSync(dbPath, { force: true });
  }
});

test('cli still allows adding a single item to the default list', () => {
  const dbPath = createDbPath();
  process.env.SHOPPING_LIST_DB = dbPath;
  process.env.SHOPPING_LIST_DEFAULT_LIST = 'despensa';

  try {
    runCli(['add-item', 'pan']);

    const db = new ShoppingListDb(dbPath);
    try {
      const pendingList = db.showList('despensa');
      assert.deepEqual(
        pendingList.items.map((item) => ({ name: item.name, qty: item.qty })),
        [{ name: 'pan', qty: 1 }]
      );
    } finally {
      db.close();
    }
  } finally {
    delete process.env.SHOPPING_LIST_DB;
    delete process.env.SHOPPING_LIST_DEFAULT_LIST;
    fs.rmSync(dbPath, { force: true });
  }
});

test('http api serves snapshots and mutations with version-aware polling', async () => {
  const dbPath = createDbPath();
  const db = new ShoppingListDb(dbPath);

  try {
    db.addItem('supermercado', 'rice cakes', 2);
    db.addItem('supermercado', 'lemsip', 1, 'solo manzanilla');
  } finally {
    db.close();
  }

  const { server, baseUrl } = await startServer(dbPath);

  try {
    const listsResponse = await fetch(`${baseUrl}/api/lists`);
    const listsPayload = await readResponseJson(listsResponse);
    assert.deepEqual(listsPayload.lists, ['supermercado']);

    const snapshotResponse = await fetch(`${baseUrl}/api/lists/supermercado`);
    const snapshot = await readResponseJson(snapshotResponse);
    assert.equal(snapshot.changed, true);
    assert.equal(snapshot.items.length, 2);
    assert.equal(snapshot.version, 2);
    assert.equal(
      snapshot.items.find(
        /** @param {{ name: string, note?: string | null }} item */
        (item) => item.name === 'lemsip'
      )?.note,
      'solo manzanilla'
    );

    const unchangedResponse = await fetch(
      `${baseUrl}/api/lists/supermercado?since=${snapshot.version}`
    );
    const unchangedSnapshot = await readResponseJson(unchangedResponse);
    assert.equal(unchangedSnapshot.changed, false);
    assert.equal(unchangedSnapshot.version, 2);

    const boughtResponse = await fetch(`${baseUrl}/api/lists/supermercado/bought`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ item: 'rice cakes' })
    });
    const boughtPayload = await readResponseJson(boughtResponse);
    assert.equal(boughtPayload.snapshot.version, 3);
    assert.equal(
      boughtPayload.snapshot.items.find(
        /** @param {{ name: string, status: string }} item */
        (item) => item.name === 'rice cakes'
      )?.status,
      'bought'
    );

    const addWithNoteResponse = await fetch(`${baseUrl}/api/lists/supermercado/add`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ item: 'mantequilla', qty: 1, note: 'pidió Rosalba' })
    });
    const addWithNotePayload = await readResponseJson(addWithNoteResponse);
    assert.equal(addWithNotePayload.snapshot.version, 4);
    assert.equal(
      addWithNotePayload.snapshot.items.find(
        /** @param {{ name: string, note?: string | null }} item */
        (item) => item.name === 'mantequilla'
      )?.note,
      'pidió Rosalba'
    );

    const noteResponse = await fetch(`${baseUrl}/api/lists/supermercado/edit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        currentItem: 'mantequilla',
        note: 'Rosalba pidió añadir cosas extra o notas a la lista.'
      })
    });
    const notePayload = await readResponseJson(noteResponse);
    assert.equal(notePayload.snapshot.version, 5);
    assert.equal(
      notePayload.snapshot.items.find(
        /** @param {{ name: string, note?: string | null }} item */
        (item) => item.name === 'mantequilla'
      )?.note,
      'Rosalba pidió añadir cosas extra o notas a la lista.'
    );

    const pendingResponse = await fetch(`${baseUrl}/api/lists/supermercado/pending`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ item: 'rice cakes' })
    });
    const pendingPayload = await readResponseJson(pendingResponse);
    assert.equal(pendingPayload.snapshot.version, 6);
    assert.equal(
      pendingPayload.snapshot.items.find(
        /** @param {{ name: string, status: string }} item */
        (item) => item.name === 'rice cakes'
      )?.status,
      'pending'
    );

    const editResponse = await fetch(`${baseUrl}/api/lists/supermercado/edit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        currentItem: 'mantequilla',
        note: 'Rosalba pidió añadir marca y tamaño.'
      })
    });
    const editPayload = await readResponseJson(editResponse);
    assert.equal(editPayload.snapshot.version, 7);
    assert.equal(
      editPayload.snapshot.items.find(
        /** @param {{ name: string, note?: string | null }} item */
        (item) => item.name === 'mantequilla'
      )?.note,
      'Rosalba pidió añadir marca y tamaño.'
    );

    const deprecatedNoteRouteResponse = await fetch(`${baseUrl}/api/lists/supermercado/note`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        item: 'mantequilla',
        note: 'esto no deberia existir'
      })
    });
    const deprecatedNoteRoutePayload = await readResponseJson(deprecatedNoteRouteResponse);
    assert.equal(deprecatedNoteRouteResponse.status, 404);
    assert.equal(deprecatedNoteRoutePayload.error, 'Route not found');

    const rootResponse = await fetch(`${baseUrl}/`);
    const rootHtml = await rootResponse.text();
    assert.match(rootHtml, /Listas de compras/);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(undefined);
      });
    });
    fs.rmSync(dbPath, { force: true });
  }
});

test('http api exposes unified per-order media for chat-created entries', async () => {
  const dbPath = createDbPath();
  const imagePath = path.join(os.tmpdir(), `shopping-image-${Date.now()}.jpg`);
  const audioPath = path.join(os.tmpdir(), `shopping-audio-${Date.now()}.ogg`);

  fs.writeFileSync(imagePath, 'fake-image');
  fs.writeFileSync(audioPath, 'fake-audio');

  runSkillCli(dbPath, [
    'add-item',
    'cereal',
    '1',
    'supermercado',
    '--by',
    'Rosalba',
    '--media',
    imagePath,
    '--note',
    'el de la foto'
  ]);
  runSkillCli(dbPath, [
    'add-item',
    'cereal',
    '1',
    'supermercado',
    '--by',
    'Juan',
    '--media',
    audioPath,
    '--note',
    'el del audio'
  ]);

  const { server, baseUrl } = await startServer(dbPath);

  try {
    const snapshotResponse = await fetch(`${baseUrl}/api/lists/supermercado`);
    const snapshot = await readResponseJson(snapshotResponse);
    const cereal = snapshot.items.find(
      /** @param {{ name: string, qty: number, orders?: any[] }} item */
      (item) => item.name === 'cereal'
    );

    assert.equal(cereal?.qty, 2);
    assert.equal(cereal?.orders.length, 2);
    assert.deepEqual(
      cereal?.orders.map(
        /** @param {{ ordered_by: string, qty: number, media: Array<{ kind: string, url: string }> }} order */
        (order) => ({
          orderedBy: order.ordered_by,
          qty: order.qty,
          kinds: order.media.map((media) => media.kind)
        })
      ),
      [
        { orderedBy: 'Juan', qty: 1, kinds: ['audio'] },
        { orderedBy: 'Rosalba', qty: 1, kinds: ['image'] }
      ]
    );

    const imageUrl = cereal?.orders.find(
      /** @param {{ ordered_by: string, media: Array<{ url: string }> }} order */
      (order) => order.ordered_by === 'Rosalba'
    )?.media[0]?.url;
    const audioUrl = cereal?.orders.find(
      /** @param {{ ordered_by: string, media: Array<{ url: string }> }} order */
      (order) => order.ordered_by === 'Juan'
    )?.media[0]?.url;

    assert.equal(typeof imageUrl, 'string');
    assert.equal(typeof audioUrl, 'string');

    const imageResponse = await fetch(`${baseUrl}${imageUrl}`);
    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get('content-type'), 'image/jpeg');
    assert.equal(await imageResponse.text(), 'fake-image');

    const audioResponse = await fetch(`${baseUrl}${audioUrl}`);
    assert.equal(audioResponse.status, 200);
    assert.equal(audioResponse.headers.get('content-type'), 'audio/ogg');
    assert.equal(await audioResponse.text(), 'fake-audio');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(undefined);
      });
    });
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(imagePath, { force: true });
    fs.rmSync(audioPath, { force: true });
  }
});

test('skill cli can clear an order note explicitly', () => {
  const dbPath = createDbPath();

  try {
    runSkillCli(dbPath, [
      'add-item',
      'banana',
      '1',
      'supermercado',
      '--note',
      'small and green'
    ]);

    const clearResult = runSkillCli(dbPath, [
      'annotate-order',
      'banana',
      'supermercado',
      '--clear-note'
    ]);

    assert.equal(clearResult.orders[0]?.note, null);

    const db = new ShoppingListDb(dbPath);
    try {
      const list = db.showList('supermercado');
      assert.equal(list.items[0]?.name, 'banana');
      assert.equal(list.items[0]?.orders[0]?.note, null);

      const events = db.showEvents(5);
      assert.equal(events.events[0]?.action, 'annotate_order');
      assert.match(events.events[0]?.payload_json ?? '', /"clearNote":true/);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('web db mutations can update mixed-case items created by the chat skill', () => {
  const dbPath = createDbPath();
  const itemName = 'bananas pequeñas ligeramente verdes para lunch box de Gianna';

  try {
    runSkillCli(dbPath, ['add-item', itemName, '1', 'supermercado']);

    const db = new ShoppingListDb(dbPath);
    try {
      const bought = db.markBought('supermercado', itemName);
      assert.equal(bought.item, itemName);
      assert.equal(bought.status, 'bought');

      assert.deepEqual(
        db.showList('supermercado', 'bought').items.map((item) => ({
          name: item.name,
          status: item.status
        })),
        [{ name: itemName, status: 'bought' }]
      );
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('skill cli writes media rows visible to an already-running web server', async () => {
  const dbPath = createDbPath();
  const imagePath = path.join(os.tmpdir(), `shopping-live-image-${Date.now()}.jpg`);
  fs.writeFileSync(imagePath, 'live-image');

  const { server, baseUrl } = await startServer(dbPath);

  try {
    runSkillCli(dbPath, [
      'add-item',
      'Old Spice Nightpanther deodorant stick',
      '1',
      'supermercado',
      '--media',
      imagePath
    ]);

    const snapshotResponse = await fetch(`${baseUrl}/api/lists/supermercado`);
    const snapshot = await readResponseJson(snapshotResponse);
    const item = snapshot.items.find(
      /** @param {{ name: string, orders?: any[] }} entry */
      (entry) => entry.name === 'Old Spice Nightpanther deodorant stick'
    );

    const mediaUrl = item?.orders[0]?.media[0]?.url;
    assert.equal(typeof mediaUrl, 'string');

    const imageResponse = await fetch(`${baseUrl}${mediaUrl}`);
    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get('content-type'), 'image/jpeg');
    assert.equal(await imageResponse.text(), 'live-image');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(undefined);
      });
    });
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(imagePath, { force: true });
  }
});

test('new pending order does not inherit media from an older bought order', async () => {
  const dbPath = createDbPath();
  const imagePath = path.join(os.tmpdir(), `shopping-old-order-image-${Date.now()}.jpg`);
  fs.writeFileSync(imagePath, 'old-order-image');

  runSkillCli(dbPath, [
    'add-item',
    'jugo de ciruelas',
    '1',
    'supermercado',
    '--by',
    'photo request',
    '--media',
    imagePath
  ]);
  runSkillCli(dbPath, ['mark-bought', 'jugo de ciruelas', 'supermercado']);
  runSkillCli(dbPath, ['add-item', 'jugo de ciruelas', '1', 'supermercado']);

  const { server, baseUrl } = await startServer(dbPath);

  try {
    const snapshotResponse = await fetch(`${baseUrl}/api/lists/supermercado`);
    const snapshot = await readResponseJson(snapshotResponse);
    const pending = snapshot.items.find(
      /** @param {{ name: string, status: string, orders?: any[] }} item */
      (item) => item.name === 'jugo de ciruelas' && item.status === 'pending'
    );
    const bought = snapshot.items.find(
      /** @param {{ name: string, status: string, orders?: any[] }} item */
      (item) => item.name === 'jugo de ciruelas' && item.status === 'bought'
    );

    assert.equal(pending?.qty, 1);
    assert.deepEqual(
      pending?.orders.map(
        /** @param {{ media?: any[] }} order */
        (order) => order.media?.length ?? 0
      ),
      [0]
    );
    assert.equal(bought?.qty, 1);
    assert.equal(bought?.orders[0]?.media.length, 1);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(undefined);
      });
    });
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(imagePath, { force: true });
  }
});
