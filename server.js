const WebSocket = require("ws");
const express = require("express");
const http = require("http");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

function constrain(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function checkPaddleCollision(
  ball,
  paddle,
  paddleWidth,
  paddleHeight,
  ballRadius
) {
  const ballX = ball.x;
  const ballY = ball.y;
  const paddleX = paddle.x;
  const paddleY = paddle.y;

  if (
    ballX + ballRadius >= paddleX &&
    ballX - ballRadius <= paddleX + paddleWidth &&
    ballY + ballRadius >= paddleY &&
    ballY - ballRadius <= paddleY + paddleHeight
  ) {
    const hitPos = (ballX - paddleX - paddleWidth / 2) / (paddleWidth / 2);
    const relativeVelocityX = ball.dx - paddle.vx;
    const relativeVelocityY = ball.dy - paddle.vy;
    const speed = Math.sqrt(relativeVelocityX ** 2 + relativeVelocityY ** 2);
    return { hit: true, hitPos, speed };
  }
  return { hit: false, hitPos: 0, speed: 0 };
}

function normalizeSpeed(dx, dy, targetSpeed) {
  const currentSpeed = Math.sqrt(dx * dx + dy * dy);
  if (currentSpeed === 0) return { dx, dy };
  const factor = targetSpeed / currentSpeed;
  return { dx: dx * factor, dy: dy * factor };
}

// Новый код: проверка столкновения мяча с бонусом
function checkBonusCollision(ball, bonus, ballRadius) {
  const cellWidth = 1 / 30; // Ширина клетки
  const cellHeight = 1 / 20; // Высота клетки
  return (
    ball.x + ballRadius >= bonus.x - cellWidth / 2 &&
    ball.x - ballRadius <= bonus.x + cellWidth / 2 &&
    ball.y + ballRadius >= bonus.y - cellHeight / 2 &&
    ball.y - ballRadius <= bonus.y + cellHeight / 2
  );
}

let players = [];
let gameState = {
  paddle1: { x: 0.5, y: 0.9333, score: 0, vx: 0, vy: 0, bonus: null },
  paddle2: { x: 0.5, y: 0.0667, score: 0, vx: 0, vy: 0, bonus: null },
  ball: { x: 0.5, y: 0.5, dx: 0, dy: 0 },
  status: "waiting",
  servingPlayer: 1,
  serveTimer: 7,
  gameTimer: 300,
  lastHitPlayer: null,
  hitTimer: 7,
  lastPing: new Map(),
  newGameRequests: new Set(),
  bonuses: [], // Массив активных бонусов
  bonusTimer: 30, // Таймер для появления первого бонуса
};

// Список возможных бонусов
const bonusTypes = ["burning_boot"];

function spawnBonus() {
  // Центр поля: x = 0.5, y = 0.5
  // Три клетки от центра: ±3 клетки по X (1/30 * 3 = 0.1), ±3 клетки по Y (1/20 * 3 = 0.15)
  const cellWidth = 1 / 30;
  const cellHeight = 1 / 20;
  const centerX = 0.5;
  const centerY = 0.5;
  const rangeX = 3 * cellWidth; // ±0.1
  const rangeY = 3 * cellHeight; // ±0.15

  // Случайные координаты в пределах трёх клеток от центра
  const gridX = Math.floor(Math.random() * 7) - 3; // От -3 до +3 клеток
  const gridY = Math.floor(Math.random() * 7) - 3; // От -3 до +3 клеток
  const bonusX = centerX + gridX * cellWidth;
  const bonusY = centerY + gridY * cellHeight;

  // Выбираем случайный бонус из списка
  const bonusType = bonusTypes[Math.floor(Math.random() * bonusTypes.length)];

  gameState.bonuses.push({
    x: bonusX,
    y: bonusY,
    type: bonusType,
  });
}

function applyBonus(player, bonusType) {
  if (bonusType === "burning_boot") {
    player.bonus = { type: "burning_boot", hits: 1 }; // Один удар с бонусом
  }
}

function updateGame() {
  if (gameState.status !== "playing") return;

  // Обновление таймера бонусов
  if (gameState.gameTimer <= 300 - 30) {
    // Первое появление бонуса на 30-й секунде
    gameState.bonusTimer -= 1 / 60;
    if (gameState.bonusTimer <= 0) {
      const numBonuses = Math.random() < 0.5 ? 1 : 2; // 1 или 2 бонуса
      for (let i = 0; i < numBonuses; i++) {
        spawnBonus();
      }
      gameState.bonusTimer = 30; // Сброс таймера на следующие 30 секунд
    }
  }

  if (gameState.gameTimer > 0) {
    gameState.gameTimer -= 1 / 60;
  } else {
    gameState.status = "gameOver";
    let winner;
    if (gameState.paddle1.score > gameState.paddle2.score) {
      winner = 1;
    } else if (gameState.paddle2.score < gameState.paddle1.score) {
      winner = 2;
    } else {
      winner = "ничья";
    }
    broadcast({
      type: "gameOver",
      winner,
      finalScore: `${gameState.paddle1.score} - ${gameState.paddle2.score}`,
    });
    return;
  }

  if (gameState.ball.dx === 0 && gameState.ball.dy === 0) {
    gameState.serveTimer -= 1 / 60;
    if (gameState.serveTimer <= 0) {
      gameState.servingPlayer = gameState.servingPlayer === 1 ? 2 : 1;
      resetBall(false);
      broadcast({
        type: "update",
        paddle1: gameState.paddle1,
        paddle2: gameState.paddle2,
        ball: gameState.ball,
        servingPlayer: gameState.servingPlayer,
        serveTimer: gameState.serveTimer,
        gameTimer: gameState.gameTimer,
        bonuses: gameState.bonuses,
        foul: true,
      });
      return;
    }
    gameState.ball.x =
      gameState.servingPlayer === 1
        ? gameState.paddle1.x + 0.0333
        : gameState.paddle2.x + 0.0333;
    gameState.ball.y = gameState.servingPlayer === 1 ? 0.9 : 0.1;
  } else {
    gameState.hitTimer -= 1 / 60;
    if (gameState.hitTimer <= 0) {
      gameState.servingPlayer = gameState.lastHitPlayer === 1 ? 2 : 1;
      resetBall(false);
      broadcast({
        type: "update",
        paddle1: gameState.paddle1,
        paddle2: gameState.paddle2,
        ball: gameState.ball,
        servingPlayer: gameState.servingPlayer,
        serveTimer: gameState.serveTimer,
        gameTimer: gameState.gameTimer,
        bonuses: gameState.bonuses,
        foul: true,
      });
      return;
    }
  }

  gameState.ball.x += gameState.ball.dx;
  gameState.ball.y += gameState.ball.dy;

  let wallHit = false;
  let ballRadius = 0.01;
  let paddleWidth = 0.0667;
  let paddleHeight = 0.0333;
  let baseSpeed = 0.008;
  let maxSpeed = 0.015;

  // Проверка столкновения с бонусами
  let bonusCollected = null;
  gameState.bonuses = gameState.bonuses.filter((bonus) => {
    if (checkBonusCollision(gameState.ball, bonus, ballRadius)) {
      if (gameState.lastHitPlayer) {
        const player =
          gameState.lastHitPlayer === 1 ? gameState.paddle1 : gameState.paddle2;
        applyBonus(player, bonus.type);
        bonusCollected = {
          playerId: gameState.lastHitPlayer,
          bonusType: bonus.type,
        };
        return false; // Удаляем бонус
      }
    }
    return true;
  });

  if (gameState.ball.x <= 0.01 || gameState.ball.x >= 1 - 0.01) {
    gameState.ball.dx *= -1;
    gameState.ball.x = constrain(gameState.ball.x, 0.01, 1 - 0.01);
    const normalized = normalizeSpeed(
      gameState.ball.dx,
      gameState.ball.dy,
      baseSpeed
    );
    gameState.ball.dx = normalized.dx;
    gameState.ball.dy = normalized.dy;
    wallHit = true;
  }

  if (
    gameState.ball.y < 0.01 &&
    gameState.ball.x >= 0.25 &&
    gameState.ball.x <= 0.75
  ) {
    gameState.paddle1.score += 1;
    gameState.servingPlayer = 2;
    resetBall(false);
    broadcast({
      type: "update",
      paddle1: gameState.paddle1,
      paddle2: gameState.paddle2,
      ball: gameState.ball,
      servingPlayer: gameState.servingPlayer,
      serveTimer: gameState.serveTimer,
      gameTimer: gameState.gameTimer,
      bonuses: gameState.bonuses,
      goal: 1,
    });
  } else if (
    gameState.ball.y > 1 - 0.01 &&
    gameState.ball.x >= 0.25 &&
    gameState.ball.x <= 0.75
  ) {
    gameState.paddle2.score += 1;
    gameState.servingPlayer = 1;
    resetBall(false);
    broadcast({
      type: "update",
      paddle1: gameState.paddle1,
      paddle2: gameState.paddle2,
      ball: gameState.ball,
      servingPlayer: gameState.servingPlayer,
      serveTimer: gameState.serveTimer,
      gameTimer: gameState.gameTimer,
      bonuses: gameState.bonuses,
      goal: 2,
    });
  } else if (gameState.ball.y <= 0.01 || gameState.ball.y >= 1 - 0.01) {
    gameState.ball.dy *= -1;
    gameState.ball.y = constrain(gameState.ball.y, 0.01, 1 - 0.01);
    const normalized = normalizeSpeed(
      gameState.ball.dx,
      gameState.ball.dy,
      baseSpeed
    );
    gameState.ball.dx = normalized.dx;
    gameState.ball.dy = normalized.dy;
    wallHit = true;
  }

  let hit = false;
  let collision1 = checkPaddleCollision(
    gameState.ball,
    gameState.paddle1,
    paddleWidth,
    paddleHeight,
    ballRadius
  );
  if (collision1.hit) {
    let hitPos = collision1.hitPos;
    let speed = Math.min(collision1.speed * 0.8 + baseSpeed, maxSpeed);
    if (
      gameState.ball.dx === 0 &&
      gameState.ball.dy === 0 &&
      gameState.servingPlayer === 1
    ) {
      speed = baseSpeed;
      gameState.ball.dx = hitPos * 0.004 + gameState.paddle1.vx * 0.5;
      gameState.ball.dy = -speed;
      const normalized = normalizeSpeed(
        gameState.ball.dx,
        gameState.ball.dy,
        speed
      );
      gameState.ball.dx = normalized.dx;
      gameState.ball.dy = normalized.dy;
      gameState.ball.y = gameState.paddle1.y - ballRadius;
      gameState.lastHitPlayer = 1;
      gameState.serveTimer = 7;
      gameState.hitTimer = 7;
      hit = true;
    } else {
      if (
        gameState.paddle1.bonus &&
        gameState.paddle1.bonus.type === "burning_boot"
      ) {
        speed *= 1.7; // Ускорение на 70%
        gameState.paddle1.bonus.hits -= 1;
        if (gameState.paddle1.bonus.hits <= 0) {
          gameState.paddle1.bonus = null; // Удаляем бонус после использования
        }
      }
      gameState.ball.dx = hitPos * 0.004 + gameState.paddle1.vx * 0.5;
      gameState.ball.dy = -Math.abs(gameState.ball.dy) * 0.8 - baseSpeed;
      const normalized = normalizeSpeed(
        gameState.ball.dx,
        gameState.ball.dy,
        speed
      );
      gameState.ball.dx = normalized.dx;
      gameState.ball.dy = normalized.dy;
      gameState.ball.y = gameState.paddle1.y - ballRadius;
      gameState.lastHitPlayer = 1;
      gameState.hitTimer = 7;
      hit = true;
    }
  }

  let collision2 = checkPaddleCollision(
    gameState.ball,
    gameState.paddle2,
    paddleWidth,
    paddleHeight,
    ballRadius
  );
  if (collision2.hit) {
    let hitPos = collision2.hitPos;
    let speed = Math.min(collision2.speed * 0.8 + baseSpeed, maxSpeed);
    if (
      gameState.ball.dx === 0 &&
      gameState.ball.dy === 0 &&
      gameState.servingPlayer === 2
    ) {
      speed = baseSpeed;
      gameState.ball.dx = hitPos * 0.004 + gameState.paddle2.vx * 0.5;
      gameState.ball.dy = speed;
      const normalized = normalizeSpeed(
        gameState.ball.dx,
        gameState.ball.dy,
        speed
      );
      gameState.ball.dx = normalized.dx;
      gameState.ball.dy = normalized.dy;
      gameState.ball.y = gameState.paddle2.y + paddleHeight + ballRadius;
      gameState.lastHitPlayer = 2;
      gameState.serveTimer = 7;
      gameState.hitTimer = 7;
      hit = true;
    } else {
      if (
        gameState.paddle2.bonus &&
        gameState.paddle2.bonus.type === "burning_boot"
      ) {
        speed *= 1.7; // Ускорение на 70%
        gameState.paddle2.bonus.hits -= 1;
        if (gameState.paddle2.bonus.hits <= 0) {
          gameState.paddle2.bonus = null; // Удаляем бонус после использования
        }
      }
      gameState.ball.dx = hitPos * 0.004 + gameState.paddle2.vx * 0.5;
      gameState.ball.dy = Math.abs(gameState.ball.dy) * 0.8 + baseSpeed;
      const normalized = normalizeSpeed(
        gameState.ball.dx,
        gameState.ball.dy,
        speed
      );
      gameState.ball.dx = normalized.dx;
      gameState.ball.dy = normalized.dy;
      gameState.ball.y = gameState.paddle2.y + paddleHeight + ballRadius;
      gameState.lastHitPlayer = 2;
      gameState.hitTimer = 7;
      hit = true;
    }
  }

  broadcast({
    type: "update",
    paddle1: gameState.paddle1,
    paddle2: gameState.paddle2,
    ball: gameState.ball,
    servingPlayer: gameState.servingPlayer,
    serveTimer: gameState.serveTimer,
    gameTimer: gameState.gameTimer,
    bonuses: gameState.bonuses,
    hit,
    wallHit,
    bonusCollected,
  });
}

function broadcast(data) {
  players.forEach((player) => {
    if (player.readyState === WebSocket.OPEN) {
      try {
        player.send(JSON.stringify(data));
      } catch (error) {
        console.error(
          `Ошибка отправки сообщения игроку ${player.playerId}:`,
          error
        );
      }
    }
  });
}

function startGame() {
  gameState.status = "playing";
  gameState.paddle1 = {
    x: 0.5,
    y: 0.9333,
    score: 0,
    vx: 0,
    vy: 0,
    bonus: null,
  };
  gameState.paddle2 = {
    x: 0.5,
    y: 0.0667,
    score: 0,
    vx: 0,
    vy: 0,
    bonus: null,
  };
  gameState.servingPlayer = Math.random() < 0.5 ? 1 : 2;
  gameState.serveTimer = 7;
  gameState.gameTimer = 300;
  gameState.lastHitPlayer = null;
  gameState.hitTimer = 7;
  gameState.bonuses = [];
  gameState.bonusTimer = 30;
  resetBall(true);

  broadcast({
    type: "start",
    paddle1: gameState.paddle1,
    paddle2: gameState.paddle2,
    ball: gameState.ball,
    servingPlayer: gameState.servingPlayer,
    serveTimer: gameState.serveTimer,
    gameTimer: gameState.gameTimer,
    bonuses: gameState.bonuses,
  });

  console.log("Игра началась!");
}

function resetGame() {
  gameState.paddle1 = {
    x: 0.5,
    y: 0.9333,
    score: 0,
    vx: 0,
    vy: 0,
    bonus: null,
  };
  gameState.paddle2 = {
    x: 0.5,
    y: 0.0667,
    score: 0,
    vx: 0,
    vy: 0,
    bonus: null,
  };
  gameState.ball = { x: 0.5, y: 0.5, dx: 0, dy: 0 };
  gameState.status = "waiting";
  gameState.servingPlayer = Math.random() < 0.5 ? 1 : 2;
  gameState.serveTimer = 7;
  gameState.gameTimer = 300;
  gameState.lastHitPlayer = null;
  gameState.hitTimer = 7;
  gameState.bonuses = [];
  gameState.bonusTimer = 30;
  gameState.newGameRequests.clear();
}

function resetBall(isNewGame) {
  gameState.ball.x =
    gameState.servingPlayer === 1
      ? gameState.paddle1.x + 0.0333
      : gameState.paddle2.x + 0.0333;
  gameState.ball.y = gameState.servingPlayer === 1 ? 0.9 : 0.1;
  gameState.ball.dx = 0;
  gameState.ball.dy = 0;
  gameState.serveTimer = 7;
  gameState.hitTimer = 7;
}

wss.on("connection", (ws) => {
  let playerId = players.length + 1;
  if (playerId > 2) {
    console.log(`Попытка подключения игрока ${playerId}, но игра заполнена`);
    ws.send(JSON.stringify({ type: "error", message: "Игра уже заполнена!" }));
    ws.close();
    return;
  }

  players.push(ws);
  ws.playerId = playerId;
  gameState.lastPing.set(ws, Date.now());

  ws.send(JSON.stringify({ type: "init", playerId }));

  console.log(
    `Игрок ${playerId} подключился. Всего игроков: ${players.length}`
  );

  if (players.length === 2) {
    console.log("Достаточно игроков, начинаем игру");
    startGame();
  }

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      if (
        data.type === "move" &&
        gameState.status === "playing" &&
        data.playerId &&
        data.position
      ) {
        const position = data.position;
        const paddle =
          data.playerId === 1 ? gameState.paddle1 : gameState.paddle2;

        if (
          (data.playerId === 1 && paddle !== gameState.paddle1) ||
          (data.playerId === 2 && paddle !== gameState.paddle2)
        ) {
          console.error(
            `Игрок ${data.playerId} пытается управлять чужой ракеткой!`
          );
          return;
        }

        const paddleWidth = 0.0667;
        const paddleHeight = 0.0333;
        const prevX = paddle.x;
        const prevY = paddle.y;
        paddle.x = constrain(position.x, 0, 1 - paddleWidth);
        if (data.playerId === 1) {
          paddle.y = constrain(position.y, 0.5, 1 - paddleHeight);
        } else {
          paddle.y = constrain(position.y, 0, 0.5 - paddleHeight);
        }
        paddle.vx = paddle.x - prevX;
        paddle.vy = paddle.y - prevY;

        console.log(
          `Игрок ${data.playerId}: x=${paddle.x.toFixed(
            3
          )}, y=${paddle.y.toFixed(3)}`
        );

        broadcast({
          type: "update",
          paddle1: gameState.paddle1,
          paddle2: gameState.paddle2,
          ball: gameState.ball,
          servingPlayer: gameState.servingPlayer,
          serveTimer: gameState.serveTimer,
          gameTimer: gameState.gameTimer,
          bonuses: gameState.bonuses,
        });
      } else if (data.type === "newGame" && gameState.status === "gameOver") {
        gameState.newGameRequests.add(ws.playerId);
        if (players.length === 2) {
          resetGame();
          startGame();
        } else {
          broadcast({
            type: "error",
            message: "Ожидание второго игрока для начала новой игры...",
          });
        }
      } else if (data.type === "ping") {
        gameState.lastPing.set(ws, Date.now());
      }
    } catch (error) {
      console.error(
        `Ошибка обработки сообщения от игрока ${ws.playerId}:`,
        error
      );
    }
  });

  ws.on("close", () => {
    players = players.filter((p) => p !== ws);
    gameState.lastPing.delete(ws);
    console.log(
      `Игрок ${ws.playerId} отключился. Всего игроков: ${players.length}`
    );
    if (gameState.status === "playing") {
      gameState.status = "waiting";
      gameState.newGameRequests.clear();
      resetBall(true);
      broadcast({
        type: "error",
        message: "Игрок отключился. Ожидание нового игрока...",
      });
    }
  });
});

setInterval(() => {
  const now = Date.now();
  players = players.filter((player) => {
    if (now - gameState.lastPing.get(player) > 1000000) {
      player.close();
      return false;
    }
    return true;
  });
  if (players.length < 2 && gameState.status === "playing") {
    gameState.status = "waiting";
    gameState.newGameRequests.clear();
    resetBall(true);
    broadcast({
      type: "error",
      message: "Игрок отключился. Ожидание нового игрока...",
    });
  }
}, 5000);

setInterval(updateGame, 1000 / 60);

server.listen(process.env.PORT || 10000, () => {
  console.log("Сервер запущен на порту", server.address().port);
});
