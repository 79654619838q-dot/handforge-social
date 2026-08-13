// Компактный оценщик покерных рук (5 карт из N) + подсчёт аутов.
// cards: массив {suit, rank, value} (value: 2..14, A=14).
'use strict';

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function fullDeck() {
  const d = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      d.push({ suit, rank, value: RANKS.indexOf(rank) + 2 });
    }
  }
  return d;
}

function cardKey(c) { return c.suit + c.rank; }

function combinations(arr, k) {
  const result = [];
  const combo = [];
  function go(start) {
    if (combo.length === k) { result.push(combo.slice()); return; }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      go(i + 1);
      combo.pop();
    }
  }
  go(0);
  return result;
}

// Оценка ровно 5 карт -> [категория, тайбрейки...] (больше = сильнее)
function evaluate5(cards) {
  const values = cards.map(c => c.value).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);

  const counts = {};
  values.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  const groups = Object.entries(counts)
    .map(([v, c]) => [Number(v), c])
    .sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));

  // Стрит (включая колесо A-2-3-4-5)
  const uniqVals = [...new Set(values)];
  let straightHigh = null;
  if (uniqVals.length === 5) {
    if (uniqVals[0] - uniqVals[4] === 4) straightHigh = uniqVals[0];
    else if (uniqVals.join(',') === '14,5,4,3,2') straightHigh = 5; // колесо
  }

  if (straightHigh && isFlush) return [8, straightHigh];
  if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]];
  if (isFlush) return [5, ...values];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][1] === 3) return [3, groups[0][0], ...groups.slice(1).map(g => g[0])];
  if (groups[0][1] === 2 && groups[1][1] === 2) {
    const pairVals = [groups[0][0], groups[1][0]].sort((a, b) => b - a);
    return [2, ...pairVals, groups[2][0]];
  }
  if (groups[0][1] === 2) return [1, groups[0][0], ...groups.slice(1).map(g => g[0])];
  return [0, ...values];
}

function compareScore(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] || 0, bv = b[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// Лучшая 5-карточная рука из 2-7 карт
function bestScore(cards) {
  if (cards.length < 5) {
    // Меньше 5 карт (например, префлоп-анализ до флопа) — дооценим тем, что есть
    return evaluate5Partial(cards);
  }
  let best = null;
  for (const combo of combinations(cards, 5)) {
    const s = evaluate5(combo);
    if (!best || compareScore(s, best) > 0) best = s;
  }
  return best;
}

// Грубая частичная оценка для <5 карт (только категория пары/старшей карты)
function evaluate5Partial(cards) {
  const values = cards.map(c => c.value).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  const counts = {};
  values.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  const groups = Object.entries(counts).map(([v, c]) => [Number(v), c]).sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));
  const suitCounts = {};
  suits.forEach(s => { suitCounts[s] = (suitCounts[s] || 0) + 1; });
  const maxSuit = Math.max(...Object.values(suitCounts));
  let cat = 0;
  if (groups[0][1] >= 4) cat = 7;
  else if (groups[0][1] === 3 && groups[1] && groups[1][1] >= 2) cat = 6;
  else if (groups[0][1] === 3) cat = 3;
  else if (groups[0][1] === 2 && groups[1] && groups[1][1] === 2) cat = 2;
  else if (groups[0][1] === 2) cat = 1;
  return [cat, ...values];
}

function unseenCards(knownCards, deadCards) {
  const known = new Set([...knownCards, ...(deadCards || [])].map(cardKey));
  return fullDeck().filter(c => !known.has(cardKey(c)));
}

// Сколько карт из ещё не открытых улучшают категорию текущей руки (аутсы)
function countOuts(ownCards, boardCards, deadCards) {
  const current = ownCards.concat(boardCards);
  const baseScore = bestScore(current);
  const baseCat = baseScore[0];
  const candidates = unseenCards(current, deadCards);
  let outs = 0;
  for (const c of candidates) {
    const hypScore = bestScore(current.concat([c]));
    if (hypScore[0] > baseCat || (hypScore[0] === baseCat && compareScore(hypScore, baseScore) > 0 && hypScore[0] >= 1)) {
      outs++;
    }
  }
  return { outs, unseenCount: candidates.length, baseCat, baseScore };
}

module.exports = { SUITS, RANKS, fullDeck, cardKey, evaluate5, bestScore, compareScore, unseenCards, countOuts, combinations };
