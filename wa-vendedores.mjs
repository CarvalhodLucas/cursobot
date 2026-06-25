// wa-vendedores.mjs — Captura conversas dos vendedores no WhatsApp pessoal
// Envia para o bot via /webhook-vendedor que salva no Supabase

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { mkdirSync, readFileSync, existsSync, rmSync } from 'fs';
import { createServer } from 'http';

const BOT_URL = 'https://cursobot-production.up.railway.app';
const VENDORS = ['Rebecca', 'Taynara', 'Paulo'];
const QR_PORT = 3000;
let currentQRs = {};

// ── Extração de texto de qualquer tipo de mensagem ──────────────────────────
function extrairTexto(message) {
  if (!message) return null;
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    (message.audioMessage ? '[Áudio]' : null) ||
    (message.stickerMessage ? '[Sticker]' : null) ||
    (message.contactMessage ? '[Contato]' : null) ||
    (message.locationMessage ? '[Localização]' : null) ||
    (message.reactionMessage ? '[Reação]' : null) ||
    null
  );
}

// ── Resolve JID (@s.whatsapp.net ou @lid) para número de telefone ────────────
function resolverTelefone(jid, authDir) {
  if (!jid) return null;

  // Formato normal: 5521999999@s.whatsapp.net
  if (jid.endsWith('@s.whatsapp.net')) {
    return jid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
  }

  // Formato LID (novo WhatsApp): 47537369133069@lid
  if (jid.endsWith('@lid')) {
    const lidId = jid.replace('@lid', '');

    // Função auxiliar: extrai número de qualquer formato de dado
    function extrairNumero(data) {
      if (!data) return null;
      // String simples com apenas dígitos (ex: "34618097942")
      if (typeof data === 'string') {
        const limpo = data.trim().replace(/\D/g, '');
        if (limpo.length >= 7) return limpo;
      }
      // Objeto com jid/id contendo @s.whatsapp.net
      if (typeof data === 'object') {
        const candidates = [data.jid, data.id, ...Object.values(data)];
        for (const v of candidates) {
          if (typeof v === 'string') {
            if (v.includes('@s.whatsapp.net')) {
              return v.replace('@s.whatsapp.net', '').replace(/\D/g, '');
            }
            const digits = v.trim().replace(/\D/g, '');
            if (digits.length >= 7) return digits;
          }
        }
      }
      return null;
    }

    // Tenta arquivo de mapeamento reverso (LID → número real)
    const reverseFile = `${authDir}/lid-mapping-${lidId}_reverse.json`;
    if (existsSync(reverseFile)) {
      try {
        const data = JSON.parse(readFileSync(reverseFile, 'utf8'));
        const num = extrairNumero(data);
        if (num) {
          console.log(`🔍 LID ${lidId} → ${num} (via reverse mapping)`);
          return num;
        }
      } catch (e) { /* ignora */ }
    }

    // Tenta arquivo de mapeamento direto
    const mappingFile = `${authDir}/lid-mapping-${lidId}.json`;
    if (existsSync(mappingFile)) {
      try {
        const data = JSON.parse(readFileSync(mappingFile, 'utf8'));
        const num = extrairNumero(data);
        if (num) {
          console.log(`🔍 LID ${lidId} → ${num} (via mapping)`);
          return num;
        }
      } catch (e) { /* ignora */ }
    }

    // Sem mapeamento encontrado — usa o número do LID como fallback
    console.log(`⚠️  LID sem mapeamento: ${jid} — salvando como ${lidId}`);
    return lidId;
  }

  // Fallback genérico
  return jid.replace(/[^\d]/g, '') || null;
}

// ── Envia mensagem para o bot (que salva no Supabase) ───────────────────────
async function enviarParaBot(vendorName, phone, fromMe, texto) {
  const url = `${BOT_URL}/webhook-vendedor?vendedor=${encodeURIComponent(vendorName)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone,
        fromMe,
        text: { message: texto },
        isGroup: false
      })
    });
    const de = fromMe ? '→' : '←';
    console.log(`✅ [${vendorName}] ${de} ${phone}: ${texto.slice(0, 60)} [${res.status}]`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`❌ [${vendorName}] Bot ${res.status}: ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.error(`❌ [${vendorName}] Falha ao enviar para bot: ${err.message}`);
  }
}

