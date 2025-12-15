<?php
session_start();
require_once '../../config/database.php';
require_once '../WhatsAppAPI.php';

header('Content-Type: application/json');

if (!isset($_SESSION['funcionario_id']) && !isset($_SESSION['super_admin_id'])) {
    echo json_encode(['success' => false, 'error' => 'Não autorizado']);
    exit;
}

$database = new Database();
$db = $database->getConnection();
$whatsapp = new WhatsAppAPI($db);

$data = json_decode(file_get_contents('php://input'), true);

$chatId = $data['chatId'] ?? null;
$message = $data['message'] ?? null;
$funcionarioId = $data['funcionarioId'] ?? null;
$funcionarioNome = $data['funcionarioNome'] ?? null;

if (!$chatId || !$message) {
    echo json_encode(['success' => false, 'error' => 'Dados incompletos']);
    exit;
}

try {
    $result = $whatsapp->sendMessage($chatId, $message, $funcionarioId, $funcionarioNome);
    echo json_encode(['success' => true, 'data' => $result]);
} catch (Exception $e) {
    echo json_encode(['success' => false, 'error' => $e->getMessage()]);
}
