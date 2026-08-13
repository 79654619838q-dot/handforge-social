// Безбраузерный (Node/Socket.IO) клиент ботов HandForge Poker — для будущей
// облачной автономии (без chrome-devtools). Логинится под несколькими
// аккаунтами, создаёт/заходит в комнату, играет турнир, решения по ставкам
// и (в Pro) по выбору карты принимает bot-brain.js на основе ТОЛЬКО видимой
// боту информации. Пишет полный транскрипт раздач в JSON для последующей
// генерации контента (рендер HTML/скриншоты + видео вне этого скрипта).
'use strict';

const { io } = require('socket.io-client');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { decideAction, decideCardPick } = require('./bot-brain');

const BASE = process.env.HF_BASE || 'https://handforge.onrender.com';

async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (!res.ok) throw new Error(`login ${username} failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.accessToken;
}

function connectBot(token, username) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { auth: { token } });
    const timer = setTimeout(() => reject(new Error(`${username} connect timeout`)), 20000);
    socket.on('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.on('connect_error', (e) => { clearTimeout(timer); reject(e); });
    socket.username = username;
  });
}

function log(...args) { console.log(new Date().toISOString(), ...args); }

async function runSession(config) {
  const { accounts, mode, maxPlayers, ante, startingStack, levelMinutes, roomName, handsToPlay, avatars } = config;

  const bots = [];
  for (const acc of accounts) {
    const token = await login(acc.username, acc.password);
    const socket = await connectBot(token, acc.username);
    bots.push({ username: acc.username, socket, hand: [], name: acc.username });
    log(`[login] ${acc.username} connected as socket ${socket.id}`);
  }

  const transcript = { mode, hands: [], startedAt: Date.now() };
  const state = { currentHand: null, roomId: null, handsSeen: 0, handsCompleted: 0, finished: false };

  return new Promise((resolve) => {
    function finish(reason, data) {
      if (state.finished) return;
      state.finished = true;
      clearInterval(capWatcher);
      clearTimeout(hardTimeout);
      transcript.endedAt = Date.now();
      transcript.endReason = reason;
      transcript.endData = data || null;
      const outPath = path.join(__dirname, `transcript-${Date.now()}.json`);
      fs.writeFileSync(outPath, JSON.stringify(transcript, null, 2));
      log(`[done] wrote ${outPath} (${reason})`);
      bots.forEach(b => b.socket.disconnect());
      resolve({ transcript, outPath });
    }

    // joinLobby на каждом сокете (сервер требует лобби до создания/входа в комнату)
    for (const bot of bots) {
      bot.socket.emit('joinLobby', { color: '#d4af37', avatar: (avatars && avatars[bot.username]) || null });
    }

    bots.forEach(bot => {
      const s = bot.socket;

      s.on('error', (msg) => log(`[error:${bot.username}]`, msg));

      s.on('yourCards', (hand) => { bot.hand = hand; });

      // Комнатные (broadcast) события приходят на КАЖДЫЙ сокет одинаково —
      // транскрипт и bot.ante/raisesThisStreet пишем только с сокета
      // организатора (bots[0]), иначе каждая запись задваивается по числу ботов.
      if (bot === bots[0]) {
        s.on('newHand', (data) => {
          state.currentHand = {
            handNumber: data.handNumber, mode: data.mode, pot: data.pot,
            board: [], actions: [], picks: [], result: null
          };
          transcript.hands.push(state.currentHand);
          state.handsSeen++;
          bots.forEach(b => { b.ante = data.ante; });
          log(`[newHand #${data.handNumber}] dealer=${data.dealer} pot=${data.pot}`);
        });

        s.on('flop', (data) => { if (state.currentHand) { state.currentHand.board = data.cards; state.currentHand.pot = data.pot; } bots.forEach(b => { b.raisesThisStreet = 0; }); });
        s.on('turnCard', (data) => { if (state.currentHand) { state.currentHand.board = data.cards; state.currentHand.pot = data.pot; } bots.forEach(b => { b.raisesThisStreet = 0; }); });
        s.on('river', (data) => { if (state.currentHand) { state.currentHand.board = data.cards; state.currentHand.pot = data.pot; } bots.forEach(b => { b.raisesThisStreet = 0; }); });

        s.on('playerAction', (data) => { if (state.currentHand) state.currentHand.actions.push(data); });
        s.on('playerFolded', (name) => { if (state.currentHand) state.currentHand.actions.push({ player: name, action: 'fold' }); });

        s.on('proPickProgress', (data) => { if (state.currentHand) state.currentHand.picks.push(data); });

        s.on('handResult', (data) => {
          if (state.currentHand) state.currentHand.result = data;
          state.handsCompleted++;
          log(`[handResult #${state.currentHand ? state.currentHand.handNumber : '?'}] winner=${data.winner} amount=${data.amount}${data.hand ? ' (' + data.hand + ')' : ''}`);
        });

        s.on('tournamentOver', (data) => {
          log('[tournamentOver]', JSON.stringify(data));
          finish('tournamentOver', data);
        });
      }

      // Ход по ставке — сервер шлёт 'turn' ВСЕМ в комнате с именем того, кто ходит.
      s.on('turn', (data) => {
        if (data.player !== bot.username) return;
        const board = state.currentHand ? state.currentHand.board : [];
        const stage = board.length >= 5 ? 'river' : board.length === 4 ? 'turn' : 'flop';
        // Лимиты ставок HandForge Pro (2/4/8 ББ по улицам, см. server.js
        // beginBettingRound) — считаем сами по ante из newHand, сервер сам их
        // тоже применяет, но без этого клиент предлагает неограниченные рейзы
        // и раздача превращается в бессмысленную гонку до олл-ина каждый раз.
        const capBB = { flop: 2, turn: 4, river: 8 }[stage] || 8;
        const gs = {
          stage,
          ownHand: bot.hand,
          board,
          pot: state.currentHand ? state.currentHand.pot : 0,
          currentBet: bot.lastKnownCurrentBet || 0,
          myBet: bot.lastKnownMyBet || 0,
          myChips: bot.lastKnownChips || 1000,
          roundCap: (mode === 'pro' && bot.ante) ? capBB * bot.ante : null
        };
        const decision = decideAction(gs);
        // Живой игрок не рейзит бесконечно в один и тот же круг торгов —
        // после пары повышений либо коллирует, либо фолдит, чтобы раздачи не
        // превращались в механическую гонку до олл-ина при каждой сильной руке.
        if (decision.action === 'raise') {
          bot.raisesThisStreet = (bot.raisesThisStreet || 0) + 1;
          if (bot.raisesThisStreet > 2) {
            decision.action = gs.currentBet > gs.myBet ? 'call' : 'check';
            delete decision.amount;
          }
        }
        setTimeout(() => {
          s.emit('action', { action: decision.action, amount: decision.amount });
          log(`[action] ${bot.username} -> ${decision.action}${decision.amount ? ' ' + decision.amount : ''}`);
        }, 900 + Math.random() * 1400);
      });

      s.on('playersUpdate', (data) => {
        const players = (data && data.players) || [];
        const me = players.find(p => p.name === bot.username);
        if (me) {
          bot.lastKnownChips = me.chips;
          bot.lastKnownMyBet = me.bet;
        }
        bot.lastKnownCurrentBet = Math.max(0, ...players.map(p => p.bet || 0));
      });

      s.on('proPickPhase', (data) => {
        const pick = decideCardPick({
          ownHand: data.yourHand || bot.hand,
          board: state.currentHand ? state.currentHand.board : [],
          blockedRanks: data.blockedRanks,
          blockedCards: data.blockedCards
        });
        if (!pick) return;
        setTimeout(() => {
          s.emit('chooseCard', { suit: pick.suit, rank: pick.rank });
          log(`[pick] ${bot.username} -> ${pick.rank}${pick.suit}`);
        }, 1500 + Math.random() * 3000);
      });
    });

    (async () => {
      const organizer = bots[0];
      await new Promise((res, rej) => {
        organizer.socket.once('roomCreated', (id) => { state.roomId = id; res(); });
        organizer.socket.once('error', rej);
        organizer.socket.emit('createRoom', {
          maxPlayers, ante, startingStack, mode, levelMinutes: levelMinutes || 8,
          smallBlind: Math.max(1, Math.round(ante / 2)), name: roomName || `HandForge ${mode} auto`
        });
      });
      log(`[room] created ${state.roomId} by ${organizer.username}`);

      // createRoom НЕ подсаживает создателя автоматически (сервер только
      // регистрирует комнату) — организатор должен сам сделать joinRoom,
      // ровно как остальные боты, иначе он не попадёт в room.players и
      // startGame будет молча отклонён (< 2 реально сидящих игроков).
      await new Promise((res, rej) => {
        organizer.socket.once('roomJoined', () => res());
        organizer.socket.once('error', rej);
        organizer.socket.emit('joinRoom', { roomId: state.roomId });
      });
      log(`[room] ${organizer.username} (organizer) joined ${state.roomId}`);

      for (const bot of bots.slice(1)) {
        await new Promise((res, rej) => {
          bot.socket.once('roomJoined', () => res());
          bot.socket.once('error', rej);
          bot.socket.emit('joinRoom', { roomId: state.roomId });
        });
        log(`[room] ${bot.username} joined ${state.roomId}`);
        if (mode === 'holdem-cash') {
          bot.socket.emit('takeSeat', { slot: bots.indexOf(bot), buyIn: startingStack });
        }
      }
      if (mode === 'holdem-cash') {
        organizer.socket.emit('takeSeat', { slot: 0, buyIn: startingStack });
        await new Promise(r => setTimeout(r, 1000));
      } else {
        await new Promise(r => setTimeout(r, 1000));
        organizer.socket.emit('startGame');
        log('[startGame] sent');
      }
    })().catch(e => { log('[fatal]', e.message); finish('error', { message: e.message }); });

    const capWatcher = setInterval(() => {
      if (handsToPlay && state.handsCompleted >= handsToPlay) finish('handsCapReached', { handsCompleted: state.handsCompleted });
    }, 3000);
    const hardTimeout = setTimeout(() => finish('timeout', null), 25 * 60 * 1000);
  });
}

module.exports = { runSession, login, connectBot };

if (require.main === module) {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error('Usage: node run-session.js <config.json>');
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  runSession(config).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
