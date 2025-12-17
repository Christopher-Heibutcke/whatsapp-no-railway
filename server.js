const express = require("express")
const { Client, LocalAuth } = require("whatsapp-web.js")
const qrcode = require("qrcode")
const cors = require("cors")
const mysql = require("mysql2/promise")
const http = require("http")
const socketIo = require("socket.io")
const fs = require("fs")

const app = express()
const server = http.createServer(app)

const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
})

app.use(cors({ origin: "*", credentials: true }))
app.use(express.json())

/* ================= DATABASE ================= */

const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "u517535970_eyesclound",
  password: process.env.DB_PASSWORD || "SENHA_AQUI",
  database: process.env.DB_NAME || "u517535970_eyesclound",
}

/* ================= GLOBAL STATE ================= */

let whatsappClient = null
let qrCodeData = null
let isConnected = false
let isClientReady = false
let chatsSynced = false
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 5

/* ================= WHATSAPP INIT ================= */

function initializeWhatsApp() {
  const chromiumPaths = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    process.env.PUPPETEER_EXECUTABLE_PATH,
  ].filter(Boolean)

  const chromiumPath = chromiumPaths.find(p => fs.existsSync(p))
  if (!chromiumPath) throw new Error("Chromium não encontrado")

  whatsappClient = new Client({
    authStrategy: new LocalAuth({
      dataPath: "./whatsapp_sessions",
      clientId: "eyescloud-main",
    }),
    puppeteer: {
      headless: true,
      executablePath: chromiumPath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process",
        "--window-size=1280,800",
      ],
    },
  })

  /* ================= EVENTS ================= */

  whatsappClient.on("qr", async (qr) => {
    qrCodeData = await qrcode.toDataURL(qr)
    io.emit("qr", qrCodeData)
  })

  whatsappClient.on("authenticated", () => {
    console.log("[WA] Authenticated")
  })

  whatsappClient.on("ready", async () => {
    console.log("[WA] Ready – aguardando sync dos chats")

    isConnected = true
    chatsSynced = false
    isClientReady = false

    const start = Date.now()
    const timeout = 60000

    while (Date.now() - start < timeout) {
      try {
        const chats = await whatsappClient.getChats()
        if (Array.isArray(chats)) {
          chatsSynced = true
          isClientReady = true
          console.log(`[WA] Chats sincronizados: ${chats.length}`)
          break
        }
      } catch (e) {}

      await new Promise(r => setTimeout(r, 2000))
    }

    if (!chatsSynced) {
      console.error("[WA] Timeout ao sincronizar chats")
    }

    io.emit("ready", {
      connected: isConnected,
      clientReady: isClientReady,
      chatsSynced,
    })
  })

  whatsappClient.on("disconnected", (reason) => {
    console.log("[WA] Disconnected:", reason)
    isConnected = false
    isClientReady = false
    chatsSynced = false
    qrCodeData = null

    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++
      setTimeout(initializeWhatsApp, 5000)
    }
  })

  whatsappClient.initialize()
}

/* ================= API ================= */

app.get("/api/status", (req, res) => {
  res.json({
    connected: isConnected,
    clientReady: isClientReady,
    chatsSynced,
    qrCode: qrCodeData,
  })
})

app.post("/api/connect", (req, res) => {
  if (!whatsappClient) {
    initializeWhatsApp()
    return res.json({ success: true, message: "Conectando..." })
  }
  res.json({ success: false, message: "Já conectado" })
})

app.get("/api/chats", async (req, res) => {
  if (!isConnected || !isClientReady || !chatsSynced) {
    return res.json({
      success: false,
      message: "WhatsApp ainda sincronizando conversas",
    })
  }

  try {
    const chats = await whatsappClient.getChats()

    const result = await Promise.all(
      chats.slice(0, 50).map(async (chat) => {
        const contact = await chat.getContact()
        return {
          id: chat.id._serialized,
          name: chat.name || contact.pushname || contact.number,
          isGroup: chat.isGroup,
          unreadCount: chat.unreadCount,
          lastMessage: chat.lastMessage
            ? {
                body: chat.lastMessage.body,
                timestamp: chat.lastMessage.timestamp,
              }
            : null,
        }
      })
    )

    res.json({ success: true, chats: result })
  } catch (err) {
    res.json({ success: false, message: err.message })
  }
})

/* ================= SOCKET ================= */

io.on("connection", (socket) => {
  socket.emit("status", {
    connected: isConnected,
    clientReady: isClientReady,
    chatsSynced,
    qrCode: qrCodeData,
  })
})

/* ================= SERVER ================= */

const PORT = process.env.PORT || 3000
server.listen(PORT, "0.0.0.0", () => {
  console.log("==========================================")
  console.log(" EyesCloud WhatsApp API v2.0")
  console.log(" Port:", PORT)
  console.log("==========================================")
})
