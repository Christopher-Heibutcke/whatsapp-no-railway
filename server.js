/**
 * EyesCloud WhatsApp Backend v2.7.0
 * Servidor completo para integração WhatsApp Web
 *
 * CORREÇÕES:
 * - Fotos de perfil com tratamento de erro robusto
 * - Atualização em tempo real via Socket.IO
 * - Remoção de chamadas que causam erro no Store
 * - Gestão de sessão para evitar falhas
 * - Filas de requisição para evitar sobrecarga
 * - Melhor tratamento de fotos de perfil
 * - Reconexão em caso de fechamento de sessão
 */

const express = require("express")
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js")
const qrcode = require("qrcode")
const cors = require("cors")
const http = require("http")
const socketIo = require("socket.io")
const fs = require("fs")
const path = require("path")

// ============================================
// CONFIGURAÇÃO DO SERVIDOR
// ============================================

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
  pingTimeout: 60000,
  pingInterval: 25000,
})

app.use(
  cors({
    origin: "*",
    credentials: true,
  }),
)
app.use(express.json({ limit: "50mb" }))
app.use(express.urlencoded({ extended: true, limit: "50mb" }))

// ============================================
// VARIÁVEIS DE ESTADO GLOBAL
// ============================================

let whatsappClient = null
let qrCodeData = null
let isConnected = false
let isClientReady = false
let isInitializing = false
let reconnectAttempts = 0
let clientInfo = null
let isProcessingRequest = false
let requestQueue = []

const profilePicCache = new Map()
const CACHE_DURATION = 30 * 60 * 1000 // 30 minutos

const MAX_RECONNECT_ATTEMPTS = 5
const VERSION = "2.7.0"

// ============================================
// FUNÇÕES UTILITÁRIAS
// ============================================

function log(level, ...args) {
  const timestamp = new Date().toISOString()
  const prefix = `[${timestamp}] [WhatsApp] [${level.toUpperCase()}]`

  if (level === "error") {
    console.error(prefix, ...args)
  } else {
    console.log(prefix, ...args)
  }
}

function findChromiumPath() {
  const possiblePaths = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
  ].filter(Boolean)

  for (const chromePath of possiblePaths) {
    if (fs.existsSync(chromePath)) {
      log("info", `Chromium found at: ${chromePath}`)
      return chromePath
    }
  }

  log("error", "Chromium executable not found! Checked paths:", possiblePaths)
  return null
}

async function processQueue() {
  if (isProcessingRequest || requestQueue.length === 0) return

  isProcessingRequest = true
  const { fn, resolve, reject } = requestQueue.shift()

  try {
    const result = await fn()
    resolve(result)
  } catch (error) {
    reject(error)
  } finally {
    isProcessingRequest = false
    setTimeout(processQueue, 100)
  }
}

function queueRequest(fn) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ fn, resolve, reject })
    processQueue()
  })
}

async function getProfilePicSafe(targetId) {
  if (!targetId || !whatsappClient || !isClientReady) return null

  const cached = profilePicCache.get(targetId)
  if (cached && Date.now() - cached.time < CACHE_DURATION) {
    return cached.url
  }

  try {
    const picUrl = await Promise.race([
      whatsappClient.getProfilePicUrl(targetId),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 5000)),
    ])

    profilePicCache.set(targetId, { url: picUrl || null, time: Date.now() })
    return picUrl || null
  } catch (error) {
    profilePicCache.set(targetId, { url: null, time: Date.now() })
    return null
  }
}

function emitStatus() {
  const status = {
    connected: isConnected,
    clientReady: isClientReady,
    initializing: isInitializing,
    qrCode: qrCodeData,
    reconnectAttempts: reconnectAttempts,
    clientInfo: clientInfo,
    version: VERSION,
    timestamp: new Date().toISOString(),
  }

  io.emit("status", status)
  return status
}

function isClientHealthy() {
  return whatsappClient && isConnected && isClientReady
}

async function handleSessionError(error) {
  log("error", "Session error detected:", error.message)

  if (error.message.includes("Session closed") || error.message.includes("Protocol error")) {
    log("warn", "Session closed, attempting recovery...")

    isConnected = false
    isClientReady = false

    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++
      log("info", `Reconnecting attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}...`)

      setTimeout(() => {
        initializeWhatsApp()
      }, 5000)
    }
  }
}

