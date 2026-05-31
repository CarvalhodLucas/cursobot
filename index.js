require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

// CORS — restringe às origens configuradas em ALLOWED_ORIGINS (vírgula separada)
// Em desenvolvimento (variável não definida), aceita qualquer origem.
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
        : null; // null = modo dev, sem restrição

app.use((req, res, next) => {
        const origin = req.headers.origin;

        if (!ALLOWED_ORIGINS) {
                // Modo dev: libera tudo
                res.header('Access-Control-Allow-Origin', '*');
        } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
                res.header('Access-Control-Allow-Origin', origin);
                res.header('Vary', 'Origin');
        } else if (!origin) {
                // Requisições server-to-server (sem cabeçalho Origin) sempre passam
                // (ex: webhook do Z-API)
        } else {
                // Origem não permitida
                return res.status(403).json({ error: 'Origem não autorizada' });
        }

        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        next();
});

const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;
const NUMERO_COORDENACAO = process.env.NUMERO_COORDENACAO;
const NUMERO_GERENTE = process.env.NUMERO_GERENTE;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
let geminiModel;

// Memória de conversa por usuário
const conversas = {};

// Mapeamento LID → telefone real (WhatsApp LID privacy feature)
const lidToPhone = new Map();

// Dados dos leads extraídos e gerenciamento de inatividade
const dadosLead = {};
const ultimaAtividade = {};
const reengajamentoEnviado = {};

// Cache de vendedor por telefone para a sessão atual
const vendedorPorTelefone = {};

// Rodízio para o período da tarde
let ultimoVendedorTarde = 'Paulo';
let ultimoVendedorFallback = 'Paulo';

// Status do bot para o CRM
const botStatus = {
        modelo: 'groq', // 'groq' | 'groq_2' | 'gemini'
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
        const agora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
        const hora = agora.getHours() + agora.getMinutes() / 60;
        const dia = agora.getDay();

        // 1. Domingo — Fallback
        if (dia === 0) {
                ultimoVendedorFallback = ultimoVendedorFallback === 'Paulo' ? 'Rebecca' : 'Paulo';
                return ultimoVendedorFallback;
        }

        // 2. Busca match na escala (com suporte a sabado_paridade)
        const diaDoProjeto = agora.getDate();
        const ehSabado = dia === 6;
        const ehPar = diaDoProjeto % 2 === 0;

        // Usamos uma pequena margem para evitar problemas de precisão com floats (16.83)
        const match = escala.find(e => {
                const diaMatch = e.dia_semana === dia;
                const horaMatch = hora >= (e.hora_inicio - 0.02) && hora < (e.hora_fim + 0.02);
                if (!diaMatch || !horaMatch) return false;

                // Filtra por paridade do sábado quando configurado
                if (ehSabado && e.sabado_paridade && e.sabado_paridade !== 'sempre') {
                        if (e.sabado_paridade === 'par' && !ehPar) return false;
                        if (e.sabado_paridade === 'impar' && ehPar) return false;
                }
                return true;
        });

        if (!match) {
                ultimoVendedorFallback = ultimoVendedorFallback === 'Paulo' ? 'Rebecca' : 'Paulo';
                console.log(`⚠️ Nenhum vendedor escalado para dia ${dia} às ${hora.toFixed(2)}h. Usando fallback: ${ultimoVendedorFallback}`);
                return ultimoVendedorFallback;
        }

        // 3. Rodízio
        if (match.vendedor === 'rodizio' || match.tipo === 'rodizio') {
                ultimoVendedorTarde = ultimoVendedorTarde === 'Paulo' ? 'Rebecca' : 'Paulo';
                return ultimoVendedorTarde;
        }

        return match.vendedor;
}

async function getVendedorDoTelefone(telefone) {
        // Se já tem em cache, usa o mesmo
        if (vendedorPorTelefone[telefone]) return vendedorPorTelefone[telefone];

        // Verifica se já existe no banco
        try {
                const { data } = await supabase
                        .from('conversas')
                        .select('vendedor')
                        .eq('telefone', telefone)
                        .order('created_at', { ascending: true })
                        .limit(1);

                if (data && data.length > 0 && data[0].vendedor) {
                        // Já tem histórico — mantém o mesmo vendedor
                        vendedorPorTelefone[telefone] = data[0].vendedor;
                        console.log(`👤 ${telefone} → vendedor fixo: ${data[0].vendedor}`);
                        return data[0].vendedor;
                }
        } catch (err) {
                console.error('Erro ao buscar vendedor do histórico:', err.message);
        }

        // Novo número — atribui vendedor do horário atual e salva em cache
        const vendedor = await getVendedor();
        vendedorPorTelefone[telefone] = vendedor;
        console.log(`👤 ${telefone} → novo lead, vendedor: ${vendedor}`);
        return vendedor;
}


// Cache da base de conhecimento (RAG)
let ragCache = null;
let ragCacheTime = 0;

async function getBaseConhecimento() {
        if (ragCache && Date.now() - ragCacheTime < 10 * 60 * 1000) return ragCache;
        try {
                const { data, error } = await supabase.from('base_conhecimento').select('*').eq('ativo', true);
                if (error) throw error;
                ragCache = data || [];
                ragCacheTime = Date.now();
                return ragCache;
        } catch (e) {
                console.error('❌ Erro ao buscar base de conhecimento:', e.message);
                return ragCache || [];
        }
}

function stemPortugues(palavra) {
	return palavra
		.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/ores$|ões$|oes$|ção$|cao$|es$|os$|as$|is$|ns$|s$/, '')
		.replace(/mente$|ando$|endo$|ção$/, '')
		.trim();
}

async function buscarRAG(mensagem) {
	const palavras = mensagem
		.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, '')
		.split(/\s+/)
		.filter(p => p.length > 1)
		.map(p => stemPortugues(p));

	if (!palavras.length) return [];

	const data = await getBaseConhecimento();
	if (!data || !data.length) return [];

	const seen = new Set();

	// Pontua cada item pelo número de palavras-chave que coincidem com a mensagem
	const pontuados = data
		.map(item => {
			if (!item.palavras_chave) return null;
			const kwNorm = item.palavras_chave
				.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
				.toLowerCase();
			const score = palavras.filter(p => kwNorm.includes(p)).length;
			return score > 0 ? { item, score } : null;
		})
		.filter(Boolean)
		.sort((a, b) => b.score - a.score); // ordena do mais relevante para o menos relevante

	// Retorna o item mais relevante por categoria (subcategorias distintas,
	// ex: horario_seg_qua ≠ horario_ter_qui, são retornadas separadamente)
	return pontuados
		.filter(({ item }) => {
			if (seen.has(item.categoria)) return false;
			seen.add(item.categoria);
			return true;
		})
		.map(({ item }) => item);
}





const SYSTEM_PROMPT = `Você é a assistente virtual de uma escola de idiomas localizada no Recreio dos Bandeirantes, Rio de Janeiro.
Fale sempre em português, mas se alguem falar com voce em ingles, pode responder em ingles.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ESTILO DE RESPOSTA — REGRAS RÍGIDAS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Cada resposta deve ter no máximo 3 linhas no WhatsApp.
- Faça UMA pergunta por vez. Nunca empilhe duas ou mais perguntas na mesma mensagem.
- Não repita "Olá, seja bem-vindo" em mensagens depois da primeira.
- Não diga a mesma frase duas vezes na mesma mensagem.
- Espelhe o tom do cliente: se ele escreve formal, responda formal; se usa "kkk" e abreviações, responda mais leve (sem exagerar).
- Use no máximo 1 emoji por mensagem. Se usou emoji em uma mensagem, a PRÓXIMA obrigatoriamente não usa emoji. Nunca use emoji em duas mensagens consecutivas.
- Emojis são opcionais — use só quando adicionar calor à conversa, não por hábito. Na dúvida, não use.
- Nunca termine uma recusa com "Ótimo!" ou expressões positivas desconectadas do contexto.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IDENTIFICAÇÃO AUTOMÁTICA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Antes de responder, classifique a mensagem:

ALUNO (já estuda na escola) vs LEAD (quer se matricular):
- Se houver sinal EXPLÍCITO de que JÁ É ALUNO (ex: "perdi minha aula", "sou aluno", "minha turma", "minha professora"):
  → Responda DIRETAMENTE: "Entendido! Vou encaminhar para a coordenação agora. Um momento!"
  → NÃO faça perguntas. NÃO peça mais informações. Encaminhe imediatamente.

SINAIS ADICIONAIS DE ALUNO — Qualquer mensagem contendo:
- "mensalidade", "boleto", "pagamento", "vencimento", "pagar" → É ALUNO
- Nome de pessoa + valor ou mês (ex: "Mensalidade de abril Pedro Cardoso") → É ALUNO
- Referência a data de aula ou horário de turma específica → É ALUNO
- Nome de professor (ex: "professora Ana", "prof João") → É ALUNO
- "falta", "reposição", "cancelar aula", "trocar horário" → É ALUNO
→ Nesses casos: responda DIRETAMENTE "Entendido! Vou encaminhar para a coordenação agora. Um momento!" e NÃO faça nenhuma pergunta.

- Se houver DÚVIDA GENUÍNA (perguntas genéricas sobre professores, aulas, horários, turmas sem contexto de aluno):
  → NÃO assuma que é aluno. Responda à dúvida e siga o fluxo de lead.
- PRIORIDADE LEAD: Na dúvida sem sinais claros de aluno, trate como LEAD. É melhor explicar algo para um aluno do que expulsar um lead mandando-o para a coordenação.

LEAD (quer se matricular) — sinais: "quero aprender", "tem curso", "vi o instagram", "vi anúncio", "quanto custa", "tem vaga", "como funciona", "meu filho", "minha filha":
→ Siga o fluxo de qualificação abaixo.

INDEFINIDO (ex: "oi", "bom dia", "tudo bem"):
→ Responda: "Olá! 😊 Você já é aluno ou tem interesse em se matricular?"
→ NÃO use essa saudação novamente na mesma conversa.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INFERÊNCIA DE CONTEXTO — PENSE ANTES DE PERGUNTAR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- "minha mãe quer que eu faça" / "meu pai mandou perguntar" → a pessoa é menor de idade. Pergunte apenas "Quantos anos você tem?" e infira a turma direto.
- "vi o instagram" / "vi um anúncio" / "me indicaram" / "tenho interesse" / "quero me matricular" / "meu filho" / "minha filha" → é lead. Pule a pergunta aluno/lead e NÃO pergunte "Você já é aluno?". Vá direto para responder a dúvida e seguir a qualificação.
- Se o cliente mencionar "minha mensalidade", "minha aula" ou "meu professor", confirme: "Você já é nosso aluno? Se sim, vou te passar para a coordenação!"
- NUNCA encaminhe para coordenação sem ter certeza que o cliente já é aluno. Na dúvida, continue como LEAD.
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

Ótimo! Seus dados foram registrados. Em breve o comercial entrará em contato para passar os valores e próximos passos. 😊

Até logo, [nome]! Qualquer dúvida, é só chamar.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TURMAS E CURSOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
As informações sobre turmas, faixas etárias, níveis e cursos disponíveis estão no bloco "INFORMAÇÕES VERIFICADAS" (RAG). Use SOMENTE essas informações. Nunca invente turmas ou cursos.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LOCALIZAÇÃO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
O endereço da escola está no bloco "INFORMAÇÕES VERIFICADAS" (RAG). NUNCA confirme cidade baseada no que o cliente disse. Se disser que está em outra cidade, mencione que temos modalidade online.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PERGUNTAS DIRETAS — RESPONDA DIRETO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- "tem vaga?" → "Vou confirmar com o comercial. Qual seu nome e horário preferido?"
- "tem turma terça às 19h?" → Consulte a tabela acima e responda o que existe naquele horário. Se não tiver certeza da vaga, diga "existe turma nesse horário — o comercial confirma a disponibilidade."
- Nunca ignore uma pergunta direta. Se não puder responder completamente, diga o que sabe e informe que o comercial confirma o restante.

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
- NUNCA confirme localização baseada no que o cliente disse.
- NUNCA mencione o comercial mais de uma vez pelo mesmo assunto. Se já redirecionou e o cliente insistir, diga: "Assim que o comercial entrar em contato, ele te explica tudo sobre isso."
- NUNCA pergunte se o cliente quer que você "encaminhe" ou "envie" a pergunta para o comercial. O comercial já vai entrar em contato automaticamente. Apenas informe: "Essa informação o comercial te passa quando entrar em contato!"
- NUNCA ofereça intermediar ou encaminhar perguntas — isso não é função do bot.
- NUNCA encaminhe para coordenação sem ter certeza que o cliente já é aluno. Na dúvida, trate como lead.
- NUNCA invente dados sobre professores (nacionalidade, quantidade, nomes).
- NUNCA responda a perguntas fora do contexto da escola de idiomas (ex: receitas, conhecimentos gerais, programação, etc). Se a pergunta não tiver relação com a escola, responda educadamente que você é a assistente virtual da escola e retorne o foco para os cursos.
- Para qualquer pergunta factual sobre a escola sem resposta no bloco INFORMAÇÕES VERIFICADAS, use SEMPRE: "Boa pergunta! O comercial vai te responder isso com precisão. Posso registrar seu interesse enquanto isso?"`;
geminiModel = genAI.getGenerativeModel({
        model: 'gemini-3.1-flash-lite',
        systemInstruction: SYSTEM_PROMPT
});

async function askGemini(telefone, mensagem, systemPromptFinal = SYSTEM_PROMPT) {
        const history = conversas[telefone].map(m => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }]
        })).slice(0, -1); // Remove a última mensagem que será enviada no sendMessage

        const model = genAI.getGenerativeModel({
                model: 'gemini-3.1-flash-lite',
                systemInstruction: systemPromptFinal
        });

        try {
                const chat = model.startChat({ history });
                const result = await chat.sendMessage(mensagem);
                const reply = result.response.text();

                conversas[telefone].push({ role: 'assistant', content: reply });
                return reply;
        } catch (error) {
                console.error('❌ Erro na API do Gemini:', error.message);
                throw error;
        }
}

async function askGroq(telefone, mensagem, apiKey, systemPromptFinal) {
        const response = await axios.post(
                'https://api.groq.com/openai/v1/chat/completions',
                {
                        model: 'llama-3.3-70b-versatile',
                        messages: [
                                { role: 'system', content: systemPromptFinal },
                                ...conversas[telefone]
                        ]
                },
                {
                        headers: {
                                'Authorization': `Bearer ${apiKey}`,
                                'Content-Type': 'application/json'
                        },
                        timeout: 10000 // 10 segundos para cada tentativa Groq
                }
        );
        return response.data.choices[0].message.content;
}

