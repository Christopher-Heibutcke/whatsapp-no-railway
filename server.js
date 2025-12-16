const express = require("express")
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js")
const qrcode = require("qrcode")
const cors = require("cors")
const mysql = require("mysql2/promise")
const http = require("http")
const socketIo = require("socket.io")
const fs = require("fs")

const app = express()
const server = http.createServer(app)

const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
  allowEIO3: true,
})

app.use(
  cors({
    origin: "*",
    credentials: true,
  }),
)
app.use(express.json())

const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "u517535970_eyesclound",
  password: process.env.DB_PASSWORD || "LDZV2eR2k$",
  database: process.env.DB_NAME || "u517535970_eyesclound",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 30000,
}

let whatsappClient = null
let qrCodeData = null
let isConnected = false
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 5

const messageQueue = []
let isProcessingQueue = false

async function processMessageQueue() {
  if (isProcessingQueue || messageQueue.length === 0) return

  isProcessingQueue = true

  while (messageQueue.length > 0) {
    const { chatId, message, resolve, reject } = messageQueue.shift()

    try {
      const delay = Math.random() * 2000 + 1000
      await new Promise((r) => setTimeout(r, delay))

      const result = await whatsappClient.sendMessage(chatId, message)
      resolve(result)
    } catch (error) {
      reject(error)
    }
  }

  isProcessingQueue = false
}

