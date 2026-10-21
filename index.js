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
// Número do Lucas — espelha tudo que a gerente recebe (resumo diário, relatório
// mensal, lembrete de escala). Configurar em NUMERO_LUCAS nas variáveis do Railway.
const NUMERO_LUCAS = process.env.NUMERO_LUCAS;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Números internos de gestão (gerente, Lucas) — nunca são lead/cliente de verdade.
// Usado tanto na guarda do /webhook (não entrar no fluxo de IA) quanto em
// checkInatividade (não entrar na fila de reengajamento — sem isso, uma resposta
// deles ao resumo diário ficava marcada como de=cliente no banco e o fallback por
// DB do reengajamento, que não conhecia essa guarda, tentava reengajar a gerente/
// Lucas como se fossem lead, batendo no erro 131047 quando a janela de 24h fechava).
// NÃO usa normalizePhone() aqui: ela prepende "55" em qualquer número de 10-11
// dígitos assumindo que é um BR local sem DDI — mas NUMERO_GERENTE é um número
// espanhol (+34 618 097 942), que também tem 11 dígitos. normalizePhone() estava
// corrompendo "34618097942" pra "5534618097942", que nunca batia com o `telefone`
// cru vindo do webhook (String(message.from).replace(/\D/g,'')) — então toda
// resposta da gerente caía no fluxo normal de lead novo em vez de ser reconhecida
// como mensagem interna. Aqui só limpamos os dígitos, igual ao webhook faz.
const NUMEROS_INTERNOS_GESTAO = new Set(
        [NUMERO_GERENTE, NUMERO_LUCAS]
                .filter(Boolean)
                .map(n => String(n).replace(/\D/g, ''))
);
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

// Relatórios (resumo diário / mensal) que já mandaram o template mas cujo conteúdo
// detalhado (texto livre) está esperando o destinatário responder pra abrir a janela
// de 24h. Chave = telefone. Valor = array com o(s) bloco(s) mais recentes a enviar
// assim que ele mandar qualquer mensagem. Evita "chutar" o envio 1.5-3s depois
// torcendo pra janela já estar aberta — que falhava silenciosamente pra quem não
// tinha conversado com o bot recentemente (ex: um número novo, como o do Lucas na
// primeira vez). Uma pendência nova SUBSTITUI a anterior desse telefone — se ele
// ficar dias sem responder o resumo diário, ao responder recebe só o mais recente,
// não uma enxurrada de dias antigos e desatualizados.
const relatoriosPendentes = {};

// Pesquisa de "lead perdido": quando um telefone acabou de receber (ou está prestes
// a receber) a pergunta "o que achou do atendimento / por que não fechou", guardamos
// aqui pra reconhecer a PRÓXIMA mensagem dele como resposta da pesquisa em vez de
// deixar cair no fluxo normal de qualificação da IA. Chave = telefone. Valor =
// { vendedorSalvar } — sempre enviada pelo número principal do bot.
const aguardandoFeedbackPerdido = {};

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

// Mapeamento LID → telefone real, persistido pra sobreviver a redeploy do Railway.
// Antes só vivia em memória (Map lidToPhone) e resetava a cada restart, forçando
// o LID a ser "reaprendido" do zero — o que deixava uma janela maior pra mensagens
// de vendedor chegarem com LID ainda não resolvido e virarem lead "fantasma".
async function carregarLidMap() {
        try {
                const { data, error } = await supabase.from('lid_telefone_map').select('lid, telefone');
                if (error) throw error;
                (data || []).forEach(r => lidToPhone.set(r.lid, r.telefone));
                console.log(`🔗 ${(data || []).length} mapeamento(s) de LID restaurado(s) do Supabase`);
        } catch (e) {
                console.error('❌ Erro ao carregar mapa de LID persistido:', e.message);
        }
}

function salvarLidMap(lid, telefone) {
        supabase.from('lid_telefone_map')
                .upsert({ lid, telefone }, { onConflict: 'lid' })
                .then(({ error }) => { if (error) console.error('❌ Erro ao salvar mapa de LID:', error.message); });
}

// Resgata mensagens de vendedor que chegaram com um LID ainda não resolvido e
// ficaram em espera (ver /webhook-vendedor) — agora que o telefone real é
// conhecido, salva todas na ordem certa sob o telefone de verdade e limpa a fila.
async function flushMensagensPendentesLid(lid, telefone) {
        try {
                const { data: pendentes, error } = await supabase
                        .from('mensagens_lid_pendentes')
                        .select('id, mensagem, de, vendedor, created_at')
                        .eq('lid', lid)
                        .order('created_at', { ascending: true });
                if (error) throw error;
                if (!pendentes || pendentes.length === 0) return;

                for (const p of pendentes) {
                        await salvarMensagem(telefone, p.mensagem, p.de, p.vendedor, 'conversa_vendedor');
                }
                await supabase.from('mensagens_lid_pendentes').delete().eq('lid', lid);
                console.log(`✅ ${pendentes.length} mensagem(ns) pendente(s) do LID ${lid} liberada(s) pro telefone ${telefone}`);
        } catch (e) {
                console.error(`❌ Erro ao liberar mensagens pendentes do LID ${lid}:`, e.message);
        }
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
        modelo: 'deepseek', // 'deepseek' | 'groq' | 'groq_2' | 'gemini'
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

// "excluir" é opcional — usado na redistribuição de leads sem contato do vendedor,
// pra garantir que o próximo escolhido NUNCA seja o mesmo que já ignorou o lead.
async function getVendedor(excluir = null) {
        const escala = await getEscala();
        const agora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
        const hora = agora.getHours() + agora.getMinutes() / 60;
        const dia = agora.getDay();
        const excluirNorm = excluir ? excluir.toLowerCase() : null;
        const naoExcluido = (nome) => !excluirNorm || String(nome).toLowerCase() !== excluirNorm;
        const TODOS_VENDEDORES = ['Wellington', 'Rebecca', 'Taynara'].filter(naoExcluido);

        if (TODOS_VENDEDORES.length === 0) return null; // só existe o excluído — não tem pra quem redistribuir

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
                        if (!naoExcluido(e.vendedor)) return false;
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
                if (!naoExcluido(e.vendedor)) return false;
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





const SYSTEM_PROMPT = `Você é a assistente virtual do CNA Recreio, escola de idiomas no Recreio dos Bandeirantes (Rio de Janeiro), atendendo pelo WhatsApp. Fale em português; se a pessoa escrever em inglês, responda em inglês.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUEM VOCÊ É
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Você é a recepção da escola, não a vendedora. Seu trabalho:
1. entender o que a pessoa quer;
2. tirar dúvidas gerais usando as INFORMAÇÕES VERIFICADAS;
3. se ela quiser estudar aqui, anotar os dados básicos pro comercial entrar em contato;
4. se ela já for aluna (ou responsável por aluno), passar pra coordenação.
Preço, mensalidade, taxa de matrícula, material, desconto, promoção, forma de pagamento e garantia de vaga são assuntos do comercial. Você nunca informa, estima nem insinua valores, e nunca dá a entender que vai passar o valor depois de pegar algum dado (ex: "me diz sua idade que eu te passo o valor" é proibido). Explique que os valores dependem da turma e do horário e que o comercial manda tudo certinho, e continue ajudando no resto.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ANTES DE RESPONDER, PENSE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Antes de escrever, responda pra você mesma (sem mostrar isso pro cliente):
1. Quem é essa pessoa? (alguém interessado em estudar, aluno ou responsável por aluno, ou outro assunto como parceria e currículo)
2. O que ela quer de verdade com esta mensagem — inclusive se é uma resposta a algo que a escola mandou antes?
3. Que informação eu já tenho (no histórico, no CRM, nas INFORMAÇÕES VERIFICADAS) e o que ainda falta?
4. Qual é a próxima coisa útil a fazer: responder, esclarecer, perguntar uma coisa só, encaminhar pra coordenação, ou só agradecer?
Se algo na mensagem não fizer sentido com o resto da conversa, considere que pode ter havido um mal-entendido e esclareça.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMO CONVERSAR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Fale como uma pessoa atenciosa da recepção, não como formulário nem menu. Frases naturais e variadas, sem fórmulas prontas ("Boa pergunta!", "Entendido!", "Você já é aluno ou tem interesse em se matricular?").
- Não elogie nomes nem idades ("que nome lindo!", "ótima idade pra começar"). Não repita a mesma pergunta ou o mesmo fechamento de uma mensagem pra outra.
- Se a pessoa só tirou uma dúvida (endereço, duração, aula experimental...), responda e pode emendar uma pergunta leve pra seguir; mas se ela já ignorou essa pergunta antes, não insista — só responda.
- Curto: de 1 a 3 linhas. No máximo uma pergunta por mensagem, e só quando ela fizer a conversa andar.
- Espelhe o tom da pessoa (formal com quem é formal, mais leve com quem é leve). Emoji só de vez em quando, nunca em duas mensagens seguidas.
- Formatação de WhatsApp: texto simples. Nada de markdown (**negrito**, # títulos, listas compridas). Pra destacar, no máximo uma palavra entre asteriscos simples, *assim*.
- Não presuma nada sobre a pessoa (se tem filhos, gênero, idade, se é aluna). Quando precisar saber, pergunte.
- Responda primeiro o que foi perguntado, antes de puxar outro assunto.
- Se a resposta não está nas INFORMAÇÕES VERIFICADAS, diga com naturalidade que o comercial confirma. Não invente.
- Se não entendeu o que a pessoa quis dizer, pergunte de forma simples em vez de chutar.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LENDO A CONVERSA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Leia o histórico inteiro antes de responder. Mensagens que começam com "[Mensagem automática enviada pela escola]" ou "[Mensagem enviada pelo(a) vendedor(a) ...]" foram mandadas pela escola, não pela pessoa — ela pode estar respondendo a elas.
- Use o CONTEXTO INTERNO DO CRM pra entender quem é a pessoa, mas nunca cite o CRM, o status ou as anotações.
- "?", "como assim?", "quem é?", "que matrícula?": a pessoa não entendeu a última mensagem da escola. Explique com suas palavras o que aquela mensagem queria dizer e por que ela recebeu. Se a escola se enganou (por exemplo, ela nunca pediu informação, só recebeu uma divulgação do comercial), admita e peça desculpas, sem drama. Se o "?" vier logo depois de uma pergunta SUA, refaça essa mesma pergunta de um jeito mais simples e diga em poucas palavras por que está perguntando — não mude de assunto nem despeje informação nova.
- A pesquisa "Notamos que você não seguiu com a matrícula..." é enviada automaticamente a quem conversou com a escola sobre matrícula e não fechou, pra saber o que dá pra melhorar.
- "Ok", "obrigada", "👍": resposta curta e simpática, sem pergunta nova.
- Reclamação ou contestação: pare o que estava fazendo, reconheça o que ela disse e ajude.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUEM JÁ É ALUNO(A)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Sinais: mensalidade, boleto, pagamento, falta, reposição, aula, professor(a), prova, certificado, grupo da turma, trocar horário, "minha turma", "a turma do meu filho". Quando o sinal for claro, não pergunte se é aluno: diga que vai passar o pedido pra coordenação, que resolve isso. Só pergunte se é aluno quando for de fato ambíguo. Na dúvida, trate como alguém interessado em estudar.
A palavra "coordenação" só pode aparecer quando você estiver encaminhando a pessoa pra lá — o sistema avisa a coordenação toda vez que ela aparece na sua resposta. (Exceção: currículo, ver ASSUNTOS QUE NÃO SÃO MATRÍCULA NEM ALUNO.)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUEM QUER ESTUDAR AQUI
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Responda o que ela perguntou e, aos poucos e sem interrogatório, descubra:
- pra quem é o curso (ela mesma ou outra pessoa, como filho ou filha);
- o nome de quem vai estudar (e o nome de quem está falando, se for o responsável);
- a idade de quem vai estudar (pra indicar a turma pelas INFORMAÇÕES VERIFICADAS);
- o horário preferido (manhã, tarde, noite ou sábado).
Não pergunte de novo o que já foi dito. Nunca invente turma ou curso.

Horário preferido = o PERÍODO. Quando a pessoa disser o período, isso basta: vá pra confirmação.
- Não pergunte dia da semana nem horário exato, e não peça pra escolher entre horários.
- Nunca escolha ou "sugira" um horário pela pessoa, e nunca diga que um horário está disponível ou tem vaga pra uma turma — quem confirma dia, horário e vaga é o comercial.
- Se ela perguntar quais são os horários, diga os do período que ela quer (pelas INFORMAÇÕES VERIFICADAS, Inglês e Espanhol). Se ela mesma disser dia ou hora, anote do jeito que ela falou.
- "Tanto faz", "qualquer um", "flexível": anote "Flexível".
Mais de uma pessoa (ex: mãe e filho): faça UMA confirmação só, com as duas pessoas nas mesmas linhas. Ex: "👤 Nome: Ana e Davi (responsável: Ana)", "📚 Turma indicada: FLY (Ana) e FUN (Davi)", "⏰ Horário preferido: noite (Ana) e tarde (Davi)".
São 3 cursos: Inglês, Espanhol e Programação e Robótica. Se não estiver claro qual curso a pessoa quer, pergunte.
As turmas (GARDEN, FUN, KIDS, TEEN UP, FLY, QUEST...) e os horários das INFORMAÇÕES VERIFICADAS valem só para Inglês e Espanhol. Se o interesse for Robótica: não indique turma nem ofereça esses horários. Pergunte a idade e o período preferido normalmente; a turma indicada é "Sem turma" e os detalhes de horário o comercial passa.

Com tudo em mãos, mande a confirmação EXATAMENTE neste formato (o sistema lê essas linhas):

Perfeito! Antes de encaminhar, deixa eu confirmar seus dados:

👤 Nome: [nome de quem vai estudar; se quem conversa é o responsável, acrescente "(responsável: [nome dele])"]
📚 Turma indicada: [turma; pra Espanhol acrescente " — Espanhol"; pra Robótica use "Sem turma — Robótica"]
⏰ Horário preferido: [horário]

Está tudo certo? (responda "sim" para confirmar ou me corrija o que estiver errado)

Se a pessoa corrigir algo, mande a confirmação de novo já corrigida. Só depois do "sim" (ou "isso", "correto", "tá certo"), envie EXATAMENTE:

Ótimo! Seus dados foram registrados. Em breve o comercial entrará em contato para passar os valores e próximos passos. 😊

Até logo, [nome de quem está conversando]! Qualquer dúvida, é só chamar.

Depois disso, não peça os dados de novo.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ASSUNTOS QUE NÃO SÃO MATRÍCULA NEM ALUNO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Parceria, divulgação, influenciador(a), fornecedor, venda de serviço, número errado: não ofereça curso, não colete dados de matrícula e não invente setor nem processo (não existe "setor de RH" neste WhatsApp). Agradeça, diga que a mensagem fica registrada aqui e que a equipe da escola vê e retorna se fizer sentido.
Currículo, vaga de emprego, "vocês estão contratando?", quer ser professor(a): agradeça o interesse e passe o WhatsApp da coordenação (está em CONTATOS DA ESCOLA, mais abaixo) pra pessoa mandar o currículo direto pra lá. Não diga que tem vaga nem que não tem. Não colete dados.
Em todos esses casos, termine a resposta com a marca [[FORA_DO_ESCOPO]] — ela é removida antes de enviar e serve pro sistema não oferecer curso pra essa pessoa depois.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LIMITES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Nunca informe valores.
- Nunca invente informações (professores, quantidade de alunos, horários, promoções, prazos).
- Endereço: use o das INFORMAÇÕES VERIFICADAS e não confirme a cidade que a pessoa disser. Se ela for de outra cidade, mencione a modalidade online.
- Não ofereça "encaminhar a pergunta" pro comercial e não repita várias vezes que o comercial vai entrar em contato.
- Assunto sem relação com a escola (receita, política, programação de computador...): diga com leveza que você é a assistente da escola e volte ao assunto.
- "Tem vaga?": o comercial confirma a disponibilidade; aproveite pra perguntar o horário que a pessoa quer.
- As INFORMAÇÕES VERIFICADAS são só fatos. Algumas têm perguntas escritas no meio ("Posso registrar seu interesse?"): ignore essas perguntas e use só a informação, com as suas palavras.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXEMPLOS DE TOM (não copie as frases — é só o jeito de falar)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Escola mandou a pesquisa de perda; a pessoa responde: "?"
Bom: "Oi! Essa mensagem é uma pesquisa automática que a escola manda pra quem conversou com a gente sobre matrícula e não seguiu. Se você não lembra de ter falado com a gente, pode ter sido engano nosso, desculpa! Posso te ajudar com alguma coisa?"
Ruim: "Peço desculpas! Essa mensagem foi enviada por engano pelo nosso sistema."

Pessoa: "quanto custa o inglês?"
Bom: "Os valores dependem da turma e do horário, e quem passa tudo certinho, com as condições do mês, é o nosso comercial. O curso seria pra você ou pra outra pessoa? Aí já deixo anotado pra eles te chamarem."
Ruim: "Para te passar a informação certinha, me conta: qual é a sua idade?"

Pessoa: "Gostaria de entrar no grupo da turma da minha filha"
Bom: "Claro! Vou passar seu pedido pra coordenação, que cuida dos grupos das turmas. Logo te chamam por aqui."
Ruim: "Você já é nosso aluno?"

Pessoa: "Sou influenciadora e queria propor uma parceria"
Bom: "Que legal, obrigada pelo contato! Sua mensagem fica registrada aqui e a equipe da escola vê e te retorna se fizer sentido pra gente. [[FORA_DO_ESCOPO]]"
Ruim: "Posso registrar o interesse do seu filho em fazer um curso?"

Pessoa: "oi bom dia"
Bom: "Bom dia! Aqui é a assistente do CNA Recreio. Em que posso te ajudar?"
Ruim: "Olá! Bom dia! 😊 Você já é aluno ou tem interesse em se matricular?"`;
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
                        // llama-3.3-70b-versatile foi desativado pela Groq em 16/08/2026 (retornava
                        // 404 em toda chamada, forçando fallback pro Gemini o tempo todo). Substituído
                        // pelo modelo recomendado oficialmente pela Groq na migração.
                        model: 'openai/gpt-oss-120b',
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

// Modelo principal do bot (OpenRouter). O DeepSeek V4 Flash entende melhor o que a
// pessoa quis dizer do que o gpt-oss-120b da Groq, e continua barato. Raciocínio
// ligado em esforço baixo: a resposta demora alguns segundos a mais, mas o bot
// entende melhor a mensagem (o webhook já respondeu 200 pra Meta antes disso).
const MODELO_BOT_PRINCIPAL = 'deepseek/deepseek-v4-flash';

async function askOpenRouterBot(telefone, systemPromptFinal) {
        const resp = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
                model: MODELO_BOT_PRINCIPAL,
                messages: [
                        { role: 'system', content: systemPromptFinal },
                        ...conversas[telefone]
                ],
                // Raciocínio LIGADO (esforço baixo): o modelo "pensa" antes de responder,
                // o que melhora entender o que a pessoa quis dizer. O raciocínio não vai pro
                // cliente (exclude) e conta no max_tokens, por isso o limite maior.
                max_tokens: 3000,
                temperature: 0.5,
                reasoning: { effort: 'low', exclude: true }
        }, {
                headers: {
                        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                        'Content-Type': 'application/json',
                        'HTTP-Referer': 'https://cursobot-production.up.railway.app',
                        'X-Title': 'Studio Rastro Bot'
                },
                timeout: 45000
        });
        const conteudo = (resp.data?.choices?.[0]?.message?.content || '').trim();
        // Resposta vazia conta como falha, pra cair no próximo modelo em vez de mandar nada.
        if (!conteudo) throw new Error('resposta vazia do modelo');
        return conteudo;
}

