// Из транскрипта сессии выбирает самую "контентную" раздачу: крупный банк
// относительно стартового стека, редкая комбинация, или драматичный ривер
// (перелом после чек/рейз войны на терн-ривер). Возвращает чистое summary
// для рендера ролика — без обращения к чужим картам сверх того, что реально
// вскрылось на шоудауне (revealedHands сервер шлёт только по факту вскрытия).
'use strict';

const fs = require('fs');

const RARE_HANDS = ['Флеш', 'Стрит', 'Фулл-хаус', 'Каре', 'Стрит-флеш', 'Флеш-рояль'];

function scoreHand(hand, startingStack) {
  if (!hand.result) return -1;
  let score = 0;
  const potRatio = (hand.result.amount || 0) / (startingStack * 2 || 1);
  score += Math.min(50, potRatio * 50); // крупный банк относительно стека обоих игроков
  if (RARE_HANDS.includes(hand.result.hand)) score += 25;
  const raises = hand.actions.filter(a => a.action === 'raise').length;
  score += Math.min(15, raises * 3); // борьба, а не тихий чек-даун
  if (hand.board.length >= 5) score += 5; // дошло до ривера
  return score;
}

function pickBestHand(transcriptPath, startingStack) {
  const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
  const withResult = transcript.hands.filter(h => h.result);
  if (!withResult.length) return null;
  let best = withResult[0];
  let bestScore = -Infinity;
  for (const h of withResult) {
    const s = scoreHand(h, startingStack || 2000);
    if (s > bestScore) { bestScore = s; best = h; }
  }
  return { hand: best, score: bestScore, mode: transcript.mode };
}

if (require.main === module) {
  const [transcriptPath, startingStack] = process.argv.slice(2);
  if (!transcriptPath) {
    console.error('Usage: node pick-hand.js <transcript.json> [startingStack]');
    process.exit(1);
  }
  const picked = pickBestHand(transcriptPath, Number(startingStack) || 2000);
  if (!picked) {
    console.error('No completed hand with a result found in transcript');
    process.exit(1);
  }
  console.log(JSON.stringify(picked, null, 2));
}

module.exports = { pickBestHand, scoreHand };