// ============================================
// FUNÇÃO PRINCIPAL: INICIALIZAR WHATSAPP
// ============================================

function initializeWhatsApp() {
  if (isInitializing) {
    log("warn", "Already initializing, skipping...")
    return
  }

  log("info", "========================================")
  log("info", `Starting WhatsApp client v${VERSION}`)
  log("info", "========================================")

  isInitializing = true
  isConnected = false
  isClientReady = false
  qrCodeData = null
  clientInfo = null
  requestQueue = []
  profilePicCache.clear()

  emitStatus()

  const chromiumPath = findChromiumPath()
  if (!chromiumPath) {
    log("error", "Cannot start: Chromium not found")
    isInitializing = false
    io.emit("error", { message: "Chromium not found on server" })
    return
  }

  if (whatsappClient) {
    log("info", "Destroying previous client...")
    try {
      whatsappClient.destroy()
    } catch (e) {
      log("warn", "Error destroying previous client:", e.message)
    }
    whatsappClient = null
  }

  log("info", "Creating new WhatsApp client...")

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
        "--disable-software-rasterizer",
        "--disable-features=site-per-process",
        "--disable-features=IsolateOrigins",
        "--disable-site-isolation-trials",
      ],
      timeout: 120000,
    },
    webVersionCache: {
      type: "remote",
      remotePath: "https://raw.githubusercontent.com/ArifRios1st/webwhatsapp-version/main/webVersion.json",
    },
  })

  // ============================================
  // EVENTOS DO CLIENTE WHATSAPP
  // ============================================

  whatsappClient.on("qr", async (qr) => {
    log("info", "========================================")
    log("info", "QR CODE RECEIVED")
    log("info", "========================================")

    try {
      qrCodeData = await qrcode.toDataURL(qr, {
        errorCorrectionLevel: "M",
        margin: 2,
        scale: 8,
      })

      io.emit("qr", qrCodeData)
      emitStatus()

      log("info", "QR Code emitted to clients")
    } catch (error) {
      log("error", "Error generating QR code:", error)
    }
  })

  whatsappClient.on("loading_screen", (percent, message) => {
    log("info", `Loading: ${percent}% - ${message}`)
    io.emit("loading", { percent, message })
  })

  whatsappClient.on("authenticated", () => {
    log("info", "========================================")
    log("info", "AUTHENTICATED SUCCESSFULLY")
    log("info", "========================================")

    reconnectAttempts = 0
    qrCodeData = null

    io.emit("authenticated", { success: true })
    emitStatus()
  })

  whatsappClient.on("auth_failure", (msg) => {
    log("error", "========================================")
    log("error", "AUTHENTICATION FAILURE:", msg)
    log("error", "========================================")

    isConnected = false
    isClientReady = false
    isInitializing = false

    io.emit("auth_failure", { message: msg })
    emitStatus()
  })

  whatsappClient.on("ready", async () => {
    log("info", "========================================")
    log("info", "WHATSAPP CLIENT IS READY!")
    log("info", "========================================")

    isConnected = true
    isClientReady = true
    isInitializing = false
    qrCodeData = null

    try {
      const info = whatsappClient.info
      clientInfo = {
        pushname: info.pushname,
        wid: info.wid._serialized,
        platform: info.platform,
      }
      log("info", "Client info:", clientInfo)
    } catch (e) {
      log("warn", "Could not get client info:", e.message)
    }

    io.emit("ready", {
      connected: true,
      clientInfo: clientInfo,
      timestamp: new Date().toISOString(),
    })

    emitStatus()

    // Test chat access
    setTimeout(async () => {
      try {
        log("info", "Testing chat access...")
        const chats = await whatsappClient.getChats()
        log("info", `SUCCESS! Can access ${chats.length} chats`)

        io.emit("chats_ready", {
          ready: true,
          count: chats.length,
        })
      } catch (error) {
        log("warn", "Initial chat test failed:", error.message)
      }
    }, 3000)

    log("info", "========================================")
    log("info", "CLIENT FULLY INITIALIZED")
    log("info", "========================================")
  })

  whatsappClient.on("disconnected", async (reason) => {
    log("warn", "========================================")
    log("warn", "DISCONNECTED:", reason)
    log("warn", "========================================")

    isConnected = false
    isClientReady = false
    isInitializing = false
    qrCodeData = null
    clientInfo = null

    io.emit("disconnected", { reason })
    emitStatus()

    if (reason !== "LOGOUT" && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++
      const delay = Math.min(5000 * reconnectAttempts, 30000)

      log("info", `Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay / 1000}s...`)

      setTimeout(() => {
        initializeWhatsApp()
      }, delay)
    }
  })

  whatsappClient.on("message", async (message) => {
    try {
      // Obter nome do contato de forma segura
      let contactName = message.from.replace("@c.us", "").replace("@g.us", "")
      const contactNumber = message.from.replace("@c.us", "").replace("@g.us", "")

      // Tentar obter informações adicionais de forma segura
      try {
        const chat = await message.getChat()
        contactName = chat.name || contactName
      } catch (e) {
        // Use default values
      }

      const messageData = {
        id: message.id._serialized,
        chatId: message.from,
        contactName: contactName,
        contactNumber: contactNumber,
        message: message.body,
        body: message.body,
        type: message.type,
        fromMe: message.fromMe,
        timestamp: message.timestamp,
        hasMedia: message.hasMedia,
      }

      io.emit("new_message", messageData)
      log("info", `New message from ${messageData.contactName}: ${message.body?.substring(0, 50)}`)
    } catch (error) {
      log("error", "Error handling message:", error.message)
    }
  })

  whatsappClient.on("message_create", async (message) => {
    if (message.fromMe) {
      try {
        const messageData = {
          id: message.id._serialized,
          chatId: message.to,
          message: message.body,
          body: message.body,
          type: message.type,
          fromMe: true,
          timestamp: message.timestamp,
          hasMedia: message.hasMedia,
        }

        io.emit("message_sent", messageData)
        log("info", `Message sent to ${message.to}`)
      } catch (error) {
        log("error", "Error handling sent message:", error.message)
      }
    }
  })

  whatsappClient.on("error", (error) => {
    log("error", "Client error:", error.message)
    handleSessionError(error)
  })

  log("info", "Calling whatsappClient.initialize()...")

  whatsappClient
    .initialize()
    .then(() => {
      log("info", "Client initialize() completed")
    })
    .catch((error) => {
      log("error", "========================================")
      log("error", "INITIALIZATION ERROR:", error.message)
      log("error", "========================================")

      isInitializing = false
      io.emit("error", { message: "Failed to initialize WhatsApp: " + error.message })
      emitStatus()
    })
}

