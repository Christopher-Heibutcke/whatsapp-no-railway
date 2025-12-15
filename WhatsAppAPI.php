<?php
class WhatsAppAPI {
    private $apiUrl;
    private $db;
    
    public function __construct($pdo) {
        $this->db = $pdo;
        // URL da API rodando no Railway/Render (você vai configurar depois)
        $this->apiUrl = $this->getApiUrl();
    }
    
    private function getApiUrl() {
        $stmt = $this->db->query("SELECT api_url FROM whatsapp_config WHERE id = 1");
        $config = $stmt->fetch(PDO::FETCH_ASSOC);
        return $config['api_url'] ?? 'http://localhost:3000';
    }
    
    private function makeRequest($endpoint, $method = 'GET', $data = null) {
        $url = $this->apiUrl . $endpoint;
        
        $ch = curl_init();
        curl_setopt($ch, CURLOPT_URL, $url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 30);
        
        if ($method === 'POST') {
            curl_setopt($ch, CURLOPT_POST, true);
            if ($data) {
                curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
                curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
            }
        }
        
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        
        if ($httpCode === 200) {
            return json_decode($response, true);
        }
        
        return null;
    }
    
    public function getStatus() {
        return $this->makeRequest('/api/status');
    }
    
    public function connect() {
        return $this->makeRequest('/api/connect', 'POST');
    }
    
    public function disconnect() {
        return $this->makeRequest('/api/disconnect', 'POST');
    }
    
    public function getChats() {
        return $this->makeRequest('/api/chats');
    }
    
    public function getMessages($chatId) {
        return $this->makeRequest('/api/messages/' . urlencode($chatId));
    }
    
    public function sendMessage($chatId, $message, $funcionarioId = null, $funcionarioNome = null) {
        $data = [
            'chatId' => $chatId,
            'message' => $message,
            'funcionarioId' => $funcionarioId,
            'funcionarioNome' => $funcionarioNome
        ];
        
        // Log da atividade
        if ($funcionarioId) {
            $this->logActivity($funcionarioId, $funcionarioNome, $chatId, 'send_message', $message);
        }
        
        return $this->makeRequest('/api/send', 'POST', $data);
    }
    
    public function markAsRead($chatId) {
        return $this->makeRequest('/api/mark-read/' . urlencode($chatId), 'POST');
    }
    
    public function getQuickMessages() {
        $stmt = $this->db->query("
            SELECT * FROM whatsapp_quick_messages 
            WHERE ativo = 1 
            ORDER BY categoria, ordem
        ");
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }
    
    private function logActivity($funcionarioId, $funcionarioNome, $chatId, $action, $details = null) {
        $stmt = $this->db->prepare("
            INSERT INTO whatsapp_activity_log 
            (funcionario_id, funcionario_nome, chat_id, action, details, created_at) 
            VALUES (?, ?, ?, ?, ?, NOW())
        ");
        $stmt->execute([$funcionarioId, $funcionarioNome, $chatId, $action, $details]);
    }
    
    public function getActivityLog($limit = 100) {
        $stmt = $this->db->prepare("
            SELECT * FROM whatsapp_activity_log 
            ORDER BY created_at DESC 
            LIMIT ?
        ");
        $stmt->execute([$limit]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }
}
