// index.js
import express from "express";
import axios from "axios";

const app = express();
const PORT = 4000;

// Pick a past game to simulate
const GAME_ID = 746087; // Phillies vs Braves example
const URL = `https://statsapi.mlb.com/api/v1.1/game/${GAME_ID}/feed/live`;

// This holds the most recent data fetched from MLB
let lastGameData = null;

// Function to fetch data from MLB API
async function fetchGameData() {
  try {
    const { data } = await axios.get(URL);
    lastGameData = data; // store it globally
    const { gameData, liveData } = data;
    const status = gameData.status.detailedState;
    const home = gameData.teams.home.name;
    const away = gameData.teams.away.name;
    const linescore = liveData?.linescore;

    console.clear();
    console.log(`${away} vs ${home} — ${status}`);
    if (linescore) {
      console.log(
        `Score: ${away} ${linescore.teams.away.runs ?? 0} - ${
          linescore.teams.home.runs ?? 0
        } ${home}`
      );
      console.log(`Inning: ${linescore.currentInning}, ${linescore.inningState}`);
    }
  } catch (error) {
    console.error("Error fetching game data:", error.message);
  }
}

// Fetch data immediately, then every 30s
fetchGameData();
setInterval(fetchGameData, 30000);

// --- Express server setup ---

// Route 1: Get the raw MLB game data
app.get("/api/game", (req, res) => {
  if (!lastGameData) {
    return res.status(500).json({ error: "No data yet — try again soon" });
  }
  res.json(lastGameData);
});

// Route 2: Simple win probability estimation
function calculateWinProb(game) {
  const linescore = game.liveData?.linescore;
  if (!linescore) return 0.5;

  const diff =
    (linescore.teams.home.runs ?? 0) - (linescore.teams.away.runs ?? 0);
  const inning = linescore.currentInning ?? 1;
  const weight = inning / 9;
  const prob = 0.5 + diff * 0.05 * weight;
  return Math.max(0, Math.min(1, prob));
}

app.get("/api/prediction", (req, res) => {
  if (!lastGameData) {
    return res.status(500).json({ error: "No data yet" });
  }
  const winProb = calculateWinProb(lastGameData);
  res.json({ winProbability: winProb });
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
