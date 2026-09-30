import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
const ROOM_TTL_DAYS = Number(process.env.ROOM_TTL_DAYS || 7);

if (!process.env.MONGODB_URI || !JWT_SECRET) {
  console.error('Missing MONGODB_URI or JWT_SECRET in .env');
  process.exit(1);
}

await mongoose.connect(process.env.MONGODB_URI);

const roomSchema = new mongoose.Schema({
  roomId: { type: String, unique: true, index: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  expiresAt: { type: Date, required: true, index: true }
}, { timestamps: true });

const messageSchema = new mongoose.Schema({
  roomId: { type: String, index: true, required: true },
  username: { type: String, required: true, maxlength: 24 },
  text: { type: String, required: true, maxlength: 2000 },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * ROOM_TTL_DAYS }
});

const Room = mongoose.model('Room', roomSchema);
const Message = mongoose.model('Message', messageSchema);

app.use(cors());
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')));

function normalizeRoomId(value) {
  return String(value || '').trim().toLowerCase();
}

function validRoomId(roomId) {
  return /^[a-z0-9_-]{3,32}$/.test(roomId);
}

function validPassword(password) {
  return typeof password === 'string' && password.length >= 4 && password.length <= 128;
}

function validUsername(username) {
  return typeof username === 'string' &&
    username.trim().length >= 1 &&
    username.trim().length <= 24 &&
    !/[<>]/.test(username);
}

function roomExpiresAt() {
  return new Date(Date.now() + ROOM_TTL_DAYS * 24 * 60 * 60 * 1000);
}

function issueRoomToken(roomId) {
  return jwt.sign({ roomId }, JWT_SECRET, { expiresIn: `${ROOM_TTL_DAYS}d` });
}

function verifyRoomToken(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  return payload.roomId;
}

// Create a room.
app.post('/api/rooms', async (req, res) => {
  try {
    const roomId = normalizeRoomId(req.body.roomId);
    const password = req.body.password;

    if (!validRoomId(roomId)) {
      return res.status(400).json({ error: 'Room ID must be 3–32 characters: letters, numbers, _ or -.' });
    }
    if (!validPassword(password)) {
      return res.status(400).json({ error: 'Password must be 4–128 characters.' });
    }

    const exists = await Room.exists({ roomId });
    if (exists) return res.status(409).json({ error: 'That room ID already exists.' });

    const passwordHash = await bcrypt.hash(password, 12);
    const room = await Room.create({
      roomId,
      passwordHash,
      expiresAt: roomExpiresAt()
    });

    return res.status(201).json({
      roomId: room.roomId,
      expiresAt: room.expiresAt,
      token: issueRoomToken(room.roomId)
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Could not create the room.' });
  }
});

// Check room password and issue a temporary room token.
app.post('/api/rooms/join', async (req, res) => {
  try {
    const roomId = normalizeRoomId(req.body.roomId);
    const password = req.body.password;

    if (!validRoomId(roomId) || !validPassword(password)) {
      return res.status(400).json({ error: 'Enter a valid room ID and password.' });
    }

    const room = await Room.findOne({ roomId });
    if (!room || room.expiresAt <= new Date()) {
      return res.status(404).json({ error: 'Room not found or it has expired.' });
    }

    const matches = await bcrypt.compare(password, room.passwordHash);
    if (!matches) return res.status(401).json({ error: 'Incorrect room ID or password.' });

    const messages = await Message.find({
      roomId,
      createdAt: { $gte: new Date(Date.now() - ROOM_TTL_DAYS * 86400000) }
    }).sort({ createdAt: 1 }).limit(500).lean();

    return res.json({
      roomId,
      expiresAt: room.expiresAt,
      token: issueRoomToken(room.roomId),
      messages: messages.map(m => ({
        username: m.username,
        text: m.text,
        createdAt: m.createdAt
      }))
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Could not join the room.' });
  }
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const roomId = verifyRoomToken(token);
    socket.data.roomId = roomId;
    next();
  } catch {
    next(new Error('Invalid or expired room session.'));
  }
});

io.on('connection', async (socket) => {
  const roomId = socket.data.roomId;
  socket.join(roomId);

  socket.on('join-chat', async ({ username }) => {
    if (!validUsername(username)) return;
    const cleanName = username.trim();
    socket.data.username = cleanName;
    socket.to(roomId).emit('system', `${cleanName} joined the room.`);
  });

  socket.on('send-message', async ({ text }) => {
    try {
      const username = socket.data.username;
      if (!username || typeof text !== 'string') return;

      const cleanText = text.trim();
      if (!cleanText || cleanText.length > 2000) return;

      const room = await Room.findOne({ roomId });
      if (!room || room.expiresAt <= new Date()) {
        socket.emit('room-expired');
        socket.disconnect(true);
        return;
      }

      const message = await Message.create({
        roomId,
        username,
        text: cleanText
      });

      io.to(roomId).emit('message', {
        username: message.username,
        text: message.text,
        createdAt: message.createdAt
      });
    } catch (error) {
      console.error(error);
    }
  });

  socket.on('disconnect', () => {
    if (socket.data.username) {
      socket.to(roomId).emit('system', `${socket.data.username} left the room.`);
    }
  });
});

// MongoDB TTL removes messages automatically. This interval removes expired rooms
// even if your MongoDB setup doesn't have a TTL index on expiresAt.
async function cleanupExpiredRooms() {
  try {
    const expired = await Room.find({ expiresAt: { $lte: new Date() } }).select('roomId').lean();
    if (!expired.length) return;
    const ids = expired.map(r => r.roomId);
    await Room.deleteMany({ roomId: { $in: ids } });
    await Message.deleteMany({ roomId: { $in: ids } });
    for (const id of ids) io.to(id).emit('room-expired');
    console.log(`Deleted ${ids.length} expired room(s).`);
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}
setInterval(cleanupExpiredRooms, 60 * 60 * 1000);
await cleanupExpiredRooms();

app.get('*', (req, res) => {
  res.sendFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Orbit Chat running at http://localhost:${PORT}`);
});
