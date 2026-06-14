// ============================================================
// 终极井字棋 - 后端服务器
// 功能：用户管理、进化数据存储、PK对战、排行榜
// ============================================================
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- 中间件 ----------
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- 数据库初始化 ----------
const dbPath = path.join(__dirname, "data", "ultimate-ttt.db");
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// 创建表
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    password TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS evolution_data (
    user_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    version INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS pk_matches (
    id TEXT PRIMARY KEY,
    player1_id TEXT NOT NULL,
    player2_id TEXT NOT NULL,
    winner TEXT,
    moves TEXT,
    played_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (player1_id) REFERENCES users(id),
    FOREIGN KEY (player2_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS leaderboard (
    user_id TEXT PRIMARY KEY,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    draws INTEGER DEFAULT 0,
    total_games INTEGER DEFAULT 0,
    elo_rating INTEGER DEFAULT 1000,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ---------- 工具函数 ----------
function getOrCreateLeaderboard(userId) {
  const existing = db.prepare("SELECT * FROM leaderboard WHERE user_id = ?").get(userId);
  if (!existing) {
    db.prepare("INSERT INTO leaderboard (user_id) VALUES (?)").run(userId);
    return { user_id: userId, wins: 0, losses: 0, draws: 0, total_games: 0, elo_rating: 1000 };
  }
  return existing;
}

function updateElo(winnerId, loserId) {
  const winner = getOrCreateLeaderboard(winnerId);
  const loser = getOrCreateLeaderboard(loserId);
  const expectedWinner = 1 / (1 + Math.pow(10, (loser.elo_rating - winner.elo_rating) / 400));
  const expectedLoser = 1 - expectedWinner;
  const K = 32;
  winner.elo_rating = Math.round(winner.elo_rating + K * (1 - expectedWinner));
  loser.elo_rating = Math.round(loser.elo_rating + K * (0 - expectedLoser));
  db.prepare("UPDATE leaderboard SET elo_rating = ?, wins = wins + 1, total_games = total_games + 1 WHERE user_id = ?").run(winner.elo_rating, winnerId);
  db.prepare("UPDATE leaderboard SET elo_rating = ?, losses = losses + 1, total_games = total_games + 1 WHERE user_id = ?").run(loser.elo_rating, loserId);
}

// ---------- API 路由 ----------

// 注册 / 登录
app.post("/api/register", (req, res) => {
  const { name, password } = req.body;
  if (!name) return res.status(400).json({ error: "用户名不能为空" });
  const existing = db.prepare("SELECT * FROM users WHERE name = ?").get(name);
  if (existing) return res.status(409).json({ error: "用户名已存在" });
  const id = uuidv4();
  db.prepare("INSERT INTO users (id, name, password) VALUES (?, ?, ?)").run(id, name, password || "");
  getOrCreateLeaderboard(id);
  res.json({ id, name });
});

app.post("/api/login", (req, res) => {
  const { name, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE name = ?").get(name);
  if (!user) return res.status(404).json({ error: "用户不存在" });
  if (user.password && user.password !== password) return res.status(403).json({ error: "密码错误" });
  res.json({ id: user.id, name: user.name });
});

// 保存进化数据
app.post("/api/evolution/save", (req, res) => {
  const { userId, data } = req.body;
  if (!userId || !data) return res.status(400).json({ error: "参数不完整" });
  const existing = db.prepare("SELECT * FROM evolution_data WHERE user_id = ?").get(userId);
  if (existing) {
    db.prepare("UPDATE evolution_data SET data = ?, version = version + 1, updated_at = datetime('now') WHERE user_id = ?").run(JSON.stringify(data), userId);
  } else {
    db.prepare("INSERT INTO evolution_data (user_id, data) VALUES (?, ?)").run(userId, JSON.stringify(data));
  }
  res.json({ success: true });
});

// 加载进化数据
app.get("/api/evolution/load/:userId", (req, res) => {
  const { userId } = req.params;
  const record = db.prepare("SELECT * FROM evolution_data WHERE user_id = ?").get(userId);
  if (!record) return res.status(404).json({ error: "无进化数据" });
  res.json({ data: JSON.parse(record.data), version: record.version, updatedAt: record.updated_at });
});

// 获取玩家列表
app.get("/api/players", (req, res) => {
  const players = db.prepare("SELECT u.id, u.name, l.wins, l.losses, l.draws, l.total_games, l.elo_rating FROM users u LEFT JOIN leaderboard l ON u.id = l.user_id ORDER BY l.elo_rating DESC").all();
  res.json(players);
});

// 排行榜
app.get("/api/leaderboard", (req, res) => {
  const board = db.prepare("SELECT u.name, l.wins, l.losses, l.draws, l.total_games, l.elo_rating FROM leaderboard l JOIN users u ON l.user_id = u.id ORDER BY l.elo_rating DESC LIMIT 50").all();
  res.json(board);
});

// PK 对战
app.post("/api/pk/result", (req, res) => {
  const { player1Id, player2Id, winner, moves } = req.body;
  if (!player1Id || !player2Id || !winner) return res.status(400).json({ error: "参数不完整" });
  const id = uuidv4();
  db.prepare("INSERT INTO pk_matches (id, player1_id, player2_id, winner, moves) VALUES (?, ?, ?, ?, ?)").run(id, player1Id, player2Id, winner, JSON.stringify(moves || []));
  if (winner === "player1") {
    updateElo(player1Id, player2Id);
  } else if (winner === "player2") {
    updateElo(player2Id, player1Id);
  } else {
    // 平局
    const p1 = getOrCreateLeaderboard(player1Id);
    const p2 = getOrCreateLeaderboard(player2Id);
    db.prepare("UPDATE leaderboard SET draws = draws + 1, total_games = total_games + 1 WHERE user_id = ?").run(player1Id);
    db.prepare("UPDATE leaderboard SET draws = draws + 1, total_games = total_games + 1 WHERE user_id = ?").run(player2Id);
  }
  res.json({ success: true, matchId: id });
});

// PK 历史
app.get("/api/pk/history/:userId", (req, res) => {
  const { userId } = req.params;
  const matches = db.prepare(`
    SELECT m.*, u1.name as p1_name, u2.name as p2_name
    FROM pk_matches m
    JOIN users u1 ON m.player1_id = u1.id
    JOIN users u2 ON m.player2_id = u2.id
    WHERE m.player1_id = ? OR m.player2_id = ?
    ORDER BY m.played_at DESC LIMIT 20
  `).all(userId, userId);
  res.json(matches);
});

// ---------- 启动 ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🦞 终极井字棋服务器启动: http://0.0.0.0:${PORT}`);
  console.log(`   API 文档:`);
  console.log(`   POST /api/register     - 注册`);
  console.log(`   POST /api/login        - 登录`);
  console.log(`   POST /api/evolution/save - 保存进化数据`);
  console.log(`   GET  /api/evolution/load/:userId - 加载进化数据`);
  console.log(`   GET  /api/players      - 玩家列表`);
  console.log(`   GET  /api/leaderboard  - 排行榜`);
  console.log(`   POST /api/pk/result    - 提交PK结果`);
  console.log(`   GET  /api/pk/history/:userId - PK历史`);
});
