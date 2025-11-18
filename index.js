import express from "express";
import axios from "axios";

const app = express();
const PORT = 4000;

/* -----------------------------
   CONFIG
----------------------------- */
const GAME_ID = 746087;
const URL = `https://statsapi.mlb.com/api/v1.1/game/${GAME_ID}/feed/live`;
const LIVE_POLL_RATE = 10000;
const REPLAY_RATE = 5500;

/* -----------------------------
   STATE
----------------------------- */
let pitchIndexMap = [];
let lastGameData = null;
let replayModeActive = false;
let pitchPointer = 0;

// Pretty log state
let lastInningPrinted = null;
let lastPitcherId = null;
let lastBatterId = null;
let pitchSequence = [];

// Simulated game state (outs)
let simulatedOuts = 0;
let simInning = null;
let simHalf = null; // "top" | "bottom"

/* -----------------------------
   COLORS
----------------------------- */
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

/* -----------------------------
   ASCII STRIKE ZONE (10x10)
----------------------------- */
function asciiStrikeZone(pitch) {
  const coords = pitch?.details?.coordinates;
  if (!coords || coords.px == null || coords.pz == null) {
    return [
      "   ┌──────────┐",
      "   │   (no    │",
      "   │ location │",
      "   │  data)   │",
      "   └──────────┘",
    ].join("\n");
  }

  const px = coords.px;
  const pz = coords.pz;
  const szTop = coords.strikeZoneTop ?? 3.5;
  const szBot = coords.strikeZoneBottom ?? 1.5;

  const GRID_SIZE = 10;
  const grid = Array.from({ length: GRID_SIZE }, () =>
    Array.from({ length: GRID_SIZE }, () => " ")
  );

  const xNorm = Math.max(-1.5, Math.min(1.5, px));
  const xPos = Math.floor(((xNorm + 1.5) / 3.0) * (GRID_SIZE - 1));

  const yNorm = Math.max(szBot, Math.min(szTop, pz));
  const yPos =
    GRID_SIZE -
    1 -
    Math.floor(((yNorm - szBot) / (szTop - szBot)) * (GRID_SIZE - 1));

  grid[yPos][xPos] = "●";

  let out = "   ┌" + "─".repeat(GRID_SIZE) + "┐\n";
  for (let r = 0; r < GRID_SIZE; r++) {
    out += "   │" + grid[r].join("") + "│\n";
  }
  out += "   └" + "─".repeat(GRID_SIZE) + "┘";

  return out;
}

/* -----------------------------
   Pitch Mix Model (Stage 1)
----------------------------- */
const leaguePitchMixByCount = {
  "0-0": { fastball: 0.63, breaking: 0.25, change: 0.12 },
  "0-1": { fastball: 0.55, breaking: 0.30, change: 0.15 },
  "0-2": { fastball: 0.40, breaking: 0.43, change: 0.17 },
  "1-0": { fastball: 0.70, breaking: 0.20, change: 0.10 },
  "1-1": { fastball: 0.58, breaking: 0.30, change: 0.12 },
  "1-2": { fastball: 0.42, breaking: 0.45, change: 0.13 },
  "2-0": { fastball: 0.72, breaking: 0.18, change: 0.10 },
  "2-1": { fastball: 0.60, breaking: 0.28, change: 0.12 },
  "2-2": { fastball: 0.50, breaking: 0.38, change: 0.12 },
  "3-0": { fastball: 0.85, breaking: 0.10, change: 0.05 },
  "3-1": { fastball: 0.75, breaking: 0.15, change: 0.10 },
  "3-2": { fastball: 0.70, breaking: 0.20, change: 0.10 }
};

function normalize(obj) {
  const sum = Object.values(obj).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v / sum]));
}

/* -----------------------------
   Pretty Helpers
----------------------------- */
function prettyRunners(r) {
  return (
    (r.first ? "🟢" : "⚪") +
    (r.second ? "🟢" : "⚪") +
    (r.third ? "🟢" : "⚪")
  );
}

function coloredPitch(type, text) {
  if (type === "fastball") return colors.red + text + colors.reset;
  if (type === "breaking") return colors.blue + text + colors.reset;
  if (type === "change") return colors.yellow + text + colors.reset;
  return text;
}

function prettyPrediction(pred) {
  return `
        ${coloredPitch("fastball",  `Fastball: ${(pred.fastball * 100).toFixed(0)}%`)}
        ${coloredPitch("breaking",  `Breaking: ${(pred.breaking * 100).toFixed(0)}%`)}
        ${coloredPitch("change",    `Changeup: ${(pred.change * 100).toFixed(0)}%`)}
  `;
}

