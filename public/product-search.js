function normalizeSearchText(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function getSearchTokens(value) {
  const normalized = normalizeSearchText(value);
  return normalized ? normalized.split(' ') : [];
}

function getMaxEditDistance(value) {
  const length = value.length;
  if (length <= 2) {
    return 0;
  }
  if (length <= 4) {
    return 1;
  }
  if (length <= 8) {
    return 2;
  }
  return 3;
}

function levenshteinDistance(left, right, maxDistance) {
  if (left === right) {
    return 0;
  }

  if (Math.abs(left.length - right.length) > maxDistance) {
    return maxDistance + 1;
  }

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMin = current[0];

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const next = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + cost
      );
      current[rightIndex] = next;
      rowMin = Math.min(rowMin, next);
    }

    if (rowMin > maxDistance) {
      return maxDistance + 1;
    }

    previous = current;
  }

  return previous[right.length];
}

function getStatusPriority(status) {
  switch (status) {
    case 'pending':
      return 0;
    case 'bought':
      return 1;
    case 'removed':
      return 2;
    default:
      return 3;
  }
}

function getProductCatalog(items) {
  const products = new Map();

  for (const item of items) {
    if (!item?.name) {
      continue;
    }

    const key = normalizeSearchText(item.name);
    if (!key) {
      continue;
    }

    const existing = products.get(key);
    if (existing === undefined || getStatusPriority(item.status) < getStatusPriority(existing.status)) {
      products.set(key, {
        name: item.name,
        status: item.status
      });
    }
  }

  return Array.from(products.values());
}

function scoreTokenMatch(queryToken, nameTokens) {
  let bestScore = Number.POSITIVE_INFINITY;

  for (const nameToken of nameTokens) {
    if (nameToken === queryToken) {
      bestScore = Math.min(bestScore, 0);
      continue;
    }

    if (nameToken.startsWith(queryToken)) {
      bestScore = Math.min(bestScore, 1 + (nameToken.length - queryToken.length) / 100);
      continue;
    }

    const includesIndex = nameToken.indexOf(queryToken);
    if (includesIndex !== -1) {
      bestScore = Math.min(bestScore, 3 + includesIndex / 100);
      continue;
    }

    const maxDistance = getMaxEditDistance(queryToken);
    if (maxDistance > 0) {
      const distance = levenshteinDistance(queryToken, nameToken, maxDistance);
      if (distance <= maxDistance) {
        bestScore = Math.min(bestScore, 8 + distance + Math.abs(nameToken.length - queryToken.length) / 100);
      }
    }
  }

  return bestScore;
}

function scoreProductMatch(query, productName) {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedName = normalizeSearchText(productName);

  if (!normalizedQuery || !normalizedName) {
    return null;
  }

  if (normalizedName === normalizedQuery) {
    return 0;
  }

  if (normalizedName.startsWith(normalizedQuery)) {
    return 5 + (normalizedName.length - normalizedQuery.length) / 100;
  }

  const includesIndex = normalizedName.indexOf(normalizedQuery);
  if (includesIndex !== -1) {
    return 10 + includesIndex / 100;
  }

  const queryTokens = getSearchTokens(normalizedQuery);
  const nameTokens = getSearchTokens(normalizedName);
  const tokenScores = queryTokens.map((queryToken) => scoreTokenMatch(queryToken, nameTokens));

  if (tokenScores.every(Number.isFinite)) {
    return 20 + tokenScores.reduce((total, score) => total + score, 0);
  }

  const maxDistance = getMaxEditDistance(normalizedQuery);
  if (maxDistance > 0) {
    const distance = levenshteinDistance(normalizedQuery, normalizedName, maxDistance);
    if (distance <= maxDistance) {
      return 50 + distance + Math.abs(normalizedName.length - normalizedQuery.length) / 100;
    }
  }

  return null;
}

function compareProducts(left, right) {
  if (left.score !== right.score) {
    return left.score - right.score;
  }

  const statusDelta = getStatusPriority(left.status) - getStatusPriority(right.status);
  if (statusDelta !== 0) {
    return statusDelta;
  }

  return left.name.localeCompare(right.name, 'es');
}

export { normalizeSearchText };

export function getProductSuggestions(items, query, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 8;

  return getProductCatalog(items)
    .map((product) => ({
      ...product,
      score: scoreProductMatch(query, product.name)
    }))
    .filter((product) => product.score !== null)
    .sort(compareProducts)
    .slice(0, limit)
    .map(({ name, status }) => ({ name, status }));
}
