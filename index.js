/* -----------------------------
   MLB Pitch Predictor
   Best Available Coordinates
   + Enhanced Context Engine (A3)
   + Break Movement (HB / VB) Fallback
   + CSV Arsenal Baselines
----------------------------- */

import express from "express";
import axios from "axios";
import fs from "fs";
import { parse } from "csv-parse/sync";

const app = express();
const PORT = 4000;

/* -----------------------------
   CONFIG
----------------------------- */
const GAME_ID = 745316; // regular-season game w/ Statcast
const URL = `https://statsapi.mlb.com/api/v1.1/game/${GAME_ID}/feed/live`;
const LIVE_POLL_RATE = 10000;
const REPLAY_RATE = 5500;

// path to your CSV (you can change this)
const ARSENAL_CSV_PATH = "../pitch-arsenal-stats.csv";

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

// Game state for outs
let simulatedOuts = 0;
let simInning = null;
let simHalf = null;

// Coordinates cache: key → { px, pz, szTop, szBot, hb?, vb?, angle?, length? }
let pitchCoordCache = {};

// pitcherGameStats[pitcherId] = { fastball, breaking, change, total }
let pitcherGameStats = {};

// batterAggressionStats[batterId] = { swings, pitches }
let batterAggressionStats = {};

// CSV arsenal baselines: pitcherArsenalById[pitcherId] = { fastball, breaking, change }
let pitcherArsenalById = {};

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
   Pitch Mix Model (League)
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
  "3-2": { fastball: 0.70, breaking: 0.20, change: 0.10 },
};

function normalize(obj) {
  const s = Object.values(obj).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v / s]));
}

/* ==========================================================
   PITCH FAMILY MAPPING (Feed + CSV)
   - fastball / breaking / change (offspeed)
   - splitter / fork / screwball → change
   - SI for sinker, SW for sweeper style, etc.
========================================================== */

function mapPitchCodeToBucket(code) {
  if (!code) return null;
  const c = code.toUpperCase();

  // Fastballs (including sinker, 2-seam, cutters)
  if (["FF", "FT", "SI", "FC", "FA"].includes(c)) return "fastball";

  // Some sources use FS as split-finger; treat splitty as offspeed
  if (["FS"].includes(c)) return "change";

  // Offspeed / change family (changeup, splitter, forkball, screwball)
  if (["CH", "SF", "FO", "SC"].includes(c)) return "change";

  // Breaking: sliders, curves, knuckle, sweepers, etc.
  if (["SL", "CU", "KC", "KN", "SV", "ST", "SW"].includes(c)) return "breaking";

  // Fallback
  return "fastball";
}

/* ==========================================================
   CSV ARSENAL LOADING
========================================================== */

function loadPitcherArsenalFromCSV() {
  try {
    const csvRaw = fs.readFileSync(ARSENAL_CSV_PATH, "utf8");
    const records = parse(csvRaw, { columns: true, skip_empty_lines: true });

    const temp = {}; // pitcherId → { fastball, breaking, change, total }

    for (const row of records) {
      const idStr = row["player_id"] ?? row.player_id;
      const pitchType = row["pitch_type"] ?? row.pitch_type;
      const usageStr = row["pitch_usage"] ?? row.pitch_usage;

      const id = Number(idStr);
      if (!id || !pitchType || usageStr == null) continue;

      const family = mapPitchCodeToBucket(pitchType);
      if (!family) continue;

      const usage = parseFloat(String(usageStr));
      if (Number.isNaN(usage)) continue;

      if (!temp[id]) {
        temp[id] = { fastball: 0, breaking: 0, change: 0, total: 0 };
      }

      temp[id][family] += usage;
      temp[id].total += usage;
    }

    pitcherArsenalById = {};
    for (const [idStr, stats] of Object.entries(temp)) {
      if (!stats.total) continue;
      const idNum = Number(idStr);
      pitcherArsenalById[idNum] = normalize({
        fastball: stats.fastball,
        breaking: stats.breaking,
        change: stats.change,
      });
    }

    console.log(
      `📊 Loaded pitcher arsenal CSV for ${
        Object.keys(pitcherArsenalById).length
      } pitchers from ${ARSENAL_CSV_PATH}`
    );
  } catch (err) {
    console.warn("⚠️ Could not load pitcher arsenal CSV:", err.message);
    pitcherArsenalById = {};
  }
}

