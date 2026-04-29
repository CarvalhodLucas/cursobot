require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

// CORS — permite chamadas do CRM (browser)
app.use((req, res, next) => {
	res.header('Access-Control-Allow-Origin', '*');
	res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	res.header('Access-Control-Allow-Headers', 'Content-Type');
	if (req.method === 'OPTIONS') return res.sendStatus(204);
	next();
});

const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
let geminiModel;

// Memória de conversa por usuário
const conversas = {};

// Dados dos leads extraídos e gerenciamento de inatividade
const dadosLead = {};
const ultimaAtividade = {};
const reengajamentoEnviado = {};

// Rodízio para o período da tarde
let ultimoVendedorTarde = 'Paulo';

// Status do bot para o CRM
const botStatus = {
	modelo: 'groq',
	fallbacksHoje: 0,
	ultimoWebhook: null
};

// Cache para escala de vendedores
let escalaCache = null;
let escalaCacheTime = 0;

async function getEscala() {
	if (escalaCache && Date.now() - escalaCacheTime < 5 * 60 * 1000) return escalaCache;
	try {
		const { data, error } = await supabase.from('escala_vendedores').select('*');
		if (error) throw error;
		escalaCache = data;
		escalaCacheTime = Date.now();
		return escalaCache;
	} catch (e) {
		console.error('❌ Erro ao buscar escala:', e.message);
		return escalaCache || [];
	}
}

async function getVendedor() {
	const escala = await getEscala();
	const agora = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
	const hora = agora.getHours() + agora.getMinutes() / 60;
	const dia = agora.getDay();

	// 1. Sábado (dia 6)
	if (dia === 6) {
		const semana = Math.ceil(agora.getDate() / 7);
		const paridade = semana % 2 === 0 ? 'par' : 'impar';
		const match = escala.find(e => e.dia_semana === 6 && (e.sabado_paridade === paridade || e.sabado_paridade === 'sempre'));
		if (match) return match.vendedor;
	}

	// 2. Domingo e Dias Úteis
	let matches = escala.filter(e => {
		const diaMatch = e.dia_semana === dia;
		const hInicio = e.hora_inicio !== null ? e.hora_inicio : 0;
		const hFim = e.hora_fim !== null ? e.hora_fim : 24;
		const horaMatch = hora >= hInicio && hora < hFim;
		return diaMatch && horaMatch;
	});
	
	if (matches.length === 0 && dia >= 1 && dia <= 5) {
		matches = escala.filter(e => {
			const diaMatch = e.dia_semana === null;
			const hInicio = e.hora_inicio !== null ? e.hora_inicio : 0;
			const hFim = e.hora_fim !== null ? e.hora_fim : 24;
			const horaMatch = hora >= hInicio && hora < hFim;
			return diaMatch && horaMatch;
		});
	}

	if (matches.length === 0) return 'Paulo';

	// Se houver qualquer regra de rodízio nos matches, alterna entre os vendedores
	if (matches.some(m => m.tipo === 'rodizio')) {
		ultimoVendedorTarde = ultimoVendedorTarde === 'Paulo' ? 'Rebeca' : 'Paulo';
		return ultimoVendedorTarde;
	}

	return matches[0].vendedor;
}


