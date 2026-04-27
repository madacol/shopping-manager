// @ts-check

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ShoppingListDb } from './shopping-list-db.js';

function getDefaultDbPath() {
  return process.env.SHOPPING_LIST_DB ?? 'shopping-lists.sqlite';
}

function getDefaultList() {
  return process.env.SHOPPING_LIST_DEFAULT_LIST ?? 'supermercado';
}

function printUsage() {
  console.log(`Usage:
  node src/cli.js create-list <name>
  node src/cli.js add-alias <alias> <canonical-name>
  node src/cli.js add-item [list] <item[=qty]> [more-items...]
  node src/cli.js mark-bought [list] <item> [more-items...]
  node src/cli.js remove-item [list] <item[=qty]> [more-items...]
  node src/cli.js show-list [list] [status]
  node src/cli.js show-events [limit]`);
}

/**
 * @param {string[]} args
 * @returns {{ list: string, itemArgs: string[] }}
 */
function parseListAndItems(args) {
  const defaultList = getDefaultList();

  if (args.length === 0) {
    throw new Error('At least one item is required');
  }

  if (args.length === 1) {
    return {
      list: defaultList,
      itemArgs: args
    };
  }

  return {
    list: args[0],
    itemArgs: args.slice(1)
  };
}

/**
 * @param {string} itemSpec
 * @returns {{ item: string, qty: string | number }}
 */
function parseAddItemSpec(itemSpec) {
  const separatorIndex = itemSpec.lastIndexOf('=');

  if (separatorIndex === -1) {
    return {
      item: itemSpec,
      qty: 1
    };
  }

  const item = itemSpec.slice(0, separatorIndex).trim();
  const qty = itemSpec.slice(separatorIndex + 1).trim();

  if (!item) {
    throw new Error(`Invalid item spec: ${itemSpec}`);
  }

  if (!qty) {
    throw new Error(`Missing quantity in item spec: ${itemSpec}`);
  }

  return {
    item,
    qty
  };
}

/**
 * @template T
 * @param {string} list
 * @param {T[]} items
 * @returns {T | { ok: true, list: string, items: T[] }}
 */
function formatBatchResult(list, items) {
  if (items.length === 1) {
    return items[0];
  }

  return {
    ok: true,
    list,
    items
  };
}

/**
 * @param {string[]} argv
 * @returns {void}
 */
export function main(argv) {
  const [command, ...args] = argv;
  const db = new ShoppingListDb(getDefaultDbPath());

  try {
    /** @type {unknown} */
    let result;

    switch (command) {
      case 'create-list':
        result = db.createList(args[0]);
        break;
      case 'add-alias':
        result = db.addAlias(args[0], args[1]);
        break;
      case 'add-item': {
        const { list, itemArgs } = parseListAndItems(args);
        const itemSpecs = itemArgs.map(parseAddItemSpec);
        result = formatBatchResult(
          list,
          itemSpecs.map(({ item, qty }) => db.addItem(list, item, qty))
        );
        break;
      }
      case 'mark-bought': {
        const { list, itemArgs } = parseListAndItems(args);
        result = formatBatchResult(
          list,
          itemArgs.map((item) => db.markBought(list, item))
        );
        break;
      }
      case 'remove-item': {
        const { list, itemArgs } = parseListAndItems(args);
        const itemSpecs = itemArgs.map(parseAddItemSpec);
        result = formatBatchResult(
          list,
          itemSpecs.map(({ item, qty }) => db.removeItem(list, item, qty))
        );
        break;
      }
      case 'show-list':
        result = db.showList(args[0] || getDefaultList(), args[1] || 'pending');
        break;
      case 'show-events':
        result = db.showEvents(args[0] || 50);
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

const cliPath = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === cliPath) {
  main(process.argv.slice(2));
}