// ============================================
// ROTAS DA API
// ============================================

app.get("/api/ping", (req, res) => {
  res.json({
    status: "alive",
    version: VERSION,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  })
})

app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    connected: isConnected,
    clientReady: isClientReady,
    initializing: isInitializing,
    qrCode: qrCodeData,
    clientInfo: clientInfo,
    reconnectAttempts: reconnectAttempts,
    version: VERSION,
    timestamp: new Date().toISOString(),
  })
})

app.post("/api/connect", (req, res) => {
  log("info", "========================================")
  log("info", "POST /api/connect received")
  log("info", `Current state - Connected: ${isConnected}, Initializing: ${isInitializing}`)
  log("info", "========================================")

  if (isInitializing) {
    return res.json({
      success: false,
      message: "Already initializing, please wait...",
    })
  }

  if (isConnected && isClientReady) {
    return res.json({
      success: false,
      message: "Already connected",
    })
  }

  try {
    reconnectAttempts = 0
    initializeWhatsApp()

    res.json({
      success: true,
      message: "Connecting to WhatsApp...",
      version: VERSION,
    })
  } catch (error) {
    log("error", "Error starting connection:", error)
    res.json({
      success: false,
      message: error.message,
    })
  }
})

app.post("/api/disconnect", async (req, res) => {
  log("info", "POST /api/disconnect received")

  try {
    if (whatsappClient) {
      await whatsappClient.logout()
      await whatsappClient.destroy()
    }

    whatsappClient = null
    isConnected = false
    isClientReady = false
    isInitializing = false
    qrCodeData = null
    clientInfo = null
    reconnectAttempts = MAX_RECONNECT_ATTEMPTS
    profilePicCache.clear()

    io.emit("disconnected", { reason: "LOGOUT" })
    emitStatus()

    res.json({ success: true, message: "Disconnected successfully" })
  } catch (error) {
    log("error", "Error disconnecting:", error)

    whatsappClient = null
    isConnected = false
    isClientReady = false
    isInitializing = false
    qrCodeData = null

    res.json({
      success: true,
      message: "Disconnected (with cleanup)",
    })
  }
})

