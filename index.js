/* -----------------------------
   MLB Pitch Predictor
   Best Available Coordinates
   + Enhanced Context Engine (A3)
   + Break Movement (HB / VB) Fallback
   + CSV Arsenal Baselines
   + Optimal vs Likely Pitch Model
   + Location-Aware Sequencing
   + Tier 1: Zone EV + Tunnels + Command/Fatigue
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
const GAME_ID = 746480; // 2024 Chris Sale vs SF
const URL = `https://statsapi.mlb.com/api/v1.1/game/${GAME_ID}/feed/live`;
const LIVE_POLL_RATE = 10000;
const REPLAY_RATE = 5500;

// path to your CSV
const ARSENAL_CSV_PATH = "./pitch-arsenal-stats.csv";

/* -----------------------------
   STATE
----------------------------- */
let pitchIndexMap = [];
let lastGameData = null;
let replayModeActive = false;
let pitchPointer = 0;
let lastCtx = null;

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

// Per-pitcher, per-family type usage: pitcherTypeUsageById[pitcherId] = { fastball:{FF:%,SI:%}, ... }
let pitcherTypeUsageById = {};

// batterVsPitchStats[batterId] = { fastball:{...}, breaking:{...}, change:{...} }
let batterVsPitchStats = {};

// batterVsZoneStats[batterId][zone][family] = {...}
let batterVsZoneStats = {};

// pitcherCommandStats[pitcherId] = command / fatigue info
let pitcherCommandStats = {};

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
  "0-1": { fastball: 0.55, breaking: 0.3, change: 0.15 },
  "0-2": { fastball: 0.4, breaking: 0.43, change: 0.17 },
  "1-0": { fastball: 0.7, breaking: 0.2, change: 0.1 },
  "1-1": { fastball: 0.58, breaking: 0.3, change: 0.12 },
  "1-2": { fastball: 0.42, breaking: 0.45, change: 0.13 },
  "2-0": { fastball: 0.72, breaking: 0.18, change: 0.1 },
  "2-1": { fastball: 0.6, breaking: 0.28, change: 0.12 },
  "2-2": { fastball: 0.5, breaking: 0.38, change: 0.12 },
  "3-0": { fastball: 0.85, breaking: 0.1, change: 0.05 },
  "3-1": { fastball: 0.75, breaking: 0.15, change: 0.1 },
  "3-2": { fastball: 0.7, breaking: 0.2, change: 0.1 },
};

function normalize(obj) {
  const s = Object.values(obj).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v / s]));
}

/* ==========================================================
   PITCH FAMILY MAPPING (Feed + CSV)
   - fastball / breaking / change (offspeed)
   - splitter / fork / screwball → change
   - SI for sinker, SW for sweeper, FC cutter as fastball
   - FT treated same as SI
========================================================== */