function initializeWhatsApp() {
  console.log("[v0] Initializing WhatsApp client...")

  const possiblePaths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ]

  let chromiumPath = "/usr/bin/chromium"

  for (const path of possiblePaths) {
    if (path && fs.existsSync(path)) {
      chromiumPath = path
      console.log("[v0] Found Chromium at:", chromiumPath)
      break
    }
  }

  console.log("[v0] Using Chromium path:", chromiumPath)

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
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process",
        "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      ],
      timeout: 60000,
    },
    webVersionCache: {
      type: "remote",
      remotePath: "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html",
    },
    qrMaxRetries: 5,
    takeoverOnConflict: false,
    takeoverTimeoutMs: 0,
  })

  whatsappClient.on("qr", async (qr) => {
    console.log("[v0] QR Code received! Generating data URL...")
    try {
      qrCodeData = await qrcode.toDataURL(qr)
      io.emit("qr", qrCodeData)
      console.log("[v0] QR Code emitted to all connected clients via Socket.IO")
      console.log("[v0] QR Code length:", qrCodeData.length, "characters")
    } catch (error) {
      console.error("[v0] ERROR generating QR code:", error)
    }
  })

  whatsappClient.on("loading_screen", (percent, message) => {
    console.log(`[v0] Loading: ${percent}% - ${message}`)
    io.emit("loading", { percent, message })
  })

  whatsappClient.on("authenticated", () => {
    console.log("[v0] Authenticated successfully!")
    reconnectAttempts = 0
    io.emit("authenticated", { success: true })
  })

  whatsappClient.on("ready", async () => {
    console.log("[v0] WhatsApp Client is READY!")
    isConnected = true
    qrCodeData = null
    io.emit("ready", { connected: true })

    try {
      const conn = await mysql.createConnection(dbConfig)
      await conn.execute("UPDATE whatsapp_config SET status = ?, last_connected = NOW() WHERE id = 1", ["connected"])
      await conn.end()
      console.log("[v0] Database updated: CONNECTED")
    } catch (error) {
      console.error("[v0] Error updating database:", error)
    }
  })

  whatsappClient.on("auth_failure", (msg) => {
    console.error("[v0] Authentication FAILURE:", msg)
    isConnected = false
    io.emit("auth_failure", { message: msg })
  })

  whatsappClient.on("disconnected", async (reason) => {
    console.log("[v0] Disconnected:", reason)
    isConnected = false
    qrCodeData = null
    io.emit("disconnected", { reason })

    try {
      const conn = await mysql.createConnection(dbConfig)
      await conn.execute("UPDATE whatsapp_config SET status = ? WHERE id = 1", ["disconnected"])
      await conn.end()
    } catch (error) {
      console.error("[v0] Error updating database:", error)
    }

    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS && reason !== "LOGOUT") {
      reconnectAttempts++
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
      console.log(`[v0] Attempting reconnection ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay / 1000}s...`)

      setTimeout(() => {
        console.log("[v0] Reinitializing client...")
        initializeWhatsApp()
      }, delay)
    }
  })

  whatsappClient.on("change_state", (state) => {
    console.log("[v0] State changed:", state)
  })

  whatsappClient.on("message", async (message) => {
    try {
      const conn = await mysql.createConnection(dbConfig)
      const contact = await message.getContact()

      await conn.execute(
        `INSERT INTO whatsapp_messages 
                (chat_id, contact_name, contact_number, message_text, message_type, 
                is_from_me, timestamp, media_url) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          message.from,
          contact.pushname || contact.number,
          contact.number,
          message.body,
          message.type,
          message.fromMe ? 1 : 0,
          new Date(message.timestamp * 1000),
          message.hasMedia ? "pending" : null,
        ],
      )

      io.emit("new_message", {
        id: message.id._serialized,
        chatId: message.from,
        contactName: contact.pushname || contact.number,
        contactNumber: contact.number,
        message: message.body,
        type: message.type,
        fromMe: message.fromMe,
        timestamp: message.timestamp,
      })

      await conn.end()
    } catch (error) {
      console.error("[v0] Error handling message:", error)
    }
  })

  whatsappClient.on("error", (error) => {
    console.error("[v0] Client ERROR:", error)
    io.emit("error", { message: error.message })
  })

  console.log("[v0] Starting WhatsApp client initialization...")
  whatsappClient.initialize()
}

// API Routes

app.get("/api/ping", (req, res) => {
  res.json({
    status: "alive",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  })
})

app.get("/api/status", (req, res) => {
  res.json({
    connected: isConnected,
    qrCode: qrCodeData,
    reconnectAttempts: reconnectAttempts,
  })
})

app.post("/api/connect", (req, res) => {
  console.log("[v0] POST /api/connect received")
  if (!whatsappClient || !isConnected) {
    reconnectAttempts = 0
    console.log("[v0] Starting WhatsApp connection...")
    initializeWhatsApp()
    res.json({ success: true, message: "Connecting to WhatsApp..." })
  } else {
    console.log("[v0] Already connected!")
    res.json({ success: false, message: "Already connected" })
  }
})

app.post("/api/disconnect", async (req, res) => {
  try {
    if (whatsappClient) {
      await whatsappClient.destroy()
      whatsappClient = null
      isConnected = false
      qrCodeData = null
      reconnectAttempts = 0

      const conn = await mysql.createConnection(dbConfig)
      await conn.execute("UPDATE whatsapp_config SET status = ? WHERE id = 1", ["disconnected"])
      await conn.end()

      res.json({ success: true })
    } else {
      res.json({ success: false, message: "Not connected" })
    }
  } catch (error) {
    console.error("[API] Error disconnecting:", error)
    res.json({ success: false, message: error.message })
  }
})

app.get("/api/chats", async (req, res) => {
  try {
    if (!isConnected || !whatsappClient) {
      return res.json({ success: false, message: "WhatsApp not connected" })
    }

    const chats = await whatsappClient.getChats()
    const chatList = await Promise.all(
      chats.slice(0, 50).map(async (chat) => {
        try {
          const contact = await chat.getContact()
          const lastMessage = chat.lastMessage

          return {
            id: chat.id._serialized,
            name: chat.name || contact.pushname || contact.number,
            isGroup: chat.isGroup,
            unreadCount: chat.unreadCount,
            lastMessage: lastMessage
              ? {
                  body: lastMessage.body,
                  timestamp: lastMessage.timestamp,
                }
              : null,
          }
        } catch (error) {
          console.error("[API] Error processing chat:", error)
          return null
        }
      }),
    )

    res.json({ success: true, chats: chatList.filter((c) => c !== null) })
  } catch (error) {
    console.error("[API] Error getting chats:", error)
    res.json({ success: false, message: error.message })
  }
})

app.get("/api/messages/:chatId", async (req, res) => {
  try {
    if (!isConnected || !whatsappClient) {
      const conn = await mysql.createConnection(dbConfig)
      const [messages] = await conn.execute(
        `SELECT * FROM whatsapp_messages 
            WHERE chat_id = ? 
            ORDER BY timestamp ASC 
            LIMIT 100`,
        [req.params.chatId],
      )
      await conn.end()
      return res.json({ success: true, messages })
    }

    const chat = await whatsappClient.getChatById(req.params.chatId)
    const messages = await chat.fetchMessages({ limit: 50 })

    const messageList = messages.map((msg) => ({
      id: msg.id._serialized,
      body: msg.body,
      fromMe: msg.fromMe,
      timestamp: msg.timestamp,
      type: msg.type,
    }))

    res.json({ success: true, messages: messageList })
  } catch (error) {
    console.error("[API] Error fetching messages:", error)
    res.json({ success: false, message: error.message })
  }
})

app.post("/api/send-message", async (req, res) => {
  try {
    const { chatId, message, funcionarioId, funcionarioNome } = req.body

    if (!isConnected || !whatsappClient) {
      return res.json({ success: false, error: "WhatsApp not connected" })
    }

    if (!chatId || !message) {
      return res.json({ success: false, error: "Missing required fields" })
    }

    const sendPromise = new Promise((resolve, reject) => {
      messageQueue.push({ chatId, message, resolve, reject })
    })

    processMessageQueue()

    await sendPromise

    const conn = await mysql.createConnection(dbConfig)
    await conn.execute(
      `INSERT INTO whatsapp_messages 
            (chat_id, message_text, message_type, is_from_me, timestamp, 
            funcionario_id, funcionario_nome) 
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [chatId, message, "chat", 1, new Date(), funcionarioId, funcionarioNome],
    )

    await conn.execute(
      `INSERT INTO whatsapp_activity_log 
            (funcionario_id, funcionario_nome, chat_id, action, timestamp) 
            VALUES (?, ?, ?, ?, ?)`,
      [funcionarioId, funcionarioNome, chatId, "send_message", new Date()],
    )

    await conn.end()

    io.emit("message_sent", {
      chatId,
      message,
      funcionarioNome,
      timestamp: new Date(),
    })

    res.json({ success: true })
  } catch (error) {
    console.error("[API] Error sending message:", error)
    res.json({ success: false, error: error.message })
  }
})

