const WebSocket = require('ws');
const express = require('express');
const path = require('path');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map();          // Map<roomId, Map<ws, username>>
const clientRoom = new Map();     // Map<ws, roomId>
const gameStructure = new Map(); // Map<roomId, { html: string, otherData? }>
const gameState = new Map(); // Map<roomId, { p1: username, p2: username }>
const poisons = new Map(); //Map<roomId , {poison1 , poison2}
const game = new Map(); //Map <roomId , {p1 : {} , p2 : {}}


// Serve static files like index.html and game.html from "public" folder
app.use(express.static(path.join(__dirname, 'public')));

// Route for home.html (Landing page)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

// Route for index.html (join page)
app.get('/join', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'join.html'));
});

// Route for game.html (game UI)
app.get('/game', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});


wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      ws.send(JSON.stringify({ error: 'Invalid message format' }));
      return;
    }

    if (msg.type === 'join') {
      const roomId = msg.room;
      const username = msg.username;

      if (!roomId || !username) {
        ws.send(JSON.stringify({ error: 'room and username required' }));
        return;
      }

      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Map());
      }


      const clientsInRoom = rooms.get(roomId);


      if (clientsInRoom.size >= 2) {
        ws.send(JSON.stringify({ error: 'Room is full. Max 2 players allowed.' }));
        ws.close();
        return;
      }


      for (const name of clientsInRoom.values()) {
        if (name === username) {
          ws.send(JSON.stringify({ error: 'Username already taken in this room' }));
          ws.close();
          return;
        }
      }

      if (!gameState.has(roomId)) {
        gameState.set(roomId, { p1: username, turn: username });
      } else {
        const state = gameState.get(roomId) || {};
        state.p2 = username;
        gameState.set(roomId, state); // update state for this room
      }

      if (!gameStructure.has(roomId)) {
        gameStructure.set(roomId, { html: initUI() });
      }

      // Leave old room if any
      const oldRoom = clientRoom.get(ws);
      if (oldRoom && oldRoom !== roomId) {
        const oldClients = rooms.get(oldRoom);
        oldClients?.delete(ws);
        if (oldClients?.size === 0) rooms.delete(oldRoom);
      }



      clientsInRoom.set(ws, username);
      clientRoom.set(ws, roomId);

      ws.send(JSON.stringify({ type: 'joined', room: roomId, username }));

      console.log(`Client ${username} joined room: ${roomId}`);

      if (clientsInRoom.size === 2) {
        for (const clientWs of clientsInRoom.keys()) {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'roomReady',
              message: '2 players connected. Ready to start!',
              gameStructure: gameStructure.get(roomId).html,
              state: { "p1": gameState.get(roomId).p1, "p2": gameState.get(roomId).p2 },
            }));
          }
        }
      }
      return;
    }
    
    
    if (msg.type === 'restart') {
      const roomId = clientRoom.get(ws);
      const clients = rooms.get(roomId);
      for (const clientWs of clients.keys()) {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'restart',
            reqBy: msg.reqBy,
            roomId: msg.room,
          }));
        }
      }
    }

    if (msg.type === 'chat') {
      const roomId = clientRoom.get(ws);
      if (!roomId) {
        ws.send(JSON.stringify({ error: 'You must join a room first' }));
        return;
      }

      const clients = rooms.get(roomId);
      if (!clients || clients.size < 2) {
        ws.send(JSON.stringify({ error: 'Waiting for second player to join...' }));
        return;
      }

      const senderName = clients.get(ws);
      if (!senderName) {
        ws.send(JSON.stringify({ error: 'Username not found' }));
        return;
      }

      for (const clientWs of clients.keys()) {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'chat',
            message: msg.message,
            sender: senderName,
          }));
        }
      }
    }


    if (msg.type == 'setPoison') {
      const roomId = clientRoom.get(ws);
      const poison = msg.index;

      if (!roomId) {
        ws.send(JSON.stringify({ error: 'You must join a room first' }));
        return;
      }

      if (!poisons.has(roomId)) {
        poisons.set(roomId, []);
      }

      const roomPoisons = poisons.get(roomId);

      // Check max poisons
      if (roomPoisons.length >= 2) {
        ws.send(JSON.stringify({ error: 'Maximum 2 poisons are allowed per room' }));
        return;
      }

      roomPoisons.push(poison);
      poisons.set(roomId, roomPoisons);

      const clients = rooms.get(roomId);
      if (!clients || clients.size < 2) {
        ws.send(JSON.stringify({ error: 'Waiting for second player to join...' }));
        return;
      }

      if (roomPoisons.length == 2) {
        for (const client of clients.keys()) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'startGame',
              status: 'ok',
              gameState: { p1: gameState.get(roomId).p1, p2: gameState.get(roomId).p2 },
              turn: gameState.get(roomId).p1
            }));
          }
        }
      }

      console.log(poisons.get(roomId))
    }


    if (msg.type === 'play') {
      const roomId = clientRoom.get(ws);

      if (!roomId) {
        ws.send(JSON.stringify({ error: 'You must join a room first' }));
        return;
      }

      const state = gameState.get(roomId);
      const player1 = state.p1;
      const player2 = state.p2;
      let turn = state.turn;

      if (!game.has(roomId)) {

        game.set(roomId, {
          p1: [],
          p2: []
        });

      }

      console.log(turn)

      const clients = rooms.get(roomId);
      if (!clients || clients.size < 2) {
        ws.send(JSON.stringify({ error: 'Waiting for second player to join...' }));
        return;
      }

      const { p1, p2 } = game.get(roomId);

      if (p1.includes(msg.index) || p2.includes(msg.index)) {
        return;
      }

      if (msg.by === player1) {
        if ((p1.length + 1) - p2.length == 2) {
          return;
        } else {
          p1.push(msg.index);
          state.turn = player2; // or player1
          gameState.set(roomId, state); // save the updated state

        }
      } else if (msg.by === player2) {
        if ((p2.length + 1) - p1.length == 2) {
          return;
        }
        else {
          p2.push(msg.index);
          state.turn = player1; // or player1
          gameState.set(roomId, state); // save the updated state

        }
      } else {
        ws.send(JSON.stringify({ error: 'Invalid player identifier', by: msg.by, player1: player1, player2: player2 }));
        return;
      }

      game.set(roomId, { p1, p2 });

      if (poisons.get(roomId).includes(msg.index)) {
        for (const client of clients.keys()) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'gameover',
              index: msg.index,
              by: msg.by,
            }));
          }
        }

        // Remove the room and all associated data
        poisons.delete(roomId);
        gameState.delete(roomId);
        game.delete(roomId);
        gameStructure.delete(roomId);


        return;
      }

      for (const client of clients.keys()) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'ok',
            index: msg.index,
            by: msg.by,
            turn: state.turn
          }));
        }
      }
    }

  });




  ws.on('close', () => {
    const roomId = clientRoom.get(ws);

    if (roomId) {
      const clients = rooms.get(roomId);
      const username = clients?.get(ws); // Get the username of the one who left

      if (clients) {
        // Remove this user from the room
        clients.delete(ws);
        clientRoom.delete(ws);

        // If room is now empty, clean up everything
        if (clients.size === 0) {
          rooms.delete(roomId);
          poisons.delete(roomId);
          gameState.delete(roomId);
          game.delete(roomId);
          gameStructure.delete(roomId);
        } else {
          // Get remaining client and username
          const [[remainingWs, remainingUsername]] = clients.entries();

          // Notify remaining user
          if (remainingWs.readyState === WebSocket.OPEN) {
            remainingWs.send(JSON.stringify({
              type: 'opponentLeft',
              message: 'Opponent left! Waiting for new player...'
            }));
          }

          // Reset game state for future player to join
          poisons.delete(roomId);
          game.delete(roomId);
          gameStructure.delete(roomId);

          // Set gameState with remaining user as p1
          gameState.set(roomId, {
            p1: remainingUsername,
            turn: remainingUsername
          });
        }
      }
    }

    console.log('Client disconnected');
  });

});