function getPitcherArsenalMix(pitcherId) {
  return pitcherArsenalById[pitcherId] || null;
}

/* ==========================================================
   BEST AVAILABLE COORDINATES SYSTEM
========================================================== */

function getCoordKey(play, pitch) {
  const atBatIndex =
    play.about?.atBatIndex != null
      ? play.about.atBatIndex
      : `${play.about.inning}-${play.about.halfInning}`;

  const pitchNum =
    pitch.pitchNumber ??
    pitch.details?.pitchNumber ??
    pitch.pitchData?.pitchNumber ??
    0;

  return `${atBatIndex}-${pitchNum}`;
}

function storeCoordsInCache(play, pitch, coord) {
  if (!coord) return;

  const key = getCoordKey(play, pitch);

  pitchCoordCache[key] = {
    px: coord.px ?? null,
    pz: coord.pz ?? null,
    szTop: coord.szTop ?? 3.5,
    szBot: coord.szBot ?? 1.5,
    hb: coord.hb ?? null,
    vb: coord.vb ?? null,
    angle: coord.angle ?? null,
    length: coord.length ?? null,
  };
}

/**
 * Extracts coordinates from the pitch itself:
 *  - Tier 1: pitch.pitchData.coordinates (Statcast pX/pZ)
 *  - Tier 2: pitch.details.coordinates (px/pz)
 */
function extractCoordinatesFromPitch(pitch) {
  if (!pitch) return { hasLocation: false };

  const pd = pitch.pitchData?.coordinates;
  if (pd && pd.pX != null && pd.pZ != null) {
    return {
      hasLocation: true,
      px: pd.pX,
      pz: pd.pZ,
      szTop: pitch.pitchData?.strikeZoneTop ?? 3.5,
      szBot: pitch.pitchData?.strikeZoneBottom ?? 1.5,
    };
  }

  const dc = pitch.details?.coordinates;
  if (dc && dc.px != null && dc.pz != null) {
    return {
      hasLocation: true,
      px: dc.px,
      pz: dc.pz,
      szTop: dc.strikeZoneTop ?? 3.5,
      szBot: dc.strikeZoneBottom ?? 1.5,
    };
  }

  return { hasLocation: false };
}

/**
 * Full Best-Available resolver for a pitch index.
 * Priority:
 *  1. True location (pitchData / details)
 *  1.5. Breaks block (HB / VB) if no location
 *  2. Cache (same at-bat + pitchNumber)
 *  3. Search same at-bat by pitchNumber
 */
