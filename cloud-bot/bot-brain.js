// "Профессиональная" (эвристическая) логика решений бота: считает аутсы и
// pot odds по ТОЛЬКО видимой ему информации (своя рука + борд), не знает
// карт соперника и не подгоняет результат. Никакого доступа к чужим рукам.
'use strict';

const { SUITS, RANKS, bestScore, compareScore, countOuts, unseenCards } = require('./evaluator');

function rand(min, max) { return min + Math.random() * (max - min); }

// equity ~ P(улучшиться/выиграть) через правило 2/4 по аутсам
function estimateEquity(outs, streetsToCome) {
  const perStreet = 2.2; // чуть скромнее классического "правила 4", чтобы не переоценивать
  return Math.min(0.92, (outs * perStreet * Math.max(1, streetsToCome)) / 100);
}

function streetsToCome(stage) {
  if (stage === 'flop') return 2;
  if (stage === 'turn') return 1;
  return 0;
}

// categoryStrength: 0..8 -> нормализованная "сила уже сделанной руки" 0..1
function madeHandStrength(score) {
  return Math.min(1, score[0] / 6); // full house(6)+ считаем максимумом уверенности
}

/**
 * Решение по ставке. gameState:
 * { stage, ownHand, board, pot, currentBet, myBet, myChips, roundCap, minRaise }
 * Возвращает { action: 'fold'|'call'|'check'|'raise', amount? }
 */
function decideAction(gameState) {
  const { stage, ownHand, board, pot, currentBet, myBet, myChips, roundCap } = gameState;
  const callAmount = Math.max(0, currentBet - myBet);
  const canCheck = callAmount === 0;

  const known = ownHand.concat(board);
  const score = bestScore(known.length >= 2 ? known : ownHand);
  const { outs } = countOuts(ownHand, board, []);
  const equity = estimateEquity(outs, streetsToCome(stage));
  const strength = Math.max(madeHandStrength(score), score[0] === 0 && known.length >= 5 ? 0.08 : 0);

  // Итоговая "уверенность" смешивает уже сделанную руку и потенциал доиграть
  const confidence = Math.max(strength, equity * 0.9);

  const potOdds = callAmount > 0 ? callAmount / (pot + callAmount) : 0;

  // Топ рука (стрит+) — играем агрессивно
  if (score[0] >= 4) {
    if (canCheck || confidence > 0.6) {
      const raiseAmt = roundCap ? roundCap : Math.max(currentBet * 2, Math.round(pot * 0.6));
      if (myChips > callAmount) return { action: 'raise', amount: raiseAmt };
    }
    return callAmount > 0 ? { action: 'call' } : { action: 'check' };
  }

  // Средняя рука (две пары/трипс уже учтены выше; тут пара) — коллируем,
  // изредка рейзим на сильной паре с хорошим кикером
  if (score[0] === 1) {
    if (canCheck) {
      if (Math.random() < 0.35 && roundCap) return { action: 'raise', amount: roundCap };
      return { action: 'check' };
    }
    if (confidence + 0.12 >= potOdds || callAmount <= myChips * 0.08) {
      return { action: 'call' };
    }
    return { action: 'fold' };
  }

  // Без пары, но есть реальный дро (флеш/стрит-дро) — играем по аутсам и pot odds,
  // без подгонки: только если equity реально оправдывает колл/полублеф-рейз
  if (score[0] === 0 && outs >= 4) {
    if (canCheck) {
      // Полублеф вперёд, если дро сильный (2+ карты одной масти уже видно на столе)
      if (outs >= 8 && Math.random() < 0.45 && roundCap) return { action: 'raise', amount: Math.round(roundCap * 0.6) };
      return { action: 'check' };
    }
    if (equity >= potOdds * 0.85) return { action: 'call' };
    return { action: 'fold' };
  }

  // Ничего — фолд на любую ставку, чек если бесплатно
  if (canCheck) return { action: 'check' };
  return { action: 'fold' };
}

// Выбор карты в HandForge Pro. pickState:
// { ownHand, board, blockedRanks, blockedCards }
// Смотрит только на свою руку + открытую часть стола (то же, что видит соперник).
function decideCardPick(pickState) {
  const { ownHand, board, blockedRanks, blockedCards } = pickState;
  const blockedR = new Set(blockedRanks || []);
  const blockedSet = new Set((blockedCards || []).map(c => c.suit + c.rank));
  const ownSet = new Set(ownHand.map(c => c.suit + c.rank));

  const candidates = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      if (blockedR.has(rank)) continue;
      if (blockedSet.has(suit + rank)) continue;
      if (ownSet.has(suit + rank)) continue;
      candidates.push({ suit, rank, value: RANKS.indexOf(rank) + 2 });
    }
  }
  if (!candidates.length) return null;

  // Масти уже на столе (для решения "тянуть флеш вперёд")
  const boardSuitCounts = {};
  board.forEach(c => { boardSuitCounts[c.suit] = (boardSuitCounts[c.suit] || 0) + 1; });
  const ownSuitCounts = {};
  ownHand.forEach(c => { ownSuitCounts[c.suit] = (ownSuitCounts[c.suit] || 0) + 1; });

  let best = null;
  let bestScoreVal = -Infinity;
  for (const cand of candidates) {
    const hypHand = ownHand.concat([cand]);
    const made = bestScore(hypHand.concat(board));
    let score = made[0] * 100 + made.slice(1).reduce((a, b, i) => a + b / Math.pow(10, i + 1), 0);

    // Бонус за построение дро вперёд (осознанно, не наугад):
    // масть, которой уже 2+ на столе/руке — тянем флеш заранее
    const suitTotal = (boardSuitCounts[cand.suit] || 0) + (ownSuitCounts[cand.suit] || 0);
    if (suitTotal >= 2) score += 6 + suitTotal * 2;

    // Потенциал стрита: близость номинала к уже собранным картам (без учёта заблокированных рангов)
    const vals = hypHand.concat(board).map(c => c.value);
    const uniq = [...new Set(vals)].sort((a, b) => a - b);
    let straightPotential = 0;
    for (let i = 0; i < uniq.length; i++) {
      let span = 1;
      for (let j = i + 1; j < uniq.length && uniq[j] - uniq[i] <= 4; j++) span++;
      straightPotential = Math.max(straightPotential, span);
    }
    if (straightPotential >= 4) score += 5;

    score += rand(-0.5, 0.5); // лёгкий разброс, чтобы не играть детерминированным роботом
    if (score > bestScoreVal) { bestScoreVal = score; best = cand; }
  }
  return best;
}

module.exports = { decideAction, decideCardPick, estimateEquity };