console.log('WebSocket server running on ws://localhost:3000');


const numCircles = 15;
const colors = ['bg-blue-400', 'bg-green-400', 'bg-yellow-400', 'bg-pink-400', 'bg-purple-400'];

// Check if a new circle overlaps with existing ones
function isOverlapping(x, y, existingCircles, minDistance) {
  return existingCircles.some(circle => {
    const dx = x - circle.x;
    const dy = y - circle.y;
    return Math.sqrt(dx * dx + dy * dy) < minDistance;
  });
}

function initUI() {
  const circles = [];
  let html = '';

  // Create small circles with no overlap
  const minDistance = 40; // Minimum distance between circle centers
  for (let i = 0; i < numCircles; i++) {
    let x, y, attempts = 0;
    const maxAttempts = 100;
    do {
      x = Math.random() * (300 - 30); // Adjust for circle size
      y = Math.random() * (300 - 30);
      attempts++;
      if (attempts > maxAttempts) break; // Prevent infinite loop
    } while (
      Math.sqrt((x - 150) ** 2 + (y - 150) ** 2) > 115 || // Keep within circle
      isOverlapping(x, y, circles, minDistance)
    );

    if (attempts <= maxAttempts) {
      circles.push({
        x,
        y,
        color: colors[Math.floor(Math.random() * colors.length)]
      });
    }
  }

  // Render circles
  circles.forEach((circle, index) => {
    html += `
      <div 
        class="small-circle ${circle.color} hover:brightness-110"
        style="left: ${circle.x}px; top: ${circle.y}px;"
        data-index="${index}"
      >${index}</div>
    `;
  });

  return html
}

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

module.exports = server;

// const PORT = process.env.PORT || 8080;
// server.listen(PORT, () => {
//   console.log(`Server listening on port ${PORT}`);
// });