app.get("/api/chats", async (req, res) => {
  log("info", "========================================")
  log("info", "GET /api/chats")
  log("info", `State - Connected: ${isConnected}, Ready: ${isClientReady}`)
  log("info", "========================================")

  if (!isClientHealthy()) {
    return res.json({
      success: false,
      message: "WhatsApp client not initialized",
      chats: [],
    })
  }

  try {
    log("info", "Fetching chats...")

    const getChatsPromise = whatsappClient.getChats()
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout getting chats")), 60000),
    )

    const chats = await Promise.race([getChatsPromise, timeoutPromise])

    log("info", `Retrieved ${chats.length} chats, processing...`)

    const processedChats = []
    const chatsToProcess = chats.slice(0, 50)

    // Process chats in parallel for speed
    const chatPromises = chatsToProcess.map(async (chat) => {
      try {
        const contactName = chat.name || chat.id.user
        let profilePic = null

        // Get profile pic safely with cache
        profilePic = await getProfilePicSafe(chat.id._serialized)

        let lastMessage = null
        if (chat.lastMessage) {
          lastMessage = {
            body: chat.lastMessage.body || "",
            timestamp: chat.lastMessage.timestamp,
            fromMe: chat.lastMessage.fromMe,
            hasMedia: chat.lastMessage.hasMedia,
            type: chat.lastMessage.type,
          }
        }

        return {
          id: chat.id._serialized,
          name: contactName,
          isGroup: chat.isGroup,
          unreadCount: chat.unreadCount || 0,
          timestamp: chat.timestamp || (chat.lastMessage ? chat.lastMessage.timestamp : 0),
          lastMessage: lastMessage,
          profilePic: profilePic,
        }
      } catch (chatError) {
        log("warn", `Error processing chat ${chat.id._serialized}:`, chatError.message)
        return {
          id: chat.id._serialized,
          name: chat.name || chat.id.user,
          isGroup: chat.isGroup,
          unreadCount: 0,
          timestamp: 0,
          lastMessage: null,
          profilePic: null,
        }
      }
    })

    const results = await Promise.all(chatPromises)
    processedChats.push(...results)

    // Sort by timestamp (most recent first)
    processedChats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))

    log("info", `Returning ${processedChats.length} processed chats`)

    res.json({
      success: true,
      chats: processedChats,
      total: chats.length,
    })
  } catch (error) {
    log("error", "Error in /api/chats:", error.message)
    handleSessionError(error)
    res.json({
      success: false,
      message: error.message,
      chats: [],
    })
  }
})