function mapPitchCodeToBucket(code) {
  if (!code) return null;
  const c = String(code).toUpperCase();

  // Normalize some codes to preferences
  const normalized = c === "FT" ? "SI" : c === "ST" ? "SW" : c;

  // Fastballs (including sinker, 2-seam, cutters)
  if (["FF", "FT", "SI", "FC", "FA"].includes(normalized)) return "fastball";

  // Split-finger fastball treated as offspeed/splitter
  if (["FS"].includes(normalized)) return "change";

  // Offspeed / change family (actual CH, splitter, fork, screwball)
  if (["CH", "SF", "FO", "SC"].includes(normalized)) return "change";

  // Breaking: sliders, curves, knuckle, sweepers, etc.
  if (["SL", "CU", "KC", "KN", "SV", "ST", "SW"].includes(normalized))
    return "breaking";

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

    const familyAgg = {}; // pitcherId → { fastball, breaking, change, total }
    const typeAgg = {}; // pitcherId → { fastball:{code:usage}, breaking:{}, change:{}, totalByFamily:{} }

    for (const row of records) {
      const idStr = row["player_id"] ?? row.player_id;
      let pitchType = row["pitch_type"] ?? row.pitch_type;
      const usageStr = row["pitch_usage"] ?? row.pitch_usage;

      const id = Number(idStr);
      if (!id || !pitchType || usageStr == null) continue;

      let rawCode = String(pitchType).toUpperCase();

      // Normalize to user prefs
      if (rawCode === "FT") rawCode = "SI";
      if (rawCode === "ST") rawCode = "SW";

      const family = mapPitchCodeToBucket(rawCode);
      if (!family) continue;

      const usage = parseFloat(String(usageStr));
      if (Number.isNaN(usage)) continue;

      if (!familyAgg[id]) {
        familyAgg[id] = { fastball: 0, breaking: 0, change: 0, total: 0 };
      }
      familyAgg[id][family] += usage;
      familyAgg[id].total += usage;

      if (!typeAgg[id]) {
        typeAgg[id] = {
          fastball: {},
          breaking: {},
          change: {},
          totalByFamily: { fastball: 0, breaking: 0, change: 0 },
        };
      }
      if (!typeAgg[id][family][rawCode]) {
        typeAgg[id][family][rawCode] = 0;
      }
      typeAgg[id][family][rawCode] += usage;
      typeAgg[id].totalByFamily[family] += usage;
    }

    pitcherArsenalById = {};
    pitcherTypeUsageById = {};

    for (const [idStr, stats] of Object.entries(familyAgg)) {
      const idNum = Number(idStr);
      if (!stats.total) continue;

      pitcherArsenalById[idNum] = normalize({
        fastball: stats.fastball,
        breaking: stats.breaking,
        change: stats.change,
      });

      const typeInfo = typeAgg[idNum];
      if (typeInfo) {
        const famTypes = {};
        for (const fam of ["fastball", "breaking", "change"]) {
          const codes = typeInfo[fam] || {};
          const totalFam = typeInfo.totalByFamily[fam] || 0;
          const normalizedCodes = {};
          for (const [code, u] of Object.entries(codes)) {
            normalizedCodes[code] = totalFam ? u / totalFam : 0;
          }
          famTypes[fam] = normalizedCodes;
        }
        pitcherTypeUsageById[idNum] = famTypes;
      }
    }

    console.log(
      `📊 Loaded pitcher arsenal CSV for ${
        Object.keys(pitcherArsenalById).length
      } pitchers from ${ARSENAL_CSV_PATH}`
    );
  } catch (err) {
    console.warn("⚠️ Could not load pitcher arsenal CSV:", err.message);
    pitcherArsenalById = {};
    pitcherTypeUsageById = {};
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
        if (
          br2 &&
          br2.breakHorizontal != null &&
          br2.breakVerticalInduced != null
        ) {
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

/* ==========================================================
   LOCATION CLASSIFICATION
   3×3 grid: High/Mid/Low × Arm/Middle/Glove
========================================================== */

function classifyLocation(px, pz, szTop, szBot) {
  if (px == null || pz == null || szTop == null || szBot == null) {
    return null;
  }

  const horizontal =
    px > 0.5 ? "ARM" : px < -0.5 ? "GLOVE" : "MIDDLE";

  const zoneHeight = szTop - szBot;
  const highThresh = szTop - zoneHeight / 3;
  const lowThresh = szBot + zoneHeight / 3;

  let height;
  if (pz >= highThresh) height = "HIGH";
  else if (pz <= lowThresh) height = "LOW";
  else height = "MID";

  return `${height}_${horizontal}`; // e.g. "LOW_GLOVE"
}

function prettyLocationLabel(zone) {
  if (!zone) return null;
  switch (zone) {
    case "HIGH_ARM":
      return "Up & in";
    case "HIGH_MIDDLE":
      return "Up";
    case "HIGH_GLOVE":
      return "Up & away";
    case "MID_ARM":
      return "In";
    case "MID_MIDDLE":
      return "Middle";
    case "MID_GLOVE":
      return "Away";
    case "LOW_ARM":
      return "Down & in";
    case "LOW_MIDDLE":
      return "Down";
    case "LOW_GLOVE":
      return "Down & away";
    default:
      return zone;
  }
}

/* ==========================================================
   TUNNEL DETECTION
========================================================== */

const TUNNEL_HORIZONTAL_THRESHOLD = 0.3; // px similarity for tunnel start
const TUNNEL_VERTICAL_THRESHOLD = 0.3; // pz similarity early
const TUNNEL_BREAK_DIFF_THRESHOLD = 3.0; // inches difference for late break tunnel

function detectTunnel(prevCtx, currCtx) {
  if (!prevCtx || !currCtx) return null;
  if (!prevCtx.location || !currCtx.location) return null;

  const A = prevCtx.location;
  const B = currCtx.location;

  // Must have some form of trajectory / movement
  if (!A.hasLocation && !A.isBreakData) return null;
  if (!B.hasLocation && !B.isBreakData) return null;

  // --- EARLY TRAJECTORY SIMILARITY ---
  const pxA = A.px ?? 0;
  const pxB = B.px ?? 0;
  const pzA = A.pz ?? 0;
  const pzB = B.pz ?? 0;

  const pxDiff = Math.abs(pxA - pxB);
  const pzDiff = Math.abs(pzA - pzB);

  const earlyAligned =
    pxDiff < TUNNEL_HORIZONTAL_THRESHOLD &&
    pzDiff < TUNNEL_VERTICAL_THRESHOLD;

  if (!earlyAligned) return null;

  // --- LATE FLIGHT DIVERGENCE ---
  const hbDiff = Math.abs((A.hb ?? 0) - (B.hb ?? 0));
  const vbDiff = Math.abs((A.vb ?? 0) - (B.vb ?? 0));

  const totalBreakDiff = hbDiff + vbDiff;
  if (totalBreakDiff < TUNNEL_BREAK_DIFF_THRESHOLD) return null;

  // Label the tunnel pattern
  const prevType = prevCtx.lastPitchType;
  const currType = currCtx.lastPitchType;

  let label = "Pitch Tunnel Detected";

  if (prevType && currType) {
    const p = prevType.toUpperCase();
    const c = currType.toUpperCase();

    if ((p === "FF" || p === "SI") && (c === "SL" || c === "SW"))
      label = "Fastball → Slider Tunnel";
    else if ((p === "FF" || p === "SI") && c === "CH")
      label = "Fastball → Change Fade Tunnel";
    else if (p === "SL" && c === "CU")
      label = "Slider → Curveball Break Stack";
    else label = `${prevType} → ${currType} Tunnel`;
  }

  return {
    pxDiff,
    pzDiff,
    hbDiff,
    vbDiff,
    totalBreakDiff,
    label,
  };
}

/* ==========================================================
   ZONE EV MODEL (batter vs zone × family)
========================================================== */

function ensureBatterZoneFamily(batterId, zone, family) {
  if (!batterVsZoneStats[batterId]) batterVsZoneStats[batterId] = {};
  if (!batterVsZoneStats[batterId][zone]) batterVsZoneStats[batterId][zone] = {};
  if (!batterVsZoneStats[batterId][zone][family]) {
    batterVsZoneStats[batterId][zone][family] = {
      seen: 0,
      swings: 0,
      whiffs: 0,
      inPlay: 0,
      hits: 0,
      hardHit: 0,
    };
  }
}

function getBatterZoneEV(batterId, zone, family) {
  const z = batterVsZoneStats[batterId]?.[zone]?.[family];
  if (!z || z.seen < 3) return null; // need a few data points

  const whiffRate = z.swings > 0 ? z.whiffs / z.swings : 0;
  const hitRate = z.inPlay > 0 ? z.hits / z.inPlay : 0;
  const hhRate = z.inPlay > 0 ? z.hardHit / z.inPlay : 0;

  return 0.6 * whiffRate + 0.25 * (1 - hitRate) + 0.15 * (1 - hhRate);
}

/* ==========================================================
   COMMAND / FATIGUE MODEL
========================================================== */

function updatePitcherCommand(play, pitch, location) {
  const pid = play.matchup.pitcher.id;
  if (!pitcherCommandStats[pid]) {
    pitcherCommandStats[pid] = {
      pitches: 0,
      missesHigh: 0,
      missesLow: 0,
      missesArm: 0,
      missesGlove: 0,
      velos: [],
    };
  }
  const cs = pitcherCommandStats[pid];

  const v = pitch.pitchData?.startSpeed ?? pitch.details?.startSpeed ?? null;
  if (typeof v === "number") {
    cs.velos.push(v);
    if (cs.velos.length > 8) cs.velos.shift();
  }

  if (location && location.hasLocation) {
    const { px, pz, szTop, szBot } = location;
    const margin = 0.1;
    if (pz > szTop + margin) cs.missesHigh++;
    if (pz < szBot - margin) cs.missesLow++;
    if (px > 1.7) cs.missesArm++;
    if (px < -1.7) cs.missesGlove++;
  }

  cs.pitches++;
}

function getPitcherWildness(pid) {
  const cs = pitcherCommandStats[pid];
  if (!cs || cs.pitches < 10) return 0;
  const misses =
    cs.missesHigh + cs.missesLow + cs.missesArm + cs.missesGlove;
  return misses / cs.pitches; // 0..1-ish
}

function getPitcherVeloTrend(pid) {
  const cs = pitcherCommandStats[pid];
  if (!cs || cs.velos.length < 4) return 0;

  const n = cs.velos.length;
  const recentAvg = (cs.velos[n - 1] + cs.velos[n - 2]) / 2;
  const earlyAvg = (cs.velos[0] + cs.velos[1]) / 2;

  return recentAvg - earlyAvg; // negative = lost velo
}

/* ==========================================================
   SEQUENCING INFLUENCE MATRIX (SIM v1.0)
   Applies MLB-like pitch sequencing biases
========================================================== */

function applySequencingAdjustments(mix, ctx) {
  if (!ctx) return mix;

  const last = ctx.lastPitchType ? mapPitchCodeToBucket(ctx.lastPitchType) : null;
  const desc = (ctx.lastPitchDescription || "").toLowerCase();

  const balls = ctx.balls ?? 0;
  const strikes = ctx.strikes ?? 0;

  let m = { ...mix };

  /* -----------------------------
     1. COUNT-BASED SEQUENCING
  ----------------------------- */

  // Way ahead (0–2, 1–2): more chase breaking
  if ((balls === 0 && strikes === 2) || (balls === 1 && strikes === 2)) {
    m.breaking += 0.12;
    m.change += 0.05;
    m.fastball -= 0.1;
  }

  // Behind (2–0, 3–1): establish heater
  if ((balls === 2 && strikes === 0) || (balls === 3 && strikes === 1)) {
    m.fastball += 0.1;
    m.breaking -= 0.06;
    m.change -= 0.04;
  }

  // Full count: rely on comfort pitches
  if (balls === 3 && strikes === 2 && ctx.pitcherArsenalMix) {
    m.fastball += ctx.pitcherArsenalMix.fastball * 0.1;
    m.breaking += ctx.pitcherArsenalMix.breaking * 0.05;
    m.change += ctx.pitcherArsenalMix.change * 0.05;
  }

  /* -----------------------------
     2. LAST-PITCH SEQUENCES
  ----------------------------- */

  if (last === "fastball") {
    // Fastball → breaker is most common MLB tunnel sequence
    m.breaking += 0.06;
    m.change += 0.02;
    m.fastball -= 0.06;
  }

  if (last === "breaking") {
    // After a slider/curve, go high fastball or CH
    m.fastball += 0.04;
    m.change += 0.03;
    m.breaking -= 0.04;
  }

  if (last === "change") {
    // After CH, MLB goes breaking or fastball
    m.breaking += 0.04;
    m.fastball += 0.02;
    m.change -= 0.06;
  }

  /* -----------------------------
     3. SWING RESULT SEQUENCING
  ----------------------------- */

  if (desc.includes("swinging strike") && !desc.includes("foul")) {
    // Whiff → repeat pitch family
    if (last === "fastball") m.fastball += 0.1;
    if (last === "breaking") m.breaking += 0.1;
    if (last === "change") m.change += 0.1;
  }

  if (desc.includes("foul")) {
    // MLB usually changes speed/plane
    if (last === "fastball") {
      m.breaking += 0.05;
      m.change += 0.03;
    } else {
      m.fastball += 0.07;
    }
  }

  if (desc.includes("ball")) {
    // Lost command → go back to strike-getter
    m.fastball += 0.06;
    m.breaking -= 0.03;
    m.change -= 0.03;
  }

  if (desc.includes("called strike")) {
    // Many pitchers go breaking low next
    m.breaking += 0.04;
  }

  /* -----------------------------
     4. Two-pitch pattern logic
  ----------------------------- */

  const seq = ctx.lastTwoPitchTypes
    ? ctx.lastTwoPitchTypes.map(mapPitchCodeToBucket)
    : [];

  if (seq.length === 2 && seq[0] === seq[1]) {
    const repeated = seq[0];
    if (repeated === "fastball") m.breaking += 0.1;
    if (repeated === "breaking") m.fastball += 0.08;
    if (repeated === "change") m.breaking += 0.07;
  }

  /* -----------------------------
     5. Tunnel influence
  ----------------------------- */

  if (ctx.tunnelInfo) {
    // Reward continuing FB→SL or FB→CH tunnel pattern
    if (last === "fastball") {
      m.breaking += 0.05;
      m.change += 0.03;
    }
  }

  /* -----------------------------
     6. Command / fatigue influence
  ----------------------------- */

  const wildness = getPitcherWildness(ctx.pitcherId);
  if (wildness > 0.3) {
    // Getting wild: simplify to fastball / CH
    m.fastball += 0.08;
    m.breaking -= 0.05;
    m.change -= 0.03;
  }

  const veloTrend = getPitcherVeloTrend(ctx.pitcherId);
  if (veloTrend < -1.0) {
    // Velo fading: less FB, more soft stuff
    m.fastball -= 0.04;
    m.change += 0.03;
    m.breaking += 0.01;
  }

  return normalize(m);
}

/* ==========================================================
   LOCATION-AWARE SEQUENCING
========================================================== */

function applyLocationSequencing(mix, ctx) {
  if (!ctx) return mix;
  const zone = ctx.lastPitchLocationZone;
  const last = ctx.lastPitchType ? mapPitchCodeToBucket(ctx.lastPitchType) : null;

  if (!zone || !last) return mix;

  let m = { ...mix };

  // Classic high FF → breaking/offspeed down
  if (last === "fastball" && zone.startsWith("HIGH")) {
    m.breaking += 0.08;
    m.change += 0.04;
    m.fastball -= 0.08;
  }

  // Low glove-side slider → high fastball tunnel
  if (last === "breaking" && zone === "LOW_GLOVE") {
    m.fastball += 0.1;
    m.breaking -= 0.05;
  }

  // Changeup low arm-side → slider/glove next
  if (last === "change" && zone === "LOW_ARM") {
    m.breaking += 0.08;
    m.fastball += 0.02;
    m.change -= 0.06;
  }

  // Down the middle heater → anything but another cookie
  if (last === "fastball" && zone === "MID_MIDDLE") {
    m.breaking += 0.08;
    m.change += 0.04;
    m.fastball -= 0.1;
  }

  return normalize(m);
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
  const xPos = Math.floor(((xNorm + 1.5) / 3) * (GRID - 1));

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

const CODE_LABELS = {
  FF: "Four-Seam Fastball",
  FA: "Four-Seam Fastball",
  SI: "Sinker",
  FT: "Sinker",
  FC: "Cutter",
  SL: "Slider",
  CU: "Curveball",
  KC: "Knuckle Curve",
  KN: "Knuckleball",
  SW: "Sweeper",
  SV: "Sweeper",
  CH: "Changeup",
  SF: "Splitter",
  FS: "Splitter",
  FO: "Forkball",
  SC: "Screwball",
};

function getPitchLabel(code) {
  const c = String(code || "").toUpperCase();
  return CODE_LABELS[c] || c || "Unknown Pitch";
}

function pickSpecificPitchCode(family, pitcherId) {
  const famUsage = pitcherTypeUsageById[pitcherId]?.[family];

  if (famUsage && Object.keys(famUsage).length > 0) {
    let bestCode = null;
    let bestVal = -1;
    for (const [code, val] of Object.entries(famUsage)) {
      if (val > bestVal) {
        bestVal = val;
        bestCode = code;
      }
    }
    if (bestCode) return bestCode;
  }

  // Fallbacks if CSV doesn't have detail
  if (family === "fastball") return "FF";
  if (family === "breaking") return "SL";
  if (family === "change") return "CH";
  return "FF";
}

function getLikelySpecificPitch(mix, ctx) {
  if (!mix) return null;

  // pick best family
  let bestFam = "fastball";
  let bestVal = mix.fastball ?? 0;
  for (const fam of ["fastball", "breaking", "change"]) {
    if ((mix[fam] ?? 0) > bestVal) {
      bestVal = mix[fam];
      bestFam = fam;
    }
  }

  const code = pickSpecificPitchCode(bestFam, ctx?.pitcherId);
  const label = getPitchLabel(code);

  const famUsage = pitcherTypeUsageById[ctx?.pitcherId]?.[bestFam];
  let typeShare = 1.0;
  if (famUsage && Object.keys(famUsage).length > 0) {
    const share = famUsage[code];
    if (typeof share === "number" && share > 0) {
      typeShare = share;
    }
  }
  const prob = (mix[bestFam] ?? 0) * typeShare;

  return {
    family: bestFam,
    code,
    label,
    probability: prob,
  };
}

function getOptimalSpecificPitch(opt, ctx) {
  if (!opt || !opt.mix) return null;
  const bestFam = opt.best || "fastball";
  const code = pickSpecificPitchCode(bestFam, ctx?.pitcherId);
  const label = getPitchLabel(code);

  const famUsage = pitcherTypeUsageById[ctx?.pitcherId]?.[bestFam];
  let typeShare = 1.0;
  if (famUsage && Object.keys(famUsage).length > 0) {
    const share = famUsage[code];
    if (typeof share === "number" && share > 0) {
      typeShare = share;
    }
  }
  const prob = (opt.mix[bestFam] ?? 0) * typeShare;

  return {
    family: bestFam,
    code,
    label,
    probability: prob,
  };
}

function prettyPrediction(pred, ctx) {
  const spec = getLikelySpecificPitch(pred, ctx);

  const lines = [
    `${coloredPitch(
      "fastball",
      `Fastball: ${(pred.fastball * 100).toFixed(0)}%`
    )}`,
    `${coloredPitch(
      "breaking",
      `Breaking: ${(pred.breaking * 100).toFixed(0)}%`
    )}`,
    `${coloredPitch(
      "change",
      `Offspeed: ${(pred.change * 100).toFixed(0)}%`
    )}`,
  ];

  let extra = "";
  if (spec) {
    extra = `\n        Most likely pitch: ${spec.label} (${spec.code}, ~${(
      spec.probability * 100
    ).toFixed(0)}%)`;
  }

  return `
        ${lines.join("\n        ")}${extra}
  `;
}

function prettyOptimal(opt, ctx) {
  const mix = opt.mix;
  const best = opt.best;
  const labelFamily =
    best === "fastball"
      ? "Fastball"
      : best === "breaking"
      ? "Breaking"
      : "Offspeed";

  const spec = getOptimalSpecificPitch(opt, ctx);

  let extra = "";
  if (spec) {
    extra = `\n        Recommended pitch: ${spec.label} (${spec.code}, ~${(
      spec.probability * 100
    ).toFixed(0)}%)`;
  }

  return `
        Recommended family: ${labelFamily} (${(mix[best] * 100).toFixed(0)}%)
        Full optimal mix:
        Fastball: ${(mix.fastball * 100).toFixed(0)}%
        Breaking: ${(mix.breaking * 100).toFixed(0)}%
        Offspeed: ${(mix.change * 100).toFixed(0)}%${extra}
  `;
}

function prettyContext(ctx) {
  const pitcherMix = ctx.pitcherGameMix;
  const ba = ctx.batterAggression;
  const arsenal = ctx.pitcherArsenalMix;
  const bvp = ctx.batterVsPitch;

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

  const weakStr = bvp?.topWeakFamily
    ? `   Batter weakness this game: ${bvp.topWeakFamily}`
    : "   Batter weakness this game: (n/a yet)";

  const locStr = ctx.lastPitchLocationLabel
    ? `   Last pitch loc: ${ctx.lastPitchLocationLabel}`
    : "   Last pitch loc: (n/a)";

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
${weakStr}
${locStr}
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
    lastCtx = null;
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

/* ==========================================================
   BATTER vs PITCH FAMILY WEAKNESS MODEL
========================================================== */

function ensureBatterFamily(batterId, family) {
  if (!batterVsPitchStats[batterId]) {
    batterVsPitchStats[batterId] = {
      fastball: {
        seen: 0,
        swings: 0,
        whiffs: 0,
        inPlay: 0,
        hits: 0,
        hardHit: 0,
      },
      breaking: {
        seen: 0,
        swings: 0,
        whiffs: 0,
        inPlay: 0,
        hits: 0,
        hardHit: 0,
      },
      change: {
        seen: 0,
        swings: 0,
        whiffs: 0,
        inPlay: 0,
        hits: 0,
        hardHit: 0,
      },
    };
  }
  if (!batterVsPitchStats[batterId][family]) {
    batterVsPitchStats[batterId][family] = {
      seen: 0,
      swings: 0,
      whiffs: 0,
      inPlay: 0,
      hits: 0,
      hardHit: 0,
    };
  }
}

function updateBatterVsPitchStats(
  play,
  pitch,
  bucket,
  isLastPitch,
  zoneForThisPitch
) {
  if (!bucket) return;

  const batterId = play.matchup.batter.id;
  ensureBatterFamily(batterId, bucket);
  const stats = batterVsPitchStats[batterId][bucket];

  stats.seen += 1;

  const desc = (pitch.details?.description || "").toLowerCase();
  const swung = isSwing(pitch);
  if (swung) stats.swings += 1;

  const swingingStrike =
    swung &&
    desc.includes("swinging") &&
    !desc.includes("foul") &&
    !desc.includes("in play");
  if (swingingStrike) stats.whiffs += 1;

  const inPlay = pitch.details?.isInPlay || desc.includes("in play");
  if (inPlay) stats.inPlay += 1;

  // Hit / hard-hit only on last pitch of the PA
  let isHit = false;
  let hardHit = false;

  if (isLastPitch) {
    const eventType = (play.result?.eventType || "").toLowerCase();
    isHit =
      eventType.includes("single") ||
      eventType.includes("double") ||
      eventType.includes("triple") ||
      eventType.includes("home_run") ||
      eventType.includes("home run");

    if (isHit) {
      stats.hits += 1;
    }

    const ls = pitch.hitData?.launchSpeed;
    if (typeof ls === "number" && ls >= 95) {
      stats.hardHit += 1;
      hardHit = true;
    }
  }

  // Zone EV tracking (batter vs zone × family)
  if (zoneForThisPitch) {
    ensureBatterZoneFamily(batterId, zoneForThisPitch, bucket);
    const Z = batterVsZoneStats[batterId][zoneForThisPitch][bucket];

    Z.seen += 1;
    if (swung) Z.swings += 1;
    if (swingingStrike) Z.whiffs += 1;
    if (inPlay) Z.inPlay += 1;
    if (isHit) Z.hits += 1;
    if (hardHit) Z.hardHit += 1;
  }
}

function getBatterVsPitchProfile(batterId) {
  const raw = batterVsPitchStats[batterId];
  if (!raw) return null;

  const families = ["fastball", "breaking", "change"];
  const vuln = {};
  let topWeakFamily = null;
  let bestScore = -Infinity;

  for (const fam of families) {
    const s = raw[fam] || {
      seen: 0,
      swings: 0,
      whiffs: 0,
      inPlay: 0,
      hits: 0,
      hardHit: 0,
    };
    const seen = s.seen || 0;
    const swings = s.swings || 0;
    const whiffs = s.whiffs || 0;
    const inPlay = s.inPlay || 0;
    const hits = s.hits || 0;
    const hardHit = s.hardHit || 0;

    const whiffRate = swings > 0 ? whiffs / swings : 0;
    const hitRate = inPlay > 0 ? hits / inPlay : 0;
    const hardHitRate = inPlay > 0 ? hardHit / inPlay : 0;

    // Higher score = batter worse vs that family
    const score =
      0.6 * whiffRate + 0.25 * (1 - hitRate) + 0.15 * (1 - hardHitRate);

    vuln[fam] = score;

    if (seen >= 3 && score > bestScore) {
      bestScore = score;
      topWeakFamily = fam;
    }

    // attach the derived rates back on raw[fam]
    s.whiffRate = whiffRate;
    s.hitRate = hitRate;
    s.hardHitRate = hardHitRate;
  }

  return {
    ...raw,
    vuln,
    topWeakFamily,
  };
}

/* ==========================================================
   OPTIMAL PITCH (WHAT HE SHOULD THROW)
========================================================== */

function getCountFactor(family, balls, strikes) {
  const count = `${balls}-${strikes}`;

  // Way ahead in count: favor chase stuff
  if (strikes >= 2 && balls <= 1) {
    if (family === "breaking") return 1.25;
    if (family === "change") return 1.15;
    return 0.8; // fastball
  }

  // Behind in count: more likely to need a strike
  if (balls >= 2 && strikes <= 1) {
    if (family === "fastball") return 1.2;
    if (family === "breaking") return 0.9;
    if (family === "change") return 0.9;
  }

  // Full count nuance
  if (count === "3-2") {
    if (family === "fastball") return 1.05;
    if (family === "breaking") return 0.95;
    if (family === "change") return 1.0;
  }

  return 1.0;
}

function recommendOptimalPitch(ctx) {
  // Baseline from arsenal (what he actually throws)
  let base =
    ctx.pitcherArsenalMix ||
    leaguePitchMixByCount[`${ctx.balls}-${ctx.strikes}`] || {
      fastball: 0.6,
      breaking: 0.25,
      change: 0.15,
    };
  base = normalize(base);

  const vuln = ctx.batterVsPitch?.vuln || null;

  const families = ["fastball", "breaking", "change"];
  const scores = {};

  for (const fam of families) {
    let score = base[fam] ?? 1 / 3;

    // If we have batter vulnerability by family, blend it in
    if (vuln && typeof vuln[fam] === "number") {
      score = 0.4 * score + 0.6 * vuln[fam];
    }

    // Count leverage adjustment
    const cf = getCountFactor(fam, ctx.balls, ctx.strikes);
    score *= cf;

    // Zone EV adjustment: how does this batter handle this family in this zone?
    const zone = ctx.lastPitchLocationZone;
    if (zone && ctx.batterId) {
      const zoneEV = getBatterZoneEV(ctx.batterId, zone, fam);
      if (zoneEV != null) {
        // 50/50 blend with EV
        score = 0.5 * score + 0.5 * zoneEV;
      }
    }

    scores[fam] = score;
  }

  const mix = normalize(scores);

  // pick best
  let best = "fastball";
  let bestVal = mix.fastball;
  for (const fam of families) {
    if (mix[fam] > bestVal) {
      bestVal = mix[fam];
      best = fam;
    }
  }

  return { mix, best };
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
    const batterVsPitch = getBatterVsPitchProfile(batterId);

    // Location → zone + label
    let zone = null;
    let zoneLabel = null;
    if (location && location.hasLocation && location.px != null && location.pz != null) {
      zone = classifyLocation(
        location.px,
        location.pz,
        location.szTop,
        location.szBot
      );
      zoneLabel = prettyLocationLabel(zone);
    }

    // previous context for tunneling
    const prev = lastCtx;

    const tempCtx = {
      lastPitchType: pitch.details?.type?.code ?? null,
      location,
    };

    const tunnelInfo = detectTunnel(prev, tempCtx);

    // Save this context for next pitch
    lastCtx = tempCtx;

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
      lastPitchDescription: pitch.details?.description ?? "",
      lastTwoPitchTypes: pitchSequence.slice(-2),

      lastPitchLocationZone: zone,
      lastPitchLocationLabel: zoneLabel,

      pitcherThrows: play.matchup.pitchHand?.code ?? "R",
      batterBats: play.matchup.batSide?.code ?? "R",

      location,
      pitcherGameMix,
      batterAggression,
      pitcherArsenalMix,
      batterVsPitch,

      pitcherId,
      batterId,

      tunnelInfo,
    };
  } catch {
    return null;
  }
}

/* -----------------------------
   Predict Next Pitch (LIKELY)
   League baseline + CSV arsenal + game mix + sequencing
----------------------------- */
function predictPitchType(ctx) {
  if (!ctx) return { fastball: 0.33, breaking: 0.33, change: 0.34 };

  const key = `${ctx.balls}-${ctx.strikes}`;

  /* ------------------------------------------------------
     1) League Baseline by Count
  ------------------------------------------------------ */
  let mix = {
    ...(leaguePitchMixByCount[key] || {
      fastball: 0.60,
      breaking: 0.25,
      change: 0.15,
    }),
  };

  /* ------------------------------------------------------
     2) Blend with Pitcher CSV Arsenal Baseline
        (50% league + 50% personal tendencies)
  ------------------------------------------------------ */
  if (ctx.pitcherArsenalMix) {
    const wL = 0.5;
    const wA = 0.5;

    mix = {
      fastball:
        wL * mix.fastball + wA * ctx.pitcherArsenalMix.fastball,
      breaking:
        wL * mix.breaking + wA * ctx.pitcherArsenalMix.breaking,
      change:
        wL * mix.change + wA * ctx.pitcherArsenalMix.change,
    };
  }

  /* ------------------------------------------------------
     3) Handedness Effects
  ------------------------------------------------------ */
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

  /* ------------------------------------------------------
     4) Runners On (slight increase toward breaking)
  ------------------------------------------------------ */
  if (ctx.runnersOn.first || ctx.runnersOn.second || ctx.runnersOn.third) {
    mix.breaking += 0.03;
    mix.fastball -= 0.03;
  }

  /* Normalize before sequencing transforms */
  mix = normalize(mix);

  /* ------------------------------------------------------
     5) Sequencing-Based Adjustments
  ------------------------------------------------------ */
  mix = applySequencingAdjustments(mix, ctx);

  /* ------------------------------------------------------
     6) Location-Aware Sequencing (NEW)
  ------------------------------------------------------ */
  mix = applyLocationSequencing(mix, ctx);

  /* Normalize again */
  mix = normalize(mix);

  /* ------------------------------------------------------
     7) Batter Weakness Awareness (NEW)
        Pitcher knows hitter holes:
        multiplier = 1 + vulnerability * strength
  ------------------------------------------------------ */
  if (ctx.batterVsPitch?.vuln) {
    const v = ctx.batterVsPitch.vuln;

    mix.fastball *= (1 + v.fastball * 0.35);
    mix.breaking *= (1 + v.breaking * 0.35);
    mix.change   *= (1 + v.change   * 0.35);
  }

  /* ------------------------------------------------------
     8) Tunnel Continuation Bias (NEW)
        If last pitch tunneled, MLB pitchers often repeat
        or complement that pitch
  ------------------------------------------------------ */
  if (ctx.tunnelInfo) {
    const last = ctx.lastPitchType ? mapPitchCodeToBucket(ctx.lastPitchType) : null;

    if (last === "fastball") {
      // FB→SL tunnel: raise breaking likelihood
      mix.breaking += 0.05;
    }
    if (last === "breaking") {
      // SL→FF tunnel: raise fastball likelihood
      mix.fastball += 0.05;
    }
    if (last === "change") {
      // CH tunnels often repeat or go SL
      mix.change += 0.04;
      mix.breaking += 0.02;
    }
  }

  /* ------------------------------------------------------
     9) Blend In Pitcher In-Game Mix (What He's Done Today)
        Weighted lightly — small but real influence
  ------------------------------------------------------ */
  if (ctx.pitcherGameMix) {
    const wBase = 0.8;
    const wGame = 0.2;

    mix = {
      fastball:
        wBase * mix.fastball + wGame * ctx.pitcherGameMix.fastball,
      breaking:
        wBase * mix.breaking + wGame * ctx.pitcherGameMix.breaking,
      change:
        wBase * mix.change + wGame * ctx.pitcherGameMix.change,
    };
  }

  /* Final normalize */
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
    batterVsPitchStats = {};
    batterVsZoneStats = {};
    pitcherCommandStats = {};
    pitchSequence = [];
    lastCtx = null;
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

  const code = pitch.details?.type?.code ?? null;
  let seqNote = null;
  if (code) {
    seqNote = analyzeSequence(code);
  }

  const ctx = buildReplayPitchContext(
    lastGameData,
    playIdx,
    pitchIdx,
    outsBefore
  );
  const likelyMix = predictPitchType(ctx);
  const optimal = recommendOptimalPitch(ctx);

  const mph =
    pitch.pitchData?.startSpeed ?? pitch.details?.startSpeed ?? null;

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

  if (seqNote) console.log(colors.yellow + seqNote + colors.reset);

  if (ctx) console.log(prettyContext(ctx));

  console.log(
    colors.green + "   ➤ Expected Next Pitch (Likely):" + colors.reset
  );
  console.log(prettyPrediction(likelyMix, ctx));

  console.log(
    colors.magenta + "   ➤ Recommended Pitch (Optimal):" + colors.reset
  );
  console.log(prettyOptimal(optimal, ctx));

  console.log(
    colors.blue + "\nASCII Strike Zone / Movement:\n" + colors.reset
  );
  console.log(asciiStrikeZone(ctx?.location));

  if (ctx?.tunnelInfo) {
    console.log(
      colors.magenta +
        `🔥 Tunnel Detected: ${ctx.tunnelInfo.label} (ΔBreak: ${ctx.tunnelInfo.totalBreakDiff.toFixed(
          1
        )}")` +
        colors.reset
    );
  }

  // Update context stats AFTER using them (info available at “decision time”)
  const bucket = mapPitchCodeToBucket(code);

  updatePitcherStats(play, pitch);
  updateBatterStats(play, pitch);

  // update command/fatigue model
  updatePitcherCommand(play, pitch, ctx?.location);

  // zone for this pitch (for batter vs zone EV)
  let zoneForThisPitch = null;
  if (ctx?.location && ctx.location.hasLocation) {
    const loc = ctx.location;
    zoneForThisPitch = classifyLocation(
      loc.px,
      loc.pz,
      loc.szTop,
      loc.szBot
    );
  }

  updateBatterVsPitchStats(
    play,
    pitch,
    bucket,
    isLastPitch,
    zoneForThisPitch
  );

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
  const likely = predictPitchType(ctx);
  const optimal = recommendOptimalPitch(ctx);

  const likelySpecific = getLikelySpecificPitch(likely, ctx);
  const optimalSpecific = getOptimalSpecificPitch(optimal, ctx);

  res.json({
    context: ctx,
    likely,
    likelySpecific,
    optimal,
    optimalSpecific,
  });
});

app.get("/api/arsenal/:pid", (req, res) => {
  const pid = Number(req.params.pid);

  if (!pitcherArsenalById || Object.keys(pitcherArsenalById).length === 0) {
    return res.json({
      error: "Pitcher arsenal CSV not loaded or parsed yet.",
    });
  }

  const data = pitcherArsenalById[pid];

  if (!data) {
    return res.json({
      error: `No arsenal data found for player_id ${pid}`,
      tip: "Check if your CSV includes this pitcher_id.",
    });
  }

  res.json({
    player_id: pid,
    arsenal: {
      fastball: data.fastball,
      breaking: data.breaking,
      offspeed: data.change,
    },
    types: pitcherTypeUsageById[pid] || null,
  });
});

/* -----------------------------
   START SERVER
----------------------------- */
app.listen(PORT, () =>
  console.log(`🌐 Server running at http://localhost:${PORT}`)
);

