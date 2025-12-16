FROM ghcr.io/puppeteer/puppeteer:21.6.1

# Set environment variables for Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

RUN mkdir -p whatsapp_sessions && chmod 777 whatsapp_sessions

EXPOSE 3000

CMD ["node", "server.js"]
