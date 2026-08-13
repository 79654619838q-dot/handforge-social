// Точка входа для облачного routine: играет турнир ботами, выбирает самую
// контентную раздачу, рендерит готовый вертикальный Reels-ролик с
// оригинальной музыкой. Публикация в Instagram — отдельным шагом самого
// routine (через MCP-коннектор Windsor, который недоступен из чистого
// Node-скрипта), см. cloud-bot/README.md.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { runSession } = require('./run-session');
const { pickBestHand } = require('./pick-hand');
const { synthMusic } = require('./music-synth');
const { renderReel } = require('./render-reel');

async function main() {
  const configPath = process.argv[2];
  const outDir = process.argv[3] || '.';
  if (!configPath) {
    console.error('Usage: node produce-reel.js <session-config.json> [outDir]');
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  fs.mkdirSync(outDir, { recursive: true });

  console.log('=== 1/4 Playing session ===');
  const { outPath: transcriptPath } = await runSession(config);

  console.log('=== 2/4 Picking best hand ===');
  const picked = pickBestHand(transcriptPath, config.startingStack || 2000);
  if (!picked) {
    console.error('No completed hand to render — session ended before any showdown.');
    process.exit(1);
  }
  console.log(`Picked hand #${picked.hand.handNumber}, score ${picked.score.toFixed(1)}, result: ${picked.hand.result.hand} (+${picked.hand.result.amount})`);

  console.log('=== 3/4 Synthesizing music ===');
  const musicPath = path.join(os.tmpdir(), `hf-music-${Date.now()}.wav`);
  synthMusic({ duration: 16, outPath: musicPath });

  console.log('=== 4/4 Rendering reel ===');
  const outPath = path.join(outDir, `reel-${config.mode}-${Date.now()}.mp4`);
  renderReel({ hand: picked.hand, mode: picked.mode, outPath, musicPath });

  const metaPath = outPath.replace(/\.mp4$/, '.json');
  fs.writeFileSync(metaPath, JSON.stringify({ hand: picked.hand, mode: picked.mode, transcriptPath }, null, 2));

  console.log('DONE');
  console.log('VIDEO:', outPath);
  console.log('META:', metaPath);
}

main().catch(e => { console.error(e); process.exit(1); });
