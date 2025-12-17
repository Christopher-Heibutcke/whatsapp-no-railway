/**
 * EyesCloud WhatsApp Backend v2.5.0
 * Servidor completo para integração WhatsApp Web
 *
 * REESCRITO COMPLETAMENTE para garantir funcionamento
 */

const express = require("express")
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js")
const qrcode = require("qrcode")
const cors = require("cors")
const mysql = require("mysql2/promise")
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
// CONFIGURAÇÃO DO BANCO DE DADOS
// ============================================

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

const MAX_RECONNECT_ATTEMPTS = 5
const VERSION = "2.5.0"

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

async function updateDatabaseStatus(status) {
  try {
    const conn = await mysql.createConnection(dbConfig)
    await conn.execute("UPDATE whatsapp_config SET status = ?, last_connected = NOW() WHERE id = 1", [status])
    await conn.end()
    log("info", `Database status updated to: ${status}`)
  } catch (error) {
    log("error", "Error updating database status:", error.message)
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

// ============================================
// FUNÇÃO PRINCIPAL: INICIALIZAR WHATSAPP
// ============================================

function initializeWhatsApp() {
  if (isInitializing) {
    log("warn", "Already initializing, skipping...")
    return
  }

  log("info", "========================================")
  log("info", "Starting WhatsApp client initialization")
  log("info", `Version: ${VERSION}`)
  log("info", "========================================")

  isInitializing = true
  isConnected = false
  isClientReady = false
  qrCodeData = null
  clientInfo = null

  emitStatus()

  // Encontrar Chromium
  const chromiumPath = findChromiumPath()
  if (!chromiumPath) {
    log("error", "Cannot start: Chromium not found")
    isInitializing = false
    io.emit("error", { message: "Chromium not found on server" })
    return
  }

  // Limpar cliente anterior se existir
  if (whatsappClient) {
    log("info", "Destroying previous client...")
    try {
      whatsappClient.destroy()
    } catch (e) {
      log("warn", "Error destroying previous client:", e.message)
    }
    whatsappClient = null
  }

  // Criar novo cliente
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

  // QR Code recebido
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

  // Tela de carregamento
  whatsappClient.on("loading_screen", (percent, message) => {
    log("info", `Loading: ${percent}% - ${message}`)
    io.emit("loading", { percent, message })
  })

  // Autenticado
  whatsappClient.on("authenticated", () => {
    log("info", "========================================")
    log("info", "AUTHENTICATED SUCCESSFULLY")
    log("info", "========================================")

    reconnectAttempts = 0
    qrCodeData = null

    io.emit("authenticated", { success: true })
    emitStatus()
  })

  // Falha na autenticação
  whatsappClient.on("auth_failure", (msg) => {
    log("error", "========================================")
    log("error", "AUTHENTICATION FAILURE:", msg)
    log("error", "========================================")

    isConnected = false
    isClientReady = false
    isInitializing = false

    io.emit("auth_failure", { message: msg })
    emitStatus()

    updateDatabaseStatus("auth_failure")
  })

  // Cliente pronto
  whatsappClient.on("ready", async () => {
    log("info", "========================================")
    log("info", "WHATSAPP CLIENT IS READY!")
    log("info", "========================================")

    isConnected = true
    isClientReady = true
    isInitializing = false
    qrCodeData = null

    // Obter informações do cliente
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
    await updateDatabaseStatus("connected")

    // Testar se consegue obter chats após um delay
    log("info", "Waiting 5 seconds before testing chat access...")

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
        log("info", "This is normal, chats will be available on request")
      }
    }, 5000)

    log("info", "========================================")
    log("info", "CLIENT FULLY INITIALIZED")
    log("info", "========================================")
  })

  // Desconectado
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

    await updateDatabaseStatus("disconnected")

    // Tentar reconectar se não foi logout manual
    if (reason !== "LOGOUT" && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++
      const delay = Math.min(5000 * reconnectAttempts, 30000)

      log("info", `Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay / 1000}s...`)

      setTimeout(() => {
        initializeWhatsApp()
      }, delay)
    }
  })

  // Mudança de estado
  whatsappClient.on("change_state", (state) => {
    log("info", "State changed:", state)
    io.emit("state_change", { state })
  })

  // Nova mensagem recebida
  whatsappClient.on("message", async (message) => {
    try {
      const contact = await message.getContact()

      const messageData = {
        id: message.id._serialized,
        chatId: message.from,
        contactName: contact.pushname || contact.number || message.from,
        contactNumber: contact.number || message.from.replace("@c.us", ""),
        message: message.body,
        type: message.type,
        fromMe: message.fromMe,
        timestamp: message.timestamp,
        hasMedia: message.hasMedia,
      }

      io.emit("new_message", messageData)
      log("info", `New message from ${messageData.contactName}`)

      // Salvar no banco
      try {
        const conn = await mysql.createConnection(dbConfig)
        await conn.execute(
          `INSERT INTO whatsapp_messages 
                    (chat_id, contact_name, contact_number, message_text, message_type, 
                    is_from_me, timestamp, media_url) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            message.from,
            messageData.contactName,
            messageData.contactNumber,
            message.body,
            message.type,
            message.fromMe ? 1 : 0,
            new Date(message.timestamp * 1000),
            message.hasMedia ? "pending" : null,
          ],
        )
        await conn.end()
      } catch (dbError) {
        log("error", "Error saving message to database:", dbError.message)
      }
    } catch (error) {
      log("error", "Error handling message:", error.message)
    }
  })

  // Erro do cliente
  whatsappClient.on("error", (error) => {
    log("error", "Client error:", error.message)
    io.emit("error", { message: error.message })
  })

  // ============================================
  // INICIALIZAR CLIENTE
  // ============================================

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
      io.emit("error", {
        message: "Failed to initialize WhatsApp: " + error.message,
      })
      emitStatus()
    })
}

// ============================================
// ROTAS DA API
// ============================================

// Health check
app.get("/api/ping", (req, res) => {
  res.json({
    status: "alive",
    version: VERSION,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  })
})

// Status completo
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

// Conectar
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

// Desconectar
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
    reconnectAttempts = MAX_RECONNECT_ATTEMPTS // Prevenir reconexão automática

    await updateDatabaseStatus("disconnected")

    io.emit("disconnected", { reason: "LOGOUT" })
    emitStatus()

    res.json({ success: true, message: "Disconnected successfully" })
  } catch (error) {
    log("error", "Error disconnecting:", error)

    // Forçar reset do estado mesmo com erro
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

// Obter conversas
app.get("/api/chats", async (req, res) => {
  log("info", "========================================")
  log("info", "GET /api/chats")
  log("info", `State - Connected: ${isConnected}, Ready: ${isClientReady}`)
  log("info", "========================================")

  if (!whatsappClient) {
    return res.json({
      success: false,
      message: "WhatsApp client not initialized",
      chats: [],
    })
  }

  if (!isConnected || !isClientReady) {
    return res.json({
      success: false,
      message: "WhatsApp not ready. Please wait for connection.",
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

    for (const chat of chatsToProcess) {
      try {
        let contactName = chat.name
        let profilePic = null

        try {
          if (!chat.isGroup) {
            const contact = await chat.getContact()
            contactName = contact.pushname || contact.name || contact.number || chat.name
            profilePic = await contact.getProfilePicUrl()
          } else {
            profilePic = await chat.getProfilePicUrl()
          }
        } catch (picError) {
          // Profile pic not available, continue without it
        }

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

        processedChats.push({
          id: chat.id._serialized,
          name: contactName || chat.id.user,
          isGroup: chat.isGroup,
          unreadCount: chat.unreadCount || 0,
          timestamp: chat.timestamp || (chat.lastMessage ? chat.lastMessage.timestamp : 0),
          lastMessage: lastMessage,
          profilePic: profilePic,
        })
      } catch (chatError) {
        log("warn", `Error processing chat ${chat.id._serialized}:`, chatError.message)
        processedChats.push({
          id: chat.id._serialized,
          name: chat.name || chat.id.user,
          isGroup: chat.isGroup,
          unreadCount: 0,
          timestamp: 0,
          lastMessage: null,
          profilePic: null,
        })
      }
    }

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
    res.json({
      success: false,
      message: error.message,
      chats: [],
    })
  }
})

// Obter mensagens de um chat
app.get("/api/messages/:chatId", async (req, res) => {
  const { chatId } = req.params
  const limit = Number.parseInt(req.query.limit) || 50

  log("info", `GET /api/messages/${chatId}`)

  if (!whatsappClient || !isClientReady) {
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

      if (msg.hasMedia) {
        try {
          const media = await msg.downloadMedia()
          if (media) {
            mediaUrl = `data:${media.mimetype};base64,${media.data}`
          }
        } catch (mediaError) {
          log("warn", "Could not download media:", mediaError.message)
        }
      }

      processedMessages.push({
        id: msg.id._serialized,
        body: msg.body,
        fromMe: msg.fromMe,
        timestamp: msg.timestamp,
        type: msg.type,
        hasMedia: msg.hasMedia,
        mediaUrl: mediaUrl,
        ack: msg.ack,
      })
    }

    res.json({
      success: true,
      messages: processedMessages,
    })
  } catch (error) {
    log("error", "Error fetching messages:", error.message)
    res.json({
      success: false,
      message: error.message,
      messages: [],
    })
  }
})

// Enviar mensagem
app.post("/api/send", async (req, res) => {
  const { number, message, chatId } = req.body

  log("info", `POST /api/send to ${number || chatId}`)

  if (!whatsappClient || !isClientReady) {
    return res.json({
      success: false,
      message: "WhatsApp not connected",
    })
  }

  try {
    let targetId = chatId

    if (!targetId && number) {
      // Formatar número
      const cleanNumber = number.replace(/\D/g, "")
      targetId = cleanNumber.includes("@") ? cleanNumber : `${cleanNumber}@c.us`
    }

    if (!targetId) {
      return res.json({
        success: false,
        message: "No target number or chatId provided",
      })
    }

    const result = await whatsappClient.sendMessage(targetId, message)

    log("info", "Message sent successfully")

    res.json({
      success: true,
      messageId: result.id._serialized,
    })
  } catch (error) {
    log("error", "Error sending message:", error.message)
    res.json({
      success: false,
      message: error.message,
    })
  }
})

// Enviar mídia
app.post("/api/send-media", async (req, res) => {
  const { chatId, media, filename, mimetype, funcionarioId, funcionarioNome } = req.body

  log("info", `POST /api/send-media to ${chatId}`)

  if (!whatsappClient || !isClientReady) {
    return res.json({
      success: false,
      message: "WhatsApp not ready",
    })
  }

  try {
    // Extract base64 data
    const base64Data = media.split(",")[1]

    const messageMedia = new MessageMedia(mimetype, base64Data, filename)

    await whatsappClient.sendMessage(chatId, messageMedia)

    // Save to database
    try {
      const conn = await mysql.createConnection(dbConfig)
      await conn.execute(
        `INSERT INTO whatsapp_messages 
        (chat_id, message_text, message_type, is_from_me, timestamp, funcionario_id, funcionario_nome) 
        VALUES (?, ?, ?, 1, NOW(), ?, ?)`,
        [chatId, `[Mídia: ${filename}]`, mimetype.split("/")[0], funcionarioId, funcionarioNome],
      )
      await conn.end()
    } catch (dbError) {
      log("warn", "Error saving media message to database:", dbError.message)
    }

    res.json({ success: true, message: "Media sent successfully" })
  } catch (error) {
    log("error", "Error sending media:", error.message)
    res.json({ success: false, message: error.message })
  }
})

// Obter respostas rápidas
app.get("/api/quick-replies", async (req, res) => {
  log("info", "GET /api/quick-replies")

  try {
    const conn = await mysql.createConnection(dbConfig)
    const [rows] = await conn.execute(
      "SELECT id, titulo, mensagem, categoria FROM whatsapp_quick_replies WHERE ativo = 1 ORDER BY ordem ASC",
    )
    await conn.end()

    res.json({
      success: true,
      replies: rows,
    })
  } catch (error) {
    log("error", "Error fetching quick replies:", error.message)
    // Return empty array instead of error to avoid frontend crashes
    res.json({
      success: true,
      replies: [],
    })
  }
})

// Obter foto de perfil
app.get("/api/profile-pic/:chatId", async (req, res) => {
  const { chatId } = req.params

  if (!whatsappClient || !isClientReady) {
    return res.json({
      success: false,
      profilePic: null,
    })
  }

  try {
    let profilePic = null

    if (chatId.includes("@g.us")) {
      // Group chat
      const chat = await whatsappClient.getChatById(chatId)
      profilePic = await chat.getProfilePicUrl()
    } else {
      // Individual contact
      const contact = await whatsappClient.getContactById(chatId)
      profilePic = await contact.getProfilePicUrl()
    }

    res.json({
      success: true,
      profilePic: profilePic || null,
    })
  } catch (error) {
    res.json({
      success: false,
      profilePic: null,
    })
  }
})

// Obter mídia de uma mensagem
app.get("/api/media/:messageId", async (req, res) => {
  const { messageId } = req.params

  log("info", `GET /api/media/${messageId}`)

  if (!whatsappClient || !isClientReady) {
    return res.json({
      success: false,
      message: "WhatsApp not ready",
    })
  }

  try {
    // Find the message in recent chats
    const chats = await whatsappClient.getChats()

    for (const chat of chats.slice(0, 20)) {
      try {
        const messages = await chat.fetchMessages({ limit: 30 })
        const targetMsg = messages.find((m) => m.id._serialized === messageId)

        if (targetMsg && targetMsg.hasMedia) {
          const media = await targetMsg.downloadMedia()
          if (media) {
            return res.json({
              success: true,
              media: {
                mimetype: media.mimetype,
                data: media.data,
                filename: media.filename,
              },
            })
          }
        }
      } catch (e) {
        // Continue to next chat
      }
    }

    res.json({
      success: false,
      message: "Media not found",
    })
  } catch (error) {
    log("error", "Error fetching media:", error.message)
    res.json({
      success: false,
      message: error.message,
    })
  }
})

// ============================================
// SOCKET.IO
// ============================================

io.on("connection", (socket) => {
  log("info", `Socket connected: ${socket.id}`)

  // Enviar status atual
  socket.emit("status", {
    connected: isConnected,
    clientReady: isClientReady,
    initializing: isInitializing,
    qrCode: qrCodeData,
    clientInfo: clientInfo,
    version: VERSION,
  })

  // Se tiver QR code disponível, enviar
  if (qrCodeData && !isConnected) {
    socket.emit("qr", qrCodeData)
  }

  socket.on("request_status", () => {
    emitStatus()
  })

  socket.on("disconnect", () => {
    log("info", `Socket disconnected: ${socket.id}`)
  })
})

// ============================================
// INICIALIZAÇÃO DO SERVIDOR
// ============================================

const PORT = process.env.PORT || 3000

server.listen(PORT, () => {
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

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

async function gracefulShutdown(signal) {
  log("info", `${signal} received, shutting down...`)

  if (whatsappClient) {
    try {
      await whatsappClient.destroy()
      log("info", "WhatsApp client destroyed")
    } catch (e) {
      log("warn", "Error destroying client:", e.message)
    }
  }

  server.close(() => {
    log("info", "Server closed")
    process.exit(0)
  })

  // Forçar saída após 10 segundos
  setTimeout(() => {
    log("warn", "Forcing shutdown...")
    process.exit(1)
  }, 10000)
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"))
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))

// Capturar erros não tratados
process.on("uncaughtException", (error) => {
  log("error", "Uncaught exception:", error.message)
  log("error", error.stack)
})

process.on("unhandledRejection", (reason, promise) => {
  log("error", "Unhandled rejection at:", promise)
  log("error", "Reason:", reason)
})