function getPitchCoordinates(game, playIdx, pitchIdx) {
  const play = game.liveData.plays.allPlays[playIdx];
  const pitch = play.playEvents[pitchIdx];
  if (!pitch) return { hasLocation: false };

  const atBatIndex = play.about?.atBatIndex;
  const pitchNum =
    pitch.pitchNumber ??
    pitch.details?.pitchNumber ??
    pitch.pitchData?.pitchNumber ??
    null;

  // Tier 1: direct from pitch (true location)
  const direct = extractCoordinatesFromPitch(pitch);
  if (direct.hasLocation) {
    storeCoordsInCache(play, pitch, direct);
    return direct;
  }

  // Tier 1.5: Breaks block (movement only)
  const br = pitch.breaks;
  if (br) {
    const hb = br.breakHorizontal;
    const vb = br.breakVerticalInduced;
    const angle = br.breakAngle;
    const length = br.breakLength;

    if (hb != null && vb != null) {
      const movementCoord = {
        px: null,
        pz: null,
        szTop: 3.5,
        szBot: 1.5,
        hb,
        vb,
        angle,
        length,
      };

      storeCoordsInCache(play, pitch, movementCoord);

      return {
        hasLocation: false,
        isBreakData: true,
        hb,
        vb,
        angle,
        length,
      };
    }
  }

  // Tier 2: cache
  if (pitchNum != null && atBatIndex != null) {
    const key = getCoordKey(play, pitch);
    if (pitchCoordCache[key]) {
      const c = pitchCoordCache[key];
      const hasLocation = c.px != null && c.pz != null;
      return {
        hasLocation,
        isBreakData: !hasLocation && (c.hb != null || c.vb != null),
        px: c.px,
        pz: c.pz,
        szTop: c.szTop,
        szBot: c.szBot,
        hb: c.hb,
        vb: c.vb,
        angle: c.angle,
        length: c.length,
      };
    }
  }

  // Tier 3: search same at-bat by pitchNumber
  if (pitchNum != null && atBatIndex != null) {
    const plays = game.liveData.plays.allPlays;
    for (const p2 of plays) {
      if (p2.about?.atBatIndex !== atBatIndex) continue;
      for (const ev of p2.playEvents ?? []) {
        if (!ev.isPitch) continue;

        const evPitchNum =
          ev.pitchNumber ??
          ev.details?.pitchNumber ??
          ev.pitchData?.pitchNumber ??
          null;

        if (evPitchNum !== pitchNum) continue;

        const evCoord = extractCoordinatesFromPitch(ev);
        if (evCoord.hasLocation) {
          storeCoordsInCache(play, pitch, evCoord);
          return evCoord;
        }

        const br2 = ev.breaks;
        if (br2 && br2.breakHorizontal != null && br2.breakVerticalInduced != null) {
          const movementCoord = {
            px: null,
            pz: null,
            szTop: 3.5,
            szBot: 1.5,
            hb: br2.breakHorizontal,
            vb: br2.breakVerticalInduced,
            angle: br2.breakAngle,
            length: br2.breakLength,
          };

          storeCoordsInCache(play, pitch, movementCoord);
          return {
            hasLocation: false,
            isBreakData: true,
            hb: br2.breakHorizontal,
            vb: br2.breakVerticalInduced,
            angle: br2.breakAngle,
            length: br2.breakLength,
          };
        }
      }
    }
  }

  // Tier 4: nothing
  return { hasLocation: false };
}

/* -----------------------------
   ASCII STRIKE ZONE (10×10)
----------------------------- */
function asciiStrikeZone(loc) {
  if (!loc) {
    return (
      colors.yellow +
      "Location / movement data unavailable for this pitch." +
      colors.reset
    );
  }

  // Movement-only mode (no location, but HB/VB present)
  if (!loc.hasLocation && loc.isBreakData) {
    const hb = loc.hb ?? 0;
    const vb = loc.vb ?? 0;
    const ang = loc.angle ?? 0;
    const len = loc.length ?? Math.sqrt(hb * hb + vb * vb);

    return `
   Movement (Statcast break):
      HB: ${hb.toFixed(1)}″
      VB: ${vb.toFixed(1)}″
      Break: ${len.toFixed(1)}″
      Angle: ${ang.toFixed(1)}°
`;
  }

  if (!loc.hasLocation) {
    return (
      colors.yellow +
      "Location data unavailable for this pitch." +
      colors.reset
    );
  }

  const { px, pz, szTop, szBot } = loc;

  const GRID = 10;
  const grid = Array.from({ length: GRID }, () =>
    Array.from({ length: GRID }, () => " ")
  );

  const xNorm = Math.max(-1.5, Math.min(1.5, px));
  const xPos = Math.floor(((xNorm + 1.5) / 3.0) * (GRID - 1));

  const yNorm = Math.max(szBot, Math.min(szTop, pz));
  const yPos =
    GRID - 1 -
    Math.floor(((yNorm - szBot) / (szTop - szBot)) * (GRID - 1));

  grid[yPos][xPos] = "●";

  let out = "   ┌" + "─".repeat(GRID) + "┐\n";
  for (let r = 0; r < GRID; r++) {
    out += "   │" + grid[r].join("") + "│\n";
  }
  out += "   └" + "─".repeat(GRID) + "┘";

  return out;
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

function coloredPitch(type, txt) {
  if (type === "fastball") return colors.red + txt + colors.reset;
  if (type === "breaking") return colors.blue + txt + colors.reset;
  if (type === "change") return colors.yellow + txt + colors.reset;
  return txt;
}

function prettyPrediction(pred) {
  return `
        ${coloredPitch(
          "fastball",
          `Fastball: ${(pred.fastball * 100).toFixed(0)}%`
        )}
        ${coloredPitch(
          "breaking",
          `Breaking: ${(pred.breaking * 100).toFixed(0)}%`
        )}
        ${coloredPitch(
          "change",
          `Offspeed: ${(pred.change * 100).toFixed(0)}%`
        )}
  `;
}

function prettyContext(ctx) {
  const pitcherMix = ctx.pitcherGameMix;
  const ba = ctx.batterAggression;
  const arsenal = ctx.pitcherArsenalMix;

  const pitcherMixStr = pitcherMix
    ? `   Pitcher game mix: F ${(pitcherMix.fastball * 100).toFixed(
        0
      )}% | Br ${(pitcherMix.breaking * 100).toFixed(
        0
      )}% | Off ${(pitcherMix.change * 100).toFixed(0)}%`
    : "   Pitcher game mix: (n/a yet)";

  const arsenalStr = arsenal
    ? `   Pitcher CSV arsenal: F ${(arsenal.fastball * 100).toFixed(
        0
      )}% | Br ${(arsenal.breaking * 100).toFixed(
        0
      )}% | Off ${(arsenal.change * 100).toFixed(0)}%`
    : "   Pitcher CSV arsenal: (n/a yet)";

  const baStr =
    ba != null
      ? `   Batter aggression (swings/pitches): ${(ba * 100).toFixed(0)}%`
      : "   Batter aggression: (n/a yet)";

  return `
   Count: ${ctx.balls}-${ctx.strikes} | Outs: ${ctx.outs} | Runners: ${prettyRunners(
    ctx.runnersOn
  )}
   Matchup: ${ctx.pitcherThrows}HP vs ${
    ctx.batterBats
  }HB | Inning: ${ctx.inning} ${ctx.topBottom}
   Last pitch type: ${ctx.lastPitchType ?? "None"}
${pitcherMixStr}
${arsenalStr}
${baStr}
  `;
}

/* -----------------------------
   Sequence Analysis
----------------------------- */
function analyzeSequence(newType) {
  pitchSequence.push(newType);

  const last2 = pitchSequence.slice(-2);
  const last3 = pitchSequence.slice(-3);

  const notes = [];

  if (last2.length === 2 && last2[0] === last2[1]) {
    notes.push(`Back-to-back ${newType}s`);
  }

  if (last3.length === 3 && last3.every((p) => p === newType)) {
    notes.push(`⚠️  3 straight ${newType}s`);
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
    lastBatterId = play.matchup.batter.id;
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
    console.log(
      colors.magenta + `\n===== Inning ${current} =====` + colors.reset
    );
  }
}

/* -----------------------------
   PITCH INDEX MAPPING
----------------------------- */
function buildPitchIndexMap(gameData) {
  pitchIndexMap = [];
  const plays = gameData.liveData.plays.allPlays;

  plays.forEach((play, pIdx) => {
    play.playEvents?.forEach((ev, eIdx) => {
      if (ev.isPitch) pitchIndexMap.push({ playIdx: pIdx, pitchIdx: eIdx });
    });
  });

  console.log(`PITCH INDEX MAP LENGTH: ${pitchIndexMap.length}`);
}

/* -----------------------------
   OUTS FROM PLAY (event-based)
----------------------------- */
function outsFromPlay(play) {
  const event = play.result?.event?.toLowerCase() ?? "";

  if (event.includes("triple play")) return 3;
  if (event.includes("double play")) return 2;

  if (event.includes("groundout")) return 1;
  if (event.includes("forceout")) return 1;
  if (event.includes("fielder's choice out")) return 1;
  if (event.includes("fielders choice out")) return 1;
  if (event.includes("flyout")) return 1;
  if (event.includes("lineout")) return 1;
  if (event.includes("pop out")) return 1;
  if (event.includes("strikeout")) return 1;

  return 0;
}

/* ==========================================================
   CONTEXT ENGINE: PITCHER + BATTER STATS
========================================================== */

function updatePitcherStats(play, pitch) {
  const pitcherId = play.matchup.pitcher.id;
  const code = pitch.details?.type?.code;
  const bucket = mapPitchCodeToBucket(code);
  if (!bucket) return;

  if (!pitcherGameStats[pitcherId]) {
    pitcherGameStats[pitcherId] = {
      fastball: 0,
      breaking: 0,
      change: 0,
      total: 0,
    };
  }

  const stats = pitcherGameStats[pitcherId];
  stats[bucket] += 1;
  stats.total += 1;
}

function getPitcherGameMix(pitcherId) {
  const stats = pitcherGameStats[pitcherId];
  if (!stats || stats.total === 0) return null;

  return normalize({
    fastball: stats.fastball,
    breaking: stats.breaking,
    change: stats.change,
  });
}

// Very simple "did the batter swing?" heuristic
function isSwing(pitch) {
  const d = (pitch.details?.description || "").toLowerCase();

  if (pitch.details?.isInPlay) return true;
  if (d.includes("swinging")) return true;
  if (d.includes("foul")) return true;
  if (d.includes("in play")) return true;

  return false;
}

function updateBatterStats(play, pitch) {
  const batterId = play.matchup.batter.id;

  if (!batterAggressionStats[batterId]) {
    batterAggressionStats[batterId] = { swings: 0, pitches: 0 };
  }

  const stats = batterAggressionStats[batterId];
  stats.pitches += 1;
  if (isSwing(pitch)) stats.swings += 1;
}

function getBatterAggression(batterId) {
  const stats = batterAggressionStats[batterId];
  if (!stats || stats.pitches === 0) return null;
  return stats.swings / stats.pitches;
}

/* -----------------------------
   Build Replay Pitch Context
----------------------------- */
function buildReplayPitchContext(game, playIdx, pitchIdx, outsBefore) {
  try {
    const play = game.liveData.plays.allPlays[playIdx];
    const pitch = play.playEvents[pitchIdx];

    const location = getPitchCoordinates(game, playIdx, pitchIdx);

    const pitcherId = play.matchup.pitcher.id;
    const batterId = play.matchup.batter.id;

    const pitcherGameMix = getPitcherGameMix(pitcherId);
    const batterAggression = getBatterAggression(batterId);
    const pitcherArsenalMix = getPitcherArsenalMix(pitcherId);

    return {
      inning: play.about.inning,
      topBottom: play.about.halfInning === "top" ? "Top" : "Bottom",

      balls: pitch.count?.balls ?? 0,
      strikes: pitch.count?.strikes ?? 0,
      outs: outsBefore,

      runnersOn: {
        first: play.runners?.some((r) => r.startingBase === 1) ?? false,
        second: play.runners?.some((r) => r.startingBase === 2) ?? false,
        third: play.runners?.some((r) => r.startingBase === 3) ?? false,
      },

      lastPitchType: pitch.details?.type?.code ?? null,
      pitcherThrows: play.matchup.pitchHand?.code ?? "R",
      batterBats: play.matchup.batSide?.code ?? "R",

      location,
      pitcherGameMix,
      batterAggression,
      pitcherArsenalMix,
    };
  } catch {
    return null;
  }
}

/* -----------------------------
   Predict Next Pitch
   League baseline + CSV arsenal + game mix
----------------------------- */
function predictPitchType(ctx) {
  if (!ctx) return { fastball: 0.33, breaking: 0.33, change: 0.34 };

  const key = `${ctx.balls}-${ctx.strikes}`;

  // League baseline by count
  let mix = {
    ...(leaguePitchMixByCount[key] || {
      fastball: 0.6,
      breaking: 0.25,
      change: 0.15,
    }),
  };

  // Blend in CSV arsenal baseline (pitcher tendencies)
  if (ctx.pitcherArsenalMix) {
    const wLeague = 0.5;
    const wArsenal = 0.5;
    mix = {
      fastball:
        wLeague * (mix.fastball ?? 0) +
        wArsenal * (ctx.pitcherArsenalMix.fastball ?? 0),
      breaking:
        wLeague * (mix.breaking ?? 0) +
        wArsenal * (ctx.pitcherArsenalMix.breaking ?? 0),
      change:
        wLeague * (mix.change ?? 0) +
        wArsenal * (ctx.pitcherArsenalMix.change ?? 0),
    };
  }

  // Handedness adjustments
  if (ctx.pitcherThrows === "R" && ctx.batterBats === "L") {
    mix.change += 0.05;
    mix.fastball -= 0.03;
    mix.breaking -= 0.02;
  }
  if (ctx.pitcherThrows === "L" && ctx.batterBats === "R") {
    mix.breaking += 0.05;
    mix.fastball -= 0.03;
    mix.change -= 0.02;
  }

  // Runners on = more breaking
  if (ctx.runnersOn.first || ctx.runnersOn.second || ctx.runnersOn.third) {
    mix.breaking += 0.03;
    mix.fastball -= 0.03;
  }

  mix = normalize(mix);

  // Blend in pitcher-specific game mix (what he's actually done this game)
  if (ctx.pitcherGameMix) {
    const wBase = 0.7; // league+arsenal
    const wGame = 0.3; // in-game usage
    mix = {
      fastball:
        wBase * (mix.fastball ?? 0) +
        wGame * (ctx.pitcherGameMix.fastball ?? 0),
      breaking:
        wBase * (mix.breaking ?? 0) +
        wGame * (ctx.pitcherGameMix.breaking ?? 0),
      change:
        wBase * (mix.change ?? 0) +
        wGame * (ctx.pitcherGameMix.change ?? 0),
    };
  }

  return normalize(mix);
}

/* -----------------------------
   REPLAY MODE
----------------------------- */
async function handleReplayMode() {
  if (!replayModeActive) {
    console.log("🎬 Pitch-by-Pitch Replay Started");
    replayModeActive = true;
    buildPitchIndexMap(lastGameData);
    simulatedOuts = 0;
    simInning = null;
    simHalf = null;
    pitchCoordCache = {};
    pitcherGameStats = {};
    batterAggressionStats = {};
  }

  if (pitchPointer >= pitchIndexMap.length) {
    console.log("🏁 All pitches replayed.");
    return;
  }

  const { playIdx, pitchIdx } = pitchIndexMap[pitchPointer];
  const play = lastGameData.liveData.plays.allPlays[playIdx];
  const pitch = play.playEvents[pitchIdx];

  const inning = play.about.inning;
  const half = play.about.halfInning;

  if (simInning !== inning || simHalf !== half) {
    simInning = inning;
    simHalf = half;
    simulatedOuts = 0;
  }

  const outsBefore = simulatedOuts;

  // Is this the last pitch of the play?
  let isLastPitch = true;
  for (let j = pitchIdx + 1; j < play.playEvents.length; j++) {
    if (play.playEvents[j].isPitch) {
      isLastPitch = false;
      break;
    }
  }

  const ctx = buildReplayPitchContext(lastGameData, playIdx, pitchIdx, outsBefore);
  const prediction = predictPitchType(ctx);

  const mph =
    pitch.pitchData?.startSpeed ??
    pitch.details?.startSpeed ??
    null;

  console.log(
    colors.bold +
      `🎯 Pitch ${pitchPointer + 1} — ` +
      (mph ? `${(mph.toFixed ? mph.toFixed(1) : mph)} mph ` : "") +
      `${pitch.details?.type?.code ?? "??"} — ${
        pitch.details?.description || "Unknown"
      }` +
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

  console.log(colors.blue + "\nASCII Strike Zone / Movement:\n" + colors.reset);
  console.log(asciiStrikeZone(ctx?.location));

  // Update context stats after using them
  updatePitcherStats(play, pitch);
  updateBatterStats(play, pitch);

  // Outs update on last pitch of play
  if (isLastPitch) {
    const outsThisPlay = outsFromPlay(play);
    simulatedOuts += outsThisPlay;
    if (simulatedOuts >= 3) {
      simulatedOuts = 0;
    }
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
  // load CSV arsenal once at startup
  loadPitcherArsenalFromCSV();

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
   API ENDPOINTS
----------------------------- */
app.get("/api/game", (req, res) => {
  res.json(lastGameData || { error: "No data yet" });
});

app.get("/api/pitch-type", (req, res) => {
  if (!lastGameData) return res.json({ error: "No data yet" });

  if (!pitchIndexMap.length) buildPitchIndexMap(lastGameData);

  const { playIdx, pitchIdx } = pitchIndexMap[pitchPointer] || {};
  if (playIdx == null || pitchIdx == null) {
    return res.json({ error: "No pitch index yet" });
  }

  const ctx = buildReplayPitchContext(
    lastGameData,
    playIdx,
    pitchIdx,
    simulatedOuts
  );
  const probs = predictPitchType(ctx);

  res.json({ context: ctx, probabilities: probs });
});

/* -----------------------------
   START SERVER
----------------------------- */
app.listen(PORT, () =>
  console.log(`🌐 Server running at http://localhost:${PORT}`)
);
