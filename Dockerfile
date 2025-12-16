# Use imagem oficial do Puppeteer que ja vem com Chromium
FROM ghcr.io/puppeteer/puppeteer:21.6.1

# Definir variaveis de ambiente
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    NODE_ENV=production

# Definir diretorio de trabalho
WORKDIR /usr/src/app

# Copiar package.json e package-lock.json (se existir)
COPY package*.json ./

RUN npm install --production

# Copiar todo o codigo do projeto
COPY . .

# Criar pasta de sessoes do WhatsApp com permissoes corretas
RUN mkdir -p whatsapp_sessions && chmod 777 whatsapp_sessions

# Expor porta 3000
EXPOSE 3000

# Comando para iniciar o servidor
CMD ["node", "server.js"]
