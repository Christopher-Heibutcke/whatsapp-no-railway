const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const cors = require("cors");
const mysql = require("mysql2/promise");
const http = require("http");
const socketIo = require("socket.io");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());

/* ===================== DATABASE ===================== */
const dbConfig = {
  host: "localhost",
  user: "u517535970_eyesclound",
  password: "LDZV2eR2k$",
  database: "u517535970_eyesclound",
};

/* ===================== STATE ===================== */
let client = null;
let qrCodeData = null;
let isConnected = false;
let isReady = false;

/* ===================== INIT WHATSAPP ===================== */
async function initWhatsApp() {
  if (client) {
    console.log("[WA] Client already exists");
    return;
  }

  console.log("[WA] Initializing WhatsApp...");

  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: "./sessions",
      clientId: "eyescloud"
    }),
    puppeteer: {
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    }
  });

  /* ---------- QR ---------- */
  client.on("qr", async (qr) => {
    qrCodeData = await qrcode.toDataURL(qr);
    io.emit("qr", qrCodeData);
    console.log("[WA] QR RECEIVED");
  });

  /* ---------- AUTH ---------- */
  client.on("authenticated", () => {
    console.log("[WA] AUTHENTICATED");
  });

  /* ---------- READY (ÚNICO PONTO DE CONEXÃO REAL) ---------- */
  client.on("ready", async () => {
    console.log("[WA] READY ✔");
    isConnected = true;
    isReady = true;
    qrCodeData = null;

    io.emit("ready", { connected: true });

    try {
      const conn = await mysql.createConnection(dbConfig);
      await conn.execute(
        "UPDATE whatsapp_config SET status='connected', last_connected=NOW() WHERE id=1"
      );
      await conn.end();
    } catch (e) {
      console.error("[DB] Error updating status", e.message);
    }
  });

  /* ---------- DISCONNECT ---------- */
  client.on("disconnected", async (reason) => {
    console.log("[WA] DISCONNECTED:", reason);
    isConnected = false;
    isReady = false;
    qrCodeData = null;

    io.emit("disconnected", reason);

    try {
      await client.destroy();
    } catch {}
    client = null;
  });

  client.initialize();
}

/* ===================== ROUTES ===================== */
app.post("/api/connect", async (_, res) => {
  await initWhatsApp();
  res.json({ success: true });
});

app.get("/api/status", (_, res) => {
  res.json({
    connected: isConnected,
    ready: isReady,
    qrCode: qrCodeData
  });
});

/* ===================== CHATS ===================== */
app.get("/api/chats", async (_, res) => {
  if (!client || !isReady) {
    return res.json({ success: false, message: "WhatsApp not ready" });
  }

  const chats = await client.getChats();

  const data = await Promise.all(
    chats.slice(0, 50).map(async (chat) => {
      const contact = await chat.getContact();
      return {
        id: chat.id._serialized,
        name: chat.name || contact.pushname || contact.number,
        unread: chat.unreadCount,
        lastMessage: chat.lastMessage?.body || ""
      };
    })
  );

  res.json({ success: true, chats: data });
});

/* ===================== MESSAGES ===================== */
app.get("/api/messages/:chatId", async (req, res) => {
  if (!client || !isReady) {
    return res.json({ success: false });
  }

  const chat = await client.getChatById(req.params.chatId);
  const msgs = await chat.fetchMessages({ limit: 50 });

  res.json({
    success: true,
    messages: msgs.map((m) => ({
      id: m.id._serialized,
      body: m.body,
      fromMe: m.fromMe,
      timestamp: m.timestamp
    }))
  });
});

/* ===================== SEND ===================== */
app.post("/api/send-message", async (req, res) => {
  if (!client || !isReady) {
    return res.json({ success: false });
  }

  const { chatId, message } = req.body;
  await client.sendMessage(chatId, message);
  res.json({ success: true });
});

/* ===================== SOCKET ===================== */
io.on("connection", (socket) => {
  socket.emit("status", {
    connected: isConnected,
    ready: isReady,
    qrCode: qrCodeData
  });
});

/* ===================== START ===================== */
const PORT = 3000;
server.listen(PORT, () => {
  console.log("====================================");
  console.log(" EyesCloud WhatsApp API - ONLINE");
  console.log(" PORT:", PORT);
  console.log("====================================");
});
