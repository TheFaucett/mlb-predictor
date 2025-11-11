// index.js
import axios from "axios";

const GAME_ID = 746087; // pick any old gamePk (Phillies vs Braves example)
const URL = `https://statsapi.mlb.com/api/v1.1/game/${GAME_ID}/feed/live`;

async function getGameData() {
  try {
    const { data } = await axios.get(URL);
    const { gameData, liveData } = data;

    const status = gameData.status.detailedState;
    const home = gameData.teams.home.name;
    const away = gameData.teams.away.name;

    const linescore = liveData.linescore;

    console.clear();
    console.log(`${away} vs ${home} — ${status}`);
    if (linescore) {
      console.log(
        `Score: ${away} ${linescore.teams.away.runs} - ${linescore.teams.home.runs} ${home}`
      );
      console.log(`Inning: ${linescore.currentInning}, ${linescore.inningState}`);
      console.log(`Outs: ${linescore.outs}, Balls: ${linescore.balls}, Strikes: ${linescore.strikes}`);
    }
  } catch (err) {
    console.error("Error fetching game data:", err.message);
  }
}

// poll every 30 seconds
setInterval(getGameData, 30000);

// run once on startup
getGameData();