async function askAI(telefone, mensagem) {
        if (!conversas[telefone]) conversas[telefone] = [];
        conversas[telefone].push({ role: 'user', content: mensagem });
        if (conversas[telefone].length > 20) conversas[telefone] = conversas[telefone].slice(-20);

        // Busca RAG usando o contexto das últimas 3 mensagens para pegar referências como "15" respondendo a "qual a sua idade"
        const contextoRecente = conversas[telefone].slice(-3).map(m => m.content).join(' ');
        const ragResultados = await buscarRAG(contextoRecente);
        let systemPromptFinal = SYSTEM_PROMPT;
        if (ragResultados.length > 0) {
                const contextoRAG = ragResultados.map(r => `- ${r.resposta}`).join('\n');
                systemPromptFinal = `${SYSTEM_PROMPT}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INFORMAÇÕES VERIFICADAS DA ESCOLA — USE APENAS ESTAS, NÃO INVENTE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${contextoRAG}`;
                console.log(`🧠 Contexto RAG injetado (${ragResultados.length} itens)`);
        }

        // Após injetar o RAG, injetar também os dados já coletados
        const dados = dadosLead[telefone];
        if (dados && dados.confirmado) {
                // Lead já encerrado — modo pós-confirmação
                systemPromptFinal += `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STATUS DO ATENDIMENTO — LEAD JÁ REGISTRADO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Este cliente JÁ TEVE SEUS DADOS REGISTRADOS com sucesso:
- Nome: ${dados.nome || '—'}
- Turma indicada: ${dados.turma || '—'}
- Horário preferido: ${dados.horario || '—'}

REGRAS OBRIGATÓRIAS PARA ESTE ATENDIMENTO:
1. NUNCA peça nome, idade, horário ou turma novamente — esses dados já foram coletados.
2. O comercial já foi notificado e entrará em contato em breve.
3. Se o cliente fizer perguntas sobre cursos, responda normalmente usando as informações disponíveis.
4. Se o cliente perguntar sobre o status do cadastro, diga: "Seus dados já estão registrados! O comercial entrará em contato em breve."
5. Seja cordial e breve. NÃO reinicie o fluxo de qualificação.
6. Responda no idioma que o cliente estiver usando.`;
        } else if (dados && (dados.nome || dados.turma || dados.horario)) {
                // Lead parcialmente preenchido — injeta dados coletados
                const dadosColetados = [];
                if (dados.nome) dadosColetados.push(`Nome: ${dados.nome}`);
                if (dados.turma) dadosColetados.push(`Turma indicada: ${dados.turma}`);
                if (dados.horario) dadosColetados.push(`Horário preferido: ${dados.horario}`);

                systemPromptFinal += `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DADOS JÁ COLETADOS DESTE CLIENTE — NÃO PERGUNTE DE NOVO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${dadosColetados.join('\n')}
IMPORTANTE: Esses dados já foram coletados. NÃO peça nome, idade ou horário novamente. Se o cliente quiser corrigir algum dado, atualize e mostre a confirmação.`;
        }

        // Tentativa 1 — Groq chave principal
        if (process.env.GROQ_API_KEY) {
                try {
                        const reply = await askGroq(telefone, mensagem, process.env.GROQ_API_KEY, systemPromptFinal);
                        conversas[telefone].push({ role: 'assistant', content: reply });
                        botStatus.modelo = 'groq';
                        return reply;
                } catch (err) {
                        const isLimit = err.response?.status === 429 || err.code === 'ECONNABORTED';
                        console.warn(`⚠️ Groq chave 1 falhou (limit: ${isLimit}):`, err.message);
                }
        }

        // Tentativa 2 — Groq chave reserva
        if (process.env.GROQ_API_KEY_2) {
                try {
                        const reply = await askGroq(telefone, mensagem, process.env.GROQ_API_KEY_2, systemPromptFinal);
                        conversas[telefone].push({ role: 'assistant', content: reply });
                        botStatus.modelo = 'groq_2';
                        console.log('✅ Usando Groq chave 2');
                        return reply;
                } catch (err) {
                        const isLimit = err.response?.status === 429 || err.code === 'ECONNABORTED';
                        console.warn(`⚠️ Groq chave 2 falhou (limit: ${isLimit}):`, err.message);
                }
        }

        // Tentativa 3 — Gemini (Fallback final)
        console.log('🔄 Acionando Gemini como fallback final...');
        botStatus.modelo = 'gemini';
        botStatus.fallbacksHoje++;
        try {
                const reply = await askGemini(telefone, mensagem, systemPromptFinal);
                return reply;
        } catch (geminiErr) {
                console.error('❌ Todos os modelos falharam.', geminiErr.message);
                throw geminiErr;
        }
}

