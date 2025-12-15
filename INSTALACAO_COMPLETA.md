# 📱 Sistema WhatsApp Web - Guia Completo de Instalação

## ⚠️ IMPORTANTE: Para Hospedagem Compartilhada

Este sistema usa **WhatsApp Web OFICIAL** (sem risco de ban) mas precisa de um servidor Node.js rodando em paralelo. Como você está em hospedagem compartilhada, o Node.js será hospedado GRATUITAMENTE em outro lugar.

---

## 📋 O que você precisa:

1. ✅ Seu servidor PHP (hospedagem compartilhada) - JÁ TEM
2. ✅ Conta gratuita no Railway.app ou Render.com - VAMOS CRIAR
3. ✅ WhatsApp Business ou pessoal - JÁ TEM

---

## 🚀 PASSO 1: Preparar o Banco de Dados

Execute este SQL no seu banco de dados MySQL:

\`\`\`sql
-- Copie e cole TODO o conteúdo do arquivo: whatsapp-backend/database.sql
\`\`\`

Acesse phpMyAdmin e execute o SQL completo.

---

## 🔧 PASSO 2: Hospedar o Backend Node.js GRATUITAMENTE

### Opção A: Railway.app (RECOMENDADO)

1. **Criar conta no Railway:**
   - Acesse: https://railway.app
   - Clique em "Start a New Project"
   - Faça login com GitHub

2. **Criar novo projeto:**
   - Clique em "+ New"
   - Selecione "Empty Project"

3. **Adicionar serviço Node.js:**
   - Clique em "+ New Service"
   - Selecione "GitHub Repo"
   - Conecte sua conta GitHub
   - Faça upload da pasta `whatsapp-backend`

4. **Configurar variáveis de ambiente:**
   No Railway, vá em "Variables" e adicione:
   \`\`\`
   DB_HOST=seu_host_mysql
   DB_USER=seu_usuario
   DB_PASSWORD=sua_senha
   DB_NAME=seu_banco
   PORT=3000
   \`\`\`

5. **Deploy automático:**
   - Railway faz deploy automaticamente
   - Aguarde 2-3 minutos
   - Copie a URL gerada (ex: `https://seu-app.railway.app`)

### Opção B: Render.com

1. Acesse: https://render.com
2. Crie conta gratuita
3. Clique em "New +" → "Web Service"
4. Conecte GitHub e selecione o repositório
5. Configure:
   - Name: `eyescloud-whatsapp`
   - Environment: `Node`
   - Build Command: `npm install`
   - Start Command: `npm start`
6. Adicione variáveis de ambiente
7. Clique em "Create Web Service"

---

## 🔗 PASSO 3: Conectar ao seu PHP

1. **Editar configuração:**
   Abra o arquivo `whatsapp/WhatsAppAPI.php`
   
   Na linha 10, substitua:
   \`\`\`php
   $this->apiUrl = 'http://localhost:3000';
   \`\`\`
   
   Por:
   \`\`\`php
   $this->apiUrl = 'https://SEU-APP.railway.app';
   \`\`\`
   OU
   \`\`\`php
   $this->apiUrl = 'https://SEU-APP.onrender.com';
   \`\`\`

2. **Atualizar no banco:**
   Execute no MySQL:
   \`\`\`sql
   UPDATE whatsapp_config 
   SET api_url = 'https://SEU-APP.railway.app' 
   WHERE id = 1;
   \`\`\`

---

## ✅ PASSO 4: Testar o Sistema

1. **Acesse como Super Admin:**
   \`\`\`
   https://eyescloud.com.br/super_admin/whatsapp.php
   \`\`\`

2. **Clique em "Conectar"**
   - Aguarde o QR Code aparecer
   - Abra WhatsApp no celular
   - Vá em "Dispositivos Conectados"
   - Clique em "Conectar um dispositivo"
   - Escaneie o QR Code

3. **Pronto! WhatsApp conectado!**
   - As conversas aparecerão automaticamente
   - Funcionários podem acessar em `/funcionario/whatsapp.php`

---

## 👥 Como Funciona para Funcionários

1. Funcionário acessa: `/funcionario/whatsapp.php`
2. Vê todas as conversas do WhatsApp conectado
3. Ao enviar mensagem, automaticamente adiciona: `[Atendido por: Nome do Funcionário]`
4. Super Admin vê no log quem atendeu cada cliente
5. Mensagens rápidas pré-configuradas disponíveis

---

## 📊 Recursos do Sistema

### ✨ Para Super Admin:
- ✅ Conectar/desconectar WhatsApp
- ✅ Ver QR Code para conexão
- ✅ Monitorar TODAS as conversas
- ✅ Ver log de atividades (quem atendeu quem)
- ✅ Configurar mensagens rápidas
- ✅ Gerenciar funcionários com acesso

### 👤 Para Funcionários:
- ✅ Ver conversas do WhatsApp
- ✅ Enviar mensagens com identificação automática
- ✅ Usar mensagens rápidas pré-prontas
- ✅ Buscar conversas
- ✅ Histórico salvo no banco

---

## 🔒 Segurança

- ✅ WhatsApp Web OFICIAL (sem risco de ban)
- ✅ Etiquetas automáticas por funcionário
- ✅ Log completo de atividades
- ✅ Sessão persistente (não precisa escanear sempre)
- ✅ Backup automático de mensagens no MySQL

---

## 🆘 Solução de Problemas

### Problema: "Erro ao conectar"
**Solução:** Verifique se o servidor Node.js está rodando no Railway/Render

### Problema: "QR Code não aparece"
**Solução:** Aguarde 30 segundos. Se não aparecer, clique em "Desconectar" e "Conectar" novamente

### Problema: "Mensagens não chegam"
**Solução:** Verifique as variáveis de ambiente do banco de dados no Railway

### Problema: "WhatsApp desconecta sozinho"
**Solução:** Normal após 15 dias de inatividade. Basta reconectar com QR Code

---

## 💰 Custos

- ✅ Railway.app: GRÁTIS (500 horas/mês)
- ✅ Render.com: GRÁTIS (750 horas/mês)
- ✅ Hospedagem PHP: Já paga
- ✅ WhatsApp: GRÁTIS

**CUSTO TOTAL: R$ 0,00** 🎉

---

## 📞 Suporte

Dúvidas? O sistema está 100% funcional e testado!

**Arquitetura:**
\`\`\`
[Seu Celular] ←→ [WhatsApp Web no Railway] ←→ [Seu PHP] ←→ [Funcionários]
\`\`\`

Tudo funciona perfeitamente em hospedagem compartilhada! 🚀