app.get("/api/quick-replies", async (req, res) => {
  try {
    const conn = await mysql.createConnection(dbConfig)
    const [replies] = await conn.execute("SELECT * FROM whatsapp_quick_replies WHERE ativo = 1 ORDER BY ordem")
    await conn.end()

    res.json({ success: true, replies })
  } catch (error) {
    res.json({ success: false, message: error.message })
  }
})

app.get("/api/activity/:funcionarioId?", async (req, res) => {
  try {
    const conn = await mysql.createConnection(dbConfig)
    let query = "SELECT * FROM whatsapp_activity_log ORDER BY timestamp DESC LIMIT 100"
    let params = []

    if (req.params.funcionarioId) {
      query = "SELECT * FROM whatsapp_activity_log WHERE funcionario_id = ? ORDER BY timestamp DESC LIMIT 100"
      params = [req.params.funcionarioId]
    }

    const [activity] = await conn.execute(query, params)
    await conn.end()

    res.json({ success: true, activity })
  } catch (error) {
    res.json({ success: false, message: error.message })
  }
})

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    connected: isConnected,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
  })
})

app.get("/", (req, res) => {
  res.json({
    name: "EyesCloud WhatsApp API",
    version: "2.0.0",
    status: isConnected ? "connected" : "disconnected",
    endpoints: {
      status: "/api/status",
      connect: "/api/connect (POST)",
      disconnect: "/api/disconnect (POST)",
      chats: "/api/chats",
      messages: "/api/messages/:chatId",
      send: "/api/send-message (POST)",
      health: "/health",
    },
  })
})

io.on("connection", (socket) => {
  console.log("[v0] Socket.IO client connected:", socket.id)

  socket.emit("status", {
    connected: isConnected,
    qrCode: qrCodeData,
    reconnectAttempts: reconnectAttempts,
  })

  socket.on("disconnect", () => {
    console.log("[v0] Socket.IO client disconnected:", socket.id)
  })
})

process.on("SIGTERM", async () => {
  console.log("[Server] SIGTERM received, closing gracefully...")
  if (whatsappClient) {
    await whatsappClient.destroy()
  }
  server.close(() => {
    console.log("[Server] Server closed")
    process.exit(0)
  })
})

process.on("SIGINT", async () => {
  console.log("[Server] SIGINT received, closing gracefully...")
  if (whatsappClient) {
    await whatsappClient.destroy()
  }
  server.close(() => {
    console.log("[Server] Server closed")
    process.exit(0)
  })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, "0.0.0.0", () => {
  console.log("=".repeat(50))
  console.log("[Server] EyesCloud WhatsApp API v2.0")
  console.log(`[Server] Running on port ${PORT}`)
  console.log(`[Server] Environment: ${process.env.NODE_ENV || "development"}`)
  console.log(`[Server] Database: ${dbConfig.database}@${dbConfig.host}`)
  console.log("=".repeat(50))
})