// ── Conecta um vendedor ──────────────────────────────────────────────────────
async function connectVendor(vendorName, attempt = 1) {
  const authDir = `/root/wa-sessions/${vendorName.toLowerCase()}`;
  mkdirSync(authDir, { recursive: true });

  console.log(`\n🔌 [${vendorName}] Conectando (tentativa ${attempt})...`);

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  console.log(`📦 [${vendorName}] WhatsApp v${version.join('.')}`);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
    browser: ['Mac OS', 'Chrome', '126.0.0.0'],
    getMessage: async () => ({ conversation: '' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQRs[vendorName] = qr;
      console.log(`\n📱 [${vendorName}] QR gerado → http://65.109.128.237:${QR_PORT}/qr/${vendorName}`);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      delete currentQRs[vendorName];
      console.log(`🔴 [${vendorName}] Desconectado (código ${statusCode})`);

      if (loggedOut) {
        // 401: WhatsApp removeu o dispositivo vinculado → limpa sessão e gera novo QR
        console.log(`⚠️  [${vendorName}] Sessão expirada (401). Limpando e gerando novo QR em 5s...`);
        try { rmSync(authDir, { recursive: true, force: true }); } catch (e) {}
        mkdirSync(authDir, { recursive: true });
        setTimeout(() => connectVendor(vendorName, 1), 5000);
      } else {
        const delay = Math.min(attempt * 5000, 60000);
        console.log(`⏳ [${vendorName}] Reconectando em ${delay / 1000}s...`);
        setTimeout(() => connectVendor(vendorName, attempt + 1), delay);
      }
    }

    if (connection === 'open') {
      delete currentQRs[vendorName];
      console.log(`🟢 [${vendorName}] Conectado!`);
    }
  });

  // ── Captura mensagens ──────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Log de debug: mostra TODOS os eventos (incluindo 'append', 'set', etc.)
    if (messages.length > 0) {
      const resumo = messages
        .map(m => `${m.key.remoteJid?.split('@')[0]}(fromMe=${m.key.fromMe})`)
        .join(', ');
      console.log(`📥 [${vendorName}] upsert type=${type} [${resumo}]`);
    }

    // 'notify' = mensagens novas em tempo real
    // 'append' = histórico sincronizado ao conectar (ignoramos para não poluir)
    if (type !== 'notify') return;

    for (const msg of messages) {
      const remoteJid = msg.key.remoteJid;
      if (!remoteJid) continue;
      if (remoteJid.endsWith('@g.us')) continue;       // ignora grupos
      if (remoteJid === 'status@broadcast') continue;  // ignora status

      const texto = extrairTexto(msg.message);
      if (!texto) {
        const chaves = Object.keys(msg.message || {}).join(', ');
        console.log(`⚠️  [${vendorName}] Mensagem sem texto (chaves: ${chaves})`);
        continue;
      }

      const telefone = resolverTelefone(remoteJid, authDir);
      if (!telefone) {
        console.log(`⚠️  [${vendorName}] JID sem telefone resolvível: ${remoteJid}`);
        continue;
      }

      await enviarParaBot(vendorName, telefone, !!msg.key.fromMe, texto);
    }
  });
}

// ── Servidor HTTP para visualizar QR codes ───────────────────────────────────
createServer((req, res) => {
  const partes = (req.url || '/').split('/').filter(Boolean);

  if (partes[0] === 'qr' && partes[1]) {
    const vendor = partes[1];
    const qr = currentQRs[vendor];

    if (qr) {
      const qrData = encodeURIComponent(qr);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>QR — ${vendor}</title>
<meta http-equiv="refresh" content="5">
<style>body{background:#111;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;padding:40px;margin:0}</style>
</head><body>
<h2>📱 QR Code — ${vendor}</h2>
<img src="https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${qrData}"
     style="border:8px solid #fff;border-radius:8px;margin:16px 0">
<p style="color:#aaa">Escaneie com o WhatsApp de <strong>${vendor}</strong><br>
Página atualiza a cada 5s</p>
</body></html>`);
    } else {
      const isKnown = VENDORS.includes(vendor);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${vendor}</title>
<meta http-equiv="refresh" content="5">
<style>body{background:#111;color:#fff;font-family:sans-serif;padding:40px}</style>
</head><body>
<h2>${vendor}</h2>
<p>${isKnown ? '🟢 Já conectado (sem QR pendente)' : '❌ Vendedor não encontrado'}</p>
<p><a href="/" style="color:#4af">← Voltar</a></p>
</body></html>`);
    }
    return;
  }

  // Página inicial: lista todos os vendedores
  const itens = VENDORS.map(v => {
    const temQR = !!currentQRs[v];
    return `<li style="margin:8px 0">
      <a href="/qr/${v}" style="color:${temQR ? '#4af' : '#4f4'};text-decoration:none;font-size:1.1em">
        ${v} ${temQR ? '📲 QR disponível — clique para escanear' : '🟢 Conectado'}
      </a></li>`;
  }).join('');

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>WhatsApp Vendedores</title>
<meta http-equiv="refresh" content="10">
<style>body{background:#111;color:#fff;font-family:sans-serif;padding:40px}</style>
</head><body>
<h2>🔗 WhatsApp Vendedores</h2>
<ul style="list-style:none;padding:0">${itens}</ul>
<p style="color:#555;font-size:12px">Atualiza a cada 10s</p>
</body></html>`);

}).listen(QR_PORT, () => {
  console.log(`🌐 QR server rodando: http://65.109.128.237:${QR_PORT}/`);
});

// ── Inicia todos os vendedores com intervalo de 3s ───────────────────────────
console.log('🚀 WhatsApp Vendedores iniciando...\n');
for (let i = 0; i < VENDORS.length; i++) {
  setTimeout(() => connectVendor(VENDORS[i]), i * 3000);
}