const SYSTEM_PROMPT = `Você é a assistente virtual de uma escola de idiomas localizada no Recreio dos Bandeirantes, Rio de Janeiro.
Fale sempre em português.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ESTILO DE RESPOSTA — REGRAS RÍGIDAS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Cada resposta deve ter no máximo 3 linhas no WhatsApp.
- Faça UMA pergunta por vez. Nunca empilhe duas ou mais perguntas na mesma mensagem.
- Não repita "Olá, seja bem-vindo" em mensagens depois da primeira.
- Não diga a mesma frase duas vezes na mesma mensagem.
- Espelhe o tom do cliente: se ele escreve formal, responda formal; se usa "kkk" e abreviações, responda mais leve (sem exagerar).
- Use no máximo 1 emoji por mensagem.
- Nunca termine uma recusa com "Ótimo!" ou expressões positivas desconectadas do contexto.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IDENTIFICAÇÃO AUTOMÁTICA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Antes de responder, classifique a mensagem:

ALUNO (já estuda na escola) — sinais: "minha aula", "meu professor", "minha mensalidade", "prova", "falta", "material", "turma que estou", "sou aluno":
→ Responda APENAS: "Entendido! Vou te encaminhar para a coordenação. Um momento! 😊"
→ NÃO tente resolver a dúvida. NÃO peça dados.

LEAD (quer se matricular) — sinais: "quero aprender", "tem curso", "vi o instagram", "vi anúncio", "quanto custa", "tem vaga", "como funciona", "meu filho", "minha filha":
→ Siga o fluxo de qualificação abaixo.

INDEFINIDO (ex: "oi", "bom dia", "tudo bem"):
→ Responda: "Olá! 😊 Você já é aluno ou tem interesse em se matricular?"
→ NÃO use essa saudação novamente na mesma conversa.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INFERÊNCIA DE CONTEXTO — PENSE ANTES DE PERGUNTAR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- "minha mãe quer que eu faça" / "meu pai mandou perguntar" → a pessoa é menor de idade. Pergunte apenas "Quantos anos você tem?" e infira a turma direto.
- "vi o instagram" / "vi um anúncio" / "me indicaram" → é lead. Pule a pergunta aluno/lead.
- "minha mensalidade" / "minha aula" / "meu professor" → é aluno. Encaminhe para coordenação sem perguntar nada.
- Se o cliente já informou a idade, calcule a turma sozinho. NÃO peça a faixa etária de novo.
- Se o cliente já está no WhatsApp, NÃO peça telefone. NÃO peça e-mail a menos que seja essencial.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FLUXO DE QUALIFICAÇÃO DO LEAD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Colete as informações UMA de cada vez, nesta ordem:
1. Nome
2. Idade (para indicar a turma certa)
3. Horário preferido (manhã / tarde / noite / sábado)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONFIRMAÇÃO FINAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Somente após ter nome + idade + horário, ANTES de encerrar, você DEVE enviar uma mensagem de confirmação com os dados coletados EXATAMENTE neste formato:

Perfeito! Antes de encaminhar, deixa eu confirmar seus dados:

👤 Nome: [nome]
📚 Turma indicada: [turma]
⏰ Horário preferido: [horário]

Está tudo certo? (responda "sim" para confirmar ou me corrija o que estiver errado)

Se o cliente corrigir algum dado, atualize e mostre a confirmação novamente.
SOMENTE após o cliente responder "sim" (ou equivalente: "correto", "pode ser", "isso", "tá certo"), envie a mensagem de encerramento:

Ótimo! Seus dados foram registrados. Em breve um de nossos consultores entrará em contato para passar os valores e próximos passos. 😊

Até logo, [nome]! Qualquer dúvida, é só chamar.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TURMAS — RESPONDA COM CONFIANÇA, SEM "PROVAVELMENTE"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- 7 a 8 anos → FUN
- 9 a 10 anos → KIDS
- 11 a 12 anos → TEEN UP
- 13 anos ou mais (adolescente/adulto) → FLY
- Nível intermediário → QUEST
- Pré-avançado → PRE ADV
- Avançado → ADV
- Avançado com nivelamento obrigatório → MASTER

MASTER: sempre avise que é obrigatório fazer um nivelamento antes de qualquer outra informação.
Cada período tem seu próprio material didático incluso.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HORÁRIOS DISPONÍVEIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Segunda e Quarta:
- 14:00–15:15 → PRE ADV Adulto, PRE ADV Teens
- 15:15–16:30 → FLY 2
- 16:30–17:45 → PRE ADV 2, QUEST 1, FLY 2
- 18:00–19:15 → FUN 2, TEEN UP 1, ADV 1, MASTER 2
- 19:15–20:30 → FLY 1, MASTER 1, ACC 1

Terça e Quinta:
- 10:00–11:15 → QUEST 1, KIDS 1
- 14:00–15:15 → PRE ADV 1
- 15:15–16:30 → ADV 1, ADV 2, FLY 1
- 16:30–17:45 → TEEN UP 1, KIDS 4, TEEN UP 3
- 18:00–19:15 → KIDS 1, PRE ADV 2, MASTER 1, TEEN UP 3, ADV 2
- 19:15–20:30 → INTER 2, FLY 2, ADV 1, PRE ADV 1, TEEN UP 3

Sábado:
- 08:00–10:45 → MASTER 1
- 10:45–13:30 → FLY 2, PRE ADV 1
- 14:00–15:15 → PRE ADV 1
- 15:15–16:30 → FLY 1
- 16:30–17:45 → PRE ADV 1

Aulas online: grade flexível — informe que o comercial passa os horários disponíveis.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CURSOS DISPONÍVEIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Inglês (curso principal, turmas acima)
- Espanhol (turmas disponíveis — o comercial passa detalhes)
- IA e Robótica (em breve — demonstre entusiasmo e colete interesse, so mencione isso se perguntarem)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PERGUNTAS DIRETAS — RESPONDA DIRETO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- "tem vaga?" → "Vou confirmar com o comercial. Qual seu nome e horário preferido?"
- "tem turma terça às 19h?" → Consulte a tabela acima e responda o que existe naquele horário. Se não tiver certeza da vaga, diga "existe turma nesse horário — o comercial confirma a disponibilidade."
- Nunca ignore uma pergunta direta. Se não puder responder completamente, diga o que sabe e informe que o comercial confirma o restante.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LOCALIZAÇÃO E DADOS DA ESCOLA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Endereço: Estrada Benvindo de Novaes, 1880 — Recreio dos Bandeirantes, Rio de Janeiro — RJ
- NUNCA confirme uma cidade só porque o cliente disse que mora nela. Se o cliente disser "estou em SP", responda: "Nossa escola fica no Recreio dos Bandeirantes, Rio de Janeiro. Também temos modalidade online, caso prefira!"
- NUNCA invente informações sobre localização, horários ou turmas que não estejam neste prompt.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ENCAMINHAMENTO — COORDENAÇÃO OU COMERCIAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Para alunos (dúvida de aula, mensalidade, reclamação): "Vou encaminhar para a coordenação, que te atende em instantes."
- Para leads (preço, vaga, contrato, matrícula): "Esses detalhes o comercial passa pra você. Posso registrar seu interesse agora?"
- NÃO use "consultores" — use sempre "comercial".

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REGRAS INVIOLÁVEIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- NUNCA informe preços — isso é função do comercial.
- NUNCA invente informações que não estejam neste prompt.
- NUNCA responda dúvidas de alunos — encaminhe sempre.
- NUNCA confirme localização baseada no que o cliente disse.`;

geminiModel = genAI.getGenerativeModel({
        model: 'gemini-3.1-flash-lite-preview',
        systemInstruction: SYSTEM_PROMPT
});

async function askGemini(telefone, mensagem) {
        const history = conversas[telefone].map(m => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }]
        })).slice(0, -1); // Remove a última mensagem que será enviada no sendMessage

        const chat = geminiModel.startChat({ history });

        const result = await chat.sendMessage(mensagem);
        const reply = result.response.text();

        conversas[telefone].push({ role: 'assistant', content: reply });
        return reply;
}

async function askDeepSeek(telefone, mensagem) {
        if (!conversas[telefone]) conversas[telefone] = [];
        conversas[telefone].push({ role: 'user', content: mensagem });
        if (conversas[telefone].length > 20) conversas[telefone] = conversas[telefone].slice(-20);

        try {
                const response = await axios.post(
                        'https://api.groq.com/openai/v1/chat/completions',
                        {
                                model: 'llama-3.3-70b-versatile',
                                messages: [
                                        { role: 'system', content: SYSTEM_PROMPT },
                                        ...conversas[telefone]
                                ]
                        },
                        {
                                headers: {
                                        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                                        'Content-Type': 'application/json'
                                },
                                timeout: 5000 // 5 segundos de timeout para o Groq
                        }
                );

                const reply = response.data.choices[0].message.content;
                conversas[telefone].push({ role: 'assistant', content: reply });
                
                // Se o Groq funcionou, garante que o status mostre o modelo principal
                botStatus.modelo = 'groq';
                
                return reply;
        } catch (err) {
                const isRateLimit = err.response?.status === 429 || err.message.includes('rate_limit_exceeded');
                console.error(`⚠️ Erro no Groq (Rate Limit: ${isRateLimit}):`, err.response?.data || err.message);

                if (isRateLimit || err.code === 'ECONNABORTED') {
                        console.log('🔄 Acionando fallback: Gemini 3.1 Flash-Lite...');
                        botStatus.modelo = 'gemini';
                        botStatus.fallbacksHoje++;
                        try {
                                return await askGemini(telefone, mensagem);
                        } catch (geminiErr) {
                                console.error('❌ Erro crítico: Groq e Gemini falharam.', geminiErr.message);
                                throw geminiErr;
                        }
                }
                throw err;
        }
}

