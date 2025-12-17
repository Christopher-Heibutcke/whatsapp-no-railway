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
let isClientReady = false
let isStoreReady = false
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 5

const messageQueue = []
let isProcessingQueue = false

// Não depende mais de window.Store que pode não estar exposto
async function probeStoreReady(maxAttempts = 15, delayMs = 3000) {
  console.log("[WhatsApp] ========================================")
  console.log("[WhatsApp] Probing WhatsApp Store availability...")
  console.log("[WhatsApp] Max attempts:", maxAttempts, "Delay:", delayMs + "ms")
  console.log("[WhatsApp] ========================================")

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[WhatsApp] Probe attempt ${attempt}/${maxAttempts}...`)

      if (!whatsappClient || !isClientReady) {
        console.log("[WhatsApp] Client not ready yet, waiting...")
        await new Promise((r) => setTimeout(r, delayMs))
        continue
      }

      // Tentar chamar getChats() com timeout curto para testar se o Store está pronto
      const testPromise = whatsappClient.getChats()
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Probe timeout")), 10000))

      const testChats = await Promise.race([testPromise, timeoutPromise])

      // Se chegou aqui, getChats() funcionou!
      console.log("[WhatsApp] ========================================")
      console.log("[WhatsApp] STORE PROBE SUCCESSFUL!")
      console.log("[WhatsApp] Found", testChats.length, "chats")
      console.log("[WhatsApp] ========================================")

      isStoreReady = true
      return { ready: true, chatCount: testChats.length }
    } catch (error) {
      console.log(`[WhatsApp] Probe attempt ${attempt} failed:`, error.message)

      // Se for erro de "Cannot read properties of undefined", o Store não está pronto
      if (
        error.message.includes("Cannot read properties") ||
        error.message.includes("Store") ||
        error.message.includes("Probe timeout")
      ) {
        console.log(`[WhatsApp] Store not ready yet, waiting ${delayMs}ms...`)
        await new Promise((r) => setTimeout(r, delayMs))
      } else {
        // Outro tipo de erro, pode ser problema diferente
        console.error(`[WhatsApp] Unexpected error during probe:`, error.message)
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }
  }

  console.log("[WhatsApp] ========================================")
  console.log("[WhatsApp] WARNING: Store probe failed after all attempts")
  console.log("[WhatsApp] ========================================")

  return { ready: false, chatCount: 0 }
}

async function getChatsWithRetry(maxRetries = 5, initialDelay = 2000) {
  let lastError = null

  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      const delay = initialDelay * Math.pow(1.5, retry)

      if (retry > 0) {
        console.log(`[WhatsApp] Retry ${retry}/${maxRetries} - waiting ${Math.round(delay)}ms...`)
        await new Promise((r) => setTimeout(r, delay))
      }

      console.log(`[WhatsApp] Calling getChats() attempt ${retry + 1}/${maxRetries}...`)

      // Timeout de 30 segundos para getChats
      const getChatsPromise = whatsappClient.getChats()
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("getChats timeout after 30 seconds")), 30000),
      )

      const chats = await Promise.race([getChatsPromise, timeoutPromise])

      console.log(`[WhatsApp] SUCCESS! Retrieved ${chats.length} chats`)
      isStoreReady = true
      return chats
    } catch (error) {
      lastError = error
      console.error(`[WhatsApp] getChats attempt ${retry + 1} failed:`, error.message)

      // Se for erro de Store, marcar como não pronto
      if (error.message.includes("Cannot read properties of undefined") || error.message.includes("Store")) {
        isStoreReady = false
      }
    }
  }

  throw lastError || new Error("Failed to get chats after all retries")
}

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
  console.log("[WhatsApp] ========================================")
  console.log("[WhatsApp] Starting WhatsApp client initialization...")
  console.log("[WhatsApp] ========================================")

  isStoreReady = false

  const possiblePaths = [
    "/usr/bin/chromium",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    process.env.PUPPETEER_EXECUTABLE_PATH,
  ].filter(Boolean)

  let chromiumPath = null

  console.log("[WhatsApp] Searching for Chromium executable...")
  for (const path of possiblePaths) {
    console.log(`[WhatsApp]   Checking: ${path}`)
    if (fs.existsSync(path)) {
      chromiumPath = path
      console.log(`[WhatsApp]   FOUND: ${chromiumPath}`)
      break
    }
  }

  if (!chromiumPath) {
    console.error("[WhatsApp] ========================================")
    console.error("[WhatsApp] ERROR: Chromium not found!")
    console.error("[WhatsApp] Checked paths:", possiblePaths)
    console.error("[WhatsApp] ========================================")
    throw new Error("Chromium executable not found")
  }

  console.log("[WhatsApp] ========================================")
  console.log("[WhatsApp] Initializing WhatsApp Client...")
  console.log(`[WhatsApp] Chromium: ${chromiumPath}`)
  console.log("[WhatsApp] ========================================")

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
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
    },
    webVersionCache: {
      type: "remote",
      remotePath: "https://raw.githubusercontent.com/ArifRios1st/webwhatsapp-version/main/webVersion.json",
    },
  })

  whatsappClient.on("qr", async (qr) => {
    console.log("[WhatsApp] ========================================")
    console.log("[WhatsApp] QR CODE RECEIVED!")
    console.log("[WhatsApp] ========================================")

    try {
      qrCodeData = await qrcode.toDataURL(qr)
      console.log("[WhatsApp] QR Code converted to Data URL")

      io.emit("qr", qrCodeData)
      console.log("[WhatsApp] QR Code emitted via Socket.IO")
      console.log("[WhatsApp] ========================================")
    } catch (error) {
      console.error("[WhatsApp] ERROR generating QR code:", error)
    }
  })

  whatsappClient.on("loading_screen", (percent, message) => {
    console.log(`[WhatsApp] Loading: ${percent}% - ${message}`)
    io.emit("loading", { percent, message })
  })

  whatsappClient.on("authenticated", async () => {
    console.log("[WhatsApp] ========================================")
    console.log("[WhatsApp] AUTHENTICATED SUCCESSFULLY!")
    console.log("[WhatsApp] ========================================")
    reconnectAttempts = 0
    io.emit("authenticated", { success: true })
  })

  whatsappClient.on("ready", async () => {
    console.log("[WhatsApp] ========================================")
    console.log("[WhatsApp] WHATSAPP CLIENT IS READY!")
    console.log("[WhatsApp] ========================================")

    isConnected = true
    isClientReady = true
    qrCodeData = null

    io.emit("ready", { connected: true, timestamp: new Date().toISOString() })

    // O WhatsApp Web precisa de tempo para carregar todos os dados internos
    console.log("[WhatsApp] Waiting 10 seconds for WhatsApp Web to fully load...")
    await new Promise((r) => setTimeout(r, 10000))

    console.log("[WhatsApp] Starting store probe...")

    const probeResult = await probeStoreReady(20, 3000) // Até 60 segundos de espera total

    if (probeResult.ready) {
      console.log("[WhatsApp] ========================================")
      console.log("[WhatsApp] STORE IS READY - Found", probeResult.chatCount, "chats")
      console.log("[WhatsApp] ========================================")
      io.emit("authenticated_ready", {
        connected: true,
        storeReady: true,
        chatCount: probeResult.chatCount,
        timestamp: new Date().toISOString(),
      })
      io.emit("store_ready", { ready: true, chatCount: probeResult.chatCount })
    } else {
      console.log("[WhatsApp] ========================================")
      console.log("[WhatsApp] WARNING: Store probe failed")
      console.log("[WhatsApp] Chats may load on first request")
      console.log("[WhatsApp] ========================================")
      io.emit("authenticated_ready", {
        connected: true,
        storeReady: false,
        timestamp: new Date().toISOString(),
      })
    }

    try {
      const conn = await mysql.createConnection(dbConfig)
      await conn.execute("UPDATE whatsapp_config SET status = ?, last_connected = NOW() WHERE id = 1", ["connected"])
      await conn.end()
      console.log("[WhatsApp] Database updated: CONNECTED")
    } catch (error) {
      console.error("[WhatsApp] Error updating database:", error)
    }

    console.log("[WhatsApp] ========================================")
    console.log("[WhatsApp] CLIENT FULLY READY")
    console.log("[WhatsApp] ========================================")
  })

  whatsappClient.on("auth_failure", (msg) => {
    console.error("[WhatsApp] Authentication FAILURE:", msg)
    isConnected = false
    isStoreReady = false
    io.emit("auth_failure", { message: msg })
  })

  whatsappClient.on("disconnected", async (reason) => {
    console.log("[WhatsApp] Disconnected:", reason)
    isConnected = false
    isClientReady = false
    isStoreReady = false
    qrCodeData = null
    io.emit("disconnected", { reason })

    try {
      const conn = await mysql.createConnection(dbConfig)
      await conn.execute("UPDATE whatsapp_config SET status = ? WHERE id = 1", ["disconnected"])
      await conn.end()
    } catch (error) {
      console.error("[WhatsApp] Error updating database:", error)
    }

    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS && reason !== "LOGOUT") {
      reconnectAttempts++
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
      console.log(
        `[WhatsApp] Attempting reconnection ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay / 1000}s...`,
      )

      setTimeout(() => {
        console.log("[WhatsApp] Reinitializing client...")
        initializeWhatsApp()
      }, delay)
    }
  })

  whatsappClient.on("change_state", (state) => {
    console.log("[WhatsApp] State changed:", state)
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
      console.error("[WhatsApp] Error handling message:", error)
    }
  })

  whatsappClient.on("error", (error) => {
    console.error("[WhatsApp] ========================================")
    console.error("[WhatsApp] CLIENT ERROR:")
    console.error("[WhatsApp]", error.message)
    console.error("[WhatsApp] ========================================")
    io.emit("error", { message: error.message })
  })

  console.log("[WhatsApp] Starting client initialization...")
  whatsappClient.initialize().catch((err) => {
    console.error("[WhatsApp] ========================================")
    console.error("[WhatsApp] INITIALIZATION ERROR:")
    console.error("[WhatsApp]", err.message)
    console.error("[WhatsApp] ========================================")
  })
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
    clientReady: isClientReady,
    storeReady: isStoreReady,
    qrCode: qrCodeData,
    reconnectAttempts: reconnectAttempts,
  })
})

app.post("/api/connect", (req, res) => {
  console.log("[WhatsApp] ========================================")
  console.log("[WhatsApp] POST /api/connect received")
  console.log("[WhatsApp] Current status - Connected:", isConnected)
  console.log("[WhatsApp] ========================================")

  if (!whatsappClient || !isConnected) {
    reconnectAttempts = 0
    isStoreReady = false
    console.log("[WhatsApp] Starting WhatsApp connection...")
    try {
      initializeWhatsApp()
      res.json({ success: true, message: "Connecting to WhatsApp..." })
    } catch (error) {
      console.error("[WhatsApp] Error starting connection:", error)
      res.json({ success: false, message: error.message })
    }
  } else {
    console.log("[WhatsApp] Already connected!")
    res.json({ success: false, message: "Already connected" })
  }
})

app.post("/api/disconnect", async (req, res) => {
  try {
    if (whatsappClient) {
      await whatsappClient.destroy()
      whatsappClient = null
      isConnected = false
      isClientReady = false
      isStoreReady = false
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
    console.error("[WhatsApp] Error disconnecting:", error)
    res.json({ success: false, message: error.message })
  }
})

app.get("/api/chats", async (req, res) => {
  console.log("[WhatsApp] ========================================")
  console.log("[WhatsApp] GET /api/chats requested")
  console.log("[WhatsApp] isConnected:", isConnected)
  console.log("[WhatsApp] isClientReady:", isClientReady)
  console.log("[WhatsApp] isStoreReady:", isStoreReady)
  console.log("[WhatsApp] ========================================")

  try {
    if (!isConnected || !whatsappClient) {
      console.log("[WhatsApp] WhatsApp not connected")
      return res.json({ success: false, message: "WhatsApp not connected" })
    }

    if (!isClientReady) {
      console.log("[WhatsApp] Client not ready yet")
      return res.json({ success: false, message: "WhatsApp is still initializing, please wait..." })
    }

    // Se o Store não está marcado como pronto, tentar mesmo assim
    // pois o probe pode ter falhado mas o Store pode estar disponível agora
    if (!isStoreReady) {
      console.log("[WhatsApp] Store not marked as ready, will try getChats anyway...")
    }

    console.log("[WhatsApp] Fetching chats with retry mechanism...")

    let chats
    try {
      chats = await getChatsWithRetry(5, 2000)
      console.log("[WhatsApp] Successfully retrieved", chats.length, "chats")
    } catch (getChatsError) {
      console.error("[WhatsApp] ========================================")
      console.error("[WhatsApp] ERROR getting chats after all retries:")
      console.error("[WhatsApp] Message:", getChatsError.message)
      console.error("[WhatsApp] ========================================")

      isStoreReady = false

      return res.json({
        success: false,
        message: "WhatsApp is still loading your conversations. Please wait 30-60 seconds and try again.",
        error: getChatsError.message,
        suggestion:
          "This is normal after connecting. If it persists for more than 2 minutes, try disconnecting and reconnecting.",
      })
    }

    // Processar os chats
    console.log("[WhatsApp] Processing", Math.min(chats.length, 50), "chats...")

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
          console.error("[WhatsApp] Error processing chat:", error.message)
          return {
            id: chat.id._serialized,
            name: chat.name || chat.id.user || "Unknown",
            isGroup: chat.isGroup,
            unreadCount: chat.unreadCount || 0,
            lastMessage: null,
          }
        }
      }),
    )

    const filteredChats = chatList.filter((c) => c !== null)
    console.log("[WhatsApp] Returning", filteredChats.length, "chats")
    console.log("[WhatsApp] ========================================")

    res.json({ success: true, chats: filteredChats, storeReady: true, total: chats.length })
  } catch (error) {
    console.error("[WhatsApp] ========================================")
    console.error("[WhatsApp] UNEXPECTED ERROR in /api/chats:")
    console.error("[WhatsApp] Message:", error.message)
    console.error("[WhatsApp] Stack:", error.stack)
    console.error("[WhatsApp] ========================================")
    res.json({ success: false, message: error.message })
  }
})

app.post("/api/check-store", async (req, res) => {
  console.log("[WhatsApp] POST /api/check-store requested")

  if (!whatsappClient || !isClientReady) {
    return res.json({ success: false, message: "WhatsApp client not ready", storeReady: false })
  }

  try {
    const probeResult = await probeStoreReady(5, 2000)
    res.json({ success: true, storeReady: probeResult.ready, chatCount: probeResult.chatCount })
  } catch (error) {
    res.json({ success: false, message: error.message, storeReady: false })
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
    console.error("[WhatsApp] Error fetching messages:", error)
    res.json({ success: false, message: error.message })
  }
})

app.post("/api/send", async (req, res) => {
  try {
    const { number, message } = req.body

    if (!isConnected || !whatsappClient) {
      return res.json({ success: false, message: "WhatsApp not connected" })
    }

    const formattedNumber = number.includes("@c.us") ? number : `${number}@c.us`
    const result = await whatsappClient.sendMessage(formattedNumber, message)

    res.json({ success: true, messageId: result.id._serialized })
  } catch (error) {
    console.error("[WhatsApp] Error sending message:", error)
    res.json({ success: false, message: error.message })
  }
})

app.post("/api/send-media", async (req, res) => {
  try {
    const { number, mediaUrl, caption, mimetype } = req.body

    if (!isConnected || !whatsappClient) {
      return res.json({ success: false, message: "WhatsApp not connected" })
    }

    const media = await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true })
    if (mimetype) media.mimetype = mimetype

    const formattedNumber = number.includes("@c.us") ? number : `${number}@c.us`
    const result = await whatsappClient.sendMessage(formattedNumber, media, { caption })

    res.json({ success: true, messageId: result.id._serialized })
  } catch (error) {
    console.error("[WhatsApp] Error sending media:", error)
    res.json({ success: false, message: error.message })
  }
})

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log("[Socket.IO] Client connected:", socket.id)

  // Enviar status atual imediatamente
  socket.emit("status", {
    connected: isConnected,
    clientReady: isClientReady,
    storeReady: isStoreReady,
    qrCode: qrCodeData,
  })

  if (qrCodeData && !isConnected) {
    socket.emit("qr", qrCodeData)
  }

  socket.on("disconnect", () => {
    console.log("[Socket.IO] Client disconnected:", socket.id)
  })

  socket.on("request_status", () => {
    socket.emit("status", {
      connected: isConnected,
      clientReady: isClientReady,
      storeReady: isStoreReady,
      qrCode: qrCodeData,
    })
  })
})

// Start server
const PORT = process.env.PORT || 3000

server.listen(PORT, () => {
  console.log("==================================================")
  console.log("==================================================")
  console.log(`[Server] EyesCloud WhatsApp API v2.2.0`)
  console.log(`[Server] Running on port ${PORT}`)
  console.log(`[Server] Environment: ${process.env.NODE_ENV || "development"}`)
  console.log("==================================================")
  console.log("==================================================")
})

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("[Server] Shutting down gracefully...")
  if (whatsappClient) {
    await whatsappClient.destroy()
  }
  process.exit(0)
})

process.on("SIGTERM", async () => {
  console.log("[Server] SIGTERM received, shutting down...")
  if (whatsappClient) {
    await whatsappClient.destroy()
  }
  process.exit(0)
})