async function sendWhatsApp(telefone, mensagem) {
        try {
                const phoneLimpo = String(telefone).replace(/\D/g, '');
                await axios.post(
                        `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
                        { phone: phoneLimpo, message: mensagem },
                        { headers: { 'Content-Type': 'application/json', 'Client-Token': ZAPI_CLIENT_TOKEN } }
                );
        } catch (err) {
                console.error('Erro ao enviar:', err.response?.data || err.message);
        }
}

async function notificarVendedor(telefone, vendedor) {
        const dados = dadosLead[telefone];
        if (!dados || !dados.confirmado) return;

        // Pega o número do vendedor pela variável de ambiente
        const nomeVendedor = (vendedor || '').toLowerCase();
        const numeroVendedor = nomeVendedor === 'rebecca'
                ? process.env.NUMERO_REBECCA
                : process.env.NUMERO_PAULO;

        if (!numeroVendedor) {
                console.warn(`⚠️ Número do vendedor ${vendedor} não configurado`);
                return;
        }

        console.log(`📡 Notificando vendedor ${vendedor} para lead ${telefone}. Dados:`, JSON.stringify(dados));
        const telefoneLimpo = String(telefone).replace(/\D/g, '');
        const msg = `🔔 *Novo lead confirmado!*

👤 Nome: ${dados.nome || '—'}
📚 Turma: ${dados.turma || '—'}
⏰ Horário: ${dados.horario || '—'}
📱 Contato: +${telefoneLimpo}

Entre em contato para fechar a matrícula!`;

        await sendWhatsApp(numeroVendedor, msg);
        console.log(`✅ Lead notificado para ${vendedor} (${numeroVendedor})`);
}

async function notificarCoordenacao(telefone) {
        if (!NUMERO_COORDENACAO) {
                console.warn('⚠️ Número da coordenação não configurado');
                return;
        }

        const telefoneLimpo = String(telefone).replace(/\D/g, '');
        const msg = `📋 *Aluno aguardando atendimento!*

📱 Contato: +${telefoneLimpo}

Este número foi identificado como aluno e está aguardando suporte da coordenação.`;

        await sendWhatsApp(NUMERO_COORDENACAO, msg);
        console.log(`✅ Coordenação notificada para atender ${telefone}`);
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
                        console.error(`❌ Supabase insert falhou [${telefone}] de=${de} tipo=${tipo}: ${JSON.stringify(error)}`);
                } else {
                        console.log(`✅ Salvo [${telefone}] de=${de} tipo=${tipo}`);
                }
        } catch (err) {
                console.error(`❌ Erro ao salvar [${telefone}]: ${err.message}`);
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

                        // Reconstruir dadosLead a partir do histórico
                        if (!dadosLead[telefone]) {
                                dadosLead[telefone] = { nome: null, turma: null, horario: null, confirmado: false, notificado: false, consentimentoDado: true };
                        }
                        // Já tem histórico = consentimento dado anteriormente
                        dadosLead[telefone].consentimentoDado = true;

                        // Busca nas mensagens do bot os dados já confirmados
                        data.forEach(m => {
                                if (m.de === 'bot') {
                                        const nomeMatch = m.mensagem.match(/(?:👤|Nome).*?:\s*([^\n\*]+)/i);
                                        const turmaMatch = m.mensagem.match(/(?:📚|Turma).*?:\s*([^\n\*]+)/i);
                                        const horarioMatch = m.mensagem.match(/(?:⏰|Hor[áa]rio).*?:\s*([^\n\*]+)/i);
                                        if (nomeMatch) dadosLead[telefone].nome = nomeMatch[1].trim();
                                        if (turmaMatch) dadosLead[telefone].turma = turmaMatch[1].trim();
                                        if (horarioMatch) dadosLead[telefone].horario = horarioMatch[1].trim();
                                }
                        });

                        console.log(`📜 Histórico + dados carregados para ${telefone}`);
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

async function verificarConsentimento(telefone) {
  // Verifica se já deu consentimento nesta sessão
  if (dadosLead[telefone]?.consentimentoDado) return true;

  // Verifica se já existe qualquer histórico no banco — qualquer tipo de conversa
  // (inclui conversa_vendedor) — se existe, já deu consentimento antes
  try {
    const { data } = await supabase
      .from('conversas')
      .select('id')
      .eq('telefone', telefone)
      .limit(1);
    
    if (data && data.length > 0) {
      if (!dadosLead[telefone]) dadosLead[telefone] = { nome: null, turma: null, horario: null, confirmado: false, notificado: false, consentimentoDado: true };
      dadosLead[telefone].consentimentoDado = true;
      return true;
    }
  } catch (err) {
    console.error('Erro ao verificar consentimento:', err.message);
  }

  return false;
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

// Extrai o conteúdo de qualquer tipo de mensagem do Z-API
function extrairMensagem(body) {
	if (body.text?.message) return body.text.message;
	if (typeof body.text === 'string' && body.text) return body.text;
	if (body.message?.text) return body.message.text;
	if (body.image) return body.image.caption || '[imagem]';
	if (body.audio) return '[áudio]';
	if (body.video) return body.video.caption || '[vídeo]';
	if (body.document) return `[documento: ${body.document.fileName || 'arquivo'}]`;
	if (body.sticker) return '[figurinha]';
	if (body.reaction) return `[reação: ${body.reaction.reactionMessage || ''}]`;
	if (body.contact) return `[contato: ${body.contact.displayName || ''}]`;
	if (body.location) return '[localização]';
	return null;
}

// Normaliza o telefone: remove @c.us, não-dígitos e garante prefixo 55 em números brasileiros
function normalizePhone(phone) {
        if (!phone) return null;
        let num = String(phone).split('@')[0].replace(/\D/g, '');
        // Números brasileiros sem código de país (10-11 dígitos) recebem prefixo 55
        if (num.length === 10 || num.length === 11) num = '55' + num;
        return num;
}

// Webhook
app.post('/webhook', async (req, res) => {
        res.sendStatus(200);

        const body = req.body;
        if (body.fromMe || body.isGroup) return;

        const telefone = normalizePhone(body.phone);
        const mensagem = body.text?.message || body.text || (typeof body.text === 'string' ? body.text : null);
        if (!telefone || !mensagem) return;

        // Atualiza status do último webhook recebido
        botStatus.ultimoWebhook = new Date().toISOString();

        // Garante que o histórico esteja carregado na RAM antes de processar
        await getHistorico(telefone);

        // Verifica se pediu remoção de dados
        if (mensagem.toUpperCase().includes('REMOVER MEUS DADOS')) {
                // Deleta do Supabase
                await supabase.from('conversas').delete().eq('telefone', telefone);
                await supabase.from('status_de_leads').delete().eq('telefone', telefone);
                
                // Limpa da RAM
                delete conversas[telefone];
                delete dadosLead[telefone];
                delete ultimaAtividade[telefone];
                delete vendedorPorTelefone[telefone];

                await sendWhatsApp(telefone, 'Seus dados foram removidos com sucesso. Obrigado! 😊');
                return;
        }

        const jaConsentiu = await verificarConsentimento(telefone);

        const vendedor = await getVendedorDoTelefone(telefone);

        if (!jaConsentiu) {
                // Primeira mensagem do número — envia aviso de LGPD
                const msgLGPD = `Olá! Sou a assistente virtual da escola. 😊\n\nEste atendimento é automático e os dados desta conversa serão armazenados conforme a LGPD. Para remover seus dados, envie "REMOVER MEUS DADOS".`;

                await sendWhatsApp(telefone, msgLGPD);

                // Inicializa o lead com consentimento pendente mas continua o fluxo
                if (!dadosLead[telefone]) dadosLead[telefone] = { nome: null, turma: null, horario: null, confirmado: false, notificado: false, consentimentoDado: false };
                dadosLead[telefone].consentimentoDado = true; // Considera consentido ao continuar

                // Salva apenas a mensagem LGPD no banco, a mensagem do cliente será salva no final junto com a resposta da IA
                await salvarMensagem(telefone, msgLGPD, 'bot', vendedor, 'desconhecido');
                
                // Adiciona a LGPD no histórico em RAM
                if (!conversas[telefone]) conversas[telefone] = [];
                conversas[telefone].push({ role: 'assistant', content: msgLGPD });
                
                // NÃO damos return; continua o fluxo para a IA responder à mensagem inicial
        }
        console.log(`📩 ${telefone}: ${mensagem} → vendedor: ${vendedor}`);

        try {
                // Atualiza inatividade — reseta reengajamento APENAS se ainda não foi encerrado
                ultimaAtividade[telefone] = Date.now();
                // Não reseta se já foi marcado como encerrado pelo checkInatividade
                // (permite reengajamento se o cliente voltar a interagir após ficar inativo)
                reengajamentoEnviado[telefone] = false;
                salvarEstadoBot(telefone);

                const reply = await askAI(telefone, mensagem);
                let tipo = detectarTipo(mensagem, reply);

                if (tipo === 'aluno' && !reengajamentoEnviado[`coord_${telefone}`]) {
                        reengajamentoEnviado[`coord_${telefone}`] = true;
                        await notificarCoordenacao(telefone);
                }

                // Extração de dados da resposta do bot para memória
                if (!dadosLead[telefone]) {
                        dadosLead[telefone] = { nome: null, turma: null, horario: null, confirmado: false, notificado: false, consentimentoDado: true };
                }

                const nomeMatch = reply.match(/(?:👤|Nome).*?:\s*([^\n\*]+)/i);
                const turmaMatch = reply.match(/(?:📚|Turma).*?:\s*([^\n\*]+)/i);
                const horarioMatch = reply.match(/(?:⏰|Hor[áa]rio).*?:\s*([^\n\*]+)/i);

                if (nomeMatch) dadosLead[telefone].nome = nomeMatch[1].trim();
                if (turmaMatch) dadosLead[telefone].turma = turmaMatch[1].trim();
                if (horarioMatch) dadosLead[telefone].horario = horarioMatch[1].trim();

                if (reply.includes('Seus dados foram registrados')) {
                        dadosLead[telefone].confirmado = true;
                        salvarEstadoBot(telefone);
                }

                if (dadosLead[telefone].confirmado && !dadosLead[telefone].notificado) {
                        tipo = 'lead_confirmado';
                        dadosLead[telefone].notificado = true;
                        salvarEstadoBot(telefone);
                        await notificarVendedor(telefone, vendedor);
                } else if (dadosLead[telefone].confirmado) {
                        tipo = 'lead_confirmado';
                }

                console.log(`🤖 Resposta: ${reply} → tipo: ${tipo}`);

                // Prioridade: Enviar o WhatsApp primeiro
                await sendWhatsApp(telefone, reply);

                // Salva cliente ANTES do bot, com timestamps sequenciais garantidos
                // (evita inversão de ordem no CRM quando os dois têm o mesmo segundo)
                await salvarMensagem(telefone, mensagem, 'cliente', vendedor, tipo);
                await salvarMensagem(telefone, reply, 'bot', vendedor, tipo);
        } catch (err) {
                console.error('Erro:', err.response?.data || err.message);
                // Salva a mensagem do cliente mesmo que a IA tenha falhado
                try {
                        salvarMensagem(telefone, mensagem, 'cliente', vendedor, 'desconhecido');
                } catch (_) {}
                // Fallback: responde ao cliente para não deixá-lo sem retorno
                try {
                        const fallbackMsg = 'Desculpe, tive um probleminha aqui! Pode repetir sua mensagem? 😊';
                        await sendWhatsApp(telefone, fallbackMsg);
                        salvarMensagem(telefone, fallbackMsg, 'bot', vendedor, 'desconhecido');
                } catch (_) {}
        }
});

app.post('/webhook-vendedor', async (req, res) => {
	res.sendStatus(200);

	const body = req.body;
	if (body.isGroup) return;

        // LOG de diagnóstico — mostra o payload raw para depurar mensagens de vendedor
        console.log(`📥 webhook-vendedor [${req.query.vendedor||'?'}] fromMe=${body.fromMe} phone=${body.phone} chatLid=${body.chatLid} keys=${Object.keys(body).join(',')}`);

        // Extração robusta da mensagem (suporta texto, áudio, imagem, vídeo, sticker, etc.)
        const mensagem = extrairMensagem(body);

        // Resolve telefone: usa chatLid como chave consistente para mapear LID → número real
        const rawPhone = body.phone || '';
        const chatLid = body.chatLid ? body.chatLid.split('@')[0] : null;
        const isLid = rawPhone.includes('@lid');

        let telefone;
        if (!isLid) {
                // Recebido (fromMe=false): temos o número real do cliente
                telefone = normalizePhone(rawPhone);
                // Armazena mapeamento LID → telefone real (em memória e retroativo no banco)
                if (chatLid && !lidToPhone.has(chatLid)) {
                        lidToPhone.set(chatLid, telefone);
                        console.log(`🔗 LID mapeado: ${chatLid} → ${telefone}`);
                        // Atualiza registros antigos no banco que usavam o LID como telefone
                        supabase.from('conversas')
                                .update({ telefone: telefone })
                                .eq('telefone', chatLid)
                                .then(({ error, count }) => {
                                        if (!error) console.log(`✅ DB retroativo: ${chatLid} → ${telefone}`);
                                });
                }
        } else {
                // Enviado (fromMe=true): Z-API usa LID — tenta resolver pelo cache
                const lid = rawPhone.split('@')[0];
                const realPhone = lidToPhone.get(lid) || (chatLid ? lidToPhone.get(chatLid) : null);
                telefone = realPhone || lid; // fallback: usa o LID como identificador
        }

        if (!telefone || !mensagem) {
                console.log(`⚠️ Webhook vendedor ignorado: f=${telefone}, m=${!!mensagem}`);
                return;
        }

        const vendedor = req.query.vendedor || 'desconhecido';
        const de = (body.fromMe === true || body.fromMe === 'true') ? 'vendedor' : 'cliente';

        console.log(`📱 [${vendedor}] ${de}: ${mensagem} (${telefone})`);

	try {
		// Verifica se esse número já tem histórico no bot
		const { data: historicoBot } = await supabase
			.from('conversas')
			.select('id')
			.eq('telefone', telefone)
			.eq('de', 'bot')
			.limit(1);

		const passouPeloBot = historicoBot && historicoBot.length > 0;

		// Regras de tipo:
		// 1. Vendedor iniciou conversa com número NOVO (veio de fora) → 'lead'
		// 2. Qualquer outra situação → 'conversa_vendedor'
		let tipo = 'conversa_vendedor';
		if (body.fromMe && !passouPeloBot) {
			// Verifica se já tem histórico no webhook-vendedor também
			const { data: historicoVendedor } = await supabase
				.from('conversas')
				.select('id')
				.eq('telefone', telefone)
				.limit(1);
			
			// Só marca como lead-vendedor se for a PRIMEIRA mensagem para esse número
			// Usa 'lead-vendedor' (não 'lead') para que o CRM não exiba na aba "Em atendimento"
			if (!historicoVendedor || historicoVendedor.length === 0) {
				tipo = 'lead-vendedor';
			}
		}

		await salvarMensagem(telefone, mensagem, de, vendedor, tipo);
		console.log(`✅ Conversa salva — ${vendedor} | ${de} | tipo: ${tipo} | ${telefone}`);
	} catch (err) {
		console.error('Erro ao salvar conversa vendedor:', err.message);
	}
});


app.get('/', (req, res) => res.send('Escola Bot rodando ✅'));

// Rota de simulação para o CRM — usa o mesmo Groq/Gemini do bot
app.post('/simulate', async (req, res) => {
        if (!checkAdminToken(req, res)) return;
        const { mensagem } = req.body;
        if (!mensagem) return res.status(400).json({ error: 'mensagem is required' });

        const telefone = 'simulador_crm';
        
        // Comando especial para limpar a memória do simulador
        if (mensagem.trim().toLowerCase() === '/clear') {
                conversas[telefone] = [];
                // Também limpa os dados provisórios do simulador, se houver
                if (dadosLead[telefone]) delete dadosLead[telefone];
                return res.json({ reply: '🔄 Memória do simulador reiniciada!', tipo: 'sistema', modelo: botStatus.modelo });
        }

        // Se não tiver histórico (ou foi recém limpo), inicializa
        if (!conversas[telefone]) conversas[telefone] = [];

        try {
                const reply = await askAI(telefone, mensagem);
                const tipo = detectarTipo(mensagem, reply);
                // REMOVIDO: delete conversas[telefone]; // Mantém a memória
                res.json({ reply, tipo, modelo: botStatus.modelo });
        } catch (err) {
                console.error('Erro na simulação:', err.message);
                res.status(500).json({ error: err.message });
        }
});

// Rota de status para o CRM
app.get('/status', (req, res) => {
        if (!checkAdminToken(req, res)) return;
        res.json({
                modelo: botStatus.modelo,
                fallbacksHoje: botStatus.fallbacksHoje,
                ultimoWebhook: botStatus.ultimoWebhook || null,
                uptime: Math.floor(process.uptime()),
                conversasAtivas: Object.keys(conversas).length,
                groq2Disponivel: !!process.env.GROQ_API_KEY_2
        });
});

// Token simples para proteger rotas administrativas
function checkAdminToken(req, res) {
        const token = req.headers['x-admin-token'] || req.query.token;
        if (process.env.ADMIN_TOKEN && token !== process.env.ADMIN_TOKEN) {
                res.status(401).send('Não autorizado ❌');
                return false;
        }
        return true;
}

// Rota para resetar memória de um número
app.get('/reset/:telefone', (req, res) => {
        if (!checkAdminToken(req, res)) return;
        const telefone = req.params.telefone;
        delete conversas[telefone];
        delete vendedorPorTelefone[telefone];
        console.log(`🔄 Memória resetada para ${telefone}`);
        res.send(`Memória resetada para ${telefone} ✅`);
});

// Rota para resetar TUDO
app.get('/reset-all', (req, res) => {
        if (!checkAdminToken(req, res)) return;
        Object.keys(conversas).forEach(k => delete conversas[k]);
        Object.keys(vendedorPorTelefone).forEach(k => delete vendedorPorTelefone[k]);
        console.log('🔄 Toda memória resetada');
        res.send('Toda memória resetada ✅');
});

// Rota de diagnóstico — busca registros de um número no banco
app.get('/buscar/:telefone', async (req, res) => {
        if (!checkAdminToken(req, res)) return;
        const frag = req.params.telefone.replace(/\D/g, '');
        try {
                const { data, error } = await supabase
                        .from('conversas')
                        .select('id, telefone, mensagem, de, vendedor, tipo, created_at')
                        .ilike('telefone', `%${frag}%`)
                        .order('created_at', { ascending: false })
                        .limit(50);
                if (error) return res.status(500).json({ error: error.message });
                res.json({ total: data.length, registros: data });
        } catch (err) {
                res.status(500).json({ error: err.message });
        }
});

// ── Persistência de estado no Supabase ─────────────────────────────────────
// Carrega estado salvo no startup para resistir a redeploys do Railway
async function carregarEstadoBot() {
        try {
                const { data, error } = await supabase
                        .from('estado_bot')
                        .select('telefone, ultima_atividade, reengajamento_env, confirmado, notificado');
                if (error) throw error;
                if (!data || data.length === 0) {
                        console.log('📦 estado_bot: nenhum registro ainda');
                        return;
                }
                data.forEach(r => {
                        if (r.ultima_atividade) {
                                ultimaAtividade[r.telefone] = new Date(r.ultima_atividade).getTime();
                        }
                        if (r.reengajamento_env) {
                                reengajamentoEnviado[r.telefone] = true;
                        }
                        if (r.confirmado || r.notificado) {
                                if (!dadosLead[r.telefone]) {
                                        dadosLead[r.telefone] = { nome: null, turma: null, horario: null, confirmado: false, notificado: false, consentimentoDado: true };
                                }
                                dadosLead[r.telefone].confirmado = r.confirmado;
                                dadosLead[r.telefone].notificado  = r.notificado;
                        }
                });
                console.log(`📦 Estado restaurado para ${data.length} telefone(s)`);
        } catch (err) {
                console.error('❌ Erro ao carregar estado_bot:', err.message);
        }
}

// Persiste estado de um telefone no Supabase (fire-and-forget, não bloqueia o fluxo)
function salvarEstadoBot(telefone) {
        const ultima = ultimaAtividade[telefone]
                ? new Date(ultimaAtividade[telefone]).toISOString()
                : null;
        supabase.from('estado_bot').upsert({
                telefone,
                ultima_atividade:  ultima,
                reengajamento_env: !!reengajamentoEnviado[telefone],
                confirmado:        !!(dadosLead[telefone]?.confirmado),
                notificado:        !!(dadosLead[telefone]?.notificado),
                updated_at:        new Date().toISOString()
        }, { onConflict: 'telefone' }).then(({ error }) => {
                if (error) console.error(`❌ Erro ao salvar estado_bot [${telefone}]:`, error.message);
        });
}
// ────────────────────────────────────────────────────────────────────────────

// Reengajamento após 24h de inatividade
async function checkInatividade() {
        const agora = Date.now();
        for (const telefone in ultimaAtividade) {
                if (agora - ultimaAtividade[telefone] > 24 * 60 * 60 * 1000 && !reengajamentoEnviado[telefone]) {
                        // Consulta o banco para ver se essa conversa já foi encerrada/encaminhada
                        // Não reenvia reengajamento para: alunos, leads confirmados, ou quem já recebeu reengajamento recente
                        try {
                                const { data: historico } = await supabase
                                        .from('conversas')
                                        .select('tipo, created_at')
                                        .eq('telefone', telefone)
                                        .order('created_at', { ascending: false })
                                        .limit(20);

                                if (historico && historico.length > 0) {
                                        const tipos = historico.map(r => r.tipo);
                                        // Não envia reengajamento se a conversa já foi encerrada
                                        const jaEncerrado = tipos.some(t =>
                                                t === 'aluno' ||
                                                t === 'lead_confirmado' ||
                                                t === 'lead-vendedor' ||
                                                t === 'conversa_vendedor'
                                        );
                                        if (jaEncerrado) {
                                                reengajamentoEnviado[telefone] = true; // marca para não checar de novo
                                                salvarEstadoBot(telefone);
                                                console.log(`⏭️  Reengajamento pulado para ${telefone} (conversa já encerrada: ${tipos.find(t => ['aluno','lead_confirmado','lead-vendedor','conversa_vendedor'].includes(t))})`);
                                                continue;
                                        }
                                }
                        } catch (e) {
                                console.error('Erro ao checar histórico para reengajamento:', e.message);
                        }

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
                                salvarEstadoBot(telefone);
                        }
                }
        }
}

// Roda a cada 30 minutos
setInterval(checkInatividade, 30 * 60 * 1000);

// ── Resumo diário para a gerente ────────────────────────────────────────────
async function enviarResumoDiario() {
        if (!NUMERO_GERENTE) return;

        try {
                // Ontem 00:00 BRT (03:00 UTC) até 23:59 BRT (02:59 UTC do dia seguinte)
                const agora = new Date();
                const ontemInicio = new Date(agora);
                ontemInicio.setUTCDate(ontemInicio.getUTCDate() - 1);
                ontemInicio.setUTCHours(3, 0, 0, 0);
                const ontemFim = new Date(ontemInicio);
                ontemFim.setUTCHours(26, 59, 59, 999);

                const inicioISO = ontemInicio.toISOString();
                const fimISO   = ontemFim.toISOString();

                // Leads novos ontem — apenas leads confirmados pelo bot (exclui alunos e desconhecidos)
                const { data: leadsNovos } = await supabase
                        .from('leads_resumo')
                        .select('telefone, vendedor, tem_msg_bot')
                        .gte('primeiro_contato', inicioISO)
                        .lte('primeiro_contato', fimISO)
                        .eq('tem_msg_cliente', true)
                        .in('tipo', ['lead', 'lead_confirmado', 'lead-vendedor']);

                // Todos os status cadastrados (visão geral)
                const { data: todosStatus } = await supabase
                        .from('status_de_leads')
                        .select('telefone, status, nome, updated_at');

                // Todos os leads existentes para calcular sem status
                const { data: todosLeads } = await supabase
                        .from('leads_resumo')
                        .select('telefone, vendedor')
                        .eq('tem_msg_cliente', true);

                const totalLeadsNovos = leadsNovos?.length || 0;

                // Busca nomes salvos dos leads novos (se houver)
                const telefonesNovos = (leadsNovos || []).map(l => l.telefone);
                let nomesLeadsNovos = {};
                if (telefonesNovos.length > 0) {
                        const { data: statusNovos } = await supabase
                                .from('status_de_leads')
                                .select('telefone, nome')
                                .in('telefone', telefonesNovos);
                        (statusNovos || []).forEach(s => { if (s.nome) nomesLeadsNovos[s.telefone] = s.nome; });
                }

                // Agrupa leads novos por canal (bot vs vendedor) e por vendedor
                const leadsViaBot = (leadsNovos || []).filter(l => l.tem_msg_bot);
                const leadsViaVendedor = (leadsNovos || []).filter(l => !l.tem_msg_bot);
                const viaBot      = leadsViaBot.length;
                const viaVendedor = leadsViaVendedor.length;

                // Agrupa leads por vendedor (apenas os via vendedor)
                const leadsPorVendedor = {};
                leadsViaVendedor.forEach(l => {
                        const v = l.vendedor || 'desconhecido';
                        if (!leadsPorVendedor[v]) leadsPorVendedor[v] = [];
                        leadsPorVendedor[v].push(l);
                });

                // Contagem por status (geral)
                const contStatus = { novo: 0, em_andamento: 0, matriculado: 0, aluno: 0, perdido: 0 };
                (todosStatus || []).forEach(s => {
                        if (contStatus[s.status] !== undefined) contStatus[s.status]++;
                });
                const comStatusSet = new Set((todosStatus || []).map(s => s.telefone));
                const totalSemStatus = (todosLeads || []).filter(l => !comStatusSet.has(l.telefone)).length;

                // Status alterados ontem
                const statusAlteradosOntem = (todosStatus || []).filter(s =>
                        s.updated_at && s.updated_at >= inicioISO && s.updated_at <= fimISO
                );
                const alteradosPorStatus = { novo: [], em_andamento: [], matriculado: [], aluno: [], perdido: [] };
                statusAlteradosOntem.forEach(s => {
                        if (alteradosPorStatus[s.status]) {
                                alteradosPorStatus[s.status].push(s.nome || s.telefone);
                        }
                });

                // Por vendedor — contagem com sem status (para seção separada)
                const porVendedor = {};
                (leadsNovos || []).forEach(l => {
                        const v = l.vendedor || 'desconhecido';
                        if (!porVendedor[v]) porVendedor[v] = { total: 0, semStatus: 0 };
                        porVendedor[v].total++;
                        if (!comStatusSet.has(l.telefone)) porVendedor[v].semStatus++;
                });

                // Monta mensagem
                const dataStr = ontemInicio.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' });
                let msg = `📊 *Resumo do dia ${dataStr}*\n\n`;

                msg += `👥 *Leads novos: ${totalLeadsNovos}*\n\n`;

                if (viaBot > 0) {
                        msg += `  🤖 *Via bot: ${viaBot}*\n`;
                        leadsViaBot.forEach(l => {
                                const nome = nomesLeadsNovos[l.telefone] || 'sem nome';
                                msg += `    • ${nome} — ${l.telefone}\n`;
                        });
                        msg += '\n';
                }

                if (viaVendedor > 0) {
                        msg += `  🧑 *Via vendedor: ${viaVendedor}*\n`;
                        for (const [vendedor, leads] of Object.entries(leadsPorVendedor)) {
                                msg += `  _${vendedor}:_\n`;
                                leads.forEach(l => {
                                        const nome = nomesLeadsNovos[l.telefone] || 'sem nome';
                                        msg += `    • ${nome} — ${l.telefone}\n`;
                                });
                        }
                        msg += '\n';
                }

                if (totalLeadsNovos === 0) msg += `  _Nenhum lead novo ontem._\n\n`;

                msg += `📋 *Status geral dos leads:*\n`;
                msg += `  • Novo: ${contStatus.novo}\n`;
                msg += `  • Em andamento: ${contStatus.em_andamento}\n`;
                msg += `  • Matriculado: ${contStatus.matriculado}\n`;
                msg += `  • Aluno: ${contStatus.aluno}\n`;
                msg += `  • Perdido: ${contStatus.perdido}\n`;
                msg += `  • Sem status: ${totalSemStatus}\n\n`;

                // Resumo por vendedor (sem status)
                const vendedoresComPendencia = Object.entries(porVendedor).filter(([, d]) => d.semStatus > 0);
                if (vendedoresComPendencia.length > 0) {
                        msg += `⚠️ *Leads sem status (ontem):*\n`;
                        vendedoresComPendencia.forEach(([vendedor, dados]) => {
                                msg += `  • ${vendedor}: ${dados.semStatus} sem status\n`;
                        });
                        msg += '\n';
                }

                // Seção de status alterados ontem
                const totalAlterados = statusAlteradosOntem.length;
                if (totalAlterados > 0) {
                        msg += `\n✏️ *Status alterados ontem: ${totalAlterados}*\n`;
                        const labels = { novo: 'Novo', em_andamento: 'Em andamento', matriculado: 'Matriculado', aluno: 'Aluno', perdido: 'Perdido' };
                        for (const [status, nomes] of Object.entries(alteradosPorStatus)) {
                                if (nomes.length > 0) {
                                        msg += `  • ${labels[status]}: ${nomes.join(', ')}\n`;
                                }
                        }
                }

                await sendWhatsApp(NUMERO_GERENTE, msg);
                console.log(`📊 Resumo diário enviado para a gerente`);
        } catch (err) {
                console.error('❌ Erro ao enviar resumo diário:', err.message);
        }
}

// Agenda o resumo diário às 8h horário de Brasília (11:00 UTC)
function agendarResumoDiario() {
        const agora = new Date();
        // Próximas 11:00 UTC (= 08:00 BRT)
        const proxima = new Date(agora);
        proxima.setUTCHours(11, 0, 0, 0);
        if (proxima <= agora) proxima.setUTCDate(proxima.getUTCDate() + 1);

        const msAteProxima = proxima - agora;
        console.log(`⏰ Resumo diário agendado em ${Math.round(msAteProxima / 60000)} minutos`);

        setTimeout(() => {
                enviarResumoDiario();
                checkLeadsPausados();
                // Depois da primeira execução, repete a cada 24h
                setInterval(() => { enviarResumoDiario(); checkLeadsPausados(); }, 24 * 60 * 60 * 1000);
        }, msAteProxima);
}
// ────────────────────────────────────────────────────────────────────────────

// ── Lembrete semanal de escala para a gerente ────────────────────────────────
function agendarLembreteEscala() {
        if (!NUMERO_GERENTE) return;

        function msAteProximaSexta22UTC() {
                const agora = new Date();
                const proxima = new Date(agora);
                // Avança até a próxima sexta (dia 5)
                // diasAteSexta = 0 se hoje É sexta, >0 caso contrário
                const diasAteSexta = (5 - proxima.getUTCDay() + 7) % 7;
                proxima.setUTCDate(proxima.getUTCDate() + diasAteSexta);
                proxima.setUTCHours(22, 0, 0, 0); // 19h BRT = 22h UTC
                // Se já passou (sexta mas depois das 22h UTC), pega a próxima semana
                if (proxima <= agora) proxima.setUTCDate(proxima.getUTCDate() + 7);
                return proxima - agora;
        }

        function agendar() {
                const ms = msAteProximaSexta22UTC();
                console.log(`⏰ Lembrete de escala agendado em ${Math.round(ms / 60000)} minutos`);
                setTimeout(() => {
                        sendWhatsApp(NUMERO_GERENTE,
                                `Oi, Leybian! 👋 Lembrete: não esquece de atualizar a *escala de sábado* no CRM 😊`
                        );
                        console.log(`🔔 Lembrete de escala enviado para a gerente`);
                        agendar(); // reagenda para a próxima sexta
                }, ms);
        }

        agendar();
}
// ────────────────────────────────────────────────────────────────────────────

// ── Lembrete de leads pausados ───────────────────────────────────────────────
async function checkLeadsPausados() {
        try {
                // Data de hoje no formato YYYY-MM-DD no horário de Brasília
                const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

                const { data: pausados, error } = await supabase
                        .from('status_de_leads')
                        .select('telefone, nome, data_retorno')
                        .eq('status', 'pausado')
                        .eq('data_retorno', hoje);

                if (error) throw error;
                if (!pausados || pausados.length === 0) return;

                // Busca o vendedor de cada lead pausado
                for (const lead of pausados) {
                        const { data: resumo } = await supabase
                                .from('leads_resumo')
                                .select('vendedor')
                                .eq('telefone', lead.telefone)
                                .single();

                        const vendedor = resumo?.vendedor?.toLowerCase();
                        let numeroVendedor = null;
                        if (vendedor && vendedor.includes('rebecca')) numeroVendedor = process.env.NUMERO_REBECCA;
                        else if (vendedor && vendedor.includes('paulo')) numeroVendedor = process.env.NUMERO_PAULO;

                        if (!numeroVendedor) continue;

                        const nome = lead.nome || lead.telefone;
                        const msg = `🔔 Lembrete! Hoje é o dia de retomar contato com *${nome}* (${lead.telefone}).\n\nEsse lead estava pausado aguardando esta data. Bora entrar em contato? 💪`;
                        await sendWhatsApp(numeroVendedor, msg);
                        console.log(`🔔 Lembrete de lead pausado enviado: ${lead.telefone} → ${vendedor}`);
                }
        } catch (err) {
                console.error('❌ Erro ao checar leads pausados:', err.message);
        }
}
// ────────────────────────────────────────────────────────────────────────────

// ── Alerta de leads sem status para vendedores ───────────────────────────────
async function enviarAlertaVendedor(nomeVendedor, numeroVendedor) {
        if (!numeroVendedor) return;

        try {
                const limite48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

                // Leads do vendedor com último contato há mais de 48h
                const { data: leads } = await supabase
                        .from('leads_resumo')
                        .select('telefone, vendedor')
                        .ilike('vendedor', nomeVendedor)
                        .eq('tem_msg_cliente', true)
                        .lte('ultimo_contato', limite48h);

                if (!leads || leads.length === 0) {
                        console.log(`✅ ${nomeVendedor}: nenhum lead pendente`);
                        return;
                }

                // Filtra os que já têm status definido
                const telefones = leads.map(l => l.telefone);
                const { data: comStatus } = await supabase
                        .from('status_de_leads')
                        .select('telefone, status, nome')
                        .in('telefone', telefones);

                const statusMap = {};
                (comStatus || []).forEach(s => { statusMap[s.telefone] = s; });

                const semStatus = leads.filter(l => !statusMap[l.telefone]?.status);

                if (semStatus.length === 0) {
                        console.log(`✅ ${nomeVendedor}: todos os leads têm status`);
                        return;
                }

                // Monta mensagem
                let msg = `Oi, ${nomeVendedor}! 👋 Você tem *${semStatus.length} lead(s)* sem status há mais de 48h:\n\n`;
                semStatus.forEach(l => {
                        const info = statusMap[l.telefone];
                        const nome = info?.nome ? info.nome : 'sem nome';
                        msg += `• ${nome} — ${l.telefone}\n`;
                });
                msg += `\nAtualiza o status no CRM quando puder 😊`;

                await sendWhatsApp(numeroVendedor, msg);
                console.log(`🔔 Alerta enviado para ${nomeVendedor}: ${semStatus.length} lead(s) pendente(s)`);
        } catch (err) {
                console.error(`❌ Erro ao enviar alerta para ${nomeVendedor}:`, err.message);
        }
}

// Agenda alerta para um vendedor num horário UTC específico
function agendarAlertaVendedor(nomeVendedor, numeroVendedor, horaUTC) {
        const agora = new Date();
        const proxima = new Date(agora);
        proxima.setUTCHours(horaUTC, 0, 0, 0);
        if (proxima <= agora) proxima.setUTCDate(proxima.getUTCDate() + 1);

        const msAteProxima = proxima - agora;
        console.log(`⏰ Alerta ${nomeVendedor} agendado em ${Math.round(msAteProxima / 60000)} minutos`);

        setTimeout(() => {
                enviarAlertaVendedor(nomeVendedor, numeroVendedor);
                setInterval(() => enviarAlertaVendedor(nomeVendedor, numeroVendedor), 24 * 60 * 60 * 1000);
        }, msAteProxima);
}
// ────────────────────────────────────────────────────────────────────────────

// ── Relatório Mensal via OpenRouter ─────────────────────────────────────────
async function gerarRelatorioMensal() {
        if (!NUMERO_GERENTE || !OPENROUTER_API_KEY) return;
        console.log('📋 Gerando relatório mensal...');

        try {
                // Mês anterior
                const agora = new Date();
                const inicioMes = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - 1, 1, 3, 0, 0));
                const fimMes    = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1, 2, 59, 59));
                const nomeMes   = inicioMes.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', month: 'long', year: 'numeric' });

                const inicioISO = inicioMes.toISOString();
                const fimISO    = fimMes.toISOString();

                // 1. Leads do mês
                const { data: leadsDoMes } = await supabase
                        .from('leads_resumo')
                        .select('telefone, vendedor, tem_msg_bot, primeiro_contato')
                        .gte('primeiro_contato', inicioISO)
                        .lte('primeiro_contato', fimISO)
                        .eq('tem_msg_cliente', true);

                // 2. Todos os status
                const { data: todosStatus } = await supabase
                        .from('status_de_leads')
                        .select('telefone, status, nome, anotacao');

                // 3. Amostra de conversas: 10 convertidas + 10 perdidas
                const statusMap = {};
                (todosStatus || []).forEach(s => { statusMap[s.telefone] = s; });

                const convertidos = (leadsDoMes || []).filter(l => ['matriculado','aluno'].includes(statusMap[l.telefone]?.status));
                const perdidos    = (leadsDoMes || []).filter(l => statusMap[l.telefone]?.status === 'perdido');
                const amostra     = [...convertidos.slice(0, 10), ...perdidos.slice(0, 10)];

                let conversasTexto = '';
                for (const lead of amostra) {
                        const { data: msgs } = await supabase
                                .from('conversas')
                                .select('mensagem, de, created_at')
                                .eq('telefone', lead.telefone)
                                .order('created_at', { ascending: true })
                                .limit(15);

                        if (!msgs || msgs.length === 0) continue;
                        const st = statusMap[lead.telefone];
                        conversasTexto += `\n--- Lead: ${st?.nome || lead.telefone} | Vendedor: ${lead.vendedor} | Status: ${st?.status || 'sem status'} ---\n`;
                        msgs.forEach(m => {
                                conversasTexto += `[${m.de}]: ${m.mensagem.substring(0, 200)}\n`;
                        });
                }

                // 4. Métricas consolidadas
                const total       = leadsDoMes?.length || 0;
                const viaBot      = (leadsDoMes || []).filter(l => l.tem_msg_bot).length;
                const contStatus  = { novo: 0, em_andamento: 0, matriculado: 0, aluno: 0, pausado: 0, perdido: 0, sem_status: 0 };
                const comStatus   = new Set((todosStatus || []).map(s => s.telefone));
                (leadsDoMes || []).forEach(l => {
                        const s = statusMap[l.telefone]?.status;
                        if (s && contStatus[s] !== undefined) contStatus[s]++;
                        else if (!comStatus.has(l.telefone)) contStatus.sem_status++;
                });

                const porVendedor = {};
                (leadsDoMes || []).forEach(l => {
                        const v = l.vendedor || 'desconhecido';
                        if (!porVendedor[v]) porVendedor[v] = { total: 0, convertidos: 0 };
                        porVendedor[v].total++;
                        if (['matriculado','aluno'].includes(statusMap[l.telefone]?.status)) porVendedor[v].convertidos++;
                });

                const vendedoresTexto = Object.entries(porVendedor)
                        .map(([v, d]) => `${v}: ${d.total} leads, ${d.convertidos} convertidos (${total > 0 ? Math.round(d.convertidos/d.total*100) : 0}%)`)
                        .join('\n');

                // 5. Prompt para a IA
                const prompt = `Você é um analista de CRM para uma escola de idiomas no Rio de Janeiro. Analise os dados de ${nomeMes} e gere um relatório em português, direto e prático.

MÉTRICAS DO MÊS:
- Total de leads: ${total}
- Via bot: ${viaBot} | Via vendedor: ${total - viaBot}
- Novo: ${contStatus.novo} | Em andamento: ${contStatus.em_andamento} | Matriculado: ${contStatus.matriculado} | Aluno: ${contStatus.aluno} | Pausado: ${contStatus.pausado} | Perdido: ${contStatus.perdido} | Sem status: ${contStatus.sem_status}
- Taxa de conversão: ${total > 0 ? Math.round((contStatus.matriculado + contStatus.aluno) / total * 100) : 0}%

POR VENDEDOR:
${vendedoresTexto}

AMOSTRA DE CONVERSAS (convertidas e perdidas):
${conversasTexto.substring(0, 8000)}

Gere um relatório com exatamente estas seções:
1. RESUMO EXECUTIVO (3-4 linhas)
2. PERFORMANCE DOS VENDEDORES (análise individual)
3. PRINCIPAIS OBJEÇÕES DOS LEADS (o que mais apareceu nas conversas)
4. PADRÕES IDENTIFICADOS (horários, perfil dos leads, o que funcionou)
5. RECOMENDAÇÕES PARA O PRÓXIMO MÊS (3 a 5 ações práticas e concretas)

Seja objetivo. Máximo 600 palavras no total.`;

                // 6. Chamada OpenRouter
                const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
                        model: 'nvidia/nemotron-super-49b-v1:free',
                        messages: [{ role: 'user', content: prompt }],
                        max_tokens: 1500
                }, {
                        headers: {
                                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                                'Content-Type': 'application/json'
                        },
                        timeout: 60000
                });

                const analise = response.data?.choices?.[0]?.message?.content || 'Não foi possível gerar análise.';

                // 7. Monta e envia o relatório em partes (WhatsApp tem limite de caracteres)
                const cabecalho = `📋 *RELATÓRIO MENSAL — ${nomeMes.toUpperCase()}*\n\n📊 Leads: ${total} | Convertidos: ${contStatus.matriculado + contStatus.aluno} | Taxa: ${total > 0 ? Math.round((contStatus.matriculado + contStatus.aluno) / total * 100) : 0}%\n🤖 Via bot: ${viaBot} | 🧑 Via vendedor: ${total - viaBot}\n\n`;

                const relatorioCompleto = cabecalho + analise;

                // Divide em blocos de 1500 chars para não cortar no WhatsApp
                const blocos = [];
                let texto = relatorioCompleto;
                while (texto.length > 1500) {
                        const corte = texto.lastIndexOf('\n', 1500);
                        blocos.push(texto.substring(0, corte > 0 ? corte : 1500));
                        texto = texto.substring(corte > 0 ? corte + 1 : 1500);
                }
                if (texto.trim()) blocos.push(texto);

                for (const bloco of blocos) {
                        await sendWhatsApp(NUMERO_GERENTE, bloco);
                        await new Promise(r => setTimeout(r, 1500)); // pausa entre mensagens
                }

                console.log(`📋 Relatório mensal enviado (${blocos.length} mensagem(ns))`);
        } catch (err) {
                console.error('❌ Erro ao gerar relatório mensal:', err.message);
        }
}

// Agenda relatório para o dia 1 de cada mês às 8h BRT (11h UTC)
function agendarRelatorioMensal() {
        if (!NUMERO_GERENTE || !OPENROUTER_API_KEY) return;

        function msAteProximoDia1() {
                const agora = new Date();
                const proxima = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() + 1, 1, 13, 0, 0));
                return proxima - agora;
        }

        const ms = msAteProximoDia1();
        console.log(`⏰ Relatório mensal agendado em ${Math.round(ms / 3600000)} horas`);

        setTimeout(() => {
                gerarRelatorioMensal();
                // Reagenda para o próximo mês após execução
                function reagendar() {
                        const ms = msAteProximoDia1();
                        setTimeout(() => { gerarRelatorioMensal(); reagendar(); }, ms);
                }
                reagendar();
        }, ms);
}
// ────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
        console.log(`🚀 Escola Bot rodando na porta ${PORT}`);
        // Restaura estado persistido (inatividade, reengajamento, confirmações)
        carregarEstadoBot();
        // Agenda resumo diário às 8h BRT
        agendarResumoDiario();
        // Alerta de leads sem status: Rebecca às 12h BRT (15h UTC), Paulo às 17h BRT (20h UTC)
        agendarAlertaVendedor('Rebecca', process.env.NUMERO_REBECCA, 15);
        agendarAlertaVendedor('Paulo',   process.env.NUMERO_PAULO,   20);
        // Lembrete semanal de escala às sextas 19h BRT (22h UTC)
        agendarLembreteEscala();
        // Relatório mensal no dia 1 de cada mês às 8h BRT
        agendarRelatorioMensal();
});