function prettyContext(ctx) {
  return `
   Count: ${ctx.balls}-${ctx.strikes} | Outs: ${ctx.outs} | Runners: ${prettyRunners(ctx.runnersOn)}
   Matchup: ${ctx.pitcherThrows}HP vs ${ctx.batterBats}HB | Inning: ${ctx.inning} ${ctx.topBottom}
   Last pitch type: ${ctx.lastPitchType ?? "None"}
  `;
}

/* -----------------------------
   Sequence Analysis
----------------------------- */
function analyzeSequence(newPitchType) {
  pitchSequence.push(newPitchType);

  const last2 = pitchSequence.slice(-2);
  const last3 = pitchSequence.slice(-3);

  let notes = [];

  if (last2.length === 2 && last2[0] === last2[1]) {
    notes.push(`Back-to-back ${newPitchType}s`);
  }

  if (last3.length === 3 && last3.every(p => p === newPitchType)) {
    notes.push(`⚠️  3 straight ${newPitchType}s`);
  }

  return notes.join(", ") || null;
}

/* -----------------------------
   Pitcher/Batter Change Detector
----------------------------- */
function detectChanges(play) {
  const notes = [];

  if (lastPitcherId !== play.matchup.pitcher.id) {
    lastPitcherId = play.matchup.pitcher.id;
    pitchSequence = [];
    notes.push(`🧢 New Pitcher: ${play.matchup.pitcher.fullName}`);
  }

  if (lastBatterId !== play.matchup.batter.id) {
    lastBatterId = play.matchup.batter.fullName;
    notes.push(`🏏 New Batter: ${play.matchup.batter.fullName}`);
  }

  return notes.length ? notes.join("\n") : null;
}

/* -----------------------------
   Inning Headers
----------------------------- */
function showInningHeader(ctx) {
  const current = `${ctx.inning} ${ctx.topBottom}`;
  if (current !== lastInningPrinted) {
    lastInningPrinted = current;
    console.log(colors.magenta + `\n===== Inning ${current} =====` + colors.reset);
  }
}

/* -----------------------------
   PITCH INDEX MAPPING
----------------------------- */
function buildPitchIndexMap(gameData) {
  pitchIndexMap = [];
  const plays = gameData.liveData.plays.allPlays;

  plays.forEach((play, playIdx) => {
    play.playEvents?.forEach((event, pitchIdx) => {
      if (event.isPitch) {
        pitchIndexMap.push({ playIdx, pitchIdx });
      }
    });
  });

  console.log(`PITCH INDEX MAP LENGTH: ${pitchIndexMap.length}`);
}

/* -----------------------------
   Build Replay Pitch Context
   Uses simulatedOuts passed in
----------------------------- */
function buildReplayPitchContext(game, playIdx, pitchIdx, outsBefore) {
  try {
    const play = game.liveData.plays.allPlays[playIdx];
    const pitch = play.playEvents[pitchIdx];

    return {
      inning: play.about.inning,
      topBottom: play.about.halfInning === "top" ? "Top" : "Bottom",

      balls: pitch.count?.balls ?? 0,
      strikes: pitch.count?.strikes ?? 0,
      outs: outsBefore,

      // Still showing pre-play runners for now (startingBase)
      runnersOn: {
        first: play.runners?.some(r => r.startingBase === 1) ?? false,
        second: play.runners?.some(r => r.startingBase === 2) ?? false,
        third: play.runners?.some(r => r.startingBase === 3) ?? false
      },

      lastPitchType: pitch.details?.type?.code ?? null,

      pitcherThrows: play.matchup.pitchHand?.code ?? "R",
      batterBats: play.matchup.batSide?.code ?? "R"
    };
  } catch {
    return null;
  }
}

/* -----------------------------
   Predict Next Pitch
----------------------------- */
function predictPitchType(ctx) {
  if (!ctx) return { fastball: 0.33, breaking: 0.33, change: 0.34 };

  const key = `${ctx.balls}-${ctx.strikes}`;
  let baseMix = leaguePitchMixByCount[key] || { fastball: 0.6, breaking: 0.25, change: 0.15 };

  if (ctx.pitcherThrows === "R" && ctx.batterBats === "L") {
    baseMix.change += 0.05;
    baseMix.fastball -= 0.03;
    baseMix.breaking -= 0.02;
  }

  if (ctx.pitcherThrows === "L" && ctx.batterBats === "R") {
    baseMix.breaking += 0.05;
    baseMix.fastball -= 0.03;
    baseMix.change -= 0.02;
  }

  if (ctx.runnersOn.first || ctx.runnersOn.second || ctx.runnersOn.third) {
    baseMix.breaking += 0.03;
    baseMix.fastball -= 0.03;
  }

  return normalize(baseMix);
}

/* -----------------------------
   REPLAY MODE (Pretty Logs Only)
----------------------------- */
async function handleReplayMode() {
  if (!replayModeActive) {
    console.log("🎬 Pitch-by-Pitch Replay Started");
    replayModeActive = true;
    buildPitchIndexMap(lastGameData);
    simulatedOuts = 0;
    simInning = null;
    simHalf = null;
  }

  if (pitchPointer >= pitchIndexMap.length) {
    console.log("🏁 All pitches replayed.");
    return;
  }

  const { playIdx, pitchIdx } = pitchIndexMap[pitchPointer];
  const play = lastGameData.liveData.plays.allPlays[playIdx];
  const pitch = play.playEvents[pitchIdx];

  // Detect inning/half change for simulated outs reset
  const playInning = play.about.inning;
  const playHalf = play.about.halfInning; // "top" | "bottom"

  if (simInning === null || simHalf === null ||
      playInning !== simInning || playHalf !== simHalf) {
    simInning = playInning;
    simHalf = playHalf;
    simulatedOuts = 0;
  }

  const outsBefore = simulatedOuts;

  // Is this the last pitch of this play?
  let isLastPitchOfPlay = true;
  for (let j = pitchIdx + 1; j < play.playEvents.length; j++) {
    if (play.playEvents[j].isPitch) {
      isLastPitchOfPlay = false;
      break;
    }
  }

  const ctx = buildReplayPitchContext(lastGameData, playIdx, pitchIdx, outsBefore);
  const prediction = predictPitchType(ctx);

  console.log(
    colors.bold +
      `🎯 Pitch ${pitchPointer + 1} — ${pitch.details?.description || "Unknown"} (${pitch.details?.type?.code})` +
      colors.reset
  );

  if (ctx) showInningHeader(ctx);

  const changes = detectChanges(play);
  if (changes) console.log(colors.cyan + changes + colors.reset);

  if (ctx?.lastPitchType) {
    const seq = analyzeSequence(ctx.lastPitchType);
    if (seq) console.log(colors.yellow + seq + colors.reset);
  }

  if (ctx) console.log(prettyContext(ctx));

  console.log(colors.green + "   ➤ Next Pitch Probabilities:" + colors.reset);
  console.log(prettyPrediction(prediction));

  console.log(colors.blue + "\nASCII Strike Zone:\n" + colors.reset);
  console.log(asciiStrikeZone(pitch));

  // After logging: update simulated outs if this pitch ended the play
  if (isLastPitchOfPlay) {
    let outsOnPlay = 0;
    for (const runner of play.runners ?? []) {
      if (runner.isOut) outsOnPlay++;
    }
    simulatedOuts = Math.min(3, simulatedOuts + outsOnPlay);
  }

  pitchPointer++;
}

/* -----------------------------
   LIVE MODE
----------------------------- */
async function handleLiveMode() {
  const data = await fetchGameData();
  if (data) lastGameData = data;
}

/* -----------------------------
   Fetch Game
----------------------------- */
async function fetchGameData() {
  try {
    const { data } = await axios.get(URL);
    return data;
  } catch {
    return null;
  }
}

/* -----------------------------
   MAIN LOOP
----------------------------- */
async function gameLoop() {
  const initial = await fetchGameData();
  if (!initial) return;

  lastGameData = initial;
  const state = initial.gameData.status.abstractGameState;

  if (state === "Final") {
    console.log("⚾ Completed Game — Using Pitch-by-Pitch Replay");
    setInterval(handleReplayMode, REPLAY_RATE);
  } else {
    console.log("📺 Live Game — Polling");
    setInterval(handleLiveMode, LIVE_POLL_RATE);
  }
}
gameLoop();

/* -----------------------------
   API ENDPOINTS (full JSON preserved)
----------------------------- */
app.get("/api/game", (req, res) => {
  res.json(lastGameData || { error: "No data yet" });
});

app.get("/api/pitch-type", (req, res) => {
  if (!lastGameData) return res.json({ error: "No data yet" });

  if (!pitchIndexMap.length) buildPitchIndexMap(lastGameData);

  const { playIdx, pitchIdx } = pitchIndexMap[pitchPointer] || {};
  const play = lastGameData.liveData.plays.allPlays[playIdx];
  const pitch = play.playEvents?.[pitchIdx];

  // For API we use current simulatedOuts as "outs before this pitch"
  const ctx = buildReplayPitchContext(lastGameData, playIdx, pitchIdx, simulatedOuts);
  const probs = predictPitchType(ctx);

  res.json({ context: ctx, probabilities: probs });
});

/* -----------------------------
   START SERVER
----------------------------- */
app.listen(PORT, () =>
  console.log(`🌐 Server running at http://localhost:${PORT}`)
);
