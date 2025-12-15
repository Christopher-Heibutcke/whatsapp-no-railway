# WhatsApp Web Integration - EyesCloud

Sistema completo de integração WhatsApp Web com rastreamento de funcionários e mensagens pré-prontas.

## Instalação

1. Instale o Node.js (https://nodejs.org/)

2. Navegue até a pasta whatsapp:
\`\`\`bash
cd whatsapp
\`\`\`

3. Instale as dependências:
\`\`\`bash
npm install
\`\`\`

4. Inicie o servidor:
\`\`\`bash
npm start
\`\`\`

O servidor iniciará na porta 3000.

## Funcionalidades

- ✅ Conexão WhatsApp Web via QR Code
- ✅ Multi-usuário (Super Admin + Funcionários)
- ✅ Etiquetas automáticas com nome do funcionário
- ✅ Mensagens pré-prontas personalizáveis
- ✅ Monitoramento de atividades por funcionário
- ✅ Interface em tempo real com Socket.IO
- ✅ Histórico de mensagens completo
- ✅ Busca de conversas

## Acesso

- **Super Admin**: /super_admin/whatsapp.php
- **Funcionários**: /funcionario/whatsapp.php

## Observações

- O servidor Node.js precisa estar rodando para o sistema funcionar
- As sessões são salvas localmente na pasta whatsapp_sessions
- Todas as mensagens são armazenadas no banco de dados
- Cada mensagem de funcionário é automaticamente etiquetada com seu nome
