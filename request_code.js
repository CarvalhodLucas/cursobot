// Rodar com: node request_code.js
// Verifica o status do número do bot no Cloud API da Meta

const https = require('https');

const TOKEN = 'EAAdTFd4Ojx8BR2aRxN0G6FiZASymQsRlefCaZC1YHJNH9AmHh6AVFwiAjmZASdSW09SBZAIARZCDaAAuzGN1E9aYwxqUQnFlt96DnmxttGEQ1HShv374qHVfPaxLZAYDaGB5n7WNp8PN99DyEAgohrAVGBZA713S7OqJhCKnZCeBTpMqALmYOAxvLPA6weogxJKXmQZDZD';
const PHONE_NUMBER_ID = '1197249056802550'; // Bot +55 21 97038-9751

const WABA_ID = '1696422138262644';
const data = 'subscribed_fields=messages';

const options = {
  hostname: 'graph.facebook.com',
  path: `/v20.0/${WABA_ID}/subscribed_apps`,
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(data)
  }
};

console.log('📡 Inscrevendo campo messages no webhook do WABA do bot...\n');

const req = https.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    console.log(JSON.stringify(JSON.parse(body), null, 2));
  });
});

req.on('error', (e) => console.error('❌ Erro de rede:', e.message));
req.write(data);
req.end();
