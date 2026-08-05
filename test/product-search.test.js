import test from 'node:test';
import assert from 'node:assert/strict';

import { getProductSuggestions, normalizeSearchText } from '../public/product-search.js';

const items = [
  { name: 'banana', status: 'pending' },
  { name: 'bananas pequeñas', status: 'pending' },
  { name: 'café molido', status: 'bought' },
  { name: 'pan integral', status: 'removed' },
  { name: 'yogurt griego', status: 'pending' }
];

test('normalizes case, accents, and punctuation for product search', () => {
  assert.equal(normalizeSearchText(' Café--MOLIDO! '), 'cafe molido');
});

test('product suggestions prioritize exact matches before broader matches', () => {
  assert.deepEqual(
    getProductSuggestions(items, 'banana').map((product) => product.name),
    ['banana', 'bananas pequeñas']
  );
});

test('product suggestions tolerate small typing mistakes', () => {
  assert.equal(getProductSuggestions(items, 'yogrut')[0]?.name, 'yogurt griego');
});

test('product suggestions match tokens in intuitive order', () => {
  assert.equal(getProductSuggestions(items, 'integral pan')[0]?.name, 'pan integral');
});

test('product suggestions prefer pending status for duplicate normalized names', () => {
  const suggestions = getProductSuggestions(
    [
      { name: 'Leche', status: 'bought' },
      { name: 'leche', status: 'pending' }
    ],
    'leche'
  );

  assert.deepEqual(suggestions, [{ name: 'leche', status: 'pending' }]);
});
