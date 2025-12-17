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

async function waitForStore(maxAttempts = 10, delayMs = 2000) {
  console.log("[v0] ========================================")
  console.log("[v0] Waiting for WhatsApp Store to be ready...")
  console.log("[v0] ========================================")

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[v0] Store check attempt ${attempt}/${maxAttempts}...`)

      // Verificar se o cliente existe e está pronto
      if (!whatsappClient || !isClientReady) {
        console.log("[v0] Client not ready yet, waiting...")
        await new Promise((r) => setTimeout(r, delayMs))
        continue
      }

      // Tentar acessar o Store através do pupPage
      const pupPage = whatsappClient.pupPage
      if (!pupPage) {
        console.log("[v0] Puppeteer page not available yet...")
        await new Promise((r) => setTimeout(r, delayMs))
        continue
      }

      // Verificar se o Store está disponível no WhatsApp Web
      const storeAvailable = await pupPage
        .evaluate(() => {
          return (
            typeof window.Store !== "undefined" &&
            window.Store !== null &&
            typeof window.Store.Chat !== "undefined" &&
            window.Store.Chat !== null
          )
        })
        .catch(() => false)

      if (storeAvailable) {
        console.log("[v0] ========================================")
        console.log("[v0] WhatsApp Store is READY!")
        console.log("[v0] ========================================")
        isStoreReady = true
        return true
      }

      console.log(`[v0] Store not available yet (attempt ${attempt}), waiting ${delayMs}ms...`)
      await new Promise((r) => setTimeout(r, delayMs))
    } catch (error) {
      console.error(`[v0] Error checking store (attempt ${attempt}):`, error.message)
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }

  console.log("[v0] ========================================")
  console.log("[v0] WARNING: Store check timed out after all attempts")
  console.log("[v0] ========================================")
  return false
}

async function getChatsWithRetry(maxRetries = 3, initialDelay = 3000) {
  let lastError = null

  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      const delay = initialDelay * Math.pow(1.5, retry) // Backoff exponencial

      if (retry > 0) {
        console.log(`[v0] Retry ${retry}/${maxRetries} - waiting ${delay}ms before trying again...`)
        await new Promise((r) => setTimeout(r, delay))
      }

      // Verificar se o Store está pronto antes de tentar
      if (!isStoreReady) {
        console.log("[v0] Store not ready, checking...")
        const storeReady = await waitForStore(5, 2000)
        if (!storeReady) {
          throw new Error("Store not available after waiting")
        }
      }

      console.log("[v0] Attempting to get chats...")

      // Usar Promise.race com timeout
      const getChatsPromise = whatsappClient.getChats()
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("getChats timeout after 20 seconds")), 20000),
      )

      const chats = await Promise.race([getChatsPromise, timeoutPromise])

      console.log(`[v0] Successfully retrieved ${chats.length} chats!`)
      return chats
    } catch (error) {
      lastError = error
      console.error(`[v0] Error getting chats (attempt ${retry + 1}/${maxRetries}):`, error.message)

      // Se for erro de Store, marcar como não pronto para forçar nova verificação
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
  console.log("[v0] ========================================")
  console.log("[v0] Starting WhatsApp client initialization...")
  console.log("[v0] ========================================")

  isStoreReady = false

  const possiblePaths = [
    "/usr/bin/chromium",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    process.env.PUPPETEER_EXECUTABLE_PATH,
  ].filter(Boolean)

  let chromiumPath = null

  console.log("[v0] Searching for Chromium executable...")
  for (const path of possiblePaths) {
    console.log(`[v0]   Checking: ${path}`)
    if (fs.existsSync(path)) {
      chromiumPath = path
      console.log(`[v0]   ✓ FOUND: ${chromiumPath}`)
      break
    }
  }

  if (!chromiumPath) {
    console.error("[v0] ========================================")
    console.error("[v0] ERROR: Chromium not found!")
    console.error("[v0] Checked paths:", possiblePaths)
    console.error("[v0] ========================================")
    throw new Error("Chromium executable not found")
  }

  console.log("[v0] ========================================")
  console.log("[v0] Initializing WhatsApp Client...")
  console.log(`[v0] Chromium: ${chromiumPath}`)
  console.log("[v0] ========================================")

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
  })

  whatsappClient.on("qr", async (qr) => {
    console.log("[v0] ========================================")
    console.log("[v0] QR CODE RECEIVED!")
    console.log("[v0] ========================================")
    console.log("[v0] QR Code string length:", qr.length)

    try {
      qrCodeData = await qrcode.toDataURL(qr)
      console.log("[v0] QR Code converted to Data URL")
      console.log("[v0] Data URL length:", qrCodeData.length)

      io.emit("qr", qrCodeData)
      console.log("[v0] QR Code emitted via Socket.IO to all clients")
      console.log("[v0] ========================================")
    } catch (error) {
      console.error("[v0] ERROR generating QR code:", error)
      console.error("[v0] ========================================")
    }
  })

  whatsappClient.on("loading_screen", (percent, message) => {
    console.log(`[v0] Loading: ${percent}% - ${message}`)
    io.emit("loading", { percent, message })
  })

  whatsappClient.on("authenticated", async () => {
    console.log("[v0] ========================================")
    console.log("[v0] AUTHENTICATED SUCCESSFULLY!")
    console.log("[v0] ========================================")
    reconnectAttempts = 0
    io.emit("authenticated", { success: true })

    console.log("[v0] Waiting for ready event to confirm WhatsApp is fully loaded...")

    setTimeout(() => {
      if (!isClientReady && !isConnected) {
        console.log("[v0] ========================================")
        console.log("[v0] WARNING: Ready event not received after 45 seconds")
        console.log("[v0] Forcing ready state...")
        console.log("[v0] ========================================")
        isConnected = true
        isClientReady = true
        qrCodeData = null
        io.emit("ready", { connected: true, timestamp: new Date().toISOString(), forced: true })
        io.emit("authenticated_ready", { connected: true, timestamp: new Date().toISOString(), forced: true })

        waitForStore(15, 3000).then((ready) => {
          console.log("[v0] Forced ready - Store check result:", ready)
        })
      }
    }, 45000)
  })

  whatsappClient.on("ready", async () => {
    console.log("[v0] ========================================")
    console.log("[v0] WHATSAPP CLIENT IS READY!")
    console.log("[v0] ========================================")

    isConnected = true
    isClientReady = true
    qrCodeData = null

    console.log("[v0] Emitting ready events to frontend...")
    io.emit("ready", { connected: true, timestamp: new Date().toISOString() })

    console.log("[v0] Waiting for WhatsApp Store to initialize...")

    // Aguardar um tempo inicial para o Store carregar
    await new Promise((r) => setTimeout(r, 5000))

    // Verificar se o Store está pronto
    const storeReady = await waitForStore(15, 3000) // Até 45 segundos de espera

    if (storeReady) {
      console.log("[v0] ========================================")
      console.log("[v0] STORE IS READY - Emitting authenticated_ready")
      console.log("[v0] ========================================")
      io.emit("authenticated_ready", { connected: true, storeReady: true, timestamp: new Date().toISOString() })
    } else {
      console.log("[v0] ========================================")
      console.log("[v0] WARNING: Store not ready but emitting authenticated_ready anyway")
      console.log("[v0] ========================================")
      io.emit("authenticated_ready", { connected: true, storeReady: false, timestamp: new Date().toISOString() })
    }

    try {
      const conn = await mysql.createConnection(dbConfig)
      await conn.execute("UPDATE whatsapp_config SET status = ?, last_connected = NOW() WHERE id = 1", ["connected"])
      await conn.end()
      console.log("[v0] Database updated: CONNECTED")
    } catch (error) {
      console.error("[v0] Error updating database:", error)
    }

    console.log("[v0] ========================================")
    console.log("[v0] CLIENT FULLY READY - Frontend can now load chats")
    console.log("[v0] ========================================")
  })

  whatsappClient.on("auth_failure", (msg) => {
    console.error("[v0] Authentication FAILURE:", msg)
    isConnected = false
    isStoreReady = false
    io.emit("auth_failure", { message: msg })
  })

  whatsappClient.on("disconnected", async (reason) => {
    console.log("[v0] Disconnected:", reason)
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
    console.error("[v0] ========================================")
    console.error("[v0] CLIENT ERROR:")
    console.error("[v0]", error.message)
    console.error("[v0] Stack:", error.stack)
    console.error("[v0] ========================================")
    io.emit("error", { message: error.message })
  })

  console.log("[v0] Starting client initialization...")
  whatsappClient.initialize().catch((err) => {
    console.error("[v0] ========================================")
    console.error("[v0] INITIALIZATION ERROR:")
    console.error("[v0]", err.message)
    console.error("[v0] Stack:", err.stack)
    console.error("[v0] ========================================")
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
  console.log("[v0] ========================================")
  console.log("[v0] POST /api/connect received")
  console.log("[v0] Current status - Connected:", isConnected)
  console.log("[v0] Current status - Client exists:", !!whatsappClient)
  console.log("[v0] ========================================")

  if (!whatsappClient || !isConnected) {
    reconnectAttempts = 0
    isStoreReady = false
    console.log("[v0] Starting WhatsApp connection...")
    try {
      initializeWhatsApp()
      res.json({ success: true, message: "Connecting to WhatsApp..." })
    } catch (error) {
      console.error("[v0] Error starting connection:", error)
      res.json({ success: false, message: error.message })
    }
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
    console.error("[API] Error disconnecting:", error)
    res.json({ success: false, message: error.message })
  }
})

app.get("/api/chats", async (req, res) => {
  console.log("[v0] ========================================")
  console.log("[v0] GET /api/chats requested")
  console.log("[v0] isConnected:", isConnected)
  console.log("[v0] isClientReady:", isClientReady)
  console.log("[v0] isStoreReady:", isStoreReady)
  console.log("[v0] whatsappClient exists:", !!whatsappClient)
  console.log("[v0] ========================================")

  try {
    if (!isConnected || !whatsappClient) {
      console.log("[v0] WhatsApp not connected - returning error")
      return res.json({ success: false, message: "WhatsApp not connected" })
    }

    if (!isClientReady) {
      console.log("[v0] Client not fully ready yet - returning error")
      return res.json({ success: false, message: "WhatsApp is still initializing, please wait..." })
    }

    if (!isStoreReady) {
      console.log("[v0] Store not ready, attempting to wait...")
      const storeReady = await waitForStore(10, 2000) // Aguarda até 20 segundos

      if (!storeReady) {
        console.log("[v0] Store still not ready after waiting")
        return res.json({
          success: false,
          message: "WhatsApp Store is still loading. Please wait 30-60 seconds and try again.",
          storeReady: false,
          suggestion:
            "The WhatsApp internal data is still loading. This is normal after connecting. Please wait and refresh.",
        })
      }
    }

    console.log("[v0] All checks passed, fetching chats with retry mechanism...")

    let chats
    try {
      chats = await getChatsWithRetry(3, 3000)
      console.log("[v0] getChats() successful! Total chats:", chats.length)
    } catch (getChatsError) {
      console.error("[v0] ========================================")
      console.error("[v0] ERROR IN getChats() after all retries:")
      console.error("[v0] Message:", getChatsError.message)
      console.error("[v0] ========================================")

      // Resetar o status do Store para forçar nova verificação na próxima tentativa
      isStoreReady = false

      return res.json({
        success: false,
        message: "WhatsApp Store is not fully loaded yet. Please wait 30-60 seconds and refresh the page.",
        error: getChatsError.message,
        suggestion: "Try disconnecting and reconnecting if this persists for more than 2 minutes.",
      })
    }

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
          console.error("[v0] Error processing individual chat:", error.message)
          return null
        }
      }),
    )

    const filteredChats = chatList.filter((c) => c !== null)
    console.log("[v0] Processed chats successfully:", filteredChats.length)
    console.log("[v0] ========================================")

    res.json({ success: true, chats: filteredChats, storeReady: true })
  } catch (error) {
    console.error("[v0] ========================================")
    console.error("[v0] ERROR in /api/chats:")
    console.error("[v0] Message:", error.message)
    console.error("[v0] Stack:", error.stack)
    console.error("[v0] ========================================")
    res.json({ success: false, message: error.message })
  }
})

app.post("/api/check-store", async (req, res) => {
  console.log("[v0] ========================================")
  console.log("[v0] POST /api/check-store requested")
  console.log("[v0] ========================================")

  if (!whatsappClient || !isClientReady) {
    return res.json({ success: false, message: "WhatsApp client not ready", storeReady: false })
  }

  try {
    const storeReady = await waitForStore(10, 2000)
    res.json({ success: true, storeReady: storeReady })
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
    clientReady: isClientReady,
    storeReady: isStoreReady,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
  })
})

app.get("/", (req, res) => {
  res.json({
    name: "EyesCloud WhatsApp API",
    version: "2.1.0",
    status: isConnected ? "connected" : "disconnected",
    storeReady: isStoreReady,
    endpoints: {
      status: "/api/status",
      connect: "/api/connect (POST)",
      disconnect: "/api/disconnect (POST)",
      checkStore: "/api/check-store (POST)",
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
    clientReady: isClientReady,
    storeReady: isStoreReady,
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
  console.log("[Server] EyesCloud WhatsApp API v2.1.0")
  console.log(`[Server] Running on port ${PORT}`)
  console.log(`[Server] Environment: ${process.env.NODE_ENV || "development"}`)
  console.log(`[Server] Database: ${dbConfig.database}@${dbConfig.host}`)
  console.log("=".repeat(50))
})
