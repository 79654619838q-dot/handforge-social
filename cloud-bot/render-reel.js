// Собирает вертикальный (9:16) Reels-ролик из выбранной раздачи чистым
// ffmpeg (без браузера/скриншотов — в облачном routine доступен только
// Bash). Карты рисуются как прямоугольники с текстом ранг+масть (буквой,
// не юникод-символом — надёжнее для шрифтов на произвольном Linux-сандбоксе).
// Фильтр-граф пишется во внешний файл (-filter_complex_script) и каждая
// надпись — в отдельный textfile=, поэтому кириллица и спецсимволы не
// требуют ffmpeg-экранирования в шелле.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const W = 1080, H = 1920;
const DUR = 16;
const FFMPEG = process.env.HF_FFMPEG || 'ffmpeg';
// Fontconfig-имена (не файлы) — в облаке ставим fonts-dejavu-core через apt,
// локально на Windows подставляем реальные .ttf через HF_FONT_BOLD/REGULAR.
const FONT_BOLD = process.env.HF_FONT_BOLD || 'DejaVu Sans:style=Bold';
const FONT_REGULAR = process.env.HF_FONT_REGULAR || 'DejaVu Sans';
const usesFontFile = /[\\/]/.test(FONT_BOLD);

const GOLD = '0xD4AF37';
const GOLD_HI = '0xF4D989';
const CREAM = '0xF1E8DA';
const RED = '0xE2574C';
const INK = '0x0B0D10';
const CARD_BG = '0x171209';

const SUIT_LETTER = { '♠': 's', '♥': 'h', '♦': 'd', '♣': 'c' };
const SUIT_RED = new Set(['♥', '♦']);

const HOOK_POOL_RARE = (name) => [`${name.toUpperCase()} НА РИВЕРЕ!`, `ЭТО ${name.toUpperCase()}!`];
const HOOK_POOL_BIGPOT = ['БАНК НА ВСЕ ФИШКИ', 'ВСЁ РЕШИЛОСЬ НА РИВЕРЕ', 'ОБА ПОШЛИ ДО КОНЦА'];
const HOOK_POOL_DEFAULT = ['СМОТРИ КАК ЭТО ЗАКОНЧИЛОСЬ', 'РЕАЛЬНАЯ РАЗДАЧА', 'ОДНА ИЗ ЛУЧШИХ РАЗДАЧ'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-reel-'));
  return dir;
}

function writeText(dir, name, text) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text, 'utf8');
  return p.replace(/\\/g, '/');
}

function esc(p) {
  // Внутри значения ffmpeg-фильтра обратный слэш — управляющий символ и
  // "съедает" следующую букву (C\:\Windows\... тихо превращалось бы в
  // "C:Windows..." без слэшей — путь ломался без явной ошибки). Windows
  // одинаково понимает прямые слэши в путях, поэтому сначала нормализуем,
  // и только двоеточие диска экранируем по-настоящему.
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

function drawText(dir, id, text, x, y, size, color, font, opts) {
  opts = opts || {};
  const tf = writeText(dir, `${id}.txt`, text);
  const fontExpr = usesFontFile ? `fontfile='${esc(font)}'` : `font='${font.replace(/'/g, "\\'")}'`;
  const enable = opts.enable ? `:enable='${opts.enable}'` : '';
  const alpha = opts.alpha ? `:alpha='${opts.alpha}'` : '';
  return `drawtext=textfile='${esc(tf)}':${fontExpr}:fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}${enable}${alpha}`;
}

function cardBox(id, x, y, w, h, opts) {
  // drawbox's color@alpha принимает только СТАТИЧНОЕ число, не выражение от
  // t — анимировать плавное появление тут нельзя, поэтому карты появляются
  // жёстким cut-in по enable (это ок для монтажа Reels, а подпись ранга на
  // карте всё равно мягко проявляется через drawtext alpha).
  opts = opts || {};
  const enable = opts.enable ? `:enable='${opts.enable}'` : '';
  const fill = `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${CARD_BG}:t=fill${enable}`;
  const border = `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${GOLD}:t=4${enable}`;
  return [fill, border];
}

function buildCardFilters(dir, idPrefix, card, x, y, w, h, appearAt) {
  const filters = cardBox(idPrefix, x, y, w, h, {
    enable: `gte(t,${appearAt})`
  });
  const label = `${card.rank}${SUIT_LETTER[card.suit] || '?'}`;
  const color = SUIT_RED.has(card.suit) ? RED : CREAM;
  const size = card.rank.length > 1 ? 56 : 64; // "10x" чуть уже помещаем мельче
  filters.push(drawText(dir, idPrefix + '_t', label, `${x}+${w}/2-text_w/2`, `${y}+${h}/2-text_h/2`, size, color, FONT_BOLD, {
    enable: `gte(t,${appearAt})`,
    alpha: `if(lt(t,${appearAt}+0.35),(t-${appearAt})/0.35,1)`
  }));
  return filters;
}

function renderReel({ hand, mode, outPath, musicPath }) {
  const dir = mkTmp();
  const board = hand.board || [];
  const result = hand.result || {};
  const revealed = result.revealedHands || [];
  const modeLabel = mode === 'pro' ? 'HandForge Pro' : 'HandForge Race';

  const isRare = ['Флеш', 'Стрит', 'Фулл-хаус', 'Каре', 'Стрит-флеш', 'Флеш-рояль'].includes(result.hand);
  const hookText = isRare ? pick(HOOK_POOL_RARE(result.hand)) : (result.amount > 1500 ? pick(HOOK_POOL_BIGPOT) : pick(HOOK_POOL_DEFAULT));

  const filters = [`color=c=${INK}:s=${W}x${H}:d=${DUR}[bg]`];
  const chain = [];

  // Рамка бренда — весь ролик
  chain.push(`drawbox=x=44:y=44:w=${W - 88}:h=${H - 88}:color=${GOLD}@0.35:t=2`);
  chain.push(...spreadDraw(drawText(dir, 'kicker', `HANDFORGE · ${mode === 'pro' ? 'PRO' : 'RACE'}`, 84, 96, 26, CREAM, FONT_REGULAR)));
  chain.push(...spreadDraw(drawText(dir, 'handle', '@handforgepro.race', 'w-text_w-84', 96, 26, CREAM, FONT_REGULAR)));

  // Hook (0 - 2.2s) — размер подстраиваем под длину фразы, иначе на широких
  // прописных кириллических заголовках text_w вылезает за края кадра.
  const hookSize = hookText.length <= 14 ? 76 : hookText.length <= 20 ? 60 : 48;
  chain.push(...spreadDraw(drawText(dir, 'hook1', hookText, '(w-text_w)/2', 840, hookSize, GOLD_HI, FONT_BOLD, {
    enable: 'between(t,0,2.3)',
    alpha: "if(lt(t,0.3),t/0.3,if(lt(t,1.9),1,(2.3-t)/0.4))"
  })));
  chain.push(...spreadDraw(drawText(dir, 'hook2', modeLabel, '(w-text_w)/2', 960, 46, CREAM, FONT_REGULAR, {
    enable: 'between(t,0,2.3)',
    alpha: "if(lt(t,0.3),t/0.3,if(lt(t,1.9),1,(2.3-t)/0.4))"
  })));

  // Community cards row (up to 5), появляются по улицам: флоп t=2.3, тёрн t=5.3, ривер t=8.3
  const cw = 170, ch = 240, gap = 24;
  const totalW = 5 * cw + 4 * gap;
  const startX = Math.round((W - totalW) / 2);
  const cardY = 760;
  const streetAppear = [2.3, 2.3, 2.3, 5.3, 8.3];
  const streetLabels = [
    { t: 2.3, text: 'ФЛОП' },
    { t: 5.3, text: 'ТЁРН' },
    { t: 8.3, text: 'РИВЕР' }
  ];
  for (let i = 0; i < Math.min(5, board.length); i++) {
    const x = startX + i * (cw + gap);
    chain.push(...buildCardFilters(dir, `c${i}`, board[i], x, cardY, cw, ch, streetAppear[i]));
  }
  streetLabels.forEach((s, idx) => {
    // Каждая надпись видна ТОЛЬКО до начала следующей улицы — иначе
    // "ФЛОП"/"ТЁРН"/"РИВЕР" рисуются друг на друге в одной точке (gte
    // никогда не выключается) и превращаются в нечитаемое месиво.
    const nextT = streetLabels[idx + 1] ? streetLabels[idx + 1].t : DUR;
    chain.push(...spreadDraw(drawText(dir, `street${idx}`, s.text, '(w-text_w)/2', cardY - 70, 40, GOLD, FONT_BOLD, {
      enable: `between(t,${s.t},${nextT})`,
      alpha: `if(lt(t,${s.t}+0.3),(t-${s.t})/0.3,1)`
    })));
  });

  // Result block (t >= 11.3)
  const resultAt = 11.3;
  if (revealed.length) {
    const rowY = [1080, 1250];
    revealed.forEach((p, idx) => {
      const y = rowY[idx] != null ? rowY[idx] : 1080 + idx * 170;
      const isWinner = (result.winners || []).some(w => w.name === p.name);
      const nameColor = isWinner ? GOLD_HI : CREAM;
      // Юникод-звезда рискует не найтись в шрифте (тофу-квадрат) — тег ASCII.
      const tag = isWinner ? '>> ' : '';
      chain.push(...spreadDraw(drawText(dir, `pname${idx}`, `${tag}${p.name.replace('handforge_', '')}`, 140, y, 34, nameColor, FONT_BOLD, {
        enable: `gte(t,${resultAt})`,
        alpha: `if(lt(t,${resultAt}+0.3),(t-${resultAt})/0.3,1)`
      })));
      (p.hand || []).forEach((c, ci) => {
        const x = 520 + ci * 140;
        chain.push(...buildCardFilters(dir, `h${idx}_${ci}`, c, x, y - 20, 110, 154, resultAt));
      });
    });
  }
  if (result.hand) {
    chain.push(...spreadDraw(drawText(dir, 'handname', `${result.hand} · +${result.amount}`, '(w-text_w)/2', 1460, 58, GOLD_HI, FONT_BOLD, {
      enable: `gte(t,${resultAt + 0.4})`,
      alpha: `if(lt(t,${resultAt + 0.4}+0.35),(t-${resultAt + 0.4})/0.35,1)`
    })));
  }
  chain.push(...spreadDraw(drawText(dir, 'cta', `Играй в ${modeLabel} — HandForge`, '(w-text_w)/2', 1740, 34, CREAM, FONT_REGULAR, {
    enable: `gte(t,${DUR - 2.2})`,
    alpha: `if(lt(t,${DUR - 2.2}+0.4),(t-${DUR - 2.2})/0.4,1)`
  })));

  const graph = filters.join(';') + ';[bg]' + chain.join(',') + '[vout]';

  // execFileSync не идёт через шелл — граф передаём одним аргументом напрямую,
  // экранирование шелла (кириллица, кавычки, двоеточия) тут не нужно.
  // (-filter_complex_script нет в некоторых сборках ffmpeg — используем -filter_complex)
  const args = ['-y', '-filter_complex', graph];
  if (musicPath) {
    // color=/drawtext-источники живут внутри filter_complex, а не через -i,
    // поэтому музыка — единственный НУМЕРОВАННЫЙ вход (индекс 0), не 1.
    args.unshift('-i', musicPath);
    args.push('-map', '[vout]', '-map', '0:a', '-shortest');
  } else {
    args.push('-map', '[vout]');
  }
  args.push('-t', String(DUR), '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', outPath);

  execFileSync(FFMPEG, args, { stdio: 'inherit' });
  return { outPath, dir };
}

// drawText() возвращает ОДНУ строку фильтра — оборачиваем в массив, чтобы
// единообразно .push(...) вместе с cardBox(), который возвращает массив из двух.
function spreadDraw(filterStr) { return [filterStr]; }

module.exports = { renderReel };

if (require.main === module) {
  const [handPath, mode, outPath, musicPath] = process.argv.slice(2);
  if (!handPath || !outPath) {
    console.error('Usage: node render-reel.js <hand.json> <pro|race> <out.mp4> [music.wav]');
    process.exit(1);
  }
  const picked = JSON.parse(fs.readFileSync(handPath, 'utf8'));
  const hand = picked.hand || picked; // допускаем и вывод pick-hand.js целиком, и просто hand-объект
  renderReel({ hand, mode: mode || picked.mode || 'pro', outPath, musicPath });
  console.log('Wrote', outPath);
}