// Monta o histórico que a IA vê direto do banco (fonte da verdade), a cada mensagem.
// Antes o histórico vivia só na RAM e tinha dois furos que deixavam o bot "burro":
//  1. Mensagens enviadas fora do fluxo da IA (pesquisa de lead perdido, templates,
//     mensagens dos vendedores) nunca entravam na RAM — a IA não sabia que a escola
//     tinha acabado de perguntar "por que você não seguiu com a matrícula?", então
//     não entendia respostas como "Como assim? Que matrícula?".
//  2. Depois de um restart, o histórico era recarregado do banco tratando TUDO que
//     não era 'bot' como fala do cliente — inclusive a pesquisa e as mensagens dos
//     vendedores. A IA achava que o próprio cliente tinha escrito aquilo.
// Agora cada mensagem entra com o papel certo, e o que foi enviado pela escola mas
// não pela IA vem marcado entre colchetes pra ela saber quem falou.
async function carregarHistoricoParaIA(telefone, limite = 30) {
        const { data, error } = await supabase
                .from('conversas')
                .select('mensagem, de, vendedor, tipo')
                .eq('telefone', telefone)
                .order('created_at', { ascending: false })
                .limit(limite);
        if (error) throw error;
        return (data || []).reverse()
                .filter(m => m.mensagem && String(m.mensagem).trim())
                // Marcador interno ("Lead encaminhado para X") — não foi enviado ao cliente
                .filter(m => m.tipo !== 'lead_encaminhado')
                .map(m => {
                        if (m.de === 'cliente') return { role: 'user', content: m.mensagem };
                        if (m.de === 'bot') return { role: 'assistant', content: m.mensagem };
                        if (m.de === 'vendedor') return { role: 'assistant', content: `[Mensagem enviada pelo(a) vendedor(a) ${m.vendedor || ''}] ${m.mensagem}` };
                        return { role: 'assistant', content: `[Mensagem automática enviada pela escola] ${m.mensagem}` };
                });
}

// Contexto do CRM pra IA: status, anotação e interesse que o vendedor registrou.
// Sem isso o bot tratava como lead novo gente que o CRM já sabe que é aluno ou
// matriculado, e fazia o roteiro de qualificação inteiro de novo.
async function contextoCRMParaIA(telefone) {
        try {
                const { data } = await supabase
                        .from('status_de_leads')
                        .select('status, nome, interesse, anotacao, vendedor')
                        .eq('telefone', telefone)
                        .maybeSingle();
                const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
                const linhas = [`Data de hoje: ${hoje}`];
                if (data) {
                        if (data.status) linhas.push(`Status no CRM: ${data.status}`);
                        if (data.nome) linhas.push(`Nome registrado: ${data.nome}`);
                        if (data.interesse) linhas.push(`Interesse registrado: ${data.interesse}`);
                        if (data.vendedor) linhas.push(`Vendedor(a) responsável: ${data.vendedor}`);
                        if (data.anotacao) linhas.push(`Anotação do vendedor: ${String(data.anotacao).slice(0, 300)}`);
                } else {
                        linhas.push('Sem registro no CRM (contato novo).');
                }
                return `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXTO INTERNO DO CRM — USE PARA ENTENDER A PESSOA, NUNCA CITE ISSO PRO CLIENTE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${linhas.join('\n')}
Se tiver "Vendedor(a) responsável" e a pessoa estiver no meio do cadastro, siga normalmente: o comercial já sabe dela, e se ela completar os dados a confirmação vai pro mesmo vendedor.
Se o status for "matriculado" ou "aluno", ou a anotação indicar isso, a pessoa NÃO é um lead novo: não faça o fluxo de qualificação, ajude no que ela pedir ou encaminhe pra coordenação. Se o status for "perdido" e ela voltou a falar, trate com naturalidade como alguém retomando o contato.`;
        } catch (e) {
                console.warn('⚠️ Não deu pra buscar contexto do CRM pra IA:', e.message);
                return '';
        }
}

// Pós-processamento de toda resposta da IA (vale pra DeepSeek, Groq e Gemini):
//  - remove a marca [[FORA_DO_ESCOPO]] (parceria, currículo, fornecedor...) e guarda
//    a informação pra conversa não receber reengajamento "posso ajudar com os cursos?";
//  - troca **negrito** de markdown (que aparece com os asteriscos no WhatsApp) por *negrito*.
const MARCA_FORA_ESCOPO = /\[\[\s*FORA_DO_ESCOPO\s*\]\]/gi;

// "5521987654321" -> "(21) 98765-4321". Devolve '' se não der pra formatar.
function formatarTelefoneBR(numero) {
        let d = String(numero || '').replace(/\D/g, '');
        if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
        if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
        if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
        return '';
}

// Tipo da conversa a partir da mensagem + resposta. Se a IA marcou fora do escopo
// (currículo, parceria...), isso vence: a resposta de currículo cita a coordenação
// (pra passar o número), e sem essa regra o detectarTipo marcaria como aluno e
// dispararia o alerta pra coordenação à toa.
function tipoDaConversa(telefone, mensagem, reply) {
        if (dadosLead[telefone]?.ultimaForaDeEscopo) return 'outro_assunto';
        return detectarTipo(mensagem, reply);
}
async function askAI(telefone, mensagem) {
        let reply = await askAIModelos(telefone, mensagem);
        const fora = /\[\[\s*FORA_DO_ESCOPO\s*\]\]/i.test(reply);
        reply = reply.replace(MARCA_FORA_ESCOPO, '').replace(/\*\*(.+?)\*\*/g, '*$1*').trim();
        if (!dadosLead[telefone]) {
                dadosLead[telefone] = { nome: null, turma: null, horario: null, confirmado: false, notificado: false, consentimentoDado: true };
        }
        dadosLead[telefone].ultimaForaDeEscopo = fora;
        const hist = conversas[telefone];
        if (hist && hist.length && hist[hist.length - 1].role === 'assistant') hist[hist.length - 1].content = reply;
        return reply;
}

async function askAIModelos(telefone, mensagem) {
        // O simulador do CRM não grava nada no banco — o histórico dele vive só na memória.
        // Recarregar do banco apagaria a conversa simulada a cada mensagem.
        if (telefone === 'simulador_crm') {
                if (!conversas[telefone]) conversas[telefone] = [];
        } else {
                try {
                        conversas[telefone] = await carregarHistoricoParaIA(telefone);
                } catch (e) {
                        console.warn(`⚠️ Falha ao carregar histórico do banco pra ${telefone}, usando o da memória:`, e.message);
                        if (!conversas[telefone]) conversas[telefone] = [];
                }
        }
        conversas[telefone].push({ role: 'user', content: mensagem });
        if (conversas[telefone].length > 30) conversas[telefone] = conversas[telefone].slice(-30);

        // Base de conhecimento INTEIRA em toda mensagem. Antes era filtrada por
        // palavra-chave (buscarRAG): se o cliente usava uma palavra que não estava nas
        // palavras-chave do item ("vocês abrem de manhã?" sem "manhã" cadastrado), a IA
        // não recebia a informação e respondia sem saber. A base é pequena (~24 itens,
        // ~3 mil caracteres), então mandar tudo custa praticamente nada e a IA decide
        // sozinha o que é relevante — como uma atendente com a folha de informações na mão.
        const baseCompleta = await getBaseConhecimento();
        let systemPromptFinal = SYSTEM_PROMPT;
        if (baseCompleta.length > 0) {
                const porCategoria = {};
                baseCompleta.forEach(item => {
                        if (!item.resposta) return;
                        const cat = (item.categoria || 'geral').replace(/_/g, ' ').trim() || 'geral';
                        (porCategoria[cat] = porCategoria[cat] || []).push(item.resposta.trim());
                });
                const textoBase = Object.entries(porCategoria)
                        .map(([cat, respostas]) => `[${cat}]\n${respostas.join('\n')}`)
                        .join('\n\n');
                systemPromptFinal = `${SYSTEM_PROMPT}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INFORMAÇÕES VERIFICADAS DA ESCOLA — USE APENAS ESTAS, NÃO INVENTE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${textoBase}

Use só o que for relevante pra pergunta do cliente — não despeje tudo. Quando listar algo
(ex: cursos), cite todos os itens, sem cortar. Copie nomes próprios e nomes de cursos
exatamente como estão escritos acima. Se a resposta não estiver aqui, não invente.`;
        }

        systemPromptFinal += await contextoCRMParaIA(telefone);

        // Número da coordenação, usado só pra quem quer mandar currículo.
        const numCoordFormatado = formatarTelefoneBR(NUMERO_COORDENACAO);
        if (numCoordFormatado) {
                systemPromptFinal += `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTATOS DA ESCOLA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WhatsApp da coordenação (só pra quem quer mandar currículo / trabalhar na escola): ${numCoordFormatado}`;
        }

        // Após injetar o RAG, injetar também os dados já coletados
        const dados = dadosLead[telefone];
        if (dados && dados.jaAluno) {
                // Cliente já foi classificado como ALUNO nesta conversa (uma mensagem anterior
                // mencionou aula/mensalidade/professor/etc. e o bot já avisou que ia encaminhar
                // pra coordenação). Sem essa memória, um "oi" isolado logo depois fazia a IA
                // voltar pro fluxo de lead do zero, perguntando "você já é aluno?" de novo.
                systemPromptFinal += `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STATUS DO ATENDIMENTO — JÁ IDENTIFICADO COMO ALUNO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Esta pessoa já foi identificada como aluna (ou responsável) nesta conversa e o pedido dela já foi passado adiante.
Não volte a perguntar se ela é aluna nem comece o fluxo de matrícula.
Se ela mandar mais alguma coisa, responda com naturalidade: tire a dúvida pontual se der, ou diga que o pedido já foi passado e que logo retornam.`;
        } else if (dados && dados.confirmado) {
                // Lead já encerrado — modo pós-confirmação
                systemPromptFinal += `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STATUS DO ATENDIMENTO — LEAD JÁ REGISTRADO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Este cliente JÁ TEVE SEUS DADOS REGISTRADOS com sucesso:
- Nome: ${dados.nome || '—'}
- Turma indicada: ${dados.turma || '—'}
- Horário preferido: ${dados.horario || '—'}

Como seguir:
- Não peça nome, idade, horário ou turma de novo — já está tudo anotado.
- O comercial já foi avisado e vai entrar em contato.
- Dúvidas sobre os cursos: responda normalmente com as informações verificadas.
- Se perguntarem do cadastro, diga com naturalidade que está tudo anotado e o comercial chama em breve.
- Não recomece o fluxo de matrícula.`;
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

        // Tentativa 1 — DeepSeek V4 Flash via OpenRouter (modelo principal). Entende
        // melhor nuance e contexto que o gpt-oss-120b da Groq, que seguia o roteiro ao
        // pé da letra. Groq e Gemini ficam como reserva.
        if (process.env.OPENROUTER_API_KEY) {
                try {
                        const reply = await askOpenRouterBot(telefone, systemPromptFinal);
                        conversas[telefone].push({ role: 'assistant', content: reply });
                        botStatus.modelo = 'deepseek';
                        return reply;
                } catch (err) {
                        console.warn(`⚠️ DeepSeek (OpenRouter) falhou, caindo pra Groq:`, err.response?.status || err.message, err.response?.data?.error?.message || '');
                }
        }

        // Tentativa 2 — Groq chave principal
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

        // Tentativa 3 — Groq chave reserva
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

        // Tentativa 4 — Gemini (Fallback final)
        console.log('🔄 Acionando Gemini como fallback final...');
        botStatus.modelo = 'gemini';
        botStatus.fallbacksHoje++;
        try {
                return await askGemini(telefone, mensagem, systemPromptFinal);
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

// Envia o mesmo template pra gerente E, se NUMERO_LUCAS estiver configurado, também
// pro Lucas — templates aprovados ignoram a janela de 24h, então chegam sempre,
// mesmo que ele nunca tenha mandado mensagem pro bot antes.
async function sendTemplateGerente(templateName, variables = []) {
        await sendTemplate(NUMERO_GERENTE, templateName, variables);
        if (NUMERO_LUCAS) {
                try {
                        await sendTemplate(NUMERO_LUCAS, templateName, variables);
                } catch (e) {
                        console.error(`⚠️ Falha ao espelhar template "${templateName}" pro Lucas:`, e.response?.data || e.message);
                }
        }
}

// Tenta mandar texto livre (não-template) agora. Se der certo, salva no CRM e devolve
// null. Se a janela de 24h estiver fechada, NÃO marca como falha definitiva — devolve
// o item pra quem chamou decidir o que fazer com a fila de pendências (ver
// definirPendentes logo abaixo). Não mexe em relatoriosPendentes diretamente: um
// relatório mensal tem vários blocos e todos precisam ser tratados como uma unidade só,
// senão cada bloco que falhasse ia "pisar" no anterior e perder pedaço do relatório.
async function enviarLivreOuItemPendente(telefone, texto, tipoSalvar, vendedorSalvar = 'bot') {
        try {
                // Confere ANTES de tentar se a janela de 24h está aberta de verdade — com base na
                // última mensagem DO CLIENTE, não na última que NÓS mandamos. Sem essa checagem,
                // a Meta às vezes aceita a chamada de envio (POST retorna 200, ganha um wamid) e só
                // falha DEPOIS, de forma assíncrona, via webhook de status (erro 131047 — ver
                // tratamento de value.statuses no /webhook). Como o try/catch aqui só pega erro
                // síncrono do POST, esse caso batia no "sucesso" (return null), a pendência era
                // descartada e a mensagem se perdia de vez, sem nunca ser reenviada — foi o que
                // aconteceu com o resumo diário detalhado pra gerente/Lucas.
                const limite24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
                const { data: ultimaCliente } = await supabase
                        .from('conversas')
                        .select('created_at')
                        .eq('telefone', telefone)
                        .eq('de', 'cliente')
                        .order('created_at', { ascending: false })
                        .limit(1);

                const janelaAberta = ultimaCliente && ultimaCliente.length > 0 && ultimaCliente[0].created_at >= limite24h;
                if (!janelaAberta) {
                        console.log(`📬 Bloco adiado pra ${telefone} (janela de 24h fechada — sem mensagem do cliente nas últimas 24h).`);
                        return { texto, tipoSalvar, vendedorSalvar };
                }

                await sendWhatsApp(telefone, texto);
                await salvarMensagem(telefone, texto, 'sistema', vendedorSalvar, tipoSalvar);
                return null;
        } catch (e) {
                console.log(`📬 Bloco adiado pra ${telefone} (janela de 24h fechada).`, e.response?.data || e.message);
                return { texto, tipoSalvar, vendedorSalvar };
        }
}


// Substitui TODA a fila de pendências desse telefone pelos itens do envio atual — um
// relatório novo sempre vence qualquer pendência antiga (não acumula dias/meses velhos),
// mas todos os blocos de UM MESMO relatório ficam juntos, entregues na mesma ordem.
// Substitui só a pendência do MESMO TIPO (ex: 'resumo_diario_detalhado' ou
// 'relatorio_mensal_detalhado'), preservando pendências de outro tipo pro mesmo
// telefone. Isso importa porque no dia 1 do mês o resumo diário e o relatório mensal
// podem ficar pendentes juntos (se a janela de 24h estiver fechada nos dois) — sem essa
// separação, um "sobrescrevia" o outro silenciosamente porque os dois tentavam gravar
// na mesma fila (relatoriosPendentes[telefone]).
function definirPendentes(telefone, tipoSalvar, itens) {
        const outrosTipos = (relatoriosPendentes[telefone] || []).filter(i => i.tipoSalvar !== tipoSalvar);
        const validos = (itens || []).filter(Boolean);
        const combinado = [...outrosTipos, ...validos];
        if (combinado.length > 0) relatoriosPendentes[telefone] = combinado;
        else delete relatoriosPendentes[telefone];
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

// ── Redistribuição de leads sem contato do vendedor ─────────────────────────
// Reaproveita o mesmo template de notificação (notificacao_novo_lead), então não
// precisa de aprovação nova no Meta. Atualiza status_de_leads.vendedor pro novo
// responsável, preservando vendedor_original (pra saber quem foi o primeiro) e
// redistribuido_em (pra não redistribuir de novo antes do próximo prazo de 72h).
async function redistribuirLead(telefone, vendedorAntigo, vendedorNovo, vendedorOriginal, nomeLead) {
        try {
                const numeroVendedorNovo = {
                        rebecca: process.env.NUMERO_REBECCA,
                        taynara: process.env.NUMERO_TAYNARA,
                        wellington: process.env.NUMERO_PAULO
                }[vendedorNovo.toLowerCase()];

                if (!numeroVendedorNovo) {
                        console.warn(`⚠️ Número do vendedor ${vendedorNovo} não configurado — redistribuição de ${telefone} abortada`);
                        return;
                }

                await sendTemplate(numeroVendedorNovo, 'notificacao_novo_lead', [
                        { name: 'lead_nome',     value: nomeLead || '—' },
                        { name: 'lead_turma',    value: '—' },
                        { name: 'lead_horario',  value: '—' },
                        { name: 'lead_telefone', value: `+${telefone}` }
                ]);

                const textoNotificacao = `🔁 *Lead redistribuído* (${vendedorAntigo} não entrou em contato em 72h)\n\n` +
                        `👤 Nome: ${nomeLead || '—'}\n` +
                        `📞 Telefone: +${telefone}\n\n` +
                        `Entre em contato o quanto antes.`;
                await salvarMensagem(numeroVendedorNovo, textoNotificacao, 'sistema', vendedorNovo.toLowerCase(), 'lead_redistribuido');

                await supabase.from('status_de_leads').upsert({
                        telefone,
                        vendedor: vendedorNovo,
                        vendedor_original: vendedorOriginal,
                        redistribuido_em: new Date().toISOString()
                }, { onConflict: 'telefone' });

                vendedorPorTelefone[telefone] = vendedorNovo;

                console.log(`🔁 Lead ${telefone} redistribuído de ${vendedorAntigo} pra ${vendedorNovo} (sem contato em 72h)`);
        } catch (e) {
                console.error(`❌ Erro ao redistribuir lead ${telefone}:`, e.response?.data || e.message);
        }
}

// Varre leads confirmados pelo bot (tipo='lead_confirmado') dos últimos 30 dias que
// ainda não têm NENHUMA mensagem de='vendedor' registrada (nem pelo CRM, nem eco do
// WhatsApp Business App do vendedor) depois de 72h — sinal de que o vendedor nunca
// entrou em contato de verdade, só recebeu a notificação e ignorou. Pula quem já
// converteu ou já foi tratado como perdido/matriculado/etc — redistribuir não faz
// sentido nesses casos.
const STATUS_IGNORAR_REDISTRIBUICAO = ['matriculado', 'aluno', 'perdido', 'colega', 'parceiro', 'engano'];
async function redistribuirLeadsSemContato() {
        const limite72h  = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
        const limiteBusca = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

        const { data: confirmacoes, error } = await supabase
                .from('conversas')
                .select('telefone, vendedor, created_at')
                .eq('tipo', 'lead_confirmado')
                .eq('de', 'cliente')
                .gte('created_at', limiteBusca)
                .order('created_at', { ascending: true });

        if (error) {
                console.error('❌ Erro ao buscar leads confirmados p/ redistribuição:', error.message);
                return;
        }
        if (!confirmacoes || confirmacoes.length === 0) return;

        // Primeira confirmação de cada telefone = momento e vendedor original atribuído pelo bot
        const primeiraConfirmacao = {};
        confirmacoes.forEach(c => { if (!primeiraConfirmacao[c.telefone]) primeiraConfirmacao[c.telefone] = c; });
        const telefones = Object.keys(primeiraConfirmacao);
        if (telefones.length === 0) return;

        const { data: statusRows } = await supabase
                .from('status_de_leads')
                .select('telefone, status, nome, vendedor, vendedor_original, redistribuido_em')
                .in('telefone', telefones);
        const statusMap = {};
        (statusRows || []).forEach(s => { statusMap[s.telefone] = s; });

        const { data: msgsVendedor } = await supabase
                .from('conversas')
                .select('telefone, created_at')
                .eq('de', 'vendedor')
                .in('telefone', telefones)
                .gte('created_at', limiteBusca);
        const ultimoContatoVendedor = new Set((msgsVendedor || []).map(m => m.telefone));

        for (const telefone of telefones) {
                const st = statusMap[telefone];
                if (st && STATUS_IGNORAR_REDISTRIBUICAO.includes(st.status)) continue;
                if (ultimoContatoVendedor.has(telefone)) continue; // vendedor já falou com o lead

                // Referência de tempo: desde a confirmação original, ou desde a última
                // redistribuição (o que for mais recente) — pra não redistribuir de novo
                // antes de completar mais 72h com o vendedor novo.
                const desde = (st?.redistribuido_em && st.redistribuido_em > primeiraConfirmacao[telefone].created_at)
                        ? st.redistribuido_em
                        : primeiraConfirmacao[telefone].created_at;
                if (desde > limite72h) continue;

                const vendedorAtual    = st?.vendedor || primeiraConfirmacao[telefone].vendedor;
                const vendedorOriginal = st?.vendedor_original || primeiraConfirmacao[telefone].vendedor;
                if (!vendedorAtual) continue;

                const novoVendedor = await getVendedor(vendedorAtual);
                if (!novoVendedor || novoVendedor.toLowerCase() === vendedorAtual.toLowerCase()) continue;

                await redistribuirLead(telefone, vendedorAtual, novoVendedor, vendedorOriginal, st?.nome);
                await new Promise(r => setTimeout(r, 1000));
        }
}

// Roda 1x por dia — o prazo é de 72h, não precisa checar com mais frequência.
setInterval(redistribuirLeadsSemContato, 24 * 60 * 60 * 1000);
// ────────────────────────────────────────────────────────────────────────────

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
                // Mostra também a resposta da Meta (o "400" sozinho não diz se foi o token,
                // o media_id expirado ou o número sem permissão) e em qual etapa falhou.
                const detalheMeta = err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : '';
                console.error(`❌ Erro ao baixar/subir midia [${telefone}] (media_id ${mediaId}, url ${err.config?.url?.slice(0, 60) || '?'}): ${err.message} ${detalheMeta}`);
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

// Linhas da mensagem de confirmação de dados (👤 Nome / 📚 Turma indicada / ⏰ Horário
// preferido). Antes a regex aceitava QUALQUER "Nome...:", "Turma...:" ou "Horário...:" em
// qualquer resposta — então quando o bot listava "Horários de sábado: 8h-10h45..." o sistema
// achava que esse era o horário preferido do cliente, e a IA deixava de perguntar.
const RE_CONF_NOME = /^\s*👤\s*\*?Nome\*?:\s*\*?([^\n*]+)/m;
const RE_CONF_TURMA = /^\s*📚\s*\*?Turma indicada\*?:\s*\*?([^\n*]+)/m;
const RE_CONF_HORARIO = /^\s*⏰\s*\*?Hor[áa]rio preferido\*?:\s*\*?([^\n*]+)/m;

async function getHistorico(telefone) {
        // Se já existe na RAM, não faz nada
        if (conversas[telefone]) return;

        try {
                // Busca as últimas 20 mensagens ordenadas por data descendente
                const { data, error } = await supabase
                        .from('conversas')
                        .select('mensagem, de, tipo')
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
                        // Rastreia se a pesquisa de "lead perdido" foi enviada e ainda não teve
                        // resposta — mesmo problema do jaAluno: sem isso, um restart do Railway
                        // entre o envio da pesquisa e a resposta do cliente perdia a flag (só
                        // existia em RAM), e a resposta caía no fluxo normal da IA em vez do
                        // agradecimento — foi exatamente isso que gerou respostas erradas/repetidas
                        // (ex: loop de "vou encaminhar pra coordenação") quando um deploy aconteceu
                        // bem na janela entre o disparo em massa da pesquisa e as respostas.
                        let aguardandoPesquisaPerdido = false;
                        data.forEach(m => {
                                if (m.de === 'bot') {
                                        const nomeMatch = m.mensagem.match(RE_CONF_NOME);
                                        const turmaMatch = m.mensagem.match(RE_CONF_TURMA);
                                        const horarioMatch = m.mensagem.match(RE_CONF_HORARIO);
                                        if (nomeMatch) dadosLead[telefone].nome = nomeMatch[1].trim();
                                        if (turmaMatch) dadosLead[telefone].turma = turmaMatch[1].trim();
                                        if (horarioMatch) dadosLead[telefone].horario = horarioMatch[1].trim();
                                }
                                // Se em algum momento essa conversa já foi classificada como aluno,
                                // mantém a memória mesmo depois de um restart do Railway — senão a
                                // flag jaAluno (só em RAM) se perdia e a IA voltava a perguntar
                                // "você já é aluno?" depois de qualquer deploy.
                                if (m.tipo === 'aluno') dadosLead[telefone].jaAluno = true;

                                if (m.tipo === 'pesquisa_perdido') aguardandoPesquisaPerdido = true;
                                else if (m.tipo === 'feedback_perdido' && m.de === 'cliente') aguardandoPesquisaPerdido = false;
                        });
                        if (aguardandoPesquisaPerdido) {
                                aguardandoFeedbackPerdido[telefone] = { vendedorSalvar: 'bot' };
                        }

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
                // Antes era includes('falta'), que pegava "quanto falta pra começar?" e
                // "faltam vagas?" de lead novo e disparava alerta pra coordenação.
                /\b(vai|vou|vamos|vão|vao|irá|ira|vai ter que|precisa|preciso) faltar\b|\bfaltei\b|\bfaltou (na|à|a) aula\b/.test(msgLower) ||
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
                [process.env.META_PHONE_NUMBER_ID_PAULO]:   'Wellington', // mesmo número do Paulo — ele saiu, Wellington assumiu o perfil
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
                // Mídia pro número principal do bot: registra, mas a IA não consegue "ler" o
                // conteúdo em si (áudio, imagem, etc). Antes ficava em silêncio — o cliente
                // mandava um áudio e via a mensagem como enviada, sem nenhuma resposta, achando
                // que tinha caído no vácuo. Agora avisa e pede pra escrever em texto.
                await salvarMensagem(telefone, mensagem, 'cliente', null, 'desconhecido', midiaUrl);
                console.log(`📎 Mídia recebida no bot principal de ${telefone}: ${mensagem}`);

                const avisoMidia = message.type === 'audio'
                        ? 'Ainda não consigo ouvir áudios por aqui 🙏 Pode escrever sua mensagem em texto?'
                        : 'Recebi seu arquivo, mas ainda não consigo abrir esse tipo de conteúdo por aqui 🙏 Pode me contar em texto o que você gostaria de saber?';
                try {
                        await sendWhatsApp(telefone, avisoMidia);
                        await salvarMensagem(telefone, avisoMidia, 'bot', null, 'desconhecido');
                } catch (e) {
                        console.error(`❌ Falha ao avisar ${telefone} sobre mídia não suportada:`, e.response?.data || e.message);
                }
                return;
        }

        if (!telefone || !mensagem) return;

        // Mensagem da gerente ou do Lucas (normalmente é só resposta ao resumo diário
        // pra abrir a janela de 24h e liberar o detalhamento, ou o relatório mensal que
        // agora também é espelhado pro Lucas). Sem essa guarda, a resposta caía no fluxo
        // normal de lead — passava pelo aviso de LGPD e a IA perguntava "você já é aluno
        // ou tem interesse em se matricular?". Só registra a mensagem (mantém a janela de
        // 24h aberta) e não aciona a IA nem o fluxo de qualificação.
        if (NUMEROS_INTERNOS_GESTAO.has(telefone)) {
                await salvarMensagem(telefone, mensagem, 'cliente', 'Coordenação', 'resposta_gerente');

                // Essa mensagem acabou de abrir a janela de 24h — se tinha conteúdo detalhado
                // (resumo diário/relatório mensal) esperando pra ser enviado, manda agora.
                const pendentes = relatoriosPendentes[telefone];
                if (pendentes && pendentes.length > 0) {
                        delete relatoriosPendentes[telefone];
                        for (const item of pendentes) {
                                try {
                                        await sendWhatsApp(telefone, item.texto);
                                        await salvarMensagem(telefone, item.texto, 'sistema', item.vendedorSalvar || 'bot', item.tipoSalvar);
                                        await new Promise(r => setTimeout(r, 1200));
                                } catch (e) {
                                        console.error(`❌ Falha ao enviar conteúdo adiado pra ${telefone}:`, e.response?.data || e.message);
                                }
                        }
                        console.log(`📬 ${pendentes.length} mensagem(ns) adiada(s) entregue(s) pra ${telefone} após resposta.`);
                }

                console.log(`👩‍💼 Mensagem de número interno de gestão (${telefone}): "${mensagem}" — só registrada, sem fluxo de lead.`);
                return;
        }

        // Resposta da pesquisa de "lead perdido" — não deixa cair no fluxo normal da IA
        // (que perguntaria "você já é aluno?" de novo, sem sentido nesse contexto).
        // Antes QUALQUER primeira resposta virava feedback e levava um "obrigado pelo
        // retorno" — inclusive "Bom dia", respostas automáticas de empresa, "Como assim?
        // Que matrícula?" e até lead pedindo preço. Agora a IA classifica a resposta
        // primeiro e só trata como feedback o que de fato é feedback.
        let tipoRespostaPesquisa = 'FEEDBACK';
        if (aguardandoFeedbackPerdido[telefone] && mensagem) {
                tipoRespostaPesquisa = await classificarRespostaPesquisa(mensagem);
                console.log(`📮 Resposta à pesquisa de ${telefone} classificada como ${tipoRespostaPesquisa}: "${mensagem}"`);
        }
        if (aguardandoFeedbackPerdido[telefone] && tipoRespostaPesquisa === 'OUTRO') {
                // Cumprimento solto ou resposta automática: registra, não responde e continua
                // esperando o feedback de verdade.
                await salvarMensagem(telefone, mensagem, 'cliente', aguardandoFeedbackPerdido[telefone].vendedorSalvar || 'bot', 'desconhecido', midiaUrl);
                return;
        }
        if (aguardandoFeedbackPerdido[telefone] && (tipoRespostaPesquisa === 'INTERESSE' || tipoRespostaPesquisa === 'CONFUSO')) {
                // Lead que voltou interessado OU ficou confuso com a pesquisa ("?", "que matrícula?"):
                // sai do modo pesquisa e cai no atendimento normal da IA, que enxerga a pesquisa no
                // histórico e explica a própria mensagem / se desculpa conforme o caso — em vez de
                // um pedido de desculpas fixo igual pra todo mundo.
                delete aguardandoFeedbackPerdido[telefone];
                salvarEstadoBot(telefone);
        }
        if (aguardandoFeedbackPerdido[telefone]) {
                const origem = aguardandoFeedbackPerdido[telefone];
                delete aguardandoFeedbackPerdido[telefone];
                salvarEstadoBot(telefone);
                await salvarMensagem(telefone, mensagem, 'cliente', origem.vendedorSalvar || 'bot', 'feedback_perdido', midiaUrl);

                // Se a resposta der a entender que a pessoa já se matriculou (e o vendedor só não
                // atualizou o CRM), o agradecimento padrão fica sem sentido/deselegante — pede
                // desculpas em vez disso. Não muda status nem notifica vendedor (isso o Lucas
                // pediu pra não fazer) — é só o texto que a IA manda de volta pro cliente.
                const jaMatriculado = mensagem ? await respostaIndicaMatricula(mensagem) : false;
                const resposta = jaMatriculado
                        ? 'Opa, sentimos muito pelo equívoco! 🙏 Pelo visto sua matrícula já foi feita e nosso sistema não estava refletindo isso corretamente. Peço desculpas pelo transtorno!'
                        : 'Muito obrigado pelo retorno! Isso nos ajuda bastante a melhorar 🙏';
                try {
                        await sendWhatsApp(telefone, resposta);
                        await salvarMensagem(telefone, resposta, 'sistema', origem.vendedorSalvar || 'bot', 'feedback_perdido');
                } catch (e) {
                        console.error(`❌ Falha ao responder feedback de ${telefone}:`, e.response?.data || e.message);
                }
                console.log(`📮 Feedback de lead perdido recebido de ${telefone}: "${mensagem}"${jaMatriculado ? ' (indica matrícula já feita — pedido desculpas)' : ''}`);
                return;
        }

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
                // Parceria, currículo, fornecedor etc. — a IA marcou como fora do escopo.
                let tipo = tipoDaConversa(telefone, mensagem, reply);

                // Extração de dados da resposta do bot para memória
                if (!dadosLead[telefone]) {
                        dadosLead[telefone] = { nome: null, turma: null, horario: null, confirmado: false, notificado: false, consentimentoDado: true };
                }

                if (tipo === 'aluno') {
                        // Marca de forma persistente (na RAM) que esse cliente já foi tratado como
                        // aluno nesta conversa — usado pra IA não voltar a perguntar "você já é
                        // aluno?" numa mensagem seguinte (ver bloco jaAluno em askAI()).
                        dadosLead[telefone].jaAluno = true;
                        if (!reengajamentoEnviado[`coord_${telefone}`]) {
                                reengajamentoEnviado[`coord_${telefone}`] = true;
                                vendedor = 'Coordenação';
                                vendedorPorTelefone[telefone] = 'Coordenação';
                                await notificarCoordenacao(telefone);
                        }
                }

                const nomeMatch = reply.match(RE_CONF_NOME);
                const turmaMatch = reply.match(RE_CONF_TURMA);
                const horarioMatch = reply.match(RE_CONF_HORARIO);

                if (nomeMatch) dadosLead[telefone].nome = nomeMatch[1].trim();
                if (turmaMatch) dadosLead[telefone].turma = turmaMatch[1].trim();
                if (horarioMatch) dadosLead[telefone].horario = horarioMatch[1].trim();

                if (reply.includes('Seus dados foram registrados') && !dadosLead[telefone].confirmado) {
                        dadosLead[telefone].confirmado = true;

                        // Reavalia o vendedor NESTE momento (confirmação), não usa o que foi
                        // atribuído lá no primeiro "oi" do cliente — que pode ter sido horas ou
                        // até um dia antes. Assim quem recebe o lead é sempre quem está na escala
                        // (ou é a vez do rodízio) no horário real em que o lead foi confirmado.
                        // Exceção: se o lead já tinha sido encaminhado por inatividade e voltou
                        // pra terminar o cadastro, os dados completos vão pro MESMO vendedor
                        // (ele já está com o lead) em vez de sortear outro da fila.
                        const vendedorJaEncaminhado = await vendedorDoEncaminhamento(telefone);
                        vendedor = vendedorJaEncaminhado || await getVendedor();
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
        const vendedor = req.query.vendedor || 'desconhecido';
        const de = (body.fromMe === true || body.fromMe === 'true') ? 'vendedor' : 'cliente';

        let telefone;
        if (!isLid) {
                // Recebido (fromMe=false): temos o número real do cliente
                telefone = normalizePhone(rawPhone);
                // Armazena mapeamento LID → telefone real (em memória e persistido no banco,
                // pra sobreviver a redeploy) + corrige registros antigos que ficaram com o LID
                if (chatLid && !lidToPhone.has(chatLid)) {
                        lidToPhone.set(chatLid, telefone);
                        console.log(`🔗 LID mapeado: ${chatLid} → ${telefone}`);
                        salvarLidMap(chatLid, telefone);
                        supabase.from('conversas')
                                .update({ telefone: telefone })
                                .eq('telefone', chatLid)
                                .then(({ error }) => {
                                        if (!error) console.log(`✅ DB retroativo: ${chatLid} → ${telefone}`);
                                });
                        // Libera mensagens de vendedor que chegaram enquanto esse LID ainda
                        // não tinha telefone real conhecido e ficaram em espera
                        flushMensagensPendentesLid(chatLid, telefone);
                }
        } else {
                // Enviado (fromMe=true): Z-API/WANotifier usa LID — tenta resolver pelo cache
                const lid = rawPhone.split('@')[0];
                const realPhone = lidToPhone.get(lid) || (chatLid ? lidToPhone.get(chatLid) : null);
                if (!realPhone) {
                        // Ainda não sabemos o telefone real desse LID — NÃO salva com o LID cru
                        // como telefone (isso criava um lead "fantasma" que nunca mais vira um
                        // número de verdade). Guarda em espera; quando o cliente escrever e
                        // revelar o telefone real, flushMensagensPendentesLid() resgata essa
                        // mensagem pro telefone certo.
                        if (mensagem) {
                                const { error } = await supabase.from('mensagens_lid_pendentes').insert({
                                        lid: lid || chatLid, mensagem, de, vendedor
                                });
                                if (error) console.error('❌ Erro ao guardar mensagem pendente de LID:', error.message);
                                else console.log(`⏳ LID ${lid} ainda não resolvido — mensagem guardada em espera`);
                        }
                        return;
                }
                telefone = realPhone;
        }

        if (!telefone || !mensagem) {
                console.log(`⚠️ Webhook vendedor ignorado: f=${telefone}, m=${!!mensagem}`);
                return;
        }

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
                delete aguardandoFeedbackPerdido[telefone];
                return res.json({ reply: '🔄 Memória do simulador reiniciada!', tipo: 'sistema', modelo: botStatus.modelo });
        }

        // Se não tiver histórico (ou foi recém limpo), inicializa
        if (!conversas[telefone]) conversas[telefone] = [];

        // Comando de teste: simula a escola mandando a pesquisa de lead perdido pro
        // número simulado, igual acontece de verdade em enviarPesquisasLeadsPerdidos().
        // Serve pra testar, sem tocar em nenhum contato real, se uma mensagem que
        // mistura resposta de pesquisa com assunto de lead novo é separada certinho.
        if (mensagem.trim().toLowerCase() === '/pesquisa') {
                const textoPesquisa = 'Oi, tudo bem! Aqui é do CNA Recreio 😊 Notamos que você não seguiu com a matrícula. Pode nos contar rapidinho o que achou do nosso atendimento e o motivo? Isso nos ajuda muito a melhorar 🙏';
                conversas[telefone].push({ role: 'assistant', content: `[Mensagem automática enviada pela escola] ${textoPesquisa}` });
                aguardandoFeedbackPerdido[telefone] = { vendedorSalvar: 'bot' };
                return res.json({ reply: `📮 (simulação) Escola enviou: "${textoPesquisa}"`, tipo: 'sistema', modelo: botStatus.modelo });
        }

        try {
                // Reproduz, só pra este número simulado, a mesma triagem que o webhook real
                // faz antes de chamar a IA quando o número está esperando resposta da pesquisa
                // de lead perdido (ver comentário acima de aguardandoFeedbackPerdido no webhook).
                if (aguardandoFeedbackPerdido[telefone]) {
                        const tipoResposta = await classificarRespostaPesquisa(mensagem);
                        conversas[telefone].push({ role: 'user', content: mensagem });

                        if (tipoResposta === 'OUTRO') {
                                // Cumprimento solto: fica esperando a resposta de verdade, sem falar nada.
                                return res.json({ reply: '(sem resposta — bot continua esperando o feedback de verdade)', tipo: 'pesquisa_outro', modelo: botStatus.modelo });
                        }

                        if (tipoResposta === 'INTERESSE' || tipoResposta === 'CONFUSO') {
                                // Sai do modo pesquisa e cai no atendimento normal — a IA vê a pesquisa
                                // no histórico e decide como reagir.
                                delete aguardandoFeedbackPerdido[telefone];
                                const reply = await askAI(telefone, mensagem);
                                const tipo = tipoDaConversa(telefone, mensagem, reply);
                                return res.json({ reply, tipo, modelo: botStatus.modelo, pesquisaClassificada: tipoResposta });
                        }

                        // FEEDBACK: agradece e encerra, igual à produção — NÃO continua pro
                        // atendimento normal. Se a mensagem também pedia outra coisa (ex: "achei
                        // caro mas quero saber dos valores de novo"), esse pedido fica sem resposta
                        // nesta troca — é exatamente o ponto cego que este comando serve pra mostrar.
                        delete aguardandoFeedbackPerdido[telefone];
                        const jaMatriculado = await respostaIndicaMatricula(mensagem);
                        const reply = jaMatriculado
                                ? 'Opa, sentimos muito pelo equívoco! 🙏 Pelo visto sua matrícula já foi feita e nosso sistema não estava refletindo isso corretamente. Peço desculpas pelo transtorno!'
                                : 'Muito obrigado pelo retorno! Isso nos ajuda bastante a melhorar 🙏';
                        conversas[telefone].push({ role: 'assistant', content: reply });
                        return res.json({ reply, tipo: 'feedback_perdido', modelo: botStatus.modelo, pesquisaClassificada: 'FEEDBACK', matriculaDetectada: jaMatriculado });
                }

                const reply = await askAI(telefone, mensagem);
                const tipo = tipoDaConversa(telefone, mensagem, reply);
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
        wellington: process.env.META_PHONE_NUMBER_ID_PAULO, // Wellington assumiu o número/perfil do Paulo
};

// Nome com a capitalização correta, igual ao que o eco do WhatsApp Business App salva
// (evita mensagem enviada pelo CRM "sumir" da conversa por causa de maiúscula/minúscula)
const NOME_CAPITALIZADO_VENDEDOR = { rebecca: 'Rebecca', taynara: 'Taynara', wellington: 'Wellington' };

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
        // Em lotes (ver selectEmLotes) — com `.in()` único falhava calado e todo
        // inativo era tratado como "sem status", sobrescrevendo status reais.
        let comStatus;
        try {
                comStatus = await selectEmLotes('status_de_leads', 'telefone, status, nome', 'telefone', inativos);
        } catch (e) {
                return res.status(500).json({ ok: false, msg: e.message });
        }

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

// Rota para classificar leads antigos (>15 dias sem status) via IA e avisar a gerente
app.get('/processar-novos', async (req, res) => {
        if (!checkAdminToken(req, res)) return;
        res.json({ ok: true, msg: 'Classificando leads antigos...' });
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

// Preview: monta o relatório com os mesmos dados/IA, mas NÃO manda nada pelo WhatsApp —
// devolve o texto completo na resposta pra revisão antes de disparar de verdade.
app.get('/relatorio-mensal/preview', async (req, res) => {
        if (!checkAdminToken(req, res)) return;
        if (relatorioEmAndamento) {
                return res.json({ ok: false, msg: 'Relatório já está sendo gerado. Aguarde.' });
        }
        try {
                const texto = await gerarRelatorioMensal({ preview: true });
                if (!texto) return res.status(500).json({ ok: false, msg: 'Não foi possível gerar o preview (ver logs do servidor).' });
                res.json({ ok: true, relatorio: texto });
        } catch (e) {
                res.status(500).json({ ok: false, msg: e.message });
        }
});

// ── Persistência de estado no Supabase ─────────────────────────────────────
// Carrega estado salvo no startup para resistir a redeploys do Railway
async function carregarEstadoBot() {
        try {
                const { data, error } = await supabase
                        .from('estado_bot')
                        .select('telefone, ultima_atividade, reengajamento_env, confirmado, notificado, aguardando_feedback_perdido');
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
                        // Restaura a espera pela resposta da pesquisa de lead perdido — sem isso,
                        // um redeploy bem no meio da janela entre enviar a pesquisa e o lead
                        // responder faria a resposta cair no fluxo normal da IA por engano.
                        if (r.aguardando_feedback_perdido) {
                                aguardandoFeedbackPerdido[r.telefone] = { vendedorSalvar: 'bot' };
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
                aguardando_feedback_perdido: !!aguardandoFeedbackPerdido[telefone],
                updated_at:        new Date().toISOString()
        }, { onConflict: 'telefone' }).then(({ error }) => {
                if (error) console.error(`❌ Erro ao salvar estado_bot [${telefone}]:`, error.message);
        });
}
// ────────────────────────────────────────────────────────────────────────────

// ── Lead que parou de responder o bot → vai pro vendedor da fila ───────────────
// Substitui o antigo reengajamento ("Oi! Ainda posso te ajudar...?"), que foi
// desligado a pedido do Lucas (out/2026). Agora, se a pessoa escreveu pro bot e
// ficou 24h sem responder sem ter concluído o cadastro, o lead vai pro vendedor
// da vez (mesma escala/fila de getVendedor) com o que o bot conseguiu coletar —
// o que faltar vai como "—". O vendedor fala com o lead pelo número dele, então a
// janela de 24h do bot não importa aqui.
//
// Fica de fora quem:
//  - já está resolvido: aluno, lead confirmado, conversa direta com vendedor,
//    outro assunto (currículo, parceria...);
//  - já foi encaminhado e não voltou a falar depois disso;
//  - está no fluxo da pesquisa de lead perdido (últimos 7 dias);
//  - já tem status de quem está sendo atendido ou não é lead (em andamento,
//    pausado, aluno, matriculado, engano, colega, parceiro). "perdido" que volta
//    a escrever ENTRA — é alguém retomando o contato;
//  - números internos (gerente, Lucas, vendedores, coordenação) e o simulador.
const TIPO_LEAD_ENCAMINHADO = 'lead_encaminhado';
const INATIVIDADE_ENCAMINHAR_MS = 24 * 60 * 60 * 1000;
const JANELA_BUSCA_INATIVOS_MS = 7 * 24 * 60 * 60 * 1000;
const TIPOS_JA_RESOLVIDOS = ['aluno', 'lead_confirmado', 'lead-vendedor', 'conversa_vendedor', 'outro_assunto'];
const TIPOS_PESQUISA_PERDIDO = ['pesquisa_perdido', 'feedback_perdido'];
const STATUS_SEM_ENCAMINHAR = ['em_andamento', 'pausado', 'aluno', 'matriculado', 'engano', 'colega', 'parceiro'];

function numeroDoVendedor(nome) {
        return {
                rebecca: process.env.NUMERO_REBECCA,
                taynara: process.env.NUMERO_TAYNARA,
                wellington: process.env.NUMERO_PAULO
        }[String(nome || '').toLowerCase()] || null;
}

function numerosQueNuncaSaoLead() {
        return new Set(
                [...NUMEROS_INTERNOS_GESTAO, process.env.NUMERO_REBECCA, process.env.NUMERO_TAYNARA, process.env.NUMERO_PAULO, NUMERO_COORDENACAO, 'simulador_crm']
                        .filter(Boolean)
                        .map(n => String(n).replace(/\D/g, '') || String(n))
        );
}

// Vendedor que recebeu este lead no encaminhamento por inatividade (se houve).
// Usado pra que, se o lead voltar e terminar o cadastro com o bot, a confirmação
// vá pro MESMO vendedor em vez de sortear outro da fila.
async function vendedorDoEncaminhamento(telefone) {
        if (dadosLead[telefone]?.vendedorEncaminhado) return dadosLead[telefone].vendedorEncaminhado;
        try {
                const { data } = await supabase
                        .from('conversas')
                        .select('vendedor')
                        .eq('telefone', telefone)
                        .eq('tipo', TIPO_LEAD_ENCAMINHADO)
                        .order('created_at', { ascending: false })
                        .limit(1);
                return data?.[0]?.vendedor || null;
        } catch (e) {
                console.warn(`⚠️ Não deu pra checar encaminhamento anterior de ${telefone}:`, e.message);
                return null;
        }
}

// Decide quem deve ser encaminhado. Função pura (sem banco) pra dar pra testar.
//  ultimaMsgCliente: { [telefone]: ISO da última mensagem do cliente pro bot }
//  eventos: linhas de conversas { telefone, tipo, created_at } dos tipos que importam
//  statusPorTel: { [telefone]: status em status_de_leads }
function escolherLeadsParaEncaminhar({ ultimaMsgCliente, eventos, statusPorTel, agora, ignorar }) {
        const limiteInatividade = agora - INATIVIDADE_ENCAMINHAR_MS;
        const limitePesquisa = agora - JANELA_BUSCA_INATIVOS_MS;
        const porTel = {};
        for (const ev of eventos) (porTel[ev.telefone] = porTel[ev.telefone] || []).push(ev);

        return Object.keys(ultimaMsgCliente).filter(tel => {
                if (ignorar.has(tel)) return false;
                const ultima = new Date(ultimaMsgCliente[tel]).getTime();
                if (ultima > limiteInatividade) return false;                         // ainda dentro das 24h
                if (STATUS_SEM_ENCAMINHAR.includes(statusPorTel[tel])) return false;
                const evs = porTel[tel] || [];
                if (evs.some(e => TIPOS_JA_RESOLVIDOS.includes(e.tipo))) return false;
                if (evs.some(e => TIPOS_PESQUISA_PERDIDO.includes(e.tipo) && new Date(e.created_at).getTime() >= limitePesquisa)) return false;
                // Já encaminhado e não falou mais nada depois → não encaminha de novo
                if (evs.some(e => e.tipo === TIPO_LEAD_ENCAMINHADO && new Date(e.created_at).getTime() >= ultima)) return false;
                return true;
        });
}

async function encaminharLeadInativo(telefone, statusRow) {
        const dados = dadosLead[telefone] || {};
        if (dados.confirmado) return;

        // Se já foi encaminhado antes (voltou a falar e parou de novo), mantém o mesmo
        // vendedor. Senão, segue a escala/fila normal.
        const vendedorAnterior = await vendedorDoEncaminhamento(telefone);
        const vendedor = vendedorAnterior || await getVendedor();
        const numeroVendedor = numeroDoVendedor(vendedor);
        if (!vendedor || !numeroVendedor) {
                console.warn(`⚠️ Encaminhamento de ${telefone} abortado: vendedor "${vendedor}" sem número configurado`);
                return;
        }

        const telefoneLimpo = String(telefone).replace(/\D/g, '');
        const nome = dados.nome || statusRow?.nome || '';
        const turma = dados.turma || '';
        const horario = dados.horario || '';

        await sendTemplate(numeroVendedor, 'notificacao_novo_lead', [
                { name: 'lead_nome',     value: nome    || '—' },
                { name: 'lead_turma',    value: turma   || '—' },
                { name: 'lead_horario',  value: horario || '—' },
                { name: 'lead_telefone', value: `+${telefoneLimpo}` }
        ]);

        // O que o vendedor recebe no WhatsApp é o template aprovado na Meta, sem nenhuma
        // mudança: mesmo nome (notificacao_novo_lead) e as mesmas 4 variáveis que
        // notificarVendedor() e redistribuirLead() já usam. Não dá pra mandar texto
        // diferente sem aprovar um template novo. Por isso o registro no CRM da conversa
        // do vendedor é o MESMO texto que notificarVendedor() registra — o CRM mostra o
        // que de fato chegou. A informação "parou de responder" fica só na conversa do lead.
        const textoVendedor = `🎓 *Novo lead confirmado!*\n\n` +
                `👤 Nome: ${nome || '—'}\n` +
                `📚 Turma: ${turma || '—'}\n` +
                `⏰ Horário: ${horario || '—'}\n` +
                `📞 Telefone: +${telefoneLimpo}\n\n` +
                `Entre em contato o quanto antes.`;
        await salvarMensagem(numeroVendedor, textoVendedor, 'sistema', vendedor.toLowerCase(), 'notificacao_lead');

        // Marca na conversa do lead (aparece no CRM como "Sistema" e é o que impede
        // encaminhar de novo). A IA não vê essa linha (filtrada em carregarHistoricoParaIA).
        await salvarMensagem(telefone, `🔔 Lead encaminhado para ${vendedor} (sem resposta ao bot há 24h)`, 'sistema', vendedor, TIPO_LEAD_ENCAMINHADO);

        await supabase.from('status_de_leads')
                .upsert({ telefone: telefoneLimpo, vendedor, updated_at: new Date().toISOString() }, { onConflict: 'telefone' });

        vendedorPorTelefone[telefone] = vendedor;
        if (!dadosLead[telefone]) {
                dadosLead[telefone] = { nome: null, turma: null, horario: null, confirmado: false, notificado: false, consentimentoDado: true };
        }
        dadosLead[telefone].vendedorEncaminhado = vendedor;
        reengajamentoEnviado[telefone] = true;
        salvarEstadoBot(telefone);

        console.log(`📋 Lead inativo ${telefone} encaminhado para ${vendedor}${vendedorAnterior ? ' (mesmo vendedor do encaminhamento anterior)' : ' (fila)'}`);
}

async function encaminharLeadsInativos() {
        const agora = Date.now();
        try {
                const desde = new Date(agora - JANELA_BUSCA_INATIVOS_MS).toISOString();

                // Mensagens de cliente pro BOT (conversa direta com vendedor fica de fora)
                const { data: msgs, error } = await supabase
                        .from('conversas')
                        .select('telefone, created_at')
                        .eq('de', 'cliente')
                        .neq('tipo', 'conversa_vendedor')
                        .gte('created_at', desde)
                        .order('created_at', { ascending: false })
                        .limit(5000);
                if (error) throw new Error(error.message);

                const ultimaMsgCliente = {};
                for (const m of (msgs || [])) {
                        if (!ultimaMsgCliente[m.telefone]) ultimaMsgCliente[m.telefone] = m.created_at;
                }
                const ignorar = numerosQueNuncaSaoLead();
                Object.keys(aguardandoFeedbackPerdido).forEach(t => ignorar.add(t));
                Object.keys(dadosLead).forEach(t => { if (dadosLead[t]?.confirmado) ignorar.add(t); });

                const limite = agora - INATIVIDADE_ENCAMINHAR_MS;
                const preCandidatos = Object.keys(ultimaMsgCliente)
                        .filter(t => !ignorar.has(t) && new Date(ultimaMsgCliente[t]).getTime() <= limite);
                if (preCandidatos.length === 0) return;

                const eventos = await selectEmLotes('conversas', 'telefone, tipo, created_at', 'telefone', preCandidatos,
                        q => q.in('tipo', [...TIPOS_JA_RESOLVIDOS, ...TIPOS_PESQUISA_PERDIDO, TIPO_LEAD_ENCAMINHADO]));
                const statusRows = await selectEmLotes('status_de_leads', 'telefone, status, nome', 'telefone', preCandidatos);
                const statusPorTel = {};
                const statusRowPorTel = {};
                statusRows.forEach(s => { statusPorTel[s.telefone] = s.status; statusRowPorTel[s.telefone] = s; });

                const escolhidos = escolherLeadsParaEncaminhar({ ultimaMsgCliente, eventos, statusPorTel, agora, ignorar });
                for (const tel of escolhidos) {
                        try {
                                await encaminharLeadInativo(tel, statusRowPorTel[tel]);
                        } catch (e) {
                                // Isolado por lead: uma falha não trava os outros. Sem marcador
                                // salvo, tenta de novo no próximo ciclo (12h).
                                console.error(`❌ Erro ao encaminhar lead inativo ${tel}:`, e.response?.data || e.message);
                        }
                        await new Promise(r => setTimeout(r, 1500));
                }
                if (escolhidos.length) console.log(`📋 ${escolhidos.length} lead(s) inativo(s) encaminhado(s) aos vendedores`);
        } catch (e) {
                console.error('❌ Erro em encaminharLeadsInativos:', e.message);
        }
}

// Roda de 12 em 12h, em horário fixo dentro da escala dos vendedores: 8h e 20h BRT
// (11h e 23h UTC). Horário fixo em vez de "12h depois de subir" pra um deploy de
// madrugada não fazer o template chegar no celular do vendedor de madrugada.
// Com a regra de 24h, o lead chega ao vendedor entre 24h e 36h depois da última mensagem.
function agendarEncaminhamentoLeadsInativos() {
        function msAteProximoDisparo() {
                const agora = new Date();
                const opcoes = [11, 23].map(h => {
                        const d = new Date(agora);
                        d.setUTCHours(h, 0, 0, 0);
                        if (d <= agora) d.setUTCDate(d.getUTCDate() + 1);
                        return d;
                });
                return Math.min(...opcoes.map(d => d - agora));
        }
        function agendar() {
                const ms = msAteProximoDisparo();
                console.log(`⏰ Encaminhamento de leads inativos agendado em ${Math.round(ms / 60000)} minutos`);
                setTimeout(async () => {
                        await encaminharLeadsInativos();
                        agendar();
                }, ms);
        }
        agendar();
}

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
                await sendTemplateGerente('resumo_diario_util', [
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

                // Tenta mandar na hora; se a janela de 24h estiver fechada, fica guardado e
                // entrega sozinho assim que ela (ou o Lucas) responder qualquer mensagem —
                // números-chave já chegaram garantidos via template de qualquer forma. A
                // pendência de hoje substitui qualquer pendência de dias anteriores.
                const itemGerente = await enviarLivreOuItemPendente(NUMERO_GERENTE, msg, 'resumo_diario_detalhado');
                definirPendentes(NUMERO_GERENTE, 'resumo_diario_detalhado', itemGerente ? [itemGerente] : []);
                console.log(itemGerente
                        ? `📊 Resumo diário (detalhado) adiado pra gerente — janela de 24h fechada.`
                        : `📊 Resumo diário (detalhado) enviado para a gerente`);
                if (NUMERO_LUCAS) {
                        const itemLucas = await enviarLivreOuItemPendente(NUMERO_LUCAS, msg, 'resumo_diario_detalhado');
                        definirPendentes(NUMERO_LUCAS, 'resumo_diario_detalhado', itemLucas ? [itemLucas] : []);
                        console.log(itemLucas
                                ? `📊 Resumo diário (detalhado) adiado pro Lucas — janela de 24h fechada.`
                                : `📊 Resumo diário (detalhado) enviado pro Lucas`);
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
                // Checagem diária (primeiros dias do mês) que gera o relatório mensal se
                // ele ainda não existir — ver comentário de garantirRelatorioMensalDoMesAnterior.
                garantirRelatorioMensalDoMesAnterior();
                // Depois da primeira execução, repete a cada 24h
                setInterval(() => {
                        enviarResumoDiario();
                        checkLeadsPausados();
                        garantirRelatorioMensalDoMesAnterior();
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
                        sendTemplateGerente('lembrete_escala', [{ name: 'gerente_nome', value: 'Leybian' }]);
                        salvarMensagem(NUMERO_GERENTE, '[Template: lembrete_escala] Leybian', 'sistema', 'bot', 'lembrete_escala');
                        console.log(`🔔 Lembrete de escala enviado para a gerente`);
                        agendar(); // reagenda para a próxima sexta
                }, ms);
        }

        agendar();
}
// ────────────────────────────────────────────────────────────────────────────

// ── Lembrete semanal de status pros vendedores (toda segunda, 10h BRT) ──────
// Substitui o antigo prompt diário interativo (removido — vendedores não
// respondiam). Esse aqui é só um lembrete passivo, sem esperar resposta por
// WhatsApp: manda a contagem de leads sem status e direciona pro CRM.
async function contarLeadsAbertosPorVendedor(nomeVendedor) {
        const { data: leadsVendedor } = await supabase
                .from('leads_resumo')
                .select('telefone')
                .ilike('vendedor', `%${nomeVendedor}%`)
                .eq('tem_msg_cliente', true);

        if (!leadsVendedor || leadsVendedor.length === 0) return 0;

        const telefones = leadsVendedor.map(l => l.telefone);
        // Em lotes (ver selectEmLotes) — um vendedor pode ter centenas de leads.
        const statusExistentes = await selectEmLotes('status_de_leads', 'telefone, status', 'telefone', telefones);

        const statusMap = {};
        statusExistentes.forEach(s => { statusMap[s.telefone] = s.status; });

        // "Em aberto" = sem entrada em status_de_leads OU ainda com status 'novo'
        return telefones.filter(t => !statusMap[t] || statusMap[t] === 'novo').length;
}

async function enviarLembreteStatusVendedor() {
        for (const [nome, numero] of [
                ['Rebecca', process.env.NUMERO_REBECCA],
                ['Wellington', process.env.NUMERO_PAULO],
                ['Taynara', process.env.NUMERO_TAYNARA]
        ]) {
                if (!numero) continue;
                try {
                        const total = await contarLeadsAbertosPorVendedor(nome);
                        if (total === 0) {
                                console.log(`✅ ${nome}: nenhum lead em aberto, lembrete semanal não enviado.`);
                                continue;
                        }
                        await sendTemplate(numero, 'alerta_status_vendedor', [nome, String(total)]);
                        // Texto exato do template aprovado na Meta, com as variáveis já substituídas
                        const textoTemplate = `Oi, ${nome}! Você tem ${total} lead(s) com atendimento pendente no CRM. Acesse para registrar o status de cada um.`;
                        await salvarMensagem(numero, textoTemplate, 'sistema', nome.toLowerCase(), 'lembrete_status_semanal');
                        console.log(`🔔 Lembrete semanal de status enviado pra ${nome}: ${total} lead(s) em aberto`);
                } catch (e) {
                        console.error(`❌ Erro ao enviar lembrete semanal de status pra ${nome}:`, e.response?.data || e.message);
                }
        }
}

function agendarLembreteStatusVendedor() {
        function msAteProximaSegunda13UTC() {
                const agora = new Date();
                const proxima = new Date(agora);
                // Avança até a próxima segunda (dia 1)
                const diasAteSegunda = (1 - proxima.getUTCDay() + 7) % 7;
                proxima.setUTCDate(proxima.getUTCDate() + diasAteSegunda);
                proxima.setUTCHours(13, 0, 0, 0); // 10h BRT = 13h UTC
                // Se já passou (segunda mas depois das 13h UTC), pega a próxima semana
                if (proxima <= agora) proxima.setUTCDate(proxima.getUTCDate() + 7);
                return proxima - agora;
        }

        function agendar() {
                const ms = msAteProximaSegunda13UTC();
                console.log(`⏰ Lembrete semanal de status agendado em ${Math.round(ms / 60000)} minutos`);
                setTimeout(() => {
                        enviarLembreteStatusVendedor();
                        agendar(); // reagenda para a próxima segunda
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
                        else if (vendedor && vendedor.includes('wellington')) numeroVendedor = process.env.NUMERO_PAULO;
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

        // Tentativa 1 — Groq chave principal.
        // Classificação em massa (classificarLeadsAntigos) dispara centenas/milhares de
        // chamadas seguidas e batia direto no limite de requisições por minuto da Groq
        // (erro 429) — o pause de 300ms entre leads não bastava.
        // NÃO retenta a mesma chave: logs de produção mostraram a Groq 429 de forma
        // CONTÍNUA por 40+ minutos seguidos (milhares de leads, um atrás do outro) — ou
        // seja, não é um limite de curto prazo que vale a pena esperar, é o limite diário
        // esgotado. Esperar e retentar a mesma chave nesse cenário só desperdiça ~5s por
        // lead (o batch de ~1500 leads ia demorar horas à toa) sem nunca dar certo — então
        // ao primeiro 429 já desiste dessa chave e cai direto pro OpenRouter (Tentativa 2),
        // que resolve em frações de segundo por não compartilhar o limite da Groq.
        async function chamarGroqComBackoff(key, tentativasRestantes = 0) {
                try {
                        const resp = await axios.post(
                                'https://api.groq.com/openai/v1/chat/completions',
                                {
                                        // llama-3.3-70b-versatile foi desativado pela Groq em 16/08/2026 —
                                        // era por isso que TODA classificação vinha falhando (100% erro) e
                                        // nenhum lead virava 'perdido' havia semanas. Substituído pelo
                                        // modelo recomendado oficialmente pela Groq na migração.
                                        model: 'openai/gpt-oss-120b',
                                        messages: [
                                                { role: 'system', content: systemPrompt },
                                                { role: 'user', content: texto }
                                        ],
                                        max_tokens: 10,
                                        temperature: 0
                                },
                                { headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 8000 }
                        );
                        return resp.data.choices[0].message.content;
                } catch (err) {
                        if (err.response?.status === 429 && tentativasRestantes > 0) {
                                // O header Retry-After da Groq às vezes manda esperar 1-3min (limite diário
                                // esgotado, não só por minuto) — nesses casos esperar o tempo cheio trava a
                                // fila inteira (um lead atrás do outro, cada um esperando minutos) e o
                                // batch de milhares de leads levaria dias. Capa em 5s: se ainda vier 429
                                // depois disso, desiste dessa chave rápido e cai pro próximo provedor
                                // (OpenRouter/Gemini) em vez de ficar parado esperando a Groq liberar.
                                const retryAfter = Math.min(Number(err.response.headers?.['retry-after']) || 3, 5);
                                console.warn(`⏳ Groq 429 (rate limit) — aguardando ${retryAfter}s e tentando de novo...`);
                                await new Promise(r => setTimeout(r, retryAfter * 1000));
                                return chamarGroqComBackoff(key, tentativasRestantes - 1);
                        }
                        throw err;
                }
        }

        for (const key of [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2].filter(Boolean)) {
                try {
                        const conteudo = await chamarGroqComBackoff(key);
                        return parseStatus(conteudo);
                } catch (err) {
                        console.warn('⚠️ Groq classificação falhou, tentando próximo...', err.message);
                }
        }

        // Tentativa 2 — OpenRouter (deepseek-v4-flash, o modelo mais barato do catálogo —
        // classificação é uma tarefa simples de uma palavra, não precisa do modelo Pro usado
        // no relatório mensal). Entra ANTES do Gemini porque a Groq andou ficando indisponível
        // por longos períodos (limite diário, não só por minuto — ver comentário acima), e o
        // OpenRouter não compartilha esse limite, então tende a resolver mais rápido que
        // esperar a Groq voltar.
        try {
                const conteudo = await chamarOpenRouter([
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: texto }
                ], 10);
                if (conteudo) return parseStatus(conteudo);
        } catch (err) {
                console.warn('⚠️ OpenRouter classificação também falhou, tentando Gemini...', err.message);
        }

        // Tentativa 3 — Gemini (fallback). gemini-2.5-flash-lite também foi descontinuado
        // pelo Google ("no longer available to new users") — troquei pro gemini-2.5-flash
        // normal, que já é usado (e confirmado funcionando) no resto do bot.
        try {
                const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
                const result = await model.generateContent(`${systemPrompt}\n\n${texto}`);
                return parseStatus(result.response.text());
        } catch (err) {
                console.error('❌ Gemini classificação também falhou:', err.message);
                return null;
        }
}

// ── Detecta se a resposta à pesquisa de "lead perdido" indica que a pessoa já se
// matriculou (ex: "achei que já tinha me matriculado", "já sou aluno") — nesse caso
// o combinado (24h depois de virar 'perdido', pergunta o motivo de não ter fechado) não
// faz sentido: a pessoa fechou e o vendedor só não atualizou o CRM. Sem essa checagem o
// bot mandava um "obrigado, isso nos ajuda a melhorar" pra quem já é cliente — como se a
// escola não soubesse que ele fechou, o que é constrangedor. Groq → Gemini, mesmo padrão
// de classificarLeadIA; em caso de falha total assume que NÃO indica matrícula (mantém o
// agradecimento padrão, que é a resposta mais segura na dúvida).
// Classifica a resposta à pesquisa de lead perdido. Tenta Groq (2 chaves) e depois
// OpenRouter. Se tudo falhar, devolve FEEDBACK (o comportamento antigo).
async function classificarRespostaPesquisa(mensagem) {
        const prompt = `A escola de idiomas mandou para esta pessoa a mensagem: "Notamos que você não seguiu com a matrícula. Pode nos contar o que achou do nosso atendimento e o motivo?"

A pessoa respondeu: "${String(mensagem).slice(0, 600)}"

Classifique a resposta em UMA destas categorias e responda só com a palavra:
FEEDBACK = opina sobre o atendimento ou diz o motivo de não ter seguido (inclui "não tenho interesse", "achei caro", "fui pra outra escola", "já me matriculei")
CONFUSO = não entendeu (ex: "?", "como assim?", "que matrícula?"), diz que nunca pediu matrícula, que já é aluno(a) ou que o filho já estuda lá, ou que a mensagem não faz sentido pra ela
INTERESSE = quer informações, preço, horários, ou quer se matricular agora
OUTRO = só cumprimento (ex: "bom dia"), resposta automática de empresa, ou algo sem relação`;
        const extrair = txt => {
                const m = String(txt || '').toUpperCase().match(/FEEDBACK|CONFUSO|INTERESSE|OUTRO/);
                return m ? m[0] : null;
        };
        for (const key of [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2].filter(Boolean)) {
                try {
                        const resp = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                                model: 'openai/gpt-oss-120b',
                                messages: [{ role: 'user', content: prompt }],
                                temperature: 0,
                                reasoning_effort: 'low',
                                max_tokens: 400
                        }, { headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 10000 });
                        const cat = extrair(resp.data?.choices?.[0]?.message?.content);
                        if (cat) return cat;
                } catch (e) {
                        console.warn('⚠️ Groq falhou ao classificar resposta da pesquisa:', e.response?.status || e.message);
                }
        }
        try {
                const cat = extrair(await chamarOpenRouter([{ role: 'user', content: prompt }], 400));
                if (cat) return cat;
        } catch (e) {
                console.warn('⚠️ OpenRouter falhou ao classificar resposta da pesquisa:', e.message);
        }
        return 'FEEDBACK';
}

async function respostaIndicaMatricula(mensagem) {
        const systemPrompt = 'Você analisa a resposta de um ex-lead de uma escola de idiomas à pergunta "por que você não seguiu com a matrícula?". Responda APENAS "sim" se a resposta der a entender que a pessoa JÁ SE MATRICULOU ou já é aluna (ex: "já fiz minha matrícula", "já estou estudando aí", "achei que tinha concluído o cadastro", "sou aluno há X meses", "já pago mensalidade"). Responda APENAS "nao" em qualquer outro caso (dúvida sem confirmar matrícula, reclamação, feedback negativo, desistência, falta de interesse, preço, etc).';

        // O gpt-oss-120b é um modelo de raciocínio: com max_tokens: 5 ele gastava tudo
        // "pensando" e devolvia texto vazio, então "já me matriculei" nunca era detectado
        // e a pessoa recebia o agradecimento padrão em vez do pedido de desculpas.
        const lerSimNao = txt => {
                const m = String(txt || '').toLowerCase().match(/\b(sim|n[aã]o)\b/);
                return m ? m[1] === 'sim' : null;
        };
        for (const key of [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2].filter(Boolean)) {
                try {
                        const resp = await axios.post(
                                'https://api.groq.com/openai/v1/chat/completions',
                                {
                                        model: 'openai/gpt-oss-120b',
                                        messages: [
                                                { role: 'system', content: systemPrompt },
                                                { role: 'user', content: mensagem || '' }
                                        ],
                                        max_tokens: 400,
                                        reasoning_effort: 'low',
                                        temperature: 0
                                },
                                { headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 10000 }
                        );
                        const r = lerSimNao(resp.data?.choices?.[0]?.message?.content);
                        if (r !== null) return r;
                } catch (err) {
                        console.warn('⚠️ Groq falhou ao checar matrícula na resposta de feedback:', err.response?.status || err.message);
                }
        }

        try {
                const r = lerSimNao(await chamarOpenRouter([
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: mensagem || '' }
                ], 400));
                if (r !== null) return r;
        } catch (err) {
                console.warn('⚠️ OpenRouter falhou ao checar matrícula na resposta de feedback, tentando Gemini...', err.message);
        }

        try {
                const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
                const result = await model.generateContent(`${systemPrompt}\n\n${mensagem || ''}`);
                return result.response.text().trim().toLowerCase().includes('sim');
        } catch (err) {
                console.error('❌ Gemini também falhou ao checar matrícula na resposta de feedback:', err.message);
                return false;
        }
}

// ── Consultas `.in()` em lotes ───────────────────────────────────────────────
// O supabase-js manda os filtros na URL. Um `.in('telefone', [...])` com ~1600
// telefones gera uma URL de ~25KB, que estoura o limite e a requisição falha —
// e o supabase-js NÃO lança exceção, só devolve { data: null, error }. Isso fazia
// o código seguir como se a tabela estivesse vazia (confirmado nos logs de
// set-out/2026: classificarLeadsAntigos reprocessava os mesmos ~1600 leads TODO
// dia, sobrescrevendo status e resetando perdido_em). Divide em lotes e lança
// erro se algum lote falhar, pra quem chama nunca confundir "falhou" com "vazio".
const TAMANHO_LOTE_IN = 150;

async function selectEmLotes(tabela, colunas, coluna, valores, filtroExtra = q => q) {
        const resultado = [];
        for (let i = 0; i < valores.length; i += TAMANHO_LOTE_IN) {
                const lote = valores.slice(i, i + TAMANHO_LOTE_IN);
                const { data, error } = await filtroExtra(supabase.from(tabela).select(colunas).in(coluna, lote));
                if (error) throw new Error(`select em ${tabela} falhou: ${error.message}`);
                resultado.push(...(data || []));
        }
        return resultado;
}

async function updateEmLotes(tabela, valoresUpdate, coluna, valores) {
        for (let i = 0; i < valores.length; i += TAMANHO_LOTE_IN) {
                const lote = valores.slice(i, i + TAMANHO_LOTE_IN);
                const { error } = await supabase.from(tabela).update(valoresUpdate).in(coluna, lote);
                if (error) throw new Error(`update em ${tabela} falhou: ${error.message}`);
        }
}

// ── Classifica automaticamente leads com mais de 15 dias sem atividade ───────
async function classificarLeadsAntigos() {
        const limite15d = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();

        // Usa ultimo_contato da leads_resumo (data real da última mensagem)
        // em vez de updated_at do status_de_leads (que muda a cada upsert)
        // Só quem JÁ ESCREVEU alguma vez (tem_msg_cliente). Antes entrava qualquer número com
        // conversa registrada — inclusive contatos que só receberam uma promoção/transmissão do
        // vendedor e nunca responderam. Esses não são leads: viravam "perdido" e recebiam a
        // pesquisa "notamos que você não seguiu com a matrícula" (confirmado: ~47% das pesquisas
        // enviadas até 14/10/2026 foram pra gente que nunca mandou uma mensagem).
        const { data: leadsAntigos } = await supabase
                .from('leads_resumo')
                .select('telefone, vendedor, ultimo_contato')
                .eq('tem_msg_cliente', true)
                .lte('ultimo_contato', limite15d);

        if (!leadsAntigos || leadsAntigos.length === 0) {
                console.log('✅ Nenhum lead com último contato >15d');
                return;
        }

        // Filtra apenas os que ainda estão sem decisão: com status "novo" OU sem
        // NENHUMA linha em status_de_leads. Esse segundo caso é o mais comum — a
        // linha só é criada quando alguém (vendedor no CRM, notificação de lead etc.)
        // grava algo, então lead que nunca teve interação humana simplesmente não
        // existe na tabela. Antes esse filtro exigia `.eq('status','novo')`, o que
        // tornava esses leads (a maioria dos que ficam frios) invisíveis pra
        // classificação automática — o mesmo critério "sem linha OU status='novo'"
        // já é usado em contarLeadsEmAberto(), só não estava replicado aqui.
        const telefones = leadsAntigos.map(l => l.telefone);
        // Em lotes: com `.in()` único essa consulta falhava (URL grande demais),
        // statusMap ficava vazio e TODO lead antigo era tratado como "sem status" —
        // inclusive matriculados/alunos, que eram sobrescritos pra 'perdido'. Se a
        // consulta falhar, aborta: é melhor não classificar nada do que sobrescrever
        // status que o vendedor definiu.
        let statusExistentes;
        try {
                statusExistentes = await selectEmLotes('status_de_leads', 'telefone, status, nome, vendedor', 'telefone', telefones);
        } catch (e) {
                console.error('❌ Classificação de leads antigos abortada — não deu pra ler status_de_leads:', e.message);
                return;
        }

        const statusMap = {};
        (statusExistentes || []).forEach(s => { statusMap[s.telefone] = s; });

        const leads = leadsAntigos
                .filter(l => !statusMap[l.telefone] || statusMap[l.telefone].status === 'novo')
                .map(l => ({
                        telefone: l.telefone,
                        nome: statusMap[l.telefone]?.nome || null,
                        vendedor: statusMap[l.telefone]?.vendedor || l.vendedor || null,
                }));

        if (leads.length === 0) {
                console.log('✅ Nenhum lead antigo (>15d) com status "novo" para classificar');
                return;
        }

        console.log(`🤖 Classificando ${leads.length} lead(s) com mais de 15 dias...`);
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

                        const updatePayload = { telefone: lead.telefone, status };
                        // Marca o momento da transição pra 'perdido' — usado pela pesquisa de
                        // feedback (enviarPesquisasLeadsPerdidos), que dispara 24h depois disso.
                        // Vale tanto pra essa classificação automática (15+ dias sem contato)
                        // quanto pra quando um vendedor marca perdido na hora pelo CRM — nos dois
                        // casos o combinado é: 24h depois de virar 'perdido', manda a pesquisa.
                        if (status === 'perdido') {
                                updatePayload.perdido_em = new Date().toISOString();
                                updatePayload.feedback_perda_enviado = false;
                        }
                        // upsert (não update): boa parte desses leads não tem linha em
                        // status_de_leads ainda (ver filtro acima), então um simples UPDATE
                        // afetaria 0 linhas e a classificação se perderia silenciosamente.
                        if (lead.nome) updatePayload.nome = lead.nome;
                        if (lead.vendedor) updatePayload.vendedor = lead.vendedor;
                        await supabase.from('status_de_leads')
                                .upsert(updatePayload, { onConflict: 'telefone' });

                        contagem[status] = (contagem[status] || 0) + 1;
                        console.log(`🤖 ${lead.nome || lead.telefone} → ${status}`);

                        // Pausa entre chamadas para não sobrecarregar Groq — 300ms não bastava
                        // (batch de ~1500 leads gerava 429 constante, ver chamarGroqComBackoff acima).
                        // 800ms mantém uma taxa sustentada mais segura; o backoff no 429 cobre picos.
                        await new Promise(r => setTimeout(r, 800));
                } catch (err) {
                        console.error(`❌ Erro ao classificar ${lead.telefone}:`, err.message);
                        contagem.erro++;
                }
        }

        console.log(`✅ Classificação concluída:`, contagem);
}

// ── Processa backlog: IA classifica leads antigos (>15 dias) e avisa a gerente ──
// Antes também mandava um prompt interativo pro vendedor perguntando "como ficou"
// cada lead recente (≤15 dias) — removido porque os vendedores não respondiam,
// virando só ruído no WhatsApp deles sem nenhuma atualização de status real. O
// status agora é atualizado direto pelo vendedor no CRM.
async function processarBacklogNovos() {
        await classificarLeadsAntigos();
}
// ────────────────────────────────────────────────────────────────────────────

// ── Pesquisa de "lead perdido" ──────────────────────────────────────────────
// 24h depois do status virar 'perdido' — seja o vendedor marcando na hora pelo CRM,
// seja a classificação automática por 15+ dias sem contato (classificarLeadsAntigos)
// — manda um TEMPLATE aprovado pela Meta perguntando o que o lead achou do
// atendimento e o motivo de não ter fechado a matrícula. Precisa ser template (não
// texto livre): por definição um lead "perdido" já está inativo, então a janela de
// 24h quase sempre está fechada — template é o único jeito confiável de alcançar ele
// mesmo assim. Sai pelo número PRINCIPAL do bot.
async function enviarPesquisasLeadsPerdidos() {
        const limite24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const limiteExpirado = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
        const limiteContatoAntigo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

        // Rede de segurança: se por algum motivo esse sweep ficar dias sem rodar (bug,
        // deploy, API fora do ar), NÃO manda uma pesquisa "atrasada" pra quem já
        // esqueceu do assunto há quase uma semana — só zera perdido_em pra tirar da
        // fila. Preferimos silenciosamente não perguntar a mandar fora de hora.
        const { data: expirados } = await supabase
                .from('status_de_leads')
                .select('telefone')
                .eq('status', 'perdido')
                .eq('feedback_perda_enviado', false)
                .not('perdido_em', 'is', null)
                .lt('perdido_em', limiteExpirado);
        if (expirados && expirados.length > 0) {
                try {
                        await updateEmLotes('status_de_leads', { perdido_em: null }, 'telefone', expirados.map(l => l.telefone));
                        console.log(`⏳ ${expirados.length} pesquisa(s) de feedback expirada(s) sem enviar (mais de 5 dias na fila)`);
                } catch (e) {
                        console.error('❌ Erro ao tirar pesquisas expiradas da fila:', e.message);
                }
        }

        // Corte por idade do CONTATO (não da classificação): a classificação em massa
        // de leads antigos (classificarLeadsAntigos) roda sobre qualquer um com 15+ dias
        // sem contato, sem limite superior — então um catch-up de backlog pode marcar
        // como 'perdido' gente que não fala com a escola há meses. Não faz sentido
        // mandar "sentimos sua falta" pra alguém que sumiu há 90+ dias. Só entra na fila
        // de envio quem teve ÚLTIMA mensagem (leads_resumo.ultimo_contato) nos últimos
        // 30 dias — os demais saem da fila silenciosamente, igual ao caso "expirado" acima.
        const { data: candidatosFila } = await supabase
                .from('status_de_leads')
                .select('telefone')
                .eq('status', 'perdido')
                .eq('feedback_perda_enviado', false)
                .not('perdido_em', 'is', null);
        if (candidatosFila && candidatosFila.length > 0) {
                // Em lotes — com `.in()` único essa consulta falhava calada, contatosRecentes
                // vinha null e o filtro de 30 dias não funcionava (o update de remoção também
                // falhava, então os mesmos ~1600 "removidos" voltavam todo dia). Se falhar,
                // aborta o envio do dia em vez de mandar pesquisa pra quem não deveria.
                try {
                        const contatosRecentes = await selectEmLotes(
                                'leads_resumo', 'telefone', 'telefone',
                                candidatosFila.map(l => l.telefone),
                                q => q.gte('ultimo_contato', limiteContatoAntigo)
                        );
                        const recentesSet = new Set(contatosRecentes.map(l => l.telefone));
                        const contatoAntigo = candidatosFila.filter(l => !recentesSet.has(l.telefone));
                        if (contatoAntigo.length > 0) {
                                await updateEmLotes('status_de_leads', { perdido_em: null }, 'telefone', contatoAntigo.map(l => l.telefone));
                                console.log(`⏳ ${contatoAntigo.length} pesquisa(s) de feedback removida(s) da fila (último contato há mais de 30 dias)`);
                        }
                } catch (e) {
                        console.error('❌ Pesquisas de lead perdido do dia canceladas — falha ao filtrar a fila:', e.message);
                        return;
                }
        }

        // Limite diário de 50 envios: evita disparar um lote grande de uma vez (ex: no
        // dia em que o limiar de classificação automática mudou de 30 pra 15 dias, ou se
        // o envio ficar alguns dias parado por algum motivo). Pega os mais antigos na
        // fila primeiro (perdido_em ascendente), então quem está esperando há mais tempo
        // é sempre priorizado — o resto simplesmente continua na fila pro dia seguinte.
        const LIMITE_DIARIO_PESQUISAS = 50;

        // Decisão do Lucas (04/10/2026): a pesquisa só vale pra quem virou 'perdido' DEPOIS
        // desse corte. Os ~1.900 que já estavam perdidos (muitos por causa do bug da
        // classificação em massa) ficam de fora pra sempre, mesmo que algo volte a
        // preencher perdido_em neles.
        const INICIO_PESQUISAS_PERDIDOS = '2026-10-04T23:00:00.000Z';

        const { data: leads, error } = await supabase
                .from('status_de_leads')
                .select('telefone, nome, vendedor, perdido_em')
                .eq('status', 'perdido')
                .eq('feedback_perda_enviado', false)
                .not('perdido_em', 'is', null)
                .gte('perdido_em', INICIO_PESQUISAS_PERDIDOS)
                .lte('perdido_em', limite24h)
                .order('perdido_em', { ascending: true })
                .limit(LIMITE_DIARIO_PESQUISAS);

        if (error) {
                console.error('❌ Erro ao buscar leads perdidos p/ pesquisa:', error.message);
                return;
        }
        if (!leads || leads.length === 0) return;

        // Trava de segurança: nunca manda a pesquisa "sentimos sua falta" pra quem o
        // histórico mostra que já foi ALUNO em algum momento — isso significa que o
        // vendedor esqueceu de atualizar o status no CRM depois da matrícula, e a
        // classificação automática (15+ dias sem contato) marcou como 'perdido' por
        // engano. Sem essa trava a pessoa recebe uma pesquisa sem sentido perguntando
        // por que não se matriculou. Também zera perdido_em pra tirar da fila (igual
        // aos outros filtros acima), já que o vendedor precisa corrigir o status manual.
        const { data: msgsAluno } = await supabase
                .from('conversas')
                .select('telefone')
                .in('telefone', leads.map(l => l.telefone))
                .eq('tipo', 'aluno');
        const telefonesAluno = new Set((msgsAluno || []).map(m => m.telefone));
        let leadsParaEnviar = leads;
        if (telefonesAluno.size > 0) {
                leadsParaEnviar = leads.filter(l => !telefonesAluno.has(l.telefone));
                await supabase.from('status_de_leads')
                        .update({ perdido_em: null })
                        .in('telefone', [...telefonesAluno]);
                console.log(`🎓 ${telefonesAluno.size} pesquisa(s) de feedback bloqueada(s) — histórico mostra que já é aluno (provável status desatualizado pelo vendedor)`);
        }
        if (leadsParaEnviar.length === 0) return;

        // Trava: só manda a pesquisa pra quem já escreveu alguma vez. Quem só recebeu uma
        // transmissão/promoção do vendedor e nunca respondeu não é lead — sai da fila de vez
        // (marcado como enviado pra não voltar). Rede de segurança além do filtro em
        // classificarLeadsAntigos, que cobre o caminho automático; aqui cobre também o
        // status 'perdido' marcado à mão no CRM.
        try {
                const comMsgCliente = await selectEmLotes(
                        'leads_resumo', 'telefone', 'telefone',
                        leadsParaEnviar.map(l => l.telefone),
                        q => q.eq('tem_msg_cliente', true)
                );
                const setComMsg = new Set(comMsgCliente.map(l => l.telefone));
                const semMsg = leadsParaEnviar.filter(l => !setComMsg.has(l.telefone));
                if (semMsg.length > 0) {
                        await updateEmLotes('status_de_leads', { perdido_em: null, feedback_perda_enviado: true }, 'telefone', semMsg.map(l => l.telefone));
                        leadsParaEnviar = leadsParaEnviar.filter(l => setComMsg.has(l.telefone));
                        console.log(`🚫 ${semMsg.length} pesquisa(s) de feedback bloqueada(s) — contato nunca escreveu (só recebeu mensagem do vendedor)`);
                }
        } catch (e) {
                console.error('❌ Pesquisas de lead perdido do dia canceladas — não deu pra checar quem já escreveu:', e.message);
                return;
        }
        if (leadsParaEnviar.length === 0) return;

        // O nome em status_de_leads.nome pode ter sido digitado manualmente pelo
        // vendedor no CRM (ex: copiado da agenda dele) — não necessariamente o nome
        // que o próprio lead usou na conversa. Pra pesquisa de feedback só usamos o
        // nome se ele foi CONFIRMADO pelo lead através do fluxo de coleta de dados do
        // bot, que ecoa de volta uma mensagem "👤 Nome: X" só depois que o lead
        // informou o nome dele mesmo. Busca isso direto na tabela conversas (fonte
        // persistida, funciona mesmo após restart) em vez de confiar em status_de_leads.nome.
        const telefones = leadsParaEnviar.map(l => l.telefone);
        const { data: msgsNome } = await supabase
                .from('conversas')
                .select('telefone, mensagem')
                .in('telefone', telefones)
                .eq('de', 'bot')
                .ilike('mensagem', '%Nome:%');
        const nomeConfirmadoPorTelefone = {};
        (msgsNome || []).forEach(m => {
                if (nomeConfirmadoPorTelefone[m.telefone]) return; // já achou, mantém o primeiro
                const match = (m.mensagem || '').match(RE_CONF_NOME);
                if (!match) return;
                // "Clara (responsável: Ana)" → a pesquisa vai pro celular da Ana
                const resp = match[1].match(/\(respons[áa]vel:\s*([^)]+)\)/i);
                const nome = (resp ? resp[1] : match[1].replace(/\(.*?\)/g, '')).trim();
                if (nome) nomeConfirmadoPorTelefone[m.telefone] = nome;
        });

        console.log(`📮 Enviando pesquisa de feedback (template) pra ${leadsParaEnviar.length} lead(s) perdido(s) (limite diário: ${LIMITE_DIARIO_PESQUISAS})...`);

        for (const lead of leadsParaEnviar) {
                try {
                        // Nunca usa lead.nome (CRM/vendedor) aqui — só o nome que o próprio lead
                        // confirmou na conversa com o bot, se houver.
                        const nomeLead = nomeConfirmadoPorTelefone[lead.telefone] || '';
                        const textoTemplate = `Oi, ${nomeLead || 'tudo bem'}! Aqui é do CNA Recreio 😊 Notamos que você não seguiu com a matrícula. Pode nos contar rapidinho o que achou do nosso atendimento e o motivo? Isso nos ajuda muito a melhorar 🙏`;

                        await sendTemplate(lead.telefone, 'pesquisa_lead_perdido', [nomeLead || 'tudo bem']);
                        await salvarMensagem(lead.telefone, textoTemplate, 'sistema', 'bot', 'pesquisa_perdido');
                        aguardandoFeedbackPerdido[lead.telefone] = { vendedorSalvar: 'bot' };
                        salvarEstadoBot(lead.telefone);

                        // Só marca como enviado DEPOIS do sendTemplate ter sucesso — se falhar
                        // (ex: template ainda não aprovado), tenta de novo no próximo sweep.
                        await supabase.from('status_de_leads')
                                .update({ feedback_perda_enviado: true })
                                .eq('telefone', lead.telefone);

                        console.log(`📮 Pesquisa de feedback enviada pra ${lead.telefone}`);
                        await new Promise(r => setTimeout(r, 1000));
                } catch (err) {
                        console.error(`❌ Erro ao enviar pesquisa pra ${lead.telefone}:`, err.response?.data || err.message);
                }
        }
}

// Agenda o disparo diário (seg-sex, 13h BRT) da pesquisa de leads perdidos, em vez de
// ficar checando a cada 30min. Mesmo padrão de self-reschedule usado no lembrete
// semanal de status dos vendedores.
function agendarPesquisasLeadsPerdidos() {
        function msAteProximoDisparo() {
                const agora = new Date();
                const proximo = new Date(agora);
                proximo.setUTCHours(16, 0, 0, 0); // 13h BRT = 16h UTC
                if (proximo <= agora) proximo.setUTCDate(proximo.getUTCDate() + 1);
                // Pula fim de semana (domingo=0, sábado=6)
                while (proximo.getUTCDay() === 0 || proximo.getUTCDay() === 6) {
                        proximo.setUTCDate(proximo.getUTCDate() + 1);
                }
                return proximo - agora;
        }
        function agendar() {
                const ms = msAteProximoDisparo();
                console.log(`⏰ Pesquisa de leads perdidos agendada em ${Math.round(ms / 60000)} minutos`);
                setTimeout(() => {
                        enviarPesquisasLeadsPerdidos();
                        agendar();
                }, ms);
        }
        agendar();
}
// ────────────────────────────────────────────────────────────────────────────

// ── Classificação automática de leads antigos (backlog) ─────────────────────
// Antes só rodava se alguém batesse manualmente em GET /processar-novos — não
// havia nenhum agendamento, então leads parados >15 dias como 'novo' nunca
// viravam 'perdido' sozinhos, e a pesquisa de feedback (que só busca leads com
// status='perdido') ficava sem gente pra mandar mesmo com vários leads frios.
// Roda 1x por dia, antes do horário da pesquisa de leads perdidos (13h BRT).
function agendarClassificacaoLeadsAntigos() {
        function msAteProximoDisparo() {
                const agora = new Date();
                const proximo = new Date(agora);
                proximo.setUTCHours(13, 0, 0, 0); // 10h BRT = 13h UTC
                if (proximo <= agora) proximo.setUTCDate(proximo.getUTCDate() + 1);
                return proximo - agora;
        }
        function agendar() {
                const ms = msAteProximoDisparo();
                console.log(`⏰ Classificação de leads antigos agendada em ${Math.round(ms / 60000)} minutos`);
                setTimeout(() => {
                        processarBacklogNovos();
                        agendar();
                }, ms);
        }
        agendar();
}
// ────────────────────────────────────────────────────────────────────────────

// ── Relatório Mensal via OpenRouter ─────────────────────────────────────────
// opts.preview=true monta o relatório (mesma lógica, mesmos dados) e RETORNA o texto,
// sem mandar nada pelo WhatsApp — pra dar pra revisar antes de disparar de verdade.
// O gatilho automático antigo só disparava o relatório mensal se o servidor
// estivesse de pé bem no instante em que o relógio virasse o dia 1 (checagem
// diária às 11:00 UTC). Se o Railway reiniciar/redeployar entre a última
// checagem do dia 1 e a próxima (ex: redeploy no meio do dia 1, depois das
// 11:00 UTC), `agendarResumoDiario()` reagenda pra 11:00 UTC do dia 2 — e como
// a condição era `dia === 1`, o relatório do mês anterior simplesmente nunca
// era gerado. Essa função substitui a checagem por dia fixo: todo dia (até o
// 5º dia do mês, pra não ficar tentando pra sempre se a IA estiver fora do ar)
// verifica se já existe relatório salvo pro mês anterior e, se não existir,
// gera agora — autocorrige independente de quando o servidor esteve no ar.
async function garantirRelatorioMensalDoMesAnterior() {
        try {
                const agora = new Date();
                if (agora.getUTCDate() > 5) return; // só tenta recuperar nos primeiros dias do mês
                const mesAnterior = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - 1, 1));
                const mesAno = `${mesAnterior.getUTCFullYear()}-${String(mesAnterior.getUTCMonth() + 1).padStart(2, '0')}`;
                const { data, error } = await supabase
                        .from('relatorios_mensais')
                        .select('mes_ano')
                        .eq('mes_ano', mesAno)
                        .maybeSingle();
                if (error) { console.error('❌ Erro ao checar relatório mensal pendente:', error.message); return; }
                if (!data) {
                        console.log(`📋 Relatório mensal de ${mesAno} ainda não existe — gerando agora (checagem diária de recuperação).`);
                        gerarRelatorioMensal();
                }
        } catch (e) {
                console.error('❌ Erro ao checar relatório mensal pendente:', e.message);
        }
}

async function gerarRelatorioMensal(opts = {}) {
        const preview = !!opts.preview;
        if (!NUMERO_GERENTE || !OPENROUTER_API_KEY) return null;
        if (relatorioEmAndamento) { console.log('⚠️ Relatório já em andamento, ignorando.'); return null; }
        relatorioEmAndamento = true;
        console.log(preview ? '📋 Gerando PREVIEW do relatório mensal (não envia nada)...' : '📋 Gerando relatório mensal...');

        // Trava de segurança: se alguma query travar sem nunca dar erro nem timeout (ex:
        // uma chamada ao Supabase pendurada), essa flag ficaria presa em `true` pra
        // sempre e ninguém mais conseguiria gerar relatório (nem preview) até reiniciar
        // o servidor no Railway — foi exatamente o que aconteceu num teste. Depois de 5
        // min, destrava à força mesmo que a geração original ainda esteja pendurada.
        const travaSegurancaId = setTimeout(() => {
                if (relatorioEmAndamento) {
                        console.error('⏱️ Relatório mensal travado por mais de 5 min — destravando à força.');
                        relatorioEmAndamento = false;
                }
        }, 5 * 60 * 1000);

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

                // Filtra números internos (gerente/Lucas) e qualquer DDI +34 (Espanha) — esses
                // números são donas/sócias do curso conversando com os vendedores, não leads de
                // verdade. Sem esse filtro eles entravam na amostra e a IA os analisava como se
                // fossem clientes perdendo a venda, o que não faz sentido nenhum.
                const leadsDoMesFiltrado = (leadsDoMes || []).filter(l => {
                        const tel = String(l.telefone || '').replace(/\D/g, '');
                        return !NUMEROS_INTERNOS_GESTAO.has(tel) && !tel.startsWith('34');
                });
                console.log(`📋 Leads encontrados: ${leadsDoMes?.length || 0} (${leadsDoMesFiltrado.length} após filtrar números internos/+34)`);

                // 2. Todos os status
                const { data: todosStatus } = await supabase
                        .from('status_de_leads')
                        .select('telefone, status, nome, anotacao, data_matricula, vendedor');

                // 3. Amostra de conversas POR VENDEDOR — cada um precisa da própria amostra
                // (matriculados + perdidos + em andamento) pra IA conseguir avaliar o
                // atendimento individual de cada um. Antes a amostra era genérica (10
                // convertidos + 10 perdidos misturados de qualquer vendedor), então um
                // vendedor com poucos leads podia ficar sem nenhuma conversa representada
                // e não dava pra dar feedback individual de verdade.
                const statusMap = {};
                (todosStatus || []).forEach(s => { statusMap[s.telefone] = s; });

                const porVendedorLeads = {};
                leadsDoMesFiltrado.forEach(l => {
                        const v = l.vendedor || 'desconhecido';
                        if (!porVendedorLeads[v]) porVendedorLeads[v] = [];
                        porVendedorLeads[v].push(l);
                });

                let conversasTexto = '';
                for (const [vendedorNome, leadsVend] of Object.entries(porVendedorLeads)) {
                        // "desconhecido" = leads sem vendedor específico atribuído (ex: só bot,
                        // sem confirmação) — não faz sentido avaliar "atendimento" de ninguém aqui.
                        if (vendedorNome === 'desconhecido') continue;

                        const matriculadosV = leadsVend.filter(l => statusMap[l.telefone]?.status === 'matriculado');
                        const perdidosV     = leadsVend.filter(l => statusMap[l.telefone]?.status === 'perdido');
                        const outrosV       = leadsVend.filter(l => !['matriculado', 'perdido'].includes(statusMap[l.telefone]?.status));
                        // Prioriza matriculados e perdidos (mais informativos pra entender o que
                        // funciona e o que não funciona), com uma pitada de "em andamento" pra
                        // ver como ele conduz um atendimento ainda em curso.
                        const amostraVend = [...matriculadosV.slice(0, 4), ...perdidosV.slice(0, 4), ...outrosV.slice(0, 2)];

                        conversasTexto += `\n\n=========== VENDEDOR: ${vendedorNome} (${leadsVend.length} lead(s) no mês) ===========`;
                        for (const lead of amostraVend) {
                                const { data: msgs } = await supabase
                                        .from('conversas')
                                        .select('mensagem, de, created_at')
                                        .eq('telefone', lead.telefone)
                                        .order('created_at', { ascending: true })
                                        .limit(15);

                                if (!msgs || msgs.length === 0) continue;
                                const st = statusMap[lead.telefone];
                                conversasTexto += `\n--- Lead: ${st?.nome || lead.telefone} | Status: ${st?.status || 'sem status'} ---\n`;
                                // Mídias (áudio/imagem/vídeo/documento) chegam como um rótulo tipo
                                // "🎤 Áudio recebido" — o sistema NUNCA transcreve/lê o conteúdo. Marca
                                // explicitamente como [MÍDIA - conteúdo desconhecido] pra IA não confundir
                                // isso com uma mensagem de texto normal e inventar o que foi dito nela.
                                const rotulosMidia = ['📷 Imagem recebida', '🎤 Áudio recebido', '🎥 Vídeo recebido', '📄 Documento recebido', '🌟 Figurinha recebida'];
                                msgs.forEach(m => {
                                        const ehMidia = rotulosMidia.some(r => (m.mensagem || '').startsWith(r)) || /^\[(áudio|imagem|vídeo|documento)/i.test(m.mensagem || '');
                                        const texto = ehMidia ? `${m.mensagem} [MÍDIA - conteúdo desconhecido, sistema não transcreve]` : (m.mensagem || '').substring(0, 200);
                                        conversasTexto += `[${m.de}]: ${texto}\n`;
                                });

                                // Feedback direto do lead sobre por que não fechou (pesquisa pós-"perdido")
                                // — busca à parte porque a conversa às vezes é longa e o feedback,
                                // vindo depois, ficaria de fora do limit(15) acima.
                                if (st?.status === 'perdido') {
                                        const { data: feedback } = await supabase
                                                .from('conversas')
                                                .select('mensagem, de')
                                                .eq('telefone', lead.telefone)
                                                .eq('tipo', 'feedback_perdido')
                                                .eq('de', 'cliente')
                                                .order('created_at', { ascending: true })
                                                .limit(1);
                                        if (feedback && feedback.length > 0) {
                                                conversasTexto += `[FEEDBACK DO LEAD sobre por que não fechou]: ${feedback[0].mensagem.substring(0, 300)}\n`;
                                        }
                                }
                        }
                }
                const total       = leadsDoMesFiltrado.length;
                const viaBot      = leadsDoMesFiltrado.filter(l => l.tem_msg_bot).length;
                const contStatus  = { novo: 0, em_andamento: 0, matriculado: 0, aluno: 0, pausado: 0, perdido: 0, sem_status: 0 };
                const comStatus   = new Set((todosStatus || []).map(s => s.telefone));

                // Mês-alvo deste relatório no formato "YYYY-MM", pra comparar com
                // `data_matricula` (que o vendedor pode ter setado pra um mês diferente
                // do mês em que o lead teve atividade). Se `data_matricula` estiver
                // preenchida, ela manda — se estiver vazia, cai no comportamento antigo
                // (conta no mês em que o lead teve contato/status atual).
                const targetMonthStr = `${inicioMes.getUTCFullYear()}-${String(inicioMes.getUTCMonth() + 1).padStart(2, '0')}`;
                const telefonesJaContados = new Set(leadsDoMesFiltrado.map(l => l.telefone));
                // Matrículas com data_matricula explicitamente setada pra este mês —
                // contam aqui independente de terem tido atividade de contato no mês.
                const matriculadosPorDataExplicita = (todosStatus || []).filter(s =>
                        s.status === 'matriculado' && s.data_matricula && s.data_matricula.slice(0, 7) === targetMonthStr
                );
                const telefonesExplicitos = new Set(matriculadosPorDataExplicita.map(s => s.telefone));

                leadsDoMesFiltrado.forEach(l => {
                        const st = statusMap[l.telefone];
                        const s  = st?.status;
                        if (s === 'matriculado') {
                                // Só conta neste mês se não tiver data_matricula (fallback pro
                                // comportamento antigo) ou se a data_matricula apontar pra este mês.
                                // Se apontar pra outro mês, a matrícula é contada lá, não aqui.
                                if (!st.data_matricula || telefonesExplicitos.has(l.telefone)) contStatus.matriculado++;
                        } else if (s && contStatus[s] !== undefined) {
                                contStatus[s]++;
                        } else if (!comStatus.has(l.telefone)) {
                                contStatus.sem_status++;
                        }
                });
                // Matrículas com data_matricula neste mês mas sem atividade de contato
                // neste mês (ex: lead conversou em outro mês, matrícula foi remarcada).
                matriculadosPorDataExplicita.forEach(s => {
                        if (!telefonesJaContados.has(s.telefone)) contStatus.matriculado++;
                });

                const porVendedor = {};
                leadsDoMesFiltrado.forEach(l => {
                        const v = l.vendedor || 'desconhecido';
                        if (!porVendedor[v]) porVendedor[v] = { total: 0, convertidos: 0 };
                        porVendedor[v].total++;
                        const st = statusMap[l.telefone];
                        if (st?.status === 'matriculado' && (!st.data_matricula || telefonesExplicitos.has(l.telefone))) {
                                porVendedor[v].convertidos++;
                        }
                });
                // Mesma lógica acima, pro corte por vendedor: soma conversões cuja
                // data_matricula aponta pra este mês mas que não tiveram atividade de
                // contato neste mês (não entraram no loop de cima). Usa o vendedor
                // salvo em status_de_leads pra atribuição, já que pode não ter
                // registro em leads_resumo pra este mês.
                matriculadosPorDataExplicita.forEach(s => {
                        if (telefonesJaContados.has(s.telefone)) return;
                        const v = s.vendedor || 'desconhecido';
                        if (!porVendedor[v]) porVendedor[v] = { total: 0, convertidos: 0 };
                        porVendedor[v].convertidos++;
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

POR VENDEDOR (números):
${vendedoresTexto}

AMOSTRA DE CONVERSAS POR VENDEDOR (matriculados, perdidos e em andamento de cada um):
${conversasTexto.substring(0, 14000)}

REGRA IMPORTANTE SOBRE MÍDIAS: o sistema não transcreve áudio, imagem, vídeo ou
documento — você só sabe que uma mídia FOI ENVIADA, nunca o que ela dizia ou
mostrava. Mensagens marcadas como "[MÍDIA - conteúdo desconhecido...]" são só
isso: um evento de envio. NUNCA invente ou presuma o conteúdo (ex: não diga que
um áudio "explicou os diferenciais da turma" ou "criou conexão emocional") —
isso não é informação real, é alucinação. Você pode no máximo comentar o
COMPORTAMENTO (ex: "respondeu com áudio em vez de texto", "mandou 2 áudios
seguidos sem esperar resposta"), nunca o conteúdo da mídia em si.

Gere um relatório com exatamente estas seções:
1. RESUMO EXECUTIVO (3-4 linhas)
2. PERFORMANCE DOS VENDEDORES — analise CADA vendedor separadamente, com um bloco
   próprio por nome, lendo as conversas reais dele na amostra acima (não invente, use
   só o que está lá). Para cada vendedor, cubra:
   - Pontos fortes: o que ele faz bem no atendimento (ex: rapidez, clareza, simpatia,
     como contorna objeções, como conduz o fechamento).
   - Pontos a melhorar: erros ou hábitos concretos observados nas conversas dele (ex:
     demora pra responder, não faz perguntas de qualificação, não retoma leads parados,
     não personaliza a mensagem, esquece de pedir o fechamento).
   - Sugestões práticas: 2-3 ações específicas pra esse vendedor melhorar atendimento e
     fechar mais matrículas no próximo mês.
   Quando um lead tiver a linha "[FEEDBACK DO LEAD sobre por que não fechou]", use esse
   relato do PRÓPRIO lead como fonte principal (é mais confiável que inferir só pela
   conversa do vendedor) — cite o que ele disse ao avaliar pontos a melhorar do vendedor.
3. PRINCIPAIS OBJEÇÕES DOS LEADS (o que mais apareceu nas conversas, geral — dê peso
   maior às objeções que vieram direto do feedback do lead, não só do que o vendedor
   registrou)
4. PADRÕES IDENTIFICADOS (horários, perfil dos leads, o que funcionou)
5. RECOMENDAÇÕES PARA O PRÓXIMO MÊS (3 a 5 ações práticas e concretas, gerais pra equipe)

REGRA CONTRA GENÉRICO: é proibido usar conselho de manual sem amarrar num caso real
da amostra acima. Frases como "padronizar o processo", "criar um checklist",
"treinar a equipe em técnicas de fechamento", "melhorar o acompanhamento" só podem
aparecer se vierem IMEDIATAMENTE acompanhadas do caso específico que gerou aquela
sugestão (nome/telefone do lead, o que aconteceu, o que deveria ter sido diferente).
Se você não tem um exemplo concreto na amostra pra justificar um ponto, não inclua
esse ponto — é melhor um relatório mais curto e específico do que um longo e vago.
Toda sugestão de "Recomendações para o próximo mês" precisa citar pelo menos um
padrão ou caso real observado nos dados acima, não pode ser um conselho genérico
que serviria pra qualquer equipe de vendas do mundo.

Seja objetivo e direto, mas não corte a seção 2 — ela é a mais importante deste
relatório. Máximo 2600 palavras no total.`;

                // 6. Chamada OpenRouter com fallback entre modelos. Antes usava V4 FLASH — a
                // variante "leve" da DeepSeek (13B parâmetros ativos de 284B), otimizada pra
                // velocidade/custo, não pra profundidade — e o relatório saía raso/genérico.
                // Trocado pra V4 PRO: mesma geração, mas o modelo "cheio" (49B ativos de 1,6T),
                // feito especificamente pra raciocínio avançado e síntese de grande volume de
                // informação — exatamente o que um relatório mensal precisa. Roda 1x/mês, então
                // o custo maior (~$0,02-0,05 por relatório) é irrelevante. V4 Flash entra como
                // fallback pago antes dos gratuitos, que ficam só como rede de segurança.
                const modelos = [
                        'deepseek/deepseek-v4-pro-0813',
                        'deepseek/deepseek-v4-flash-0731',
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
                                        // Análise por vendedor deixou o relatório mais longo — 1500 tokens
                                        // cortava a seção de performance no meio às vezes, e mesmo 2200
                                        // ainda cortava com 3 vendedores (confirmado via preview: relatório
                                        // de agosto/2026 parou no meio da Taynara, sem as seções 3-5). Subiu
                                        // pra 5000 com folga — custo extra é insignificante na DeepSeek V4
                                        // Flash (report roda só 1x/mês).
                                        max_tokens: 5000
                                }, {
                                        headers: {
                                                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                                                'Content-Type': 'application/json'
                                        },
                                        timeout: 60000
                                });
                                const conteudo = (response.data?.choices?.[0]?.message?.content || '').trim();
                                // Confirmado em produção (relatório de setembro/2026, via logs do
                                // Railway): deepseek-v4-pro devolveu `content` vazio (modelo de
                                // raciocínio que às vezes gasta todo o max_tokens "pensando" e não
                                // sobra nada pro texto final) e foi pulado — isso já funcionava, pois
                                // string vazia é falsy. O problema real foi o PRÓXIMO da lista,
                                // deepseek-v4-flash: devolveu uma resposta não-vazia mas bem curta
                                // (o relatório inteiro, cabeçalho + análise, coube num único bloco de
                                // 1500 caracteres — longe das ~5 seções/2600 palavras pedidas no
                                // prompt), e como qualquer string não-vazia era truthy, foi aceita
                                // assim mesmo. Agora exige um tamanho mínimo compatível com um
                                // relatório de verdade (bem acima do que uma resposta truncada/rasa
                                // teria) antes de aceitar a resposta do modelo.
                                if (conteudo.length > 800) {
                                        analise = conteudo;
                                        console.log(`📋 Modelo usado: ${modelo} (${conteudo.length} caracteres)`);
                                        break;
                                }
                                console.warn(`⚠️ Modelo ${modelo} devolveu conteúdo vazio/curto demais (${conteudo.length} chars). Prévia: "${conteudo.substring(0, 200)}". Tentando próximo...`);
                        } catch (e) {
                                console.warn(`⚠️ Modelo ${modelo} falhou: ${e.response?.status || e.message}. Tentando próximo...`);
                        }
                }
                if (!analise) analise = 'Não foi possível gerar análise automática este mês (todos os modelos falharam ou devolveram conteúdo vazio).';

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

                // Modo preview: já temos o texto completo pronto (relatorioCompleto) — devolve
                // e sai sem chamar sendTemplateGerente/enviarLivreOuItemPendente, então nenhuma
                // mensagem real é disparada.
                if (preview) {
                        console.log('📋 Preview do relatório mensal gerado (nada foi enviado).');
                        return relatorioCompleto;
                }

                // Salva no Supabase pra aparecer na aba "Relatório Mensal" do CRM — não depende
                // do WhatsApp ter entregue ou não (janela de 24h fechada, etc.), então o relatório
                // sempre fica disponível pra consulta ali, mesmo se a mensagem falhar de entregar.
                // upsert por mes_ano: se rodar de novo pro mesmo mês, atualiza em vez de duplicar.
                const mesAno = `${inicioMes.getUTCFullYear()}-${String(inicioMes.getUTCMonth() + 1).padStart(2, '0')}`;
                try {
                        await supabase.from('relatorios_mensais').upsert({
                                mes_ano: mesAno,
                                mes_nome: nomeMes,
                                texto: relatorioCompleto,
                                total_leads: total,
                                matriculados: contStatus.matriculado,
                                taxa_conversao: total > 0 ? Math.round(contStatus.matriculado / total * 100) : 0,
                                via_bot: viaBot,
                                via_vendedor: total - viaBot,
                                criado_em: new Date().toISOString()
                        }, { onConflict: 'mes_ano' });
                } catch (e) {
                        console.error('❌ Erro ao salvar relatório mensal no Supabase (pra aba do CRM):', e.message);
                }

                await sendTemplateGerente('relatorio_mensal');
                await salvarMensagem(NUMERO_GERENTE, '[Template: relatorio_mensal] Seu relatório mensal está pronto — os detalhes chegam a seguir.', 'sistema', 'bot', 'relatorio_mensal');
                await new Promise(r => setTimeout(r, 1500));

                // Manda bloco por bloco. Os blocos que não entregam na hora (janela de 24h
                // fechada) são acumulados localmente e só viram pendência no final, todos
                // juntos — assim um relatório de 3 blocos não perde os 2 primeiros quando o
                // 3º "substitui" a fila (definirPendentes troca tudo de uma vez só).
                let entreguesGerente = 0;
                const pendentesGerente = [];
                const pendentesLucas = [];
                for (const bloco of blocos) {
                        const itemG = await enviarLivreOuItemPendente(NUMERO_GERENTE, bloco, 'relatorio_mensal_detalhado');
                        if (itemG) pendentesGerente.push(itemG); else entreguesGerente++;
                        if (NUMERO_LUCAS) {
                                const itemL = await enviarLivreOuItemPendente(NUMERO_LUCAS, bloco, 'relatorio_mensal_detalhado');
                                if (itemL) pendentesLucas.push(itemL);
                        }
                        await new Promise(r => setTimeout(r, 1500)); // pausa entre mensagens
                }
                definirPendentes(NUMERO_GERENTE, 'relatorio_mensal_detalhado', pendentesGerente);
                if (NUMERO_LUCAS) definirPendentes(NUMERO_LUCAS, 'relatorio_mensal_detalhado', pendentesLucas);
                console.log(`📋 Relatório mensal: ${entreguesGerente}/${blocos.length} bloco(s) entregues na hora pra gerente (o resto fica pendente até ela responder).`);
                return relatorioCompleto;
        } catch (err) {
                console.error('❌ Erro ao gerar relatório mensal:', err.message);
                return null;
        } finally {
                clearTimeout(travaSegurancaId);
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
        // Restaura o mapeamento LID → telefone real, pra não resetar a cada deploy
        carregarLidMap();
        // Agenda resumo diário às 8h BRT
        agendarResumoDiario();
        agendarLembreteEscala();
        // Lembrete semanal de leads sem status pros vendedores, toda segunda 10h BRT
        agendarLembreteStatusVendedor();
        // Classificação automática de leads antigos (>15d parados como 'novo' → perdido/pausado/em_andamento), 1x por dia às 10h BRT
        agendarClassificacaoLeadsAntigos();
        // Pesquisa de feedback de leads perdidos, seg-sex às 13h BRT
        agendarPesquisasLeadsPerdidos();
        // Lead que parou de responder o bot há 24h+ vai pro vendedor da fila, às 8h e 20h BRT
        agendarEncaminhamentoLeadsInativos();
});
