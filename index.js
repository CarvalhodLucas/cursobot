require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json({ limit: '20mb' })); // permite anexos (imagem/documento) em base64 vindos do CRM

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

// Cache de vendedor por telefone para a sessao atual
const vendedorPorTelefone = {};

// Nome de perfil do WhatsApp por telefone (vem do campo contacts do webhook Meta)
const nomeContatoPorTelefone = {};

// Quando o admin manda mensagem manual pelo CRM no número principal (aba "Bot"),
// a IA fica pausada pra esse telefone por um tempo, evitando resposta duplicada/conflitante.
const pausaAdminManual = {};

// Fila de leads pendentes por vendedor (chave = telefone do vendedor)
// { '5521999999999': { atual: {telefone, nome}, fila: [...restantes] } }
const pendentesAtualizacao = {};

// Rodízio "justo": guarda quando cada vendedor recebeu o último lead (qualquer
// tipo de atribuição — exclusiva ou por rodízio), persistido no Supabase pra não
// resetar a cada deploy/restart do Railway. Quando 2+ vendedores estão de plantão
// juntos, escolhe quem está há MAIS TEMPO sem receber, em vez de só girar um índice.
let ultimaAtribuicaoPorVendedor = {};

async function carregarRodizio() {
        try {
                const { data, error } = await supabase.from('rodizio_vendedores').select('*');
                if (error) throw error;
                (data || []).forEach(r => {
                        if (r.ultima_atribuicao) ultimaAtribuicaoPorVendedor[r.vendedor] = new Date(r.ultima_atribuicao).getTime();
                });
                console.log('🔄 Rodízio restaurado do Supabase:', ultimaAtribuicaoPorVendedor);
        } catch (e) {
                console.error('❌ Erro ao carregar rodízio persistido:', e.message);
        }
}

function registrarAtribuicao(vendedor) {
        const agora = Date.now();
        ultimaAtribuicaoPorVendedor[vendedor] = agora;
        supabase.from('rodizio_vendedores')
                .upsert({ vendedor, ultima_atribuicao: new Date(agora).toISOString() }, { onConflict: 'vendedor' })
                .then(({ error }) => { if (error) console.error('❌ Erro ao salvar rodízio:', error.message); });
}

// Entre uma lista de vendedores ativos agora, escolhe quem está há mais tempo
// sem receber um lead (nunca recebeu = prioridade máxima).
function escolherPorFila(vendedoresAtivos) {
        let escolhido = vendedoresAtivos[0];
        let maisAntigo = ultimaAtribuicaoPorVendedor[escolhido] ?? 0;
        for (const v of vendedoresAtivos) {
                const t = ultimaAtribuicaoPorVendedor[v] ?? 0;
                if (t < maisAntigo) { maisAntigo = t; escolhido = v; }
        }
        return escolhido;
}

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
        const TODOS_VENDEDORES = ['Paulo', 'Rebecca', 'Taynara'];

        // 1. Domingo — sem escala fixa, usa fila justa entre os três
        if (dia === 0) {
                const escolhido = escolherPorFila(TODOS_VENDEDORES);
                registrarAtribuicao(escolhido);
                console.log(`🔄 Domingo (fila justa) → ${escolhido}`);
                return escolhido;
        }

        // 2. Busca TODOS os vendedores ativos no horário atual (escala com sobreposição)
        const diaDoProjeto = agora.getDate();
        const ehSabado = dia === 6;
        const ehPar = diaDoProjeto % 2 === 0;

        // Sábado: ignora hora — qualquer lead que chegar no sábado vai para o vendedor da escala de sábado
        if (ehSabado) {
                const sabadoMatches = escala.filter(e => {
                        if (e.dia_semana !== 6) return false;
                        if (e.sabado_paridade && e.sabado_paridade !== 'sempre') {
                                if (e.sabado_paridade === 'par' && !ehPar) return false;
                                if (e.sabado_paridade === 'impar' && ehPar) return false;
                        }
                        return true;
                });
                if (sabadoMatches.length > 0) {
                        const escolhido = sabadoMatches[0].vendedor;
                        registrarAtribuicao(escolhido);
                        console.log(`📅 Sábado → ${escolhido} (paridade: ${sabadoMatches[0].sabado_paridade || 'sempre'})`);
                        return escolhido;
                }
                // Sem vendedor escalado para este sábado → sorteio aleatório (só sábado usa sorteio; os demais fallbacks usam fila justa)
                const sorteado = TODOS_VENDEDORES[Math.floor(Math.random() * TODOS_VENDEDORES.length)];
                registrarAtribuicao(sorteado);
                console.log(`🎲 Nenhum vendedor escalado pra este sábado. Sorteio: ${sorteado}`);
                return sorteado;
        }

        // Usamos uma pequena margem para evitar problemas de precisão com floats
        const matches = escala.filter(e => {
                const diaMatch = e.dia_semana === dia;
                const horaMatch = hora >= (e.hora_inicio - 0.02) && hora < (e.hora_fim + 0.02);
                if (!diaMatch || !horaMatch) return false;
                return true;
        });

        if (matches.length === 0) {
                const escolhido = escolherPorFila(TODOS_VENDEDORES);
                registrarAtribuicao(escolhido);
                console.log(`⚠️ Nenhum vendedor escalado para dia ${dia} às ${hora.toFixed(2)}h. Fila justa → ${escolhido}`);
                return escolhido;
        }

        // 3. Exclusivo — apenas um vendedor no horário. Mesmo sem opção de escolha,
        // registra a atribuição — assim, na próxima vez que ele dividir o horário com
        // outro vendedor, esse lead "solo" conta e ele não fica na frente da fila à toa.
        if (matches.length === 1) {
                const escolhido = matches[0].vendedor;
                registrarAtribuicao(escolhido);
                return escolhido;
        }

        // 4. Rodízio "justo" entre os vendedores ativos no momento — não é só o próximo
        // da lista, é quem está há mais tempo sem receber um lead (considerando
        // qualquer atribuição anterior, inclusive as de horário exclusivo).
        const vendedoresAtivos = matches.map(m => m.vendedor);
        const escolhido = escolherPorFila(vendedoresAtivos);
        registrarAtribuicao(escolhido);
        console.log(`🔄 Rodízio [${vendedoresAtivos.join('/')}] → ${escolhido} (mais tempo sem receber)`);
        return escolhido;
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
        model: 'gemini-2.5-flash',
        systemInstruction: SYSTEM_PROMPT
});