async function sendWhatsApp(telefone, mensagem) {
        try {
                await axios.post(
                        `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
                        { phone: telefone, message: mensagem },
                        { headers: { 'Content-Type': 'application/json', 'Client-Token': ZAPI_CLIENT_TOKEN } }
                );
        } catch (err) {
                console.error('Erro ao enviar:', err.response?.data || err.message);
        }
}

async function salvarMensagem(telefone, mensagem, de, vendedor, tipo = 'desconhecido') {
        try {
                const { error } = await supabase.from('conversas').insert({
                        telefone,
                        mensagem,
                        de,
                        vendedor,
                        tipo,
                        created_at: new Date().toISOString()
                });
                if (error) {
                        console.error('❌ Erro Supabase:', JSON.stringify(error));
                } else {
                        console.log('✅ Salvo no Supabase!');
                }
        } catch (err) {
                console.error('❌ Erro ao salvar:', err.message);
        }
}

async function getHistorico(telefone) {
        // Se já existe na RAM, não faz nada
        if (conversas[telefone]) return;

        try {
                // Busca as últimas 20 mensagens ordenadas por data descendente
                const { data, error } = await supabase
                        .from('conversas')
                        .select('mensagem, de')
                        .eq('telefone', telefone)
                        .order('created_at', { ascending: false })
                        .limit(20);

                if (error) throw error;

                if (data && data.length > 0) {
                        // Reverte para ordem cronológica (mais antiga para mais recente) e mapeia para o formato do LLM
                        conversas[telefone] = data.reverse().map(m => ({
                                role: m.de === 'bot' ? 'assistant' : 'user',
                                content: m.mensagem
                        }));
                        console.log(`📜 Histórico carregado do Supabase para ${telefone} (${data.length} mensagens)`);
                } else {
                        // Se não houver histórico, inicializa vazio
                        conversas[telefone] = [];
                }
        } catch (err) {
                console.error('❌ Erro ao carregar histórico:', err.message);
                // Em caso de erro, garante que a conversa seja inicializada para não quebrar o fluxo
                conversas[telefone] = [];
        }
}

// Detecta se é aluno ou lead
function detectarTipo(mensagem, reply) {
        const msgLower = mensagem.toLowerCase();
        const replyLower = reply.toLowerCase();

        if (
                msgLower.includes('sou aluno') ||
                msgLower.includes('já sou aluno') ||
                msgLower.includes('ja sou aluno') ||
                msgLower.includes('sou estudante') ||
                msgLower.includes('tenho aula') ||
                msgLower.includes('minha aula') ||
                msgLower.includes('prova') ||
                msgLower.includes('falta') ||
                replyLower.includes('coordenação')
        ) {
                return 'aluno';
        }

        if (
                msgLower.includes('quero me matricular') ||
                msgLower.includes('tenho interesse') ||
                msgLower.includes('quero saber') ||
                msgLower.includes('informações') ||
                msgLower.includes('informacoes') ||
                msgLower.includes('preço') ||
                msgLower.includes('preco') ||
                msgLower.includes('valor') ||
                replyLower.includes('consultor') ||
                replyLower.includes('comercial')
        ) {
                return 'lead';
        }

        return 'desconhecido';
}

// Webhook
app.post('/webhook', async (req, res) => {
        res.sendStatus(200);

        const body = req.body;
        if (body.fromMe || body.isGroup) return;

        const telefone = body.phone;
        const mensagem = body.text?.message;
        if (!telefone || !mensagem) return;

        // Atualiza status do último webhook recebido
        botStatus.ultimoWebhook = new Date().toISOString();

        // Garante que o histórico esteja carregado na RAM antes de processar
        await getHistorico(telefone);
 

        const vendedor = await getVendedor();
        console.log(`📩 ${telefone}: ${mensagem} → vendedor: ${vendedor}`);

        try {
                // Atualiza inatividade e reengajamento
                ultimaAtividade[telefone] = Date.now();
                reengajamentoEnviado[telefone] = false;

                const reply = await askDeepSeek(telefone, mensagem);
                let tipo = detectarTipo(mensagem, reply);

                // Extração de dados da resposta do bot para memória
                if (!dadosLead[telefone]) {
                        dadosLead[telefone] = { nome: null, turma: null, horario: null, confirmado: false };
                }
                
                const nomeMatch = reply.match(/👤 Nome:\s*(.+)/);
                const turmaMatch = reply.match(/📚 Turma indicada:\s*(.+)/);
                const horarioMatch = reply.match(/⏰ Horário preferido:\s*(.+)/);
                
                if (nomeMatch) dadosLead[telefone].nome = nomeMatch[1].trim();
                if (turmaMatch) dadosLead[telefone].turma = turmaMatch[1].trim();
                if (horarioMatch) dadosLead[telefone].horario = horarioMatch[1].trim();
                
                if (reply.includes('Seus dados foram registrados')) {
                        dadosLead[telefone].confirmado = true;
                }

                if (dadosLead[telefone].confirmado) {
                        tipo = 'lead_confirmado';
                }

                console.log(`🤖 Resposta: ${reply} → tipo: ${tipo}`);

                // Prioridade: Enviar o WhatsApp primeiro
                await sendWhatsApp(telefone, reply);

                // Salvar em segundo plano (sem travar a resposta)
                salvarMensagem(telefone, mensagem, 'cliente', vendedor, tipo);
                salvarMensagem(telefone, reply, 'bot', vendedor, tipo);
        } catch (err) {
                console.error('Erro:', err.response?.data || err.message);
        }
});

app.get('/', (req, res) => res.send('Escola Bot rodando ✅'));

// Rota de simulação para o CRM — usa o mesmo Groq/Gemini do bot
app.post('/simulate', async (req, res) => {
	const { mensagem } = req.body;
	if (!mensagem) return res.status(400).json({ error: 'mensagem is required' });

	const telefone = 'simulador_crm';
	// Cria histórico limpo para a simulação
	conversas[telefone] = [];

	try {
		const reply = await askDeepSeek(telefone, mensagem);
		const tipo = detectarTipo(mensagem, reply);
		delete conversas[telefone]; // limpa memória depois
		res.json({ reply, tipo, modelo: botStatus.modelo });
	} catch (err) {
		console.error('Erro na simulação:', err.message);
		res.status(500).json({ error: err.message });
	}
});

// Rota de status para o CRM
app.get('/status', (req, res) => {
	res.json({
		modelo: botStatus.modelo,
		fallbacksHoje: botStatus.fallbacksHoje,
		ultimoWebhook: botStatus.ultimoWebhook || null,
		uptime: Math.floor(process.uptime()),
		conversasAtivas: Object.keys(conversas).length
	});
});

// Rota para resetar memória de um número
app.get('/reset/:telefone', (req, res) => {
        const telefone = req.params.telefone;
        delete conversas[telefone];
        console.log(`🔄 Memória resetada para ${telefone}`);
        res.send(`Memória resetada para ${telefone} ✅`);
});

// Rota para resetar TUDO
app.get('/reset-all', (req, res) => {
        Object.keys(conversas).forEach(k => delete conversas[k]);
        console.log('🔄 Toda memória resetada');
        res.send('Toda memória resetada ✅');
});

// Reengajamento após 24h de inatividade
function checkInatividade() {
	const agora = Date.now();
	for (const telefone in ultimaAtividade) {
		if (agora - ultimaAtividade[telefone] > 24 * 60 * 60 * 1000 && !reengajamentoEnviado[telefone]) {
			const dados = dadosLead[telefone] || {};
			let msg = '';
			
			if (!dados.nome) {
				msg = "Olá! 😊 Ainda posso te ajudar com informações sobre nossos cursos? É só responder aqui!";
			} else if (dados.nome && (!dados.turma || !dados.horario)) {
				msg = `Oi, ${dados.nome}! Tudo bem? Ainda estou aqui caso queira continuar conhecendo nossos cursos. 😊`;
			} else if (dados.nome && dados.turma && dados.horario && !dados.confirmado) {
				msg = `Oi, ${dados.nome}! Enviei os seus dados para confirmar, mas ainda não recebi resposta. Gostaria de prosseguir com o cadastro?`;
			}

			if (msg) {
				console.log(`⏳ Reengajamento disparado para ${telefone}`);
				sendWhatsApp(telefone, msg);
				reengajamentoEnviado[telefone] = true;
			}
		}
	}
}

// Roda a cada 30 minutos
setInterval(checkInatividade, 30 * 60 * 1000);

app.listen(3000, () => console.log('🚀 Escola Bot rodando na porta 3000'));