app.get("/api/messages/:chatId", async (req, res) => {
  const { chatId } = req.params
  const limit = Number.parseInt(req.query.limit) || 50

  log("info", `GET /api/messages/${chatId}`)

  if (!isClientHealthy()) {
    return res.json({
      success: false,
      message: "WhatsApp not ready",
      messages: [],
    })
  }

  try {
    const chat = await whatsappClient.getChatById(chatId)
    const messages = await chat.fetchMessages({ limit })

    const processedMessages = []

    for (const msg of messages) {
      let mediaUrl = null

      // Only try to download media for media messages
      if (msg.hasMedia && ["image", "video", "audio", "ptt", "sticker"].includes(msg.type)) {
        try {
          const media = await Promise.race([
            msg.downloadMedia(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Media timeout")), 10000)),
          ])

          if (media && media.data) {
            mediaUrl = `data:${media.mimetype};base64,${media.data}`
          }
        } catch (mediaError) {
          log("warn", "Could not download media:", mediaError.message)
        }
      }

      processedMessages.push({
        id: msg.id._serialized,
        body: msg.body || "",
        fromMe: msg.fromMe,
        timestamp: msg.timestamp,
        type: msg.type,
        hasMedia: msg.hasMedia,
        mediaUrl: mediaUrl,
      })
    }

    log("info", `Returning ${processedMessages.length} messages for chat ${chatId}`)

    res.json({
      success: true,
      messages: processedMessages,
    })
  } catch (error) {
    log("error", `Error fetching messages for ${chatId}:`, error.message)
    handleSessionError(error)
    res.json({
      success: false,
      message: error.message,
      messages: [],
    })
  }
})

app.get("/api/profile-pic/:chatId", async (req, res) => {
  const { chatId } = req.params

  if (!isClientHealthy()) {
    return res.json({ success: false, url: null })
  }

  try {
    const url = await getProfilePicSafe(chatId)
    res.json({ success: true, url: url })
  } catch (error) {
    res.json({ success: false, url: null })
  }
})

app.post("/api/send", async (req, res) => {
  const { chatId, message } = req.body

  log("info", `POST /api/send to ${chatId}`)

  if (!isClientHealthy()) {
    return res.json({
      success: false,
      message: "WhatsApp not ready",
    })
  }

  if (!chatId || !message) {
    return res.json({
      success: false,
      message: "chatId and message are required",
    })
  }

  try {
    const result = await whatsappClient.sendMessage(chatId, message)
    log("info", "Message sent successfully")

    res.json({
      success: true,
      messageId: result.id._serialized,
    })
  } catch (error) {
    log("error", "Error sending message:", error.message)
    handleSessionError(error)
    res.json({
      success: false,
      message: error.message,
    })
  }
})

app.post("/api/send-media", async (req, res) => {
  const { chatId, media, filename, mimetype, caption } = req.body

  log("info", `POST /api/send-media to ${chatId}`)

  if (!isClientHealthy()) {
    return res.json({
      success: false,
      message: "WhatsApp not ready",
    })
  }

  if (!chatId || !media) {
    return res.json({
      success: false,
      message: "chatId and media are required",
    })
  }

  try {
    // Handle base64 media
    const base64Data = media.split(",")[1] || media
    const mediaMessage = new MessageMedia(mimetype || "image/jpeg", base64Data, filename || "file")

    const result = await whatsappClient.sendMessage(chatId, mediaMessage, {
      caption: caption || "",
    })

    log("info", "Media sent successfully")

    res.json({
      success: true,
      messageId: result.id._serialized,
    })
  } catch (error) {
    log("error", "Error sending media:", error.message)
    handleSessionError(error)
    res.json({
      success: false,
      message: error.message,
    })
  }
})

app.get("/api/quick-replies", async (req, res) => {
  log("info", "GET /api/quick-replies")

  // Return default quick replies without database dependency
  const defaultReplies = [
    {
      id: 1,
      titulo: "Boas-vindas",
      mensagem: "Olá! Seja bem-vindo(a) à EyesCloud. Como posso ajudá-lo(a) hoje?",
      categoria: "Saudação",
    },
    {
      id: 2,
      titulo: "Informações",
      mensagem: "Obrigado pelo contato! Vou verificar essas informações e retorno em breve.",
      categoria: "Atendimento",
    },
    {
      id: 3,
      titulo: "Orçamento",
      mensagem: "Ficamos felizes com seu interesse! Vou preparar um orçamento personalizado para você.",
      categoria: "Vendas",
    },
    {
      id: 4,
      titulo: "Agradecimento",
      mensagem: "Muito obrigado pelo contato! Estamos à disposição.",
      categoria: "Finalização",
    },
    {
      id: 5,
      titulo: "Reunião",
      mensagem: "Gostaria de agendar uma reunião para conversarmos melhor sobre suas necessidades?",
      categoria: "Vendas",
    },
  ]

  res.json({
    success: true,
    replies: defaultReplies,
  })
})

// ============================================
// SOCKET.IO EVENTOS
// ============================================

io.on("connection", (socket) => {
  log("info", `Socket connected: ${socket.id}`)

  // Send current status immediately on connection
  socket.emit("status", emitStatus())

  socket.on("disconnect", () => {
    log("info", `Socket disconnected: ${socket.id}`)
  })
})

// ============================================
// INICIAR SERVIDOR
// ============================================

const PORT = process.env.PORT || 3000

server.listen(PORT, "0.0.0.0", () => {
  console.log("")
  console.log("==================================================")
  console.log(`  EyesCloud WhatsApp API v${VERSION}`)
  console.log("==================================================")
  console.log(`  Port: ${PORT}`)
  console.log(`  Environment: ${process.env.NODE_ENV || "development"}`)
  console.log(`  Time: ${new Date().toISOString()}`)
  console.log("==================================================")
  console.log("")
})

// Graceful shutdown
process.on("SIGTERM", async () => {
  log("info", "SIGTERM received, shutting down...")

  if (whatsappClient) {
    try {
      await whatsappClient.destroy()
    } catch (e) {
      log("error", "Error destroying client on shutdown:", e.message)
    }
  }

  server.close(() => {
    log("info", "Server closed")
    process.exit(0)
  })
})