async function askGemini(telefone, mensagem, systemPromptFinal = SYSTEM_PROMPT) {
        const history = conversas[telefone].map(m => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }]
        })).slice(0, -1); // Remove a última mensagem que será enviada no sendMessage

        // O Gemini exige que o histórico comece com role 'user'. Se a primeira mensagem
        // guardada for do bot (ex: aviso de LGPD enviado antes da resposta do cliente, ou
        // o corte das últimas 20 mensagens cortando bem no meio), remove o que sobrar de
        // 'model' na frente até achar a primeira mensagem 'user' — senão a API rejeita com
        // "First content should be with role 'user', got model" e o fallback inteiro falha.
        while (history.length > 0 && history[0].role !== 'user') {
                history.shift();
        }

        const model = genAI.getGenerativeModel({
                model: 'gemini-2.5-flash',
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

// ── Fila global de envio WhatsApp ────────────────────────────────────────────
// Garante no mínimo INTERVALO_ENVIO_MS entre cada mensagem enviada,
// evitando rajadas que causam ban mesmo em resposta a webhooks em massa.
const INTERVALO_ENVIO_MS = 5000; // 5s entre mensagens
const filaEnvio = [];
let processandoFila = false;

async function _enviarAgora(telefone, mensagem) {
        const phoneLimpo = String(telefone).replace(/\D/g, '');
        const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
        const accessToken   = process.env.META_ACCESS_TOKEN;
        await axios.post(
                `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
                {
                        messaging_product: 'whatsapp',
                        to: phoneLimpo,
                        type: 'text',
                        text: { body: mensagem }
                },
                { headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
        );
}

async function _processarFilaEnvio() {
        if (processandoFila) return;
        processandoFila = true;
        while (filaEnvio.length > 0) {
                const { telefone, mensagem, resolve, reject } = filaEnvio.shift();
                try {
                        await _enviarAgora(telefone, mensagem);
                        resolve();
                } catch (err) {
                        console.error('Erro ao enviar:', err.response?.data || err.message);
                        reject(err);
                }
                if (filaEnvio.length > 0) {
                        await new Promise(r => setTimeout(r, INTERVALO_ENVIO_MS));
                }
        }
        processandoFila = false;
}

async function sendWhatsApp(telefone, mensagem) {
        return new Promise((resolve, reject) => {
                filaEnvio.push({ telefone, mensagem, resolve, reject });
                _processarFilaEnvio();
        });
}

// Resolve qual phone_number_id usar baseado no número de destino
function resolvePhoneNumberId(telefoneDestino) {
        const dest = String(telefoneDestino).replace(/\D/g, '');
        if (process.env.NUMERO_REBECCA && dest === String(process.env.NUMERO_REBECCA).replace(/\D/g, ''))
                return process.env.META_PHONE_NUMBER_ID_REBECCA || process.env.META_PHONE_NUMBER_ID;
        if (process.env.NUMERO_PAULO && dest === String(process.env.NUMERO_PAULO).replace(/\D/g, ''))
                return process.env.META_PHONE_NUMBER_ID_PAULO || process.env.META_PHONE_NUMBER_ID;
        if (process.env.NUMERO_TAYNARA && dest === String(process.env.NUMERO_TAYNARA).replace(/\D/g, ''))
                return process.env.META_PHONE_NUMBER_ID_TAYNARA || process.env.META_PHONE_NUMBER_ID;
        if (process.env.NUMERO_GERENTE && dest === String(process.env.NUMERO_GERENTE).replace(/\D/g, ''))
                return process.env.META_PHONE_NUMBER_ID || process.env.META_PHONE_NUMBER_ID;
        return process.env.META_PHONE_NUMBER_ID;
}

async function sendTemplate(telefone, templateName, variables = []) {
        const phoneLimpo = String(telefone).replace(/\D/g, '');
        // Sempre usa o número principal do bot como remetente.
        // resolvePhoneNumberId era usado para enviar por números de vendedores,
        // mas esses são gerenciados pelo WANotifier (token diferente) — não funcionaria.
        const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
        const accessToken   = process.env.META_ACCESS_TOKEN;
        const body = {
                messaging_product: 'whatsapp',
                to: phoneLimpo,
                type: 'template',
                template: {
                        name: templateName,
                        language: { code: 'pt_BR' }
                }
        };
        if (variables.length > 0) {
                // Suporta array de strings (legado) ou array de objetos {name, value} (nomeado)
                // Filtra apenas elementos válidos (objetos com name/value ou strings)
                const validVars = variables.filter(v => v !== null && v !== undefined);
                const isNamed = typeof validVars[0] === 'object' && 'name' in validVars[0];
                body.template.components = [{
                        type: 'body',
                        parameters: isNamed
                                ? validVars.filter(v => typeof v === 'object' && 'name' in v)
                                          .map(v => ({ type: 'text', parameter_name: v.name, text: String(v.value || '—') }))
                                : validVars.map(v => ({ type: 'text', text: String(v || '—') }))
                }];
        }
        try {
                await axios.post(
                        `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
                        body,
                        { headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
                );
                console.log(`📨 Template "${templateName}" enviado para ${phoneLimpo} via phone_id ${phoneNumberId}`);
        } catch (err) {
                console.error(`❌ Erro ao enviar template "${templateName}":`, err.response?.data || err.message);
                throw err;
        }
}

async function notificarVendedor(telefone, vendedor) {
        const dados = dadosLead[telefone];
        if (!dados || !dados.confirmado) return;

        // Pega o número do vendedor pela variável de ambiente
        const nomeVendedor = (vendedor || '').toLowerCase();
        const numeroVendedor = nomeVendedor === 'rebecca'
                ? process.env.NUMERO_REBECCA
                : nomeVendedor === 'taynara'
                ? process.env.NUMERO_TAYNARA
                : process.env.NUMERO_PAULO;

        if (!numeroVendedor) {
                console.warn(`⚠️ Número do vendedor ${vendedor} não configurado`);
                return;
        }

        console.log(`📡 Notificando vendedor ${vendedor} para lead ${telefone}. Dados:`, JSON.stringify(dados));
        const telefoneLimpo = String(telefone).replace(/\D/g, '');

        await sendTemplate(numeroVendedor, 'notificacao_novo_lead', [
                { name: 'lead_nome',      value: dados.nome    || '—' },
                { name: 'lead_turma',     value: dados.turma   || '—' },
                { name: 'lead_horario',   value: dados.horario || '—' },
                { name: 'lead_telefone',  value: `+${telefoneLimpo}` }
        ]);

        // Registra a notificação no CRM (aba "Bot Principal", tipo != conversa_vendedor pra
        // não se misturar com o chat direto do vendedor). Antes essa mensagem só aparecia no
        // CRM por acidente, via eco do webhook — e ainda saía com o vendedor errado.
        const textoNotificacao = `🎓 *Novo lead confirmado!*\n\n` +
                `👤 Nome: ${dados.nome || '—'}\n` +
                `📚 Turma: ${dados.turma || '—'}\n` +
                `⏰ Horário: ${dados.horario || '—'}\n` +
                `📞 Telefone: +${telefoneLimpo}\n\n` +
                `Entre em contato o quanto antes.`;
        await salvarMensagem(numeroVendedor, textoNotificacao, 'sistema', nomeVendedor, 'notificacao_lead');

        // Atualiza vendedor no status_de_leads para que alertas futuros vão para o vendedor correto
        await supabase.from('status_de_leads')
                .upsert({ telefone: telefoneLimpo, vendedor, updated_at: new Date().toISOString() }, { onConflict: 'telefone' });

        // Atualiza cache local também
        vendedorPorTelefone[telefoneLimpo] = vendedor;

        console.log(`✅ Lead notificado para ${vendedor} (${numeroVendedor})`);
}

async function notificarCoordenacao(telefone) {
        if (!NUMERO_COORDENACAO) {
                console.warn('⚠️ Número da coordenação não configurado');
                return;
        }

        const telefoneLimpo = String(telefone).replace(/\D/g, '');

        await sendTemplate(NUMERO_COORDENACAO, 'alerta_coordenacao', [telefoneLimpo]);

        // Registra no Supabase (texto real do template aprovado na Meta) pra aparecer no CRM —
        // antes esse envio ficava só no console, sem nenhum rastro visível pro time.
        const textoTemplateCoord = `🎓 Aluno aguardando atendimento da coordenação.\n📞 Número: ${telefoneLimpo}\n\nPor favor, retorne o contato.`;
        await salvarMensagem(NUMERO_COORDENACAO, textoTemplateCoord, 'bot', 'Coordenação', 'alerta_coordenacao');

        console.log(`✅ Coordenação notificada para atender ${telefone}`);
}


async function salvarMensagem(telefone, mensagem, de, vendedor, tipo = 'desconhecido', midiaUrl = null) {
        try {
                const nomeContato = nomeContatoPorTelefone[telefone] || null;
                const { error } = await supabase.from('conversas').insert({
                        telefone,
                        mensagem,
                        de,
                        vendedor,
                        tipo,
                        nome_contato: nomeContato,
                        midia_url: midiaUrl,
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

// Baixa uma midia da Meta (imagem/audio/video/documento) usando o media_id do webhook
// e sobe pro bucket 'midias' do Supabase Storage. Retorna a URL publica, ou null se falhar.
async function baixarESubirMidia(mediaId, telefone, extensaoPadrao) {
        try {
                const accessToken = process.env.META_ACCESS_TOKEN;

                // 1) Pega a URL temporaria (expira em poucos minutos) e o tipo do arquivo
                const infoResp = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, {
                        headers: { 'Authorization': `Bearer ${accessToken}` }
                });
                const mediaUrl = infoResp.data?.url;
                const mimeType = infoResp.data?.mime_type || 'application/octet-stream';
                if (!mediaUrl) return null;

                // 2) Baixa o binario (precisa do mesmo token na URL temporaria tambem)
                const fileResp = await axios.get(mediaUrl, {
                        headers: { 'Authorization': `Bearer ${accessToken}` },
                        responseType: 'arraybuffer'
                });
                const buffer = Buffer.from(fileResp.data);

                // 3) Sobe pro Supabase Storage
                const extensao = mimeType.split('/')[1]?.split(';')[0] || extensaoPadrao || 'bin';
                const caminho = `${telefone}/${Date.now()}.${extensao}`;
                const { error: uploadError } = await supabase.storage
                        .from('midias')
                        .upload(caminho, buffer, { contentType: mimeType, upsert: false });

                if (uploadError) {
                        console.error(`❌ Falha ao subir midia pro Storage [${telefone}]: ${JSON.stringify(uploadError)}`);
                        return null;
                }

                const { data: publicUrlData } = supabase.storage.from('midias').getPublicUrl(caminho);
                return publicUrlData?.publicUrl || null;
        } catch (err) {
                console.error(`❌ Erro ao baixar/subir midia [${telefone}]: ${err.message}`);
                return null;
        }
}

// ─── IA de apoio ao vendedor (copiloto, resumo, classificacao) via OpenRouter ───
// Cerebro separado do bot principal (que usa Groq/Gemini). So e chamado sob demanda,
// quando o vendedor/admin clica em algum botao de IA no CRM.
const OPENROUTER_MODEL = 'deepseek/deepseek-v4-flash';

async function chamarOpenRouter(mensagens, maxTokens = 400) {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) throw new Error('OPENROUTER_API_KEY nao configurada no servidor');

        const resp = await axios.post(
                'https://openrouter.ai/api/v1/chat/completions',
                {
                        model: OPENROUTER_MODEL,
                        messages: mensagens,
                        max_tokens: maxTokens,
                        temperature: 0.7
                },
                {
                        headers: {
                                'Authorization': `Bearer ${apiKey}`,
                                'Content-Type': 'application/json',
                                'HTTP-Referer': 'https://cursobot-production.up.railway.app',
                                'X-Title': 'Studio Rastro CRM'
                        },
                        timeout: 30000
                }
        );

        return resp.data?.choices?.[0]?.message?.content?.trim() || '';
}

// Busca as ultimas N mensagens de uma conversa (cliente + vendedor) formatadas pro prompt
// janelaHoras: se definido, corta o historico quando ha um intervalo grande sem mensagens,
// pra IA nao misturar uma conversa antiga/sem relacao com o assunto de agora.
async function buscarContextoConversa(telefone, vendedor, limite = 30, janelaHoras = null) {
        let query = supabase.from('conversas').select('mensagem,de,vendedor,created_at').eq('telefone', telefone);
        if (vendedor) query = query.ilike('vendedor', vendedor);
        const { data, error } = await query.order('created_at', { ascending: false }).limit(limite);
        if (error || !data || !data.length) return [];

        let mensagens = data; // vem em ordem DESC (mais recente primeiro)
        if (janelaHoras) {
                const recentes = [];
                let ultimoTs = null;
                for (const m of data) {
                        const ts = new Date(m.created_at).getTime();
                        if (ultimoTs !== null && (ultimoTs - ts) > janelaHoras * 60 * 60 * 1000) break;
                        recentes.push(m);
                        ultimoTs = ts;
                }
                mensagens = recentes;
        }

        return mensagens.reverse().map(m => {
                const autor = m.de === 'cliente' ? 'Cliente' : (m.de === 'vendedor' ? (m.vendedor || 'Vendedor') : 'Bot');
                return `${autor}: ${m.mensagem}`;
        });
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
                msgLower.includes('minha prova') ||
                msgLower.includes('prova amanha') ||
                msgLower.includes('prova amanhã') ||
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
// ── Verificação de webhook da Meta Cloud API ─────────────────────────────────
app.get('/webhook', (req, res) => {
        const mode      = req.query['hub.mode'];
        const token     = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];
        if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
                console.log('✅ Webhook Meta verificado');
                return res.status(200).send(challenge);
        }
        console.warn('❌ Falha na verificação do webhook Meta');
        return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
        res.sendStatus(200);

        const body = req.body;
        if (body.object !== 'whatsapp_business_account') return;

        let telefone, mensagem;
        const value   = body.entry?.[0]?.changes?.[0]?.value;
        const field   = body.entry?.[0]?.changes?.[0]?.field;

        const vendedorPorPhoneId = {
                [process.env.META_PHONE_NUMBER_ID_REBECCA]: 'Rebecca',
                [process.env.META_PHONE_NUMBER_ID_PAULO]:   'Paulo',
                [process.env.META_PHONE_NUMBER_ID_TAYNARA]: 'Taynara',
        };

        // Mensagens de mídia não são baixadas (ainda) — só registramos um indicativo
        // de que algo chegou, pra aparecer no CRM. O conteúdo real só no celular.
        const MIDIA_LABELS = {
                image: '📷 Imagem recebida',
                audio: '🎤 Áudio recebido',
                video: '🎥 Vídeo recebido',
                document: '📄 Documento recebido',
                sticker: '🌟 Figurinha recebida',
        };

        // ── statuses: status de entrega (enviado/entregue/lido/falhou) das mensagens que O BOT mandou ──
        // A Meta nunca dava esse retorno visivel antes; agora logamos pra conseguir diagnosticar
        // quando uma mensagem é "enviada" pela API mas não chega de verdade no celular.
        if (Array.isArray(value?.statuses) && value.statuses.length > 0) {
                value.statuses.forEach(st => {
                        if (st.status === 'failed') {
                                const erro = st.errors?.[0];
                                console.error(`❌ Falha de entrega pra ${st.recipient_id}: [${erro?.code}] ${erro?.title || erro?.message || 'sem detalhe'} — ${erro?.error_data?.details || ''}`);
                        } else {
                                console.log(`📶 Status "${st.status}" para ${st.recipient_id} (msg ${st.id})`);
                        }
                });
                return;
        }

        // ── smb_message_echoes: mensagem ENVIADA pela vendedora no celular ──
        if (field === 'smb_message_echoes') {
                const echo = value?.message_echoes?.[0];
                if (!echo) return;
                const echoEhMidia = echo.type !== 'text' && MIDIA_LABELS[echo.type];
                if (echo.type !== 'text' && !echoEhMidia) return; // tipo não suportado, ignora
                const phoneNumberId = value?.metadata?.phone_number_id;
                const vendedorDoNumero = vendedorPorPhoneId[phoneNumberId];
                if (!vendedorDoNumero) return;
                const telefonCliente = String(echo.to).replace(/\D/g, '');
                const textoMensagem  = echoEhMidia ? MIDIA_LABELS[echo.type] : echo.text?.body;
                await salvarMensagem(telefonCliente, textoMensagem, 'vendedor', vendedorDoNumero, 'conversa_vendedor');
                console.log(`📤 [${vendedorDoNumero}] vendedor → ${telefonCliente}: ${textoMensagem}`);
                return;
        }

        // ── messages: mensagem RECEBIDA no número da vendedora (cliente enviou) ──
        console.log(`📞 Webhook Meta RAW — phone_number_id: ${value?.metadata?.phone_number_id}, hasMessages: ${!!value?.messages?.[0]}, type: ${value?.messages?.[0]?.type}`);
        const message = value?.messages?.[0];
        if (!message) return;                          // status update, ignorar
        const mensagemEhMidia = message.type !== 'text' && MIDIA_LABELS[message.type];
        if (message.type !== 'text' && !mensagemEhMidia) return; // tipo não suportado, ignora

        const phoneNumberId = value?.metadata?.phone_number_id;
        telefone = String(message.from).replace(/\D/g, '');
        mensagem = mensagemEhMidia ? MIDIA_LABELS[message.type] : message.text?.body;

        // Guarda contra eco entre linhas internas: às vezes a Meta/Coexistência re-emite
        // pro webhook de UM vendedor uma mensagem cujo "from" é o número de OUTRO vendedor
        // (ex: notificação de lead que chegou no celular da Rebecca ecoa no webhook do
        // Paulo com from=Rebecca). Isso não é uma conversa de cliente de verdade — se o
        // remetente é um dos nossos próprios números internos, ignora e não salva/rotula errado.
        const numerosInternos = new Set(
                [process.env.NUMERO_REBECCA, process.env.NUMERO_PAULO, process.env.NUMERO_TAYNARA]
                        .filter(Boolean)
                        .map(n => normalizePhone(n))
        );
        if (numerosInternos.has(telefone)) {
                console.log(`⏭️  Ignorado: mensagem interna (from=${telefone} é número de vendedor, não de cliente) — phone_number_id ${phoneNumberId}`);
                return;
        }

        // Audio: baixa da Meta e sobe pro Supabase Storage pra poder tocar no CRM
        let midiaUrl = null;
        if (message.type === 'audio' && message.audio?.id) {
                midiaUrl = await baixarESubirMidia(message.audio.id, telefone, 'ogg');
        }

        // Nome de perfil do WhatsApp (vem junto no payload do webhook, quando disponivel)
        const nomePerfilContato = value?.contacts?.[0]?.profile?.name;
        if (nomePerfilContato) {
                nomeContatoPorTelefone[telefone] = nomePerfilContato;
        }

        const vendedorDoNumero = vendedorPorPhoneId[phoneNumberId];

        if (vendedorDoNumero) {
                // Salva no Supabase como conversa do vendedor e encerra
                await salvarMensagem(telefone, mensagem, 'cliente', vendedorDoNumero, 'conversa_vendedor', midiaUrl);
                console.log(`💬 [${vendedorDoNumero}] cliente ${telefone}: ${mensagem}`);
                return;
        }

        if (mensagemEhMidia) {
                // Mídia pro número principal do bot: só registra, não manda pra IA
                // (a IA não teria como responder algo coerente sobre a mídia em si).
                await salvarMensagem(telefone, mensagem, 'cliente', null, 'desconhecido', midiaUrl);
                console.log(`📎 Mídia recebida no bot principal de ${telefone}: ${mensagem}`);
                return;
        }

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

        // ── Resposta de vendedor ao prompt de atualização de status ──────────────
        const numRebecca  = normalizePhone(process.env.NUMERO_REBECCA  || '');
        const numPaulo    = normalizePhone(process.env.NUMERO_PAULO    || '');
        const numTaynara  = normalizePhone(process.env.NUMERO_TAYNARA  || '');
        const ehVendedor  = (telefone === numRebecca && numRebecca) || (telefone === numPaulo && numPaulo) || (telefone === numTaynara && numTaynara);

        if (ehVendedor && pendentesAtualizacao[telefone]?.atual) {
                const entrada = pendentesAtualizacao[telefone];
                const lead = entrada.atual;
                const nomeVendedorResposta = (telefone === numRebecca) ? 'Rebecca' : (telefone === numTaynara) ? 'Taynara' : 'Paulo';

                const nomeVendLower = nomeVendedorResposta.toLowerCase();

                // ── Resposta de status (aceita "perdido – motivo" na mesma mensagem) ──
                // Normaliza separadores: "–", "-", "—", ":"
                const respostaNorm = mensagem.trim()
                        .replace(/[–—]/g, '-')
                        .replace(/\s*:\s*/, ' - ');

                // Extrai parte do status (antes do traço) e motivo (depois)
                const [parteStatus, ...partesMotivo] = respostaNorm.split(/\s*-\s*/);
                const motivoInline = partesMotivo.join(' - ').trim() || null;

                const statusRaw = parteStatus.trim().toLowerCase()
                        .replace(/em\s*andamento/g, 'em_andamento')
                        .replace('emandamento', 'em_andamento');

                const statusValidos = ['em_andamento', 'matriculado', 'perdido', 'pausado', 'aluno'];

                if (statusValidos.includes(statusRaw)) {
                        // Salva resposta do vendedor na conversa
                        await salvarMensagem(telefone, mensagem.trim(), 'vendedor', nomeVendLower, 'resposta_vendedor');

                        const upsertData = { telefone: lead.telefone, status: statusRaw, nome: lead.nome };
                        if (motivoInline) upsertData.anotacao = motivoInline;

                        await supabase.from('status_de_leads')
                                .upsert(upsertData, { onConflict: 'telefone' });

                        const labelStatus = statusRaw.replace('em_andamento', 'Em Andamento').replace(/^\w/, c => c.toUpperCase());
                        if (motivoInline) {
                                console.log(`✅ Status por ${nomeVendedorResposta}: ${lead.telefone} → ${statusRaw} ("${motivoInline}")`);
                        } else {
                                console.log(`✅ Status por ${nomeVendedorResposta}: ${lead.telefone} → ${statusRaw}`);
                        }

                        // Se perdido/pausado sem motivo → pede o motivo (fallback para quem não leu o template)
                        if ((statusRaw === 'perdido' || statusRaw === 'pausado') && !motivoInline) {
                                pendentesAtualizacao[telefone].aguardandoMotivo = true;
                                pendentesAtualizacao[telefone].motivoStatus = statusRaw;
                                const pergunta = `✅ *${lead.nome || lead.telefone}* → *${labelStatus}*\n\n❓ Qual foi o motivo? Responda livremente.`;
                                await sendWhatsApp(telefone, pergunta);
                                await salvarMensagem(telefone, pergunta, 'sistema', nomeVendLower, 'alerta_vendedor');
                                return;
                        }

                        // ── Aguardando motivo de perda/pausa (fallback – segunda mensagem) ──
                        if (entrada.aguardandoMotivo) {
                                const motivo = mensagem.trim();
                                await salvarMensagem(telefone, motivo, 'vendedor', nomeVendLower, 'resposta_vendedor');
                                await supabase.from('status_de_leads')
                                        .upsert({ telefone: lead.telefone, status: entrada.motivoStatus, nome: lead.nome, anotacao: motivo }, { onConflict: 'telefone' });
                                entrada.aguardandoMotivo = false;
                                entrada.motivoStatus = null;
                                console.log(`📝 Motivo (2ª msg) por ${nomeVendedorResposta}: ${lead.telefone} → "${motivo}"`);
                                let confirmacaoMotivo = `📝 Motivo registrado para *${lead.nome || lead.telefone}*.`;
                                if (entrada.fila.length > 0) {
                                        const proximo = entrada.fila.shift();
                                        pendentesAtualizacao[telefone].atual = proximo;
                                        const restam = entrada.fila.length + 1;
                                        confirmacaoMotivo += `\n\n➡️ Próximo (${restam} restante${restam > 1 ? 's' : ''}):\n`;
                                        confirmacaoMotivo += `👤 *${proximo.nome || 'sem nome'}*\n📞 ${proximo.telefone}\n\n`;
                                        confirmacaoMotivo += `Como ficou? Responda com status e motivo se perdido/pausado.`;
                                } else {
                                        delete pendentesAtualizacao[telefone];
                                        confirmacaoMotivo += `\n\n🎉 Todos os leads atualizados! Obrigado, ${nomeVendedorResposta}!`;
                                }
                                await sendWhatsApp(telefone, confirmacaoMotivo);
                                await salvarMensagem(telefone, confirmacaoMotivo, 'sistema', nomeVendLower, 'alerta_vendedor');
                                return;
                        }

                        let confirmacao = `✅ *${lead.nome || lead.telefone}* → *${labelStatus}*${motivoInline ? `\n📝 Motivo: ${motivoInline}` : ''}`;

                        // Avança para o próximo da fila
                        if (entrada.fila.length > 0) {
                                const proximo = entrada.fila.shift();
                                pendentesAtualizacao[telefone].atual = proximo;
                                const restam = entrada.fila.length + 1;
                                confirmacao += `\n\n➡️ Próximo (${restam} restante${restam > 1 ? 's' : ''}):\n`;
                                confirmacao += `👤 *${proximo.nome || 'sem nome'}*\n📞 ${proximo.telefone}\n\n`;
                                confirmacao += `Como ficou? Responda: *matriculado*, *em andamento*, *perdido*, *pausado* ou *aluno*`;
                        } else {
                                delete pendentesAtualizacao[telefone];
                                confirmacao += `\n\n🎉 Todos os leads atualizados! Obrigado, ${nomeVendedorResposta}!`;
                        }

                        await sendWhatsApp(telefone, confirmacao);
                        await salvarMensagem(telefone, confirmacao, 'sistema', nomeVendLower, 'alerta_vendedor');
                        return;
                } else {
                        // Resposta inválida — repete a pergunta
                        await sendWhatsApp(telefone,
                                `❓ Não entendi. Para *${lead.nome || lead.telefone}*, responda com:\n*matriculado*, *em andamento*, *perdido*, *pausado* ou *aluno*`);
                        return;
                }
        }
        // ─────────────────────────────────────────────────────────────────────────

        const jaConsentiu = await verificarConsentimento(telefone);

        let vendedor = await getVendedorDoTelefone(telefone);

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
                reengajamentoEnviado[telefone] = false;
                salvarEstadoBot(telefone);

                // Verifica se o número já tem status 'aluno' no CRM — encaminha direto para coordenação
                const { data: statusCRM } = await supabase
                        .from('status_de_leads')
                        .select('status')
                        .eq('telefone', telefone)
                        .single();

                if (statusCRM?.status === 'aluno') {
                        const msgAluno = 'Olá! 😊 Vou te encaminhar para a coordenação agora. Um momento!';
                        await sendWhatsApp(telefone, msgAluno);
                        vendedor = 'Coordenação';
                        vendedorPorTelefone[telefone] = 'Coordenação';
                        await salvarMensagem(telefone, mensagem, 'cliente', 'Coordenação', 'aluno');
                        await salvarMensagem(telefone, msgAluno, 'bot', 'Coordenação', 'aluno');
                        if (!reengajamentoEnviado[`coord_${telefone}`]) {
                                reengajamentoEnviado[`coord_${telefone}`] = true;
                                await notificarCoordenacao(telefone);
                        }
                        return;
                }

                const PAUSA_ADMIN_MANUAL_MS = 3 * 60 * 60 * 1000; // 3 horas
                if (pausaAdminManual[telefone] && (Date.now() - pausaAdminManual[telefone]) < PAUSA_ADMIN_MANUAL_MS) {
                        await salvarMensagem(telefone, mensagem, 'cliente', vendedor, 'desconhecido');
                        console.log(`⏸️ IA pausada (admin assumiu manualmente) para ${telefone} — mensagem salva sem resposta automática.`);
                        return;
                }

                const reply = await askAI(telefone, mensagem);
                let tipo = detectarTipo(mensagem, reply);

                if (tipo === 'aluno' && !reengajamentoEnviado[`coord_${telefone}`]) {
                        reengajamentoEnviado[`coord_${telefone}`] = true;
                        vendedor = 'Coordenação';
                        vendedorPorTelefone[telefone] = 'Coordenação';
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

                if (reply.includes('Seus dados foram registrados') && !dadosLead[telefone].confirmado) {
                        dadosLead[telefone].confirmado = true;

                        // Reavalia o vendedor NESTE momento (confirmação), não usa o que foi
                        // atribuído lá no primeiro "oi" do cliente — que pode ter sido horas ou
                        // até um dia antes. Assim quem recebe o lead é sempre quem está na escala
                        // (ou é a vez do rodízio) no horário real em que o lead foi confirmado.
                        vendedor = await getVendedor();
                        vendedorPorTelefone[telefone] = vendedor;

                        salvarEstadoBot(telefone);
                }

                if (dadosLead[telefone].confirmado && !dadosLead[telefone].notificado) {
                        tipo = 'lead_confirmado';
                        // Isolado num try/catch próprio: se a notificação do vendedor falhar (template
                        // ausente, Meta fora do ar, etc.), o cliente ainda assim recebe a resposta dele —
                        // antes, um erro aqui derrubava o fluxo inteiro e o cliente via "tive um probleminha".
                        // "notificado" só vira true DEPOIS de confirmar que a notificação foi enviada —
                        // antes marcava true de qualquer jeito, então uma falha ficava permanentemente
                        // sem tentar de novo, mesmo depois do bug ser corrigido.
                        try {
                                await notificarVendedor(telefone, vendedor);
                                dadosLead[telefone].notificado = true;
                                salvarEstadoBot(telefone);
                        } catch (errNotif) {
                                console.error(`❌ Falha ao notificar vendedor ${vendedor} (cliente segue normalmente, vai tentar de novo na próxima mensagem):`, errNotif.response?.data || errNotif.message);
                        }
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

// ── OAuth Callback — Embedded Signup (Coexistência Meta) ─────────────────────
app.get('/oauth/callback', async (req, res) => {
        const code = req.query.code;
        const errorCode = req.query.error_code;

        if (errorCode || !code) {
                console.error('❌ OAuth callback erro:', req.query);
                return res.send(`<h2>❌ Erro no cadastro: ${req.query.error_message || 'Cancelado'}</h2>`);
        }

        try {
                // Troca o code pelo access token
                const tokenRes = await axios.get('https://graph.facebook.com/v20.0/oauth/access_token', {
                        params: {
                                client_id: process.env.META_APP_ID,
                                client_secret: process.env.META_APP_SECRET,
                                code
                        }
                });

                const accessToken = tokenRes.data.access_token;
                console.log('✅ OAuth token obtido com sucesso');
                console.log('🔑 Token:', accessToken);

                // Salva no log para uso posterior
                await supabase.from('conversas').insert({
                        telefone: 'META_OAUTH',
                        mensagem: accessToken,
                        de: 'sistema',
                        vendedor: 'oauth_callback',
                        tipo: 'coexistencia_token',
                        created_at: new Date().toISOString()
                });

                return res.send(`
                        <h2>✅ Coexistência configurada com sucesso!</h2>
                        <p>O número do Studio Rastro foi conectado à Cloud API.</p>
                        <p>As mensagens agora serão salvas no CRM automaticamente.</p>
                `);

        } catch (err) {
                console.error('❌ Erro ao trocar code por token:', err.response?.data || err.message);
                return res.send(`<h2>❌ Erro ao processar: ${err.message}</h2>`);
        }
});

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

// Rota para o CRM enviar mensagem como um vendedor (Rebecca/Taynara) via Cloud API,
// substituindo a necessidade de WhatsApp Web/linked device nesses números.
const PHONE_NUMBER_ID_POR_VENDEDOR = {
        rebecca: process.env.META_PHONE_NUMBER_ID_REBECCA,
        taynara: process.env.META_PHONE_NUMBER_ID_TAYNARA,
        paulo: process.env.META_PHONE_NUMBER_ID_PAULO,
};

// Nome com a capitalização correta, igual ao que o eco do WhatsApp Business App salva
// (evita mensagem enviada pelo CRM "sumir" da conversa por causa de maiúscula/minúscula)
const NOME_CAPITALIZADO_VENDEDOR = { rebecca: 'Rebecca', taynara: 'Taynara', paulo: 'Paulo' };

app.post('/enviar-vendedor', async (req, res) => {
        if (!checkAdminToken(req, res)) return;

        const { telefone, vendedor, mensagem } = req.body || {};
        if (!telefone || !vendedor || !mensagem) {
                return res.status(400).json({ error: 'telefone, vendedor e mensagem são obrigatórios' });
        }

        const nomeVendedor = String(vendedor).toLowerCase().trim();
        const telefoneLimpo = String(telefone).replace(/\D/g, '');
        const accessToken = process.env.META_ACCESS_TOKEN;

        // Caso especial: aba "Bot" — envia pelo número principal (admin assume a conversa da IA)
        if (nomeVendedor === 'bot') {
                const phoneNumberIdBot = process.env.META_PHONE_NUMBER_ID;
                try {
                        const response = await axios.post(
                                `https://graph.facebook.com/v21.0/${phoneNumberIdBot}/messages`,
                                {
                                        messaging_product: 'whatsapp',
                                        to: telefoneLimpo,
                                        type: 'text',
                                        text: { body: mensagem }
                                },
                                { headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
                        );

                        // Pausa a IA pra esse telefone (admin assumiu manualmente) e registra a mensagem
                        pausaAdminManual[telefoneLimpo] = Date.now();
                        await salvarMensagem(telefoneLimpo, mensagem, 'bot', null, 'admin_manual');

                        console.log(`📨 [CRM] Admin (Bot) → ${telefoneLimpo}: ${mensagem}`);
                        return res.json({ ok: true, id: response.data?.messages?.[0]?.id || null });
                } catch (err) {
                        console.error('❌ Erro ao enviar via CRM (Bot):', err.response?.data || err.message);
                        return res.status(500).json({ error: err.response?.data?.error?.message || err.message });
                }
        }

        const phoneNumberId = PHONE_NUMBER_ID_POR_VENDEDOR[nomeVendedor];
        if (!phoneNumberId) {
                return res.status(400).json({ error: `Vendedor "${vendedor}" não está habilitado para envio pelo CRM` });
        }

        try {
                const response = await axios.post(
                        `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
                        {
                                messaging_product: 'whatsapp',
                                to: telefoneLimpo,
                                type: 'text',
                                text: { body: mensagem }
                        },
                        { headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
                );

                // Salva no Supabase no mesmo formato usado pelo eco do WhatsApp Business App,
                // pra aparecer igual no histórico da conversa.
                const nomeParaSalvar = NOME_CAPITALIZADO_VENDEDOR[nomeVendedor] || nomeVendedor;
                await salvarMensagem(telefoneLimpo, mensagem, 'vendedor', nomeParaSalvar, 'conversa_vendedor');

                console.log(`📨 [CRM] ${vendedor} → ${telefoneLimpo}: ${mensagem}`);
                res.json({ ok: true, id: response.data?.messages?.[0]?.id || null });
        } catch (err) {
                console.error(`❌ Erro ao enviar via CRM (${vendedor}):`, err.response?.data || err.message);
                res.status(500).json({ error: err.response?.data?.error?.message || err.message });
        }
});

// Envia uma imagem ou documento pelo CRM (botão de anexo da aba WhatsApp).
// Recebe o arquivo em base64, sobe pro Supabase Storage e manda pra Meta por link.
app.post('/enviar-midia-vendedor', async (req, res) => {
        if (!checkAdminToken(req, res)) return;

        const { telefone, vendedor, arquivoBase64, arquivoNome, arquivoTipo, legenda } = req.body || {};
        if (!telefone || !vendedor || !arquivoBase64 || !arquivoTipo) {
                return res.status(400).json({ error: 'telefone, vendedor, arquivoBase64 e arquivoTipo são obrigatórios' });
        }

        const nomeVendedor = String(vendedor).toLowerCase().trim();
        const telefoneLimpo = String(telefone).replace(/\D/g, '');
        const accessToken = process.env.META_ACCESS_TOKEN;

        const phoneNumberId = nomeVendedor === 'bot'
                ? process.env.META_PHONE_NUMBER_ID
                : PHONE_NUMBER_ID_POR_VENDEDOR[nomeVendedor];
        if (!phoneNumberId) {
                return res.status(400).json({ error: `Vendedor "${vendedor}" não está habilitado para envio pelo CRM` });
        }

        try {
                // 1) Decodifica e sobe pro Storage
                const base64Limpo = arquivoBase64.includes(',') ? arquivoBase64.split(',')[1] : arquivoBase64;
                const buffer = Buffer.from(base64Limpo, 'base64');
                const nomeSeguro = (arquivoNome || 'arquivo').replace(/[^a-zA-Z0-9._-]/g, '_');
                const caminho = `enviados/${telefoneLimpo}/${Date.now()}_${nomeSeguro}`;

                const { error: uploadError } = await supabase.storage
                        .from('midias')
                        .upload(caminho, buffer, { contentType: arquivoTipo, upsert: false });
                if (uploadError) {
                        return res.status(500).json({ error: 'Falha ao subir arquivo: ' + JSON.stringify(uploadError) });
                }
                const { data: publicUrlData } = supabase.storage.from('midias').getPublicUrl(caminho);
                const urlPublica = publicUrlData?.publicUrl;
                if (!urlPublica) {
                        return res.status(500).json({ error: 'Não foi possível gerar a URL pública do arquivo' });
                }

                // 2) Monta a mensagem pra Meta (imagem ou documento, por link)
                const ehImagem = arquivoTipo.startsWith('image/');
                const payloadMeta = ehImagem
                        ? { messaging_product: 'whatsapp', to: telefoneLimpo, type: 'image', image: { link: urlPublica, caption: legenda || undefined } }
                        : { messaging_product: 'whatsapp', to: telefoneLimpo, type: 'document', document: { link: urlPublica, filename: nomeSeguro, caption: legenda || undefined } };

                const response = await axios.post(
                        `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
                        payloadMeta,
                        { headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
                );

                // 3) Salva no histórico do CRM
                const textoPlaceholder = ehImagem ? '📷 Imagem enviada' : `📄 Documento enviado: ${nomeSeguro}`;
                if (nomeVendedor === 'bot') {
                        pausaAdminManual[telefoneLimpo] = Date.now();
                        await salvarMensagem(telefoneLimpo, textoPlaceholder, 'bot', null, 'admin_manual', urlPublica);
                } else {
                        const nomeParaSalvar = NOME_CAPITALIZADO_VENDEDOR[nomeVendedor] || nomeVendedor;
                        await salvarMensagem(telefoneLimpo, textoPlaceholder, 'vendedor', nomeParaSalvar, 'conversa_vendedor', urlPublica);
                }

                console.log(`📨 [CRM] ${vendedor} → ${telefoneLimpo}: ${textoPlaceholder}`);
                res.json({ ok: true, url: urlPublica, id: response.data?.messages?.[0]?.id || null });
        } catch (err) {
                console.error(`❌ Erro ao enviar mídia via CRM (${vendedor}):`, err.response?.data || err.message);
                res.status(500).json({ error: err.response?.data?.error?.message || err.message });
        }
});

// Sugere uma resposta pro vendedor mandar, baseada no fim da conversa
app.post('/ia/sugerir-resposta', async (req, res) => {
        if (!checkAdminToken(req, res)) return;
        const { telefone, vendedor } = req.body || {};
        if (!telefone) return res.status(400).json({ error: 'telefone é obrigatório' });

        try {
                const contexto = await buscarContextoConversa(telefone, vendedor === 'bot' ? null : vendedor, 20, 12);
                if (!contexto.length) return res.status(404).json({ error: 'Sem histórico de conversa pra sugerir resposta' });

                const sugestao = await chamarOpenRouter([
                        {
                                role: 'system',
                                content: 'Você ajuda um vendedor de uma escola de idiomas (CNA Recreio) a responder clientes no WhatsApp. ' +
                                        'Leia a conversa e sugira UMA resposta curta, natural e simpática em português do Brasil, como se fosse o vendedor escrevendo. ' +
                                        'Não use markdown, não use aspas, não se apresente, não explique — devolva só o texto da mensagem sugerida.'
                        },
                        { role: 'user', content: 'Conversa (mais recente por último):\n' + contexto.join('\n') }
                ], 250);

                res.json({ sugestao });
        } catch (err) {
                console.error('❌ Erro em /ia/sugerir-resposta:', err.response?.data || err.message);
                res.status(500).json({ error: err.response?.data?.error?.message || err.message });
        }
});

// Reescreve um texto com o mesmo sentido, mas com outras palavras
app.post('/ia/reformular', async (req, res) => {
        if (!checkAdminToken(req, res)) return;
        const { texto } = req.body || {};
        if (!texto || !texto.trim()) return res.status(400).json({ error: 'texto é obrigatório' });

        try {
                const reformulado = await chamarOpenRouter([
                        {
                                role: 'system',
                                content: 'Reescreva a mensagem do usuário em português do Brasil, mantendo exatamente o mesmo significado e o mesmo tom, ' +
                                        'mas com palavras e estrutura diferentes. Mantenha um tamanho parecido. ' +
                                        'Não use markdown, não use aspas, devolva só o texto reescrito, nada mais.'
                        },
                        { role: 'user', content: texto }
                ], 250);

                res.json({ reformulado });
        } catch (err) {
                console.error('❌ Erro em /ia/reformular:', err.response?.data || err.message);
                res.status(500).json({ error: err.response?.data?.error?.message || err.message });
        }
});

// Resume a conversa inteira. Fica em cache na tabela ia_analises ate alguem pedir pra regerar (forcar:true)
app.post('/ia/resumo-conversa', async (req, res) => {
        if (!checkAdminToken(req, res)) return;
        const { telefone, vendedor, forcar } = req.body || {};
        if (!telefone) return res.status(400).json({ error: 'telefone é obrigatório' });

        try {
                if (!forcar) {
                        const { data: cache } = await supabase.from('ia_analises').select('resumo,atualizado_em').eq('telefone', telefone).maybeSingle();
                        if (cache && cache.resumo) {
                                return res.json({ resumo: cache.resumo, atualizado_em: cache.atualizado_em, cache: true });
                        }
                }

                const contexto = await buscarContextoConversa(telefone, vendedor === 'bot' ? null : vendedor, 100);
                if (!contexto.length) return res.status(404).json({ error: 'Sem histórico de conversa pra resumir' });

                const resumo = await chamarOpenRouter([
                        {
                                role: 'system',
                                content: 'Resuma a conversa abaixo entre um cliente e um vendedor de uma escola de idiomas (CNA Recreio), em português do Brasil, ' +
                                        'em no máximo 4 frases curtas. Foque em: o que o cliente quer/precisa, o que já foi combinado, e o que está pendente. ' +
                                        'Não use markdown, devolva só o texto do resumo.'
                        },
                        { role: 'user', content: contexto.join('\n') }
                ], 300);

                const atualizadoEm = new Date().toISOString();
                await supabase.from('ia_analises').upsert(
                        { telefone, resumo, atualizado_em: atualizadoEm },
                        { onConflict: 'telefone' }
                );

                res.json({ resumo, atualizado_em: atualizadoEm, cache: false });
        } catch (err) {
                console.error('❌ Erro em /ia/resumo-conversa:', err.response?.data || err.message);
                res.status(500).json({ error: err.response?.data?.error?.message || err.message });
        }
});

// Sugere um status pro lead com base na conversa. Tambem fica em cache (forcar:true regera)
const STATUS_VALIDOS = ['novo', 'em_andamento', 'matriculado', 'aluno', 'pausado', 'perdido'];
app.post('/ia/classificar-status', async (req, res) => {
        if (!checkAdminToken(req, res)) return;
        const { telefone, vendedor, forcar } = req.body || {};
        if (!telefone) return res.status(400).json({ error: 'telefone é obrigatório' });

        try {
                if (!forcar) {
                        const { data: cache } = await supabase.from('ia_analises').select('status_sugerido,status_justificativa,atualizado_em').eq('telefone', telefone).maybeSingle();
                        if (cache && cache.status_sugerido) {
                                return res.json({ status: cache.status_sugerido, justificativa: cache.status_justificativa, atualizado_em: cache.atualizado_em, cache: true });
                        }
                }

                const contexto = await buscarContextoConversa(telefone, vendedor === 'bot' ? null : vendedor, 40, 48);
                if (!contexto.length) return res.status(404).json({ error: 'Sem histórico de conversa pra classificar' });

                const respostaBruta = await chamarOpenRouter([
                        {
                                role: 'system',
                                content: 'Você classifica o status de um lead de uma escola de idiomas com base na conversa. ' +
                                        `Escolha exatamente UM destes valores: ${STATUS_VALIDOS.join(', ')}. ` +
                                        'Responda em UMA linha no formato exato "status: <valor> | motivo: <justificativa curta em português>". Nada mais.'
                        },
                        { role: 'user', content: contexto.join('\n') }
                ], 150);

                const matchStatus = respostaBruta.match(/status:\s*([a-z_]+)/i);
                const matchMotivo = respostaBruta.match(/motivo:\s*(.+)/i);
                const statusSugerido = matchStatus && STATUS_VALIDOS.includes(matchStatus[1].toLowerCase()) ? matchStatus[1].toLowerCase() : null;
                const justificativa = matchMotivo ? matchMotivo[1].trim() : respostaBruta;

                if (!statusSugerido) {
                        return res.status(500).json({ error: 'IA não retornou um status reconhecível', bruto: respostaBruta });
                }

                const atualizadoEm = new Date().toISOString();
                await supabase.from('ia_analises').upsert(
                        { telefone, status_sugerido: statusSugerido, status_justificativa: justificativa, atualizado_em: atualizadoEm },
                        { onConflict: 'telefone' }
                );

                res.json({ status: statusSugerido, justificativa, atualizado_em: atualizadoEm, cache: false });
        } catch (err) {
                console.error('❌ Erro em /ia/classificar-status:', err.response?.data || err.message);
                res.status(500).json({ error: err.response?.data?.error?.message || err.message });
        }
});

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

// Rota para classificar TODOS os leads "novo" via IA — só atualiza Supabase, sem WhatsApp
app.get('/classificar-antigos', async (req, res) => {
        if (!checkAdminToken(req, res)) return;

        const limite30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

        // 1. Telefones com atividade RECENTE (menos de 30 dias)
        const { data: recentes, error: errRec } = await supabase
                .from('conversas')
                .select('telefone')
                .gte('created_at', limite30d);
        if (errRec) return res.status(500).json({ ok: false, msg: errRec.message });
        const telefonesRecentes = new Set((recentes || []).map(c => c.telefone));

        // 2. Todos os telefones que já tiveram conversa
        const { data: todosConversas, error: errConv } = await supabase
                .from('conversas')
                .select('telefone')
                .limit(5000);
        if (errConv) return res.status(500).json({ ok: false, msg: errConv.message });

        const todosTelefones = [...new Set((todosConversas || []).map(c => c.telefone))];

        // 3. Inativos = sem nenhuma conversa nos últimos 30 dias
        const inativos = todosTelefones.filter(t => !telefonesRecentes.has(t));
        if (!inativos.length) return res.json({ ok: true, msg: 'Nenhum lead inativo há mais de 30 dias.', total: 0 });

        // 4. Dos inativos, pega só os sem status ou com status "novo"
        const { data: comStatus } = await supabase
                .from('status_de_leads')
                .select('telefone, status, nome')
                .in('telefone', inativos);

        const statusMap = {};
        (comStatus || []).forEach(s => { statusMap[s.telefone] = s; });

        const leads = inativos
                .filter(tel => !statusMap[tel] || statusMap[tel].status === 'novo')
                .map(tel => ({ telefone: tel, nome: statusMap[tel]?.nome || null }));

        if (!leads.length) return res.json({ ok: true, msg: 'Todos os leads já têm status definido.', total: 0 });

        // Responde imediatamente e processa em background
        res.json({ ok: true, msg: `Classificando ${leads.length} lead(s) em background. Acompanhe nos logs do Railway.`, total: leads.length });

        const contagem = { perdido: 0, pausado: 0, em_andamento: 0, erro: 0 };
        for (const lead of leads) {
                try {
                        const { data: msgs } = await supabase
                                .from('conversas').select('mensagem, de')
                                .eq('telefone', lead.telefone)
                                .order('created_at', { ascending: false }).limit(8);

                        const texto = (msgs || []).reverse()
                                .map(m => `${m.de === 'bot' ? 'Bot' : m.de === 'vendedor' ? 'Vendedor' : 'Lead'}: ${m.mensagem}`)
                                .join('\n');

                        const status = await classificarLeadIA(texto);
                        if (!status) { contagem.erro++; continue; }

                        await supabase.from('status_de_leads')
                                .upsert({ telefone: lead.telefone, status, nome: lead.nome }, { onConflict: 'telefone' });
                        console.log(`🤖 Classificado: ${lead.nome || lead.telefone} → ${status}`);
                        contagem[status] = (contagem[status] || 0) + 1;
                        await new Promise(r => setTimeout(r, 3000)); // 3s entre chamadas — evita 429
                } catch (err) {
                        console.error(`❌ Erro ao classificar ${lead.telefone}:`, err.message);
                        contagem.erro++;
                }
        }
        console.log(`✅ /classificar-antigos concluído:`, contagem);
});

// Rota para processar backlog de leads "novo" — dispara prompt interativo aos vendedores
app.get('/processar-novos', async (req, res) => {
        if (!checkAdminToken(req, res)) return;
        res.json({ ok: true, msg: 'Enviando prompts de atualização para os vendedores...' });
        processarBacklogNovos();
});

// Rota para disparar o relatório mensal manualmente (teste)
let relatorioEmAndamento = false;
app.get('/relatorio-mensal', async (req, res) => {
        if (!checkAdminToken(req, res)) return;
        if (relatorioEmAndamento) {
                return res.json({ ok: false, msg: 'Relatório já está sendo gerado. Aguarde.' });
        }
        res.json({ ok: true, msg: 'Gerando relatório mensal em background...' });
        gerarRelatorioMensal();
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

// Reengajamento após 23h de inatividade (dentro da janela de 24h — sem template)
async function checkInatividade() {
        const agora = Date.now();

        // ── Fallback DB: busca direto em conversas — nao depende de estado_bot ──
        try {
                const limite23h  = new Date(agora - 23 * 60 * 60 * 1000).toISOString();
                const limite7d   = new Date(agora -  7 * 24 * 60 * 60 * 1000).toISOString();

                const { data: jaEnviados } = await supabase
                        .from('conversas')
                        .select('telefone')
                        .eq('tipo', 'reengajamento')
                        .gte('created_at', limite7d);
                const jaEnviadosSet = new Set((jaEnviados || []).map(r => r.telefone));

                const { data: conversasAntigas } = await supabase
                        .from('conversas')
                        .select('telefone, created_at')
                        .eq('de', 'cliente')
                        .lte('created_at', limite23h)
                        .gte('created_at', limite7d)
                        .order('created_at', { ascending: false });

                const ultimaPorTel = {};
                for (const r of (conversasAntigas || [])) {
                        if (!ultimaPorTel[r.telefone]) ultimaPorTel[r.telefone] = r.created_at;
                }

                const candidatos = Object.keys(ultimaPorTel).filter(tel =>
                        !ultimaAtividade[tel] &&
                        !reengajamentoEnviado[tel] &&
                        !jaEnviadosSet.has(tel)
                );

                for (const tel of candidatos) {

                        // Checa se conversa já foi encerrada
                        const { data: historico } = await supabase
                                .from('conversas')
                                .select('tipo')
                                .eq('telefone', tel)
                                .order('created_at', { ascending: false })
                                .limit(10);

                        const tipos = (historico || []).map(r => r.tipo);
                        const jaEncerrado = tipos.some(t =>
                                ['aluno','lead_confirmado','lead-vendedor','conversa_vendedor'].includes(t)
                        );
                        if (jaEncerrado) {
                                reengajamentoEnviado[tel] = true;
                                salvarEstadoBot(tel);
                                continue;
                        }

                        // Dados do lead não estão na memória → mensagem de texto (janela 24h ainda aberta)
                        const msgReengFb = 'Oi! 👋 Ainda posso te ajudar com informações sobre nossos cursos do CNA Recreio? 😊';
                        console.log(`⏳ Reengajamento (fallback conversas) disparado para ${tel}`);
                        await sendWhatsApp(tel, msgReengFb);
                        salvarMensagem(tel, msgReengFb, 'bot', null, 'reengajamento');
                        reengajamentoEnviado[tel] = true;
                        ultimaAtividade[tel] = new Date(ultimaPorTel[tel]).getTime();
                        salvarEstadoBot(tel);

                        await new Promise(r => setTimeout(r, 2000)); // pausa entre envios
                }
        } catch (e) {
                console.error('Erro no checkInatividade fallback DB:', e.message);
        }

        // ── Check principal: telefones em memória ────────────────────────────────
        for (const telefone in ultimaAtividade) {
                if (agora - ultimaAtividade[telefone] > 23 * 60 * 60 * 1000 && !reengajamentoEnviado[telefone]) {
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
                        if (!dados.confirmado) {
                                const nomeLead = dados.nome ? `, ${dados.nome}` : '';
                                const msgReeng = `Oi${nomeLead}! 👋 Ainda posso te ajudar com informações sobre nossos cursos do CNA Recreio? 😊`;
                                console.log(`⏳ Reengajamento disparado para ${telefone}`);
                                await sendWhatsApp(telefone, msgReeng);
                                salvarMensagem(telefone, msgReeng, 'bot', null, 'reengajamento');
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

                // Início do mês atual (00:00 BRT = 03:00 UTC)
                const inicioMes = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1, 3, 0, 0));
                const inicioMesISO = inicioMes.toISOString();

                // Leads novos ontem — primeiro contato dentro do período
                // Usa leads_resumo sem filtro de tipo (a view não tem campo tipo por mensagem)
                const { data: leadsNovos } = await supabase
                        .from('leads_resumo')
                        .select('telefone, vendedor, tem_msg_bot')
                        .gte('primeiro_contato', inicioISO)
                        .lte('primeiro_contato', fimISO)
                        .eq('tem_msg_cliente', true);

                // Status apenas dos leads do mês atual
                // (primeiro buscamos os telefones do mês, depois filtramos os status)
                const { data: todosStatusRaw } = await supabase
                        .from('status_de_leads')
                        .select('telefone, status, nome, updated_at');

                // Leads do mês atual para o status geral
                const { data: todosLeads } = await supabase
                        .from('leads_resumo')
                        .select('telefone, vendedor')
                        .eq('tem_msg_cliente', true)
                        .gte('primeiro_contato', inicioMesISO);

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

                // Contagem por status — apenas leads do mês atual
                const telefonesDoMes = new Set((todosLeads || []).map(l => l.telefone));
                const todosStatus = (todosStatusRaw || []).filter(s => telefonesDoMes.has(s.telefone));

                const contStatus = { novo: 0, em_andamento: 0, matriculado: 0, aluno: 0, perdido: 0 };
                todosStatus.forEach(s => {
                        if (contStatus[s.status] !== undefined) contStatus[s.status]++;
                });
                const comStatusSet = new Set(todosStatus.map(s => s.telefone));
                const totalSemStatus = (todosLeads || []).filter(l => !comStatusSet.has(l.telefone)).length;

                // Status alterados ontem
                const statusAlteradosOntem = todosStatus.filter(s =>
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
                msg += `  • Novo: ${contStatus.novo + totalSemStatus}\n`;
                msg += `  • Em andamento: ${contStatus.em_andamento}\n`;
                msg += `  • Matriculado: ${contStatus.matriculado}\n`;
                msg += `  • Aluno: ${contStatus.aluno}\n`;
                msg += `  • Perdido: ${contStatus.perdido}\n\n`;

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

                // Os números-chave vão DENTRO do template (variáveis {{1}}..{{7}}), porque um
                // template sempre é entregue — não depende de janela de 24h aberta. Antes, só a frase
                // fixa do template chegava e o texto com os dados de verdade (mensagem livre, abaixo)
                // ficava pendurado esperando uma janela que normalmente está fechada (a gerente
                // não fala com o bot todo dia), então o "dados a seguir" nunca vinha acompanhado de nada.
                await sendTemplate(NUMERO_GERENTE, 'resumo_diario_util', [
                        dataStr,
                        String(totalLeadsNovos),
                        String(viaBot),
                        String(viaVendedor),
                        String(contStatus.em_andamento),
                        String(contStatus.matriculado),
                        String(totalSemStatus)
                ]);

                // Salva no CRM o texto EXATO do template aprovado na Meta, com as variáveis já
                // substituídas — é isso que realmente chega no WhatsApp da gerente. Antes o CRM só
                // mostrava a mensagem livre detalhada (abaixo), mesmo quando ela não era entregue
                // (janela de 24h fechada), fazendo o CRM mostrar algo diferente do que a gerente via.
                const textoTemplateResumo = `📊 *Resumo diário de atendimento*\n` +
                        `🗓️ ${dataStr}\n\n` +
                        `👥 *Leads novos:* ${totalLeadsNovos}\n` +
                        `🤖 Bot: ${viaBot}   🧑 Vendedor: ${viaVendedor}\n\n` +
                        `📋 *Status geral*\n` +
                        `🔵 Em andamento: ${contStatus.em_andamento}\n` +
                        `✅ Matriculados: ${contStatus.matriculado}\n` +
                        `⚠️ Sem status: ${totalSemStatus}\n\n` +
                        `💬 Responda esta mensagem para receber o detalhamento completo dos leads de ontem.`;
                await salvarMensagem(NUMERO_GERENTE, textoTemplateResumo, 'sistema', 'bot', 'resumo_diario');

                await new Promise(r => setTimeout(r, 3000));
                try {
                        await sendWhatsApp(NUMERO_GERENTE, msg);
                        console.log(`📊 Resumo diário (detalhado) enviado para a gerente`);
                        // Só registra a mensagem detalhada no CRM se ela realmente foi entregue —
                        // assim o CRM nunca mostra uma mensagem que a gerente não recebeu de verdade.
                        await salvarMensagem(NUMERO_GERENTE, msg, 'sistema', 'bot', 'resumo_diario_detalhado');
                } catch (errMsg) {
                        // Só falha se a janela de 24h estiver fechada (gerente não respondeu o template) —
                        // mas os números-chave já chegaram garantidos via template, então não é mais um apagão total.
                        console.error(`⚠️ Detalhamento completo não enviado (janela de 24h fechada — a gerente precisa responder o template pra liberar). Números-chave já foram entregues via template.`, errMsg.response?.data || errMsg.message);
                }
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
                // Dia 1 do mês — dispara também o relatório mensal
                if (new Date().getUTCDate() === 1) gerarRelatorioMensal();
                // Depois da primeira execução, repete a cada 24h
                setInterval(() => {
                        enviarResumoDiario();
                        checkLeadsPausados();
                        if (new Date().getUTCDate() === 1) gerarRelatorioMensal();
                }, 24 * 60 * 60 * 1000);
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
                        sendTemplate(NUMERO_GERENTE, 'lembrete_escala', [{ name: 'gerente_nome', value: 'Leybian' }]);
                        salvarMensagem(NUMERO_GERENTE, '[Template: lembrete_escala] Leybian', 'sistema', 'bot', 'lembrete_escala');
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
                        else if (vendedor && vendedor.includes('taynara')) numeroVendedor = process.env.NUMERO_TAYNARA;

                        if (!numeroVendedor) continue;

                        const nome = lead.nome || lead.telefone;
                        await sendTemplate(numeroVendedor, 'lembrete_lead_pausado', [
                                { name: 'lead_nome',     value: nome },
                                { name: 'lead_telefone', value: lead.telefone }
                        ]);
                        await salvarMensagem(
                                numeroVendedor,
                                `⏰ *Lembrete: lead pausado*\n\n👤 ${nome}\n📞 ${lead.telefone}\n\nEsse lead voltou hoje da pausa — bora dar uma olhada?`,
                                'sistema',
                                vendedor,
                                'notificacao_lead'
                        );
                        console.log(`🔔 Lembrete de lead pausado enviado: ${lead.telefone} → ${vendedor}`);
                }
        } catch (err) {
                console.error('❌ Erro ao checar leads pausados:', err.message);
        }
}
// ────────────────────────────────────────────────────────────────────────────

// ── Classifica um lead via IA com base nas últimas mensagens (Groq → Gemini) ──
async function classificarLeadIA(conversaTexto) {
        const systemPrompt = 'Você classifica leads de uma escola de idiomas. Analise as mensagens e responda APENAS com uma palavra: perdido | pausado | em_andamento';
        const texto = conversaTexto || '(sem mensagens)';

        function parseStatus(raw) {
                raw = raw.trim().toLowerCase();
                if (raw.includes('perdido'))                          return 'perdido';
                if (raw.includes('pausado'))                          return 'pausado';
                if (raw.includes('em_andamento') || raw.includes('andamento')) return 'em_andamento';
                return 'perdido'; // fallback conservador
        }

        // Tentativa 1 — Groq chave principal
        for (const key of [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2].filter(Boolean)) {
                try {
                        const resp = await axios.post(
                                'https://api.groq.com/openai/v1/chat/completions',
                                {
                                        model: 'llama-3.3-70b-versatile',
                                        messages: [
                                                { role: 'system', content: systemPrompt },
                                                { role: 'user', content: texto }
                                        ],
                                        max_tokens: 10,
                                        temperature: 0
                                },
                                { headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 8000 }
                        );
                        return parseStatus(resp.data.choices[0].message.content);
                } catch (err) {
                        console.warn('⚠️ Groq classificação falhou, tentando próximo...', err.message);
                }
        }

        // Tentativa 2 — Gemini (fallback)
        try {
                const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
                const result = await model.generateContent(`${systemPrompt}\n\n${texto}`);
                return parseStatus(result.response.text());
        } catch (err) {
                console.error('❌ Gemini classificação também falhou:', err.message);
                return null;
        }
}

// ── Classifica automaticamente leads com mais de 30 dias sem atividade ───────
async function classificarLeadsAntigos() {
        const limite30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

        // Usa ultimo_contato da leads_resumo (data real da última mensagem)
        // em vez de updated_at do status_de_leads (que muda a cada upsert)
        const { data: leadsAntigos } = await supabase
                .from('leads_resumo')
                .select('telefone, vendedor, ultimo_contato')
                .lte('ultimo_contato', limite30d);

        if (!leadsAntigos || leadsAntigos.length === 0) {
                console.log('✅ Nenhum lead com último contato >30d');
                return;
        }

        // Filtra apenas os que ainda estão com status "novo"
        const telefones = leadsAntigos.map(l => l.telefone);
        const { data: statusNovos } = await supabase
                .from('status_de_leads')
                .select('telefone, nome, vendedor')
                .in('telefone', telefones)
                .eq('status', 'novo');

        const leads = statusNovos || [];

        if (leads.length === 0) {
                console.log('✅ Nenhum lead antigo (>30d) com status "novo" para classificar');
                return;
        }

        console.log(`🤖 Classificando ${leads.length} lead(s) com mais de 30 dias...`);
        const contagem = { perdido: 0, pausado: 0, em_andamento: 0, erro: 0 };

        for (const lead of leads) {
                try {
                        // Busca últimas 8 mensagens da conversa
                        const { data: msgs } = await supabase
                                .from('conversas')
                                .select('mensagem, de')
                                .eq('telefone', lead.telefone)
                                .order('created_at', { ascending: false })
                                .limit(8);

                        const texto = (msgs || []).reverse()
                                .map(m => `${m.de === 'bot' ? 'Bot' : m.de === 'vendedor' ? 'Vendedor' : 'Lead'}: ${m.mensagem}`)
                                .join('\n');

                        const status = await classificarLeadIA(texto);
                        if (!status) { contagem.erro++; continue; }

                        await supabase.from('status_de_leads')
                                .update({ status })
                                .eq('telefone', lead.telefone);

                        contagem[status] = (contagem[status] || 0) + 1;
                        console.log(`🤖 ${lead.nome || lead.telefone} → ${status}`);

                        // Pausa de 300ms entre chamadas para não sobrecarregar Groq
                        await new Promise(r => setTimeout(r, 300));
                } catch (err) {
                        console.error(`❌ Erro ao classificar ${lead.telefone}:`, err.message);
                        contagem.erro++;
                }
        }

        console.log(`✅ Classificação concluída:`, contagem);
}

// ── Alerta interativo de leads "novo" com ≤15 dias (pergunta ao vendedor) ────
async function enviarAlertaVendedor(nomeVendedor, numeroVendedor) {
        if (!numeroVendedor) return;

        try {
                // Janela: leads com último contato entre 7 e 30 dias atrás
                // Menos de 7 dias → cedo demais para perguntar
                // Mais de 30 dias → classificarLeadsAntigos já vai tratar como "perdido"
                const limite7d  = new Date(Date.now() -  7 * 24 * 60 * 60 * 1000).toISOString();
                const limite30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

                // Busca leads do vendedor via leads_resumo (fonte correta do campo vendedor)
                const { data: leadsDoVendedor } = await supabase
                        .from('leads_resumo')
                        .select('telefone, vendedor, ultimo_contato')
                        .ilike('vendedor', `%${nomeVendedor}%`)
                        .gte('ultimo_contato', limite30d)   // não mais antigo que 30 dias
                        .lte('ultimo_contato', limite7d)    // sem contato há pelo menos 7 dias
                        .eq('tem_msg_cliente', true)
                        .order('ultimo_contato', { ascending: true })
                        .limit(50);

                if (!leadsDoVendedor || leadsDoVendedor.length === 0) {
                        console.log(`✅ ${nomeVendedor}: nenhum lead recente`);
                        return;
                }

                // Dos leads do vendedor, pega os que têm status "novo" ou sem status
                const telefones = leadsDoVendedor.map(l => l.telefone);
                const { data: statusExistentes } = await supabase
                        .from('status_de_leads')
                        .select('telefone, status, nome')
                        .in('telefone', telefones);

                const statusMap = {};
                (statusExistentes || []).forEach(s => { statusMap[s.telefone] = s; });

                // Inclui leads com status "novo" OU sem entrada em status_de_leads
                const leadsNovos = leadsDoVendedor
                        .filter(l => !statusMap[l.telefone] || statusMap[l.telefone].status === 'novo')
                        .map(l => ({
                                telefone: l.telefone,
                                nome: statusMap[l.telefone]?.nome || 'sem nome'
                        }));

                if (leadsNovos.length === 0) {
                        console.log(`✅ ${nomeVendedor}: nenhum lead "novo" para atualizar`);
                        return;
                }

                // Monta fila: primeiro lead vira "atual", o resto fica na fila
                const todos = leadsNovos.map(l => ({ telefone: l.telefone, nome: l.nome || 'sem nome' }));
                const numNorm = normalizePhone(numeroVendedor);
                pendentesAtualizacao[numNorm] = { atual: todos[0], fila: todos.slice(1), aguardandoMotivo: false, motivoStatus: null };

                // Envia template por lead (abre janela de 24h e já mostra o lead)
                const primeiro = todos[0];
                // Variáveis posicionais: {{1}} vendedor, {{2}} lead nome, {{3}} lead telefone
                await sendTemplate(numeroVendedor, 'atualizar_status_lead', [
                        nomeVendedor,
                        primeiro.nome || 'sem nome',
                        primeiro.telefone
                ]);
                // Texto exato do template aprovado na Meta, com as variáveis já substituídas —
                // assim o CRM mostra a mensagem real que o vendedor recebeu, não um placeholder cru.
                const textoTemplateStatus = `Olá ${nomeVendedor}! 👋\n\n` +
                        `O lead ${primeiro.nome || 'sem nome'} (${primeiro.telefone}) está há mais de 7 dias sem atualização.\n\n` +
                        `Como ficou? Responda com uma das opções abaixo:\n\n` +
                        `✅ matriculado\n🔵 em andamento\n❌ perdido – motivo\n🔵 pausado – motivo\n🎓 aluno\n\n` +
                        `Se perdido ou pausado, inclua o motivo na mesma mensagem.\n` +
                        `Ex: perdido – sem interesse no momento`;
                salvarMensagem(numeroVendedor, textoTemplateStatus, 'sistema', nomeVendedor.toLowerCase(), 'alerta_vendedor');
                console.log(`🔔 Alerta de status enviado para ${nomeVendedor}: ${leadsNovos.length} lead(s)`);
        } catch (err) {
                console.error(`❌ Erro ao enviar alerta para ${nomeVendedor}:`, err.message);
        }
}

// Pausa segura entre envios WhatsApp para evitar ban (200 segundos)
const PAUSA_WHATSAPP_MS = 200 * 1000;

// ── Processa backlog: IA para leads antigos + pergunta ao vendedor para recentes
async function processarBacklogNovos() {
        // 1. Leads > 15 dias → IA classifica e avisa gerente
        await classificarLeadsAntigos();

        // 2. Leads ≤ 15 dias → pergunta ao vendedor um por um
        //    200s de pausa entre cada envio para não acionar o ban do WhatsApp
        for (const [nome, numEnv] of [['Rebecca', process.env.NUMERO_REBECCA], ['Paulo', process.env.NUMERO_PAULO], ['Taynara', process.env.NUMERO_TAYNARA]]) {
                if (!numEnv) continue;
                console.log(`⏳ Aguardando ${PAUSA_WHATSAPP_MS / 1000}s antes de enviar para ${nome}...`);
                await new Promise(r => setTimeout(r, PAUSA_WHATSAPP_MS));
                await enviarAlertaVendedor(nome, numEnv);
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
        if (relatorioEmAndamento) { console.log('⚠️ Relatório já em andamento, ignorando.'); return; }
        relatorioEmAndamento = true;
        console.log('📋 Gerando relatório mensal...');

        try {
                // Mês anterior completo em horário de Brasília
                const agora = new Date();
                const inicioMes = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - 1, 1, 3, 0, 0));
                const fimMes    = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1, 2, 59, 59));
                const nomeMes   = inicioMes.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', month: 'long', year: 'numeric' });

                const inicioISO = inicioMes.toISOString();
                const fimISO    = fimMes.toISOString();

                console.log(`📋 Período: ${inicioISO} até ${fimISO}`);

                // 1. Leads do mês — busca por ultimo_contato também para pegar leads ativos no mês
                const { data: leadsDoMes, error: errLeads } = await supabase
                        .from('leads_resumo')
                        .select('telefone, vendedor, tem_msg_bot, primeiro_contato, ultimo_contato')
                        .gte('ultimo_contato', inicioISO)
                        .lte('ultimo_contato', fimISO)
                        .eq('tem_msg_cliente', true);

                if (errLeads) console.error('❌ Erro query leads:', errLeads.message);
                console.log(`📋 Leads encontrados: ${leadsDoMes?.length || 0}`);

                // 2. Todos os status
                const { data: todosStatus } = await supabase
                        .from('status_de_leads')
                        .select('telefone, status, nome, anotacao');

                // 3. Amostra de conversas: 10 convertidas + 10 perdidas
                const statusMap = {};
                (todosStatus || []).forEach(s => { statusMap[s.telefone] = s; });

                const convertidos = (leadsDoMes || []).filter(l => statusMap[l.telefone]?.status === 'matriculado');
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
                        if (statusMap[l.telefone]?.status === 'matriculado') porVendedor[v].convertidos++;
                });

                const vendedoresTexto = Object.entries(porVendedor)
                        .map(([v, d]) => `${v}: ${d.total} leads, ${d.convertidos} convertidos (${total > 0 ? Math.round(d.convertidos/d.total*100) : 0}%)`)
                        .join('\n');

                // 5. Prompt para a IA
                const prompt = `Você é um analista de CRM para uma escola de idiomas no Rio de Janeiro. Analise os dados de ${nomeMes} e gere um relatório em português, direto e prático.

MÉTRICAS DO MÊS:
- Total de leads: ${total}
- Via bot: ${viaBot} | Via vendedor: ${total - viaBot}
- Taxa de conversão: ${total > 0 ? Math.round(contStatus.matriculado / total * 100) : 0}%

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

                // 6. Chamada OpenRouter com fallback entre modelos
                const modelos = [
                        'meta-llama/llama-3.3-70b-instruct:free',
                        'nvidia/nemotron-3-super-120b-a12b:free',
                        'openai/gpt-oss-120b:free',
                        'qwen/qwen3-30b-a3b:free',
                        'google/gemma-4-31b-it:free'
                ];

                let analise = null;
                for (const modelo of modelos) {
                        try {
                                console.log(`📋 Tentando modelo: ${modelo}`);
                                const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
                                        model: modelo,
                                        messages: [{ role: 'user', content: prompt }],
                                        messages: [{ role: 'user', content: prompt }],
                                        max_tokens: 1500
                                }, {
                                        headers: {
                                                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                                                'Content-Type': 'application/json'
                                        },
                                        timeout: 60000
                                });
                                analise = response.data?.choices?.[0]?.message?.content;
                                if (analise) { console.log(`📋 Modelo usado: ${modelo}`); break; }
                        } catch (e) {
                                console.warn(`⚠️ Modelo ${modelo} falhou: ${e.response?.status || e.message}. Tentando próximo...`);
                        }
                }
                if (!analise) analise = 'Não foi possível gerar análise automática este mês (todos os modelos falharam).';

                // 7. Monta e envia o relatório em partes (WhatsApp tem limite de caracteres)
                const cabecalho = `📋 *RELATÓRIO MENSAL — ${nomeMes.toUpperCase()}*\n\n📊 Leads: ${total} | Matriculados: ${contStatus.matriculado} | Taxa: ${total > 0 ? Math.round(contStatus.matriculado / total * 100) : 0}%\n🤖 Via bot: ${viaBot} | 🧑 Via vendedor: ${total - viaBot}\n\n`;

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

                await sendTemplate(NUMERO_GERENTE, 'relatorio_mensal');
                await salvarMensagem(NUMERO_GERENTE, '[Template: relatorio_mensal] Seu relatório mensal está pronto — os detalhes chegam a seguir.', 'sistema', 'bot', 'relatorio_mensal');
                await new Promise(r => setTimeout(r, 1500));

                // Manda bloco por bloco e só registra no CRM o que realmente foi entregue —
                // se a janela de 24h fechar no meio (gerente não responde há dias), os blocos
                // restantes falham e não entram no CRM como se tivessem chegado.
                const blocosEntregues = [];
                try {
                        for (const bloco of blocos) {
                                await sendWhatsApp(NUMERO_GERENTE, bloco);
                                blocosEntregues.push(bloco);
                                await new Promise(r => setTimeout(r, 1500)); // pausa entre mensagens
                        }
                } catch (errBloco) {
                        console.error(`⚠️ Relatório mensal: só ${blocosEntregues.length}/${blocos.length} bloco(s) entregues (janela de 24h fechada?).`, errBloco.response?.data || errBloco.message);
                }
                if (blocosEntregues.length > 0) {
                        await salvarMensagem(NUMERO_GERENTE, blocosEntregues.join('\n\n'), 'sistema', 'bot', 'relatorio_mensal_detalhado');
                }

                console.log(`📋 Relatório mensal enviado (${blocosEntregues.length}/${blocos.length} bloco(s) entregues)`);
        } catch (err) {
                console.error('❌ Erro ao gerar relatório mensal:', err.message);
        } finally {
                relatorioEmAndamento = false;
        }
}

// ────────────────────────────────────────────────────────────────────────────
// Rota para disparar reengajamento manualmente para um número
app.get('/reengajar/:telefone', async (req, res) => {
        if (!checkAdminToken(req, res)) return;
        const tel = req.params.telefone.replace(/\D/g, '');
        if (!tel) return res.status(400).json({ ok: false, msg: 'Telefone inválido' });
        try {
                const dados = dadosLead[tel] || {};
                const nomeLead = dados.nome ? `, ${dados.nome}` : '';
                const msgReeng = `Oi${nomeLead}! 👋 Ainda posso te ajudar com informações sobre nossos cursos do CNA Recreio? 😊`;
                await sendWhatsApp(tel, msgReeng);
                await salvarMensagem(tel, msgReeng, 'bot', null, 'reengajamento');
                reengajamentoEnviado[tel] = true;
                ultimaAtividade[tel] = Date.now();
                await salvarEstadoBot(tel);
                console.log(`📲 Reengajamento manual disparado para ${tel}`);
                res.json({ ok: true, msg: `Reengajamento enviado para ${tel}` });
        } catch (e) {
                res.status(500).json({ ok: false, msg: e.message });
        }
});

// Rota de teste manual: dispara o alerta de coordenação agora, sem precisar esperar
// um cliente cair no fluxo de "aluno". Ajuda a diagnosticar se o template/número tá ok.
app.get('/testar-alerta-coordenacao', async (req, res) => {
        if (!checkAdminToken(req, res)) return;
        if (!NUMERO_COORDENACAO) return res.status(400).json({ ok: false, msg: 'NUMERO_COORDENACAO não configurado no Railway' });
        try {
                await notificarCoordenacao('5521999990000');
                res.json({ ok: true, msg: `Template alerta_coordenacao disparado pra ${NUMERO_COORDENACAO}. Confira o celular e os logs.` });
        } catch (e) {
                res.status(500).json({ ok: false, msg: e.response?.data?.error?.message || e.message, detalhe: e.response?.data || null });
        }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
        console.log(`🚀 Escola Bot rodando na porta ${PORT}`);
        // Restaura estado persistido (inatividade, reengajamento, confirmações)
        carregarEstadoBot();
        // Restaura a fila do rodízio (quem recebeu lead por último), pra não resetar a cada deploy
        carregarRodizio();
        // Agenda resumo diário às 8h BRT
        agendarResumoDiario();
        // Alerta de leads sem status: Rebecca às 12h BRT (15h UTC), Paulo às 17h BRT (20h UTC)
        agendarAlertaVendedor('Rebecca',  process.env.NUMERO_REBECCA,  15);
        agendarAlertaVendedor('Paulo',    process.env.NUMERO_PAULO,    20);
        agendarAlertaVendedor('Taynara',  process.env.NUMERO_TAYNARA,  17);
        agendarLembreteEscala();
});
