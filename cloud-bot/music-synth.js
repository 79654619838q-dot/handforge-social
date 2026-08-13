// Синтезирует ОРИГИНАЛЬНУЮ фоновую музыку через ffmpeg lavfi (sine-осцилляторы),
// без сэмплов и copyright-треков. Каждый вызов даёт другой результат — случайно
// выбираются тональность, темп и рисунок баса/аккордов, поэтому музыка не
// повторяется от ролика к ролику (явное требование: разная музыка каждый раз).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FFMPEG = process.env.HF_FFMPEG || 'ffmpeg';

// Минорные тональности "с напряжением", подходящие клубному покерному вайбу
// (не похоронный марш — темп умеренно-быстрый, рисунок покачивающийся).
const ROOTS = [220.0, 233.08, 246.94, 261.63, 277.18, 293.66, 329.63]; // A3..E4
const SCALE_STEPS = [0, 3, 5, 7, 10, 12]; // минорная пентатоника от корня (полутоны)

function noteFreq(root, semitoneOffset) {
  return root * Math.pow(2, semitoneOffset / 12);
}

function rand(min, max) { return min + Math.random() * (max - min); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function buildLine(root, beatDur, beats, octaveOffsets) {
  // octaveOffsets: массив множителей высоты по шагам лада для каждой доли
  const notes = [];
  for (let i = 0; i < beats; i++) {
    const degree = pick(SCALE_STEPS);
    const octave = pick(octaveOffsets);
    notes.push({ freq: noteFreq(root, degree + octave), dur: beatDur });
  }
  return notes;
}

function synthMusic({ duration, outPath }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-music-'));
  const root = pick(ROOTS);
  const bpm = Math.round(rand(92, 128));
  const beatDur = 60 / bpm;

  const bassBeats = Math.ceil(duration / (beatDur * 2)) * 1; // бас реже, по 2 доли
  const bass = buildLine(root / 2, beatDur * 2, Math.ceil(duration / (beatDur * 2)), [0]);
  const lead = buildLine(root, beatDur, Math.ceil(duration / beatDur), [0, 12, 12, 0]);

  function renderLine(notes, waveform, gainExpr, tag) {
    const inputs = [];
    const parts = [];
    notes.forEach((n, i) => {
      inputs.push('-f', 'lavfi', '-i', `${waveform}=frequency=${n.freq.toFixed(2)}:duration=${n.dur.toFixed(4)}:sample_rate=44100`);
      parts.push(`[${i}:a]afade=t=in:st=0:d=${Math.min(0.03, n.dur / 4).toFixed(4)},afade=t=out:st=${Math.max(0, n.dur - Math.min(0.05, n.dur / 3)).toFixed(4)}:d=${Math.min(0.05, n.dur / 3).toFixed(4)},volume=${gainExpr}[a${i}]`);
    });
    const concatInputs = notes.map((_, i) => `[a${i}]`).join('');
    const graph = parts.join(';') + `;${concatInputs}concat=n=${notes.length}:v=0:a=1[${tag}]`;
    const linePath = path.join(dir, `${tag}.wav`);
    // execFileSync не идёт через шелл — граф передаём одним аргументом напрямую,
    // экранирование шелла (кириллица, кавычки, двоеточия) тут не нужно.
    // (-filter_complex_script нет в некоторых сборках ffmpeg — используем -filter_complex)
    execFileSync(FFMPEG, ['-y', ...inputs, '-filter_complex', graph, '-map', `[${tag}]`, linePath], { stdio: 'inherit' });
    return linePath;
  }

  // 'triangle'/'square' не входят в стандартные lavfi-источники ffmpeg (только
  // 'sine' гарантированно есть в любой сборке) — обе линии играем синусом,
  // различие даём через октаву/громкость/ритм.
  const bassPath = renderLine(bass, 'sine', '0.5', 'bassline');
  const leadPath = renderLine(lead, 'sine', '0.22', 'leadline');

  const mixGraph = `[0:a]apad,atrim=0:${duration}[b];[1:a]apad,atrim=0:${duration}[l];[b][l]amix=inputs=2:duration=first:dropout_transition=0,dynaudnorm,volume=0.9[mix]`;
  execFileSync(FFMPEG, ['-y', '-i', bassPath, '-i', leadPath, '-filter_complex', mixGraph, '-map', '[mix]', '-t', String(duration), outPath], { stdio: 'inherit' });

  return { outPath, root, bpm };
}

module.exports = { synthMusic };

if (require.main === module) {
  const [duration, outPath] = process.argv.slice(2);
  if (!outPath) {
    console.error('Usage: node music-synth.js <durationSeconds> <out.wav>');
    process.exit(1);
  }
  const res = synthMusic({ duration: Number(duration) || 16, outPath });
  console.log('Wrote', outPath, `root=${res.root.toFixed(1)}Hz bpm=${res.bpm}`);
}
