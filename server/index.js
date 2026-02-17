/**
 * y-webrtc 互換シグナリングサーバー
 * 
 * プロトコル:
 * - subscribe: ルームに参加
 * - unsubscribe: ルームから離脱
 * - publish: ルーム内の他クライアントにメッセージを転送
 * - ping/pong: 接続維持
 */

const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 4444;

const wss = new WebSocketServer({ port: PORT });

// ルーム（トピック）ごとのクライアント管理
const topics = new Map(); // Map<topic, Set<ws>>

// クライアントごとの購読トピック
const subscriptions = new WeakMap(); // WeakMap<ws, Set<topic>>

wss.on('connection', (ws, req) => {
  const clientId = Math.random().toString(36).slice(2, 8);
  console.log(`[${timestamp()}] Client connected: ${clientId}`);
  
  // このクライアントの購読トピックを初期化
  subscriptions.set(ws, new Set());

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      handleMessage(ws, clientId, message);
    } catch (err) {
      console.error(`[${timestamp()}] Invalid message from ${clientId}:`, err.message);
    }
  });

  ws.on('close', () => {
    console.log(`[${timestamp()}] Client disconnected: ${clientId}`);
    // 全トピックから削除
    const subs = subscriptions.get(ws);
    if (subs) {
      for (const topic of subs) {
        const clients = topics.get(topic);
        if (clients) {
          clients.delete(ws);
          if (clients.size === 0) {
            topics.delete(topic);
            console.log(`[${timestamp()}] Room empty, deleted: ${topic}`);
          }
        }
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[${timestamp()}] WebSocket error for ${clientId}:`, err.message);
  });

  // 接続確認のためpingを送信
  ws.send(JSON.stringify({ type: 'pong' }));
});

function handleMessage(ws, clientId, message) {
  const { type } = message;

  switch (type) {
    case 'subscribe': {
      const { topics: newTopics } = message;
      if (!Array.isArray(newTopics)) return;

      const subs = subscriptions.get(ws);
      for (const topic of newTopics) {
        if (typeof topic !== 'string') continue;
        
        // トピックにクライアントを追加
        if (!topics.has(topic)) {
          topics.set(topic, new Set());
        }
        topics.get(topic).add(ws);
        subs.add(topic);
        
        console.log(`[${timestamp()}] ${clientId} subscribed to: ${topic} (${topics.get(topic).size} clients)`);
      }
      break;
    }

    case 'unsubscribe': {
      const { topics: oldTopics } = message;
      if (!Array.isArray(oldTopics)) return;

      const subs = subscriptions.get(ws);
      for (const topic of oldTopics) {
        if (typeof topic !== 'string') continue;
        
        const clients = topics.get(topic);
        if (clients) {
          clients.delete(ws);
          if (clients.size === 0) {
            topics.delete(topic);
          }
        }
        subs.delete(topic);
        
        console.log(`[${timestamp()}] ${clientId} unsubscribed from: ${topic}`);
      }
      break;
    }

    case 'publish': {
      const { topic } = message;
      if (typeof topic !== 'string') return;

      const clients = topics.get(topic);
      if (!clients) return;

      // 送信者以外の全クライアントに転送
      const messageStr = JSON.stringify(message);
      let sent = 0;
      for (const client of clients) {
        if (client !== ws && client.readyState === 1) {
          client.send(messageStr);
          sent++;
        }
      }
      
      // デバッグログ（頻繁なので本番では無効化推奨）
      // console.log(`[${timestamp()}] ${clientId} published to ${topic}: ${sent} recipients`);
      break;
    }

    case 'ping': {
      ws.send(JSON.stringify({ type: 'pong' }));
      break;
    }

    default:
      console.log(`[${timestamp()}] Unknown message type from ${clientId}: ${type}`);
  }
}

function timestamp() {
  return new Date().toISOString().slice(11, 23);
}

// 定期的に接続状況をログ
setInterval(() => {
  const roomCount = topics.size;
  let totalClients = 0;
  for (const clients of topics.values()) {
    totalClients += clients.size;
  }
  if (roomCount > 0) {
    console.log(`[${timestamp()}] Stats: ${roomCount} rooms, ${totalClients} total connections`);
  }
}, 30000);

console.log(`🔌 Signaling server running on ws://localhost:${PORT}`);
console.log(`   Use this URL in your client config`);
