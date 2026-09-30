# Orbit Chat

A GitHub-ready temporary web chat based on the interface in the supplied sketch.

## Features

- Home page: **Create Room** or **Enter Room**
- No user accounts / no email login
- Room ID + password
- User chooses a chat username after entering the room
- Realtime messages with Socket.IO
- Passwords are stored as bcrypt hashes, not plaintext
- Messages and rooms expire after 7 days
- 8-bit rotating earth logo
- Responsive mobile/desktop UI
- No message HTML injection: messages are rendered with `textContent`

## Stack

- Node.js + Express
- Socket.IO
- MongoDB + Mongoose
- bcryptjs
- JWT for the temporary room session
- Plain HTML/CSS/JavaScript frontend

## Run locally

1. Install Node.js 20+.
2. Create a MongoDB database (MongoDB Atlas is convenient).
3. Copy `.env.example` to `.env`.
4. Put your MongoDB connection string in `MONGODB_URI`.
5. Generate a long random `JWT_SECRET`.
6. Run:

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## GitHub + deployment

Push this folder to a GitHub repository. Then deploy the Node app to a host that supports long-running Node.js processes, such as Render, Railway, Fly.io, or a VPS. Set the same environment variables from `.env` in the host's environment settings.

Do **not** commit `.env`.

For MongoDB Atlas, allow your deployed server to connect to the database and use a strong database password.

## How the 7-day deletion works

Every room gets an `expiresAt` timestamp exactly 7 days after creation.

- The server refuses expired rooms.
- A background cleanup runs every hour and deletes expired rooms/messages.
- The message collection also has a MongoDB TTL index.
- A room is not extended when someone joins it; it is destroyed 7 days after creation.

For a production system with strict deletion guarantees, use a managed scheduled job as an additional cleanup mechanism.

## Security notes

This is a good starter implementation, not a complete production security audit.

For a public deployment, also add:

- HTTPS (normally provided by your hosting platform)
- Rate limiting on create/join endpoints
- Login-attempt throttling / temporary lockouts
- CSRF protection if you change authentication architecture
- Content moderation / abuse reporting
- Maximum room/member counts
- Logging and monitoring
- A privacy policy and data-retention disclosure

Because there are no user accounts, anyone who knows a room ID **and password** can join until the room expires. The server never exposes the password to other clients.
