const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const Rooms = require("./rooms");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/* DEV ENVIRONMENT - LOCALHOST */
const allowed = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

/*   CONNECT TO ONLINE SERVER 
const allowed = new Set([
  "http://ellisandcodesigns.co.uk",
  "http://www.ellisandcodesigns.co.uk",
  "https://ellisandcodesigns.co.uk",
  "https://www.ellisandcodesigns.co.uk",
]);
*/



app.use(express.static("public"));
const PORT = 3000;

server.listen(PORT, () => {
  console.log(`HTTP+WS server running on http://localhost:${PORT}`);
});

/*const port = process.env.PORT || 3000;
server.listen(port);
console.log(`Server listening on port ${port}`);*/


/* =========================== CARD / RULE HELPERS =========================== */

const rankOrder = {
  A: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
  10: 10,
  J: 11,
  Q: 12,
  K: 13,
};

function cardValue(card) {
  if (["J", "Q", "K"].includes(card.rank)) return 10;
  if (card.rank === "A") return 1;
  return Number(card.rank);
}

function getRankValue(rank) {
  return rankOrder[rank];
}

function cardId(card) {
  return `${card.rank}${card.suit}`;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Keep the TOP discard card. Shuffle the rest back into the deck.
function replenishDeckFromDiscard(game) {
  if (game.deck.length > 0) return false;
  if (!game.discardPile || game.discardPile.length < 2) return false;

  const top = game.discardPile.pop();
  const toShuffle = game.discardPile.splice(0);

  shuffleInPlace(toShuffle);
  game.deck = toShuffle;
  game.discardPile = [top];
  return true;
}


function maybeReplenish(game) {
  const before = game.deck.length;
  const did = replenishDeckFromDiscard(game);
  if (!did) return null;

  return {
    before,
    after: game.deck.length,
    ts: Date.now(),
  };
}


/* =========================== MELDS / DEADWOOD =========================== */

function allMelds(hand) {
  const melds = [];

  // sets
  const byRank = {};
  for (const c of hand) {
    if (!c) continue;
    (byRank[c.rank] ??= []).push(c);
  }
  for (const group of Object.values(byRank)) {
    if (group.length === 3) melds.push(group.slice());
    if (group.length === 4) {
      melds.push(group.slice());
      for (let i = 0; i < 4; i++)
        melds.push(group.filter((_, idx) => idx !== i));
    }
  }

  // runs
  const bySuit = {};
  for (const c of hand) {
    if (!c) continue;
    (bySuit[c.suit] ??= []).push(c);
  }

  for (const cards of Object.values(bySuit)) {
    const sorted = cards
      .slice()
      .sort((a, b) => getRankValue(a.rank) - getRankValue(b.rank));

    let seg = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1],
        cur = sorted[i];
      if (getRankValue(cur.rank) === getRankValue(prev.rank) + 1) seg.push(cur);
      else {
        if (seg.length >= 3) addRunSlices(seg, melds);
        seg = [cur];
      }
    }
    if (seg.length >= 3) addRunSlices(seg, melds);
  }

  return melds;
}

function addRunSlices(segment, melds) {
  for (let start = 0; start < segment.length; start++) {
    for (let end = start + 2; end < segment.length; end++) {
      melds.push(segment.slice(start, end + 1));
    }
  }
}

function bestDeadwood(hand) {
  const cards = hand.filter(Boolean);
  const ids = cards.map(cardId);
  const idToBit = new Map(ids.map((id, i) => [id, i]));
  const allMask = (1 << cards.length) - 1;

  const meldMasks = allMelds(cards).map((meld) => {
    let mask = 0;
    for (const c of meld) mask |= 1 << idToBit.get(cardId(c));
    return mask;
  });

  const memo = new Map();

  function deadwoodFromMask(usedMask) {
    const deadMask = allMask & ~usedMask;
    let count = 0;
    let points = 0;
    for (let i = 0; i < cards.length; i++) {
      if (deadMask & (1 << i)) {
        count++;
        points += cardValue(cards[i]);
      }
    }
    return { count, points };
  }

  function better(a, b) {
    if (a.count !== b.count) return a.count < b.count;
    return a.points < b.points;
  }

  function dfs(i, usedMask) {
    const key = i + "|" + usedMask;
    if (memo.has(key)) return memo.get(key);

    if (i === meldMasks.length) {
      const dw = deadwoodFromMask(usedMask);
      const res = { ...dw, usedMask, chosenMasks: [] };
      memo.set(key, res);
      return res;
    }

    let best = dfs(i + 1, usedMask);

    const m = meldMasks[i];
    if ((usedMask & m) === 0) {
      const take = dfs(i + 1, usedMask | m);
      const takeRes = { ...take, chosenMasks: [m, ...take.chosenMasks] };
      if (better(takeRes, best)) best = takeRes;
    }

    memo.set(key, best);
    return best;
  }

  return dfs(0, 0);
}

function countDeadwoodCards(hand) {
  return bestDeadwood(hand).count;
}

function layoutFromBestDeadwood(hand) {
  // Rebuild meld groups + deadwood cards from bestDeadwood’s bitmasks
  const cards = hand.filter(Boolean);
  const bd = bestDeadwood(cards);

  const usedMask = bd.usedMask || 0;
  const chosenMasks = bd.chosenMasks || [];

  const meldGroups = chosenMasks.map((mask) => {
    const group = [];
    for (let i = 0; i < cards.length; i++) {
      if (mask & (1 << i)) group.push(cards[i]);
    }
    return group;
  });

  // Deadwood = not in usedMask
  const deadwood = [];
  for (let i = 0; i < cards.length; i++) {
    if (!(usedMask & (1 << i))) deadwood.push(cards[i]);
  }

  return {
    meldGroups,
    deadwood,
    deadwoodPoints: bd.points,
    deadwoodCount: bd.count,
  };
}

/* =========================== DECK HELPERS =========================== */

function createDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = [
    { name: "A", value: 1 },
    { name: "2", value: 2 },
    { name: "3", value: 3 },
    { name: "4", value: 4 },
    { name: "5", value: 5 },
    { name: "6", value: 6 },
    { name: "7", value: 7 },
    { name: "8", value: 8 },
    { name: "9", value: 9 },
    { name: "10", value: 10 },
    { name: "J", value: 10 },
    { name: "Q", value: 10 },
    { name: "K", value: 10 },
  ];

  const deck = [];
  for (const suit of suits)
    for (const rank of ranks)
      deck.push({ suit, rank: rank.name, value: rank.value });
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

/* =========================== ROOM GAME WRAPPER =========================== */

function makeRoom({ code, playersNeeded = 2, targetScore = 10 }) {
  // NOTE: your gameplay logic is currently 2-player only.
  // We'll accept 2; for 4 we’ll reject on create/join for now.
  const room = {
    code,
    playersNeeded,
    sockets: [], // index = playerId
    game: null,
  };

  function broadcast(obj) {
    const msg = JSON.stringify(obj);
    room.sockets.forEach((ws) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
    });
  }

  function sendRoomUpdate() {
    broadcast({
      type: "room_update",
      code: room.code,
      joined: room.sockets.length,
      needed: room.playersNeeded,
    });
  }

  function startRound() {
    const lastMsg = room.game?.roundMessage ?? null;
    const lastMsgTs = room.game?.roundMessageTs ?? null;
    const nextRoundId = (room.game?.roundId ?? 0) + 1;

    const deck = createDeck();
    const existingScores = room.game?.scores ?? [0, 0];
    const targetScoreLocal = room.game?.targetScore ?? targetScore;

    shuffle(deck);

    room.game = {
      deck,
      discardPile: [],
      players: [{ hand: [] }, { hand: [] }],
      currentPlayer: 0,
      phase: "draw",
      roundOver: false,
      winner: null,
      winType: null,
      roundId: nextRoundId,
      lastHandOrder: { 0: [], 1: [] },

      scores: existingScores ?? [0, 0],
      targetScore: targetScoreLocal ?? targetScore,
      matchOver: false,
      matchWinner: null,
      roundMessage: lastMsg,
      roundMessageTs: lastMsgTs,
      rematchVotes: [false, false],
    };

    for (let i = 0; i < 10; i++) {
      room.game.players[0].hand.push(deck.pop());
      room.game.players[1].hand.push(deck.pop());
    }
    room.game.discardPile.push(room.game.deck.pop());

    sendState();
  }

  function sendState() {
    if (!room.game) return;

    // ✅ If we're in draw phase and deck is empty, replenish immediately
    // so clients don't show 0 and so you can trigger shuffle anim.
    let replenishInfo = null;
    if (room.game.phase === "draw" && room.game.deck.length === 0) {
      replenishInfo = maybeReplenish(room.game);
    }

    room.sockets.forEach((ws, index) => {
      const hand = room.game.players[index].hand;
       const oppIndex = index === 0 ? 1 : 0;
       const oppHandCount = room.game.players[oppIndex].hand.length;
      const bd = bestDeadwood(hand);

      ws.send(
        JSON.stringify({
          type: "state",
          yourHand: hand,
          yourTurn: room.game.currentPlayer === index,
          phase: room.game.phase,
          discardTop: room.game.discardPile.at(-1),

          deckCount: room.game.deck.length,

          oppHandCount,

          // ✅ NEW: tell client a shuffle happened (for animation)
          deckReplenished: replenishInfo ? true : false,
          deckReplenishInfo: replenishInfo, // {before, after, ts} or null

          roundOver: room.game.roundOver,
          winner: room.game.winner,
          winType: room.game.winType,
          roundId: room.game.roundId,

          scores: room.game.scores,
          targetScore: room.game.targetScore,
          matchOver: room.game.matchOver,
          matchWinner: room.game.matchWinner,

          roundMessage: room.game.roundMessage,
          roundMessageTs: room.game.roundMessageTs,
          rematchVotes: room.game.rematchVotes,

          deadwoodCount: bd.count,
          deadwoodPoints: bd.points,
        })
      );
    });
  }

  function handleAction(playerId, action) {
    const game = room.game;
    if (!game) return;

    
    if (action.type === "hand_order") {
      // store last known order for this player
      if (Array.isArray(action.order)) {
        game.lastHandOrder[playerId] = action.order.slice();
      }
      return;
    }

    if (game.matchOver && action.type !== "rematch") return;
    if (game.roundOver && action.type !== "rematch") return;
    if (playerId !== game.currentPlayer && action.type !== "rematch") return;

    if (action.type === "draw-deck") {
      if (game.phase !== "draw") return;

      const info = maybeReplenish(game);
      if (info) {
        room.broadcast({
          type: "deck_reshuffle",
          code: room.code,
          deckCount: info.after,
          info,
        });
      }

      if (game.deck.length === 0) return;

      const card = game.deck.pop();
      game.players[playerId].hand.push(card);
      game.phase = "discard";
      sendState();
      return;
    }

    if (action.type === "draw-discard") {
      if (game.phase !== "draw") return;
      if (game.discardPile.length === 0) return;

      const card = game.discardPile.pop();
      if (!card) return;

      game.players[playerId].hand.push(card);
      game.phase = "discard";
      sendState();
      return;
    }

    if (action.type === "discard") {
      if (game.phase !== "discard") return;

      const hand = game.players[playerId].hand;
      const idx = hand.findIndex((c) => `${c.rank}${c.suit}` === action.cardId);
      if (idx === -1) return;

      const card = hand.splice(idx, 1)[0];
      game.discardPile.push(card);

      game.currentPlayer = (game.currentPlayer + 1) % 2;
      game.phase = "draw";
      sendState();
      return;
    }



    if (action.type === "gin") {
      if (game.phase !== "discard") return;

      const hand = game.players[playerId].hand;
      const deadwoodCount = countDeadwoodCards(hand);
      if (deadwoodCount > 1) return;

      const opponent = (playerId + 1) % 2;
      const oppDeadwoodPoints = bestDeadwood(
        game.players[opponent].hand
      ).points;

      game.scores[opponent] += oppDeadwoodPoints;
      game.roundMessage = `Player ${playerId + 1} GIN 🟢 — Player ${
        opponent + 1
      } +${oppDeadwoodPoints} points`;
      game.roundMessageTs = Date.now();

      game.roundOver = true;
      game.winner = playerId;
      game.winType = "gin";

      const loser = game.scores.findIndex((s) => s >= game.targetScore);
      if (loser !== -1) {
        game.matchOver = true;
        game.matchWinner = loser === 0 ? 1 : 0;
      }

      room.broadcast({
        type: "round_end",
        winType: "gin",
        winner: playerId,
        hands: {
          0: game.players[0].hand,
          1: game.players[1].hand,
        },
        deadwoodPoints: {
          0: bestDeadwood(game.players[0].hand).points,
          1: bestDeadwood(game.players[1].hand).points,
        },
        scores: game.scores,
        targetScore: game.targetScore,
      });

      // ✅ NEW: round reveal payload (reveal the LOSER’s hand, since their deadwood adds to their own score)
      const winnerSeat = Number(playerId); // MUST be 0 or 1
      const loserSeat = Number(opponent); // MUST be 0 or 1

      const layouts = {
        0: layoutFromBestDeadwood(game.players[0].hand),
        1: layoutFromBestDeadwood(game.players[1].hand),
      };

      room.broadcast({
        type: "round_reveal",
        code: room.code,
        roundId: game.roundId,

        winner: winnerSeat,
        loser: loserSeat,
        winType: "gin",

        hands: {
          0: game.players[0].hand,
          1: game.players[1].hand,
        },

        handOrders: {
          0: game.lastHandOrder?.[0] || [],
          1: game.lastHandOrder?.[1] || [],
        },

        layouts,

        scores: game.scores,
        targetScore: game.targetScore,
      });

      sendState();

      if (!game.matchOver) setTimeout(() => startRound(), 9000);

      return;
    }

    if (action.type === "rematch") {
      game.rematchVotes[playerId] = true;
      sendState();

      if (game.rematchVotes[0] && game.rematchVotes[1]) {
        game.rematchVotes = [false, false];
        game.lastHandOrder = { 0: [], 1: [] };
        game.scores = [0, 0];
        game.matchOver = false;
        game.matchWinner = null;
        game.roundOver = false;
        game.winner = null;
        game.winType = null;
        game.roundMessage = null;
        game.roundMessageTs = null;

        startRound();
      }
      return;
    }
  }

  room.broadcast = broadcast;
  room.sendRoomUpdate = sendRoomUpdate;
  room.startRound = startRound;
  room.sendState = sendState;
  room.handleAction = handleAction;

  return room;
}

/* =========================== CONNECTIONS / ROOM COMMANDS =========================== */

function safeSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function removeSocketFromRoom(ws) {
  const code = ws.roomCode;
  if (!code) return;

  const room = Rooms.getRoom(code);
  if (!room) return;

  const idx = room.sockets.indexOf(ws);
  if (idx !== -1) room.sockets.splice(idx, 1);

  // reassign playerIds based on array positions
  room.sockets.forEach((sock, i) => {
    sock.playerId = i;
  });

  // if room empty, delete it
  if (room.sockets.length === 0) {
    Rooms.deleteRoom(code);
    return;
  }

  room.sendRoomUpdate();

  // If a game was running, simplest rule: kill it and require rematch/new start
  // (we can improve reconnect later)
  room.game = null;
}

wss.on("connection", (ws, req) => {
  const origin = req.headers.origin;
console.log("WS connection attempt, origin =", origin);

   if (origin && !allowed.has(origin)) {
     console.log("Blocked WS origin:", origin);
     ws.close();
     return;
  }
  
    console.log("WS connected origin:", origin);
  // don’t auto-assign playerId anymore; that happens on join/create
  ws.playerId = null;
  ws.roomCode = null;

    ws.on("message", (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString()); // ✅ important
      } catch {
        return;
      }

      // ====== CREATE ROOM ======
      if (data.type === "create_room") {
        const code = String(data.code || "")
          .toUpperCase()
          .trim();
        const playersNeeded = Number(data.playersNeeded || 2);
        const pointsTarget = Number(data.pointsTarget || 10);

        if (!code || code.length < 4) {
          safeSend(ws, { type: "join_error", message: "Invalid room code." });
          return;
        }

        // current server logic supports 2 players only
        if (playersNeeded !== 2) {
          safeSend(ws, {
            type: "join_error",
            message: "4-player not supported yet (2-player only for now).",
          });
          return;
        }

        if (Rooms.hasRoom(code)) {
          safeSend(ws, {
            type: "join_error",
            message: "Code already exists. Try again.",
          });
          return;
        }

        const room = makeRoom({
          code,
          playersNeeded,
          targetScore: pointsTarget,
        });
        Rooms.setRoom(code, room);

        ws.roomCode = code;
        ws.playerId = 0;
        room.sockets.push(ws);

        safeSend(ws, { type: "init", playerId: 0 });
        room.sendRoomUpdate();
        return;
      }

      // ====== JOIN ROOM ======
      if (data.type === "join_room") {
        const code = String(data.code || "")
          .toUpperCase()
          .trim();
        const room = Rooms.getRoom(code);

        if (!room) {
          safeSend(ws, { type: "join_error", message: "Room not found." });
          return;
        }

        if (room.sockets.length >= room.playersNeeded) {
          safeSend(ws, { type: "join_error", message: "Room is full." });
          return;
        }

        ws.roomCode = code;
        ws.playerId = room.sockets.length;
        room.sockets.push(ws);

        safeSend(ws, { type: "init", playerId: ws.playerId });
        safeSend(ws, { type: "join_ok", code });

        room.sendRoomUpdate();
        return;
      }

      // ====== START GAME (host only) ======
      if (data.type === "start_game") {
        const code = String(data.code || "")
          .toUpperCase()
          .trim();
        const room = Rooms.getRoom(code);

        if (!room) return;
        if (ws.roomCode !== code) return;
        if (ws.playerId !== 0) return; // host-only
        if (room.sockets.length < room.playersNeeded) {
          safeSend(ws, {
            type: "join_error",
            message: "Need more players to start.",
          });
          return;
        }

        room.broadcast({ type: "game_start", code });
        room.startRound();
        return;
      }

      // ====== GAME ACTIONS ======
      // All your existing actions flow through here
      const code = ws.roomCode;
      if (!code) return;

      const room = Rooms.getRoom(code);
      if (!room) return;

      if (typeof ws.playerId !== "number") return;

      room.handleAction(ws.playerId, data);
    });

  ws.on("close", () => {
    removeSocketFromRoom(ws);
  });
});
