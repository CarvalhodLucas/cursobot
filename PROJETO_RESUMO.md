# Resumo Completo — CNA Recreio Bot (cursobot)

## Visão Geral
Bot de WhatsApp para a escola **CNA Recreio** (escola de idiomas no Rio de Janeiro).  
Captura leads, conversa com interessados via IA, notifica vendedores, gerencia status no CRM e envia relatórios diários/mensais para a gerente **Leybian**.

---

## Infraestrutura

| Componente | Detalhe |
|---|---|
| **Servidor** | Railway — `https://cursobot-production.up.railway.app` |
| **Banco de dados** | Supabase — `https://gnyvfslxoiobgmohejqf.supabase.co` |
| **Código principal** | `index.js` (~2356 linhas) |
| **Repositório** | Git local em `C:\Users\Lucas de Carvalho\Documents\Sites\RASTRO_BOOT` |
| **CRM frontend** | `C:\Users\Lucas de Carvalho\Documents\Sites\CRM-WHATSAPP` (projeto separado) |
| **Deploy** | `git push` → Railway auto-deploy |
| **Timezone** | Railway roda em UTC. Horário de Brasília = UTC-3 (ex: 8h BRT = 11h UTC) |

---

## Números de WhatsApp

| Número | Nome | Phone Number ID (Meta) | Status |
|---|---|---|---|
| +55 21 97038-9751 | Bot principal | `META_PHONE_NUMBER_ID` = 1197249056802550 | ✅ Ativo |
| +55 21 97691-2943 | Rebecca | `META_PHONE_NUMBER_ID_REBECCA` | ✅ Ativo (WANotifier) |
| +55 21 97233-1685 | Paulo | `META_PHONE_NUMBER_ID_PAULO` | ❌ BANIDO PERMANENTE pela Meta |
| (número Taynara) | Taynara | `META_PHONE_NUMBER_ID_TAYNARA` | ✅ Ativo (WANotifier) |
| `NUMERO_GERENTE` | Leybian (gerente) | — | Recebe resumos diários |
| `NUMERO_COORDENACAO` | Coordenação | — | Recebe alertas de alunos |

**Importante:** Os números dos vendedores (Rebecca, Paulo, Taynara) são gerenciados pelo **WANotifier** com Embedded Signup separado — têm tokens próprios e são WABA separados do bot principal.

---

## Variáveis de Ambiente (Railway)

```
SUPABASE_URL
SUPABASE_KEY
META_ACCESS_TOKEN          — token do bot principal
META_VERIFY_TOKEN          — cna_recreio_2024
META_APP_ID
META_APP_SECRET
META_PHONE_NUMBER_ID       — bot principal (1197249056802550)
META_PHONE_NUMBER_ID_PAULO
META_PHONE_NUMBER_ID_REBECCA
META_PHONE_NUMBER_ID_TAYNARA
GROQ_API_KEY               — IA primária
GROQ_API_KEY_2             — IA fallback
GEMINI_API_KEY             — IA fallback final
OPENROUTER_API_KEY         — relatório mensal
NUMERO_PAULO
NUMERO_REBECCA
NUMERO_TAYNARA
NUMERO_GERENTE
NUMERO_COORDENACAO
ADMIN_TOKEN                — autenticação das rotas admin
ALLOWED_ORIGINS            — CORS (origens permitidas, vírgula separada)
```

---

## Tabelas do Supabase

### `conversas` (tabela principal)
| Campo | Tipo | Descrição |
|---|---|---|
| telefone | text | número do cliente |
| mensagem | text | conteúdo da mensagem |
| de | text | 'cliente', 'bot', 'vendedor', 'sistema' |
| vendedor | text | nome do vendedor responsável |
| tipo | text | 'lead', 'lead_confirmado', 'aluno', 'reengajamento', 'resumo_diario', etc. |
| created_at | timestamp | data/hora UTC |

### `status_de_leads`
| Campo | Tipo | Descrição |
|---|---|---|
| telefone | text | chave primária |
| status | text | 'novo', 'em_andamento', 'matriculado', 'aluno', 'pausado', 'perdido' |
| anotacao | text | observação livre |
| atualizado_em | timestamp | data de atualização (campo legado) |
| nome | text | nome do lead |
| idade | text | idade do lead |
| interesse | text | curso/interesse desejado |
| updated_at | timestamp | data de atualização |
| data_retorno | date | data para retomar contato |
| vendedor | text | vendedor responsável (coluna adicionada 02/07/2026) |

⚠️ A coluna `vendedor` foi adicionada em 02/07/2026 e populada via `leads_resumo`. O bot já faz upsert nessa coluna via `notificarVendedor()`.

### `estado_bot`
Persiste estado em memória entre restarts.
| Campo | Descrição |
|---|---|
| telefone | chave primária |
| ultima_atividade | timestamp da última msg |
| reengajamento_env | boolean — já enviou reengajamento? |
| confirmado | boolean — lead confirmou dados? |
| notificado | boolean — vendedor já foi notificado? |

### `escala_vendedores`
Define qual vendedor atende em qual horário/dia da semana.

### `leads_resumo` (VIEW — leitura apenas)
Campos disponíveis: `telefone`, `vendedor`, `ultimo_contato`, `tem_msg_bot`, `tem_msg_cliente`, `primeiro_contato`.  
⚠️ **NÃO tem campo `tipo` por mensagem** — não filtrar por tipo nessa view.

---

## Stack de IA

```
Mensagem chega → askAI()
  1. Groq (GROQ_API_KEY) — llama-3.3-70b-instruct
  2. Groq (GROQ_API_KEY_2) — fallback se o 1 falhar/429
  3. Gemini (GEMINI_API_KEY) — fallback final
  
Relatório mensal → OpenRouter (múltiplos modelos gratuitos em cascata)
```

O sistema prompt inclui: RAG da base de conhecimento da escola, dados do lead atual, contexto da conversa.

---

## Templates Meta (WhatsApp)

| Template | Categoria | Variáveis | Uso | Status |
|---|---|---|---|---|
| `reengajamento_inicial` | Utilitário | nenhuma | Lead inativo 24h+ | ✅ Ativo |
| `notificacao_novo_lead` | Utilitário | lead_nome, lead_turma, lead_horario, lead_telefone (nomeadas) | Notifica vendedor de novo lead confirmado | ✅ Ativo |
| `resumo_diario_util` | Utilitário | {{1}} = data | Header do resumo diário para Leybian | ⏳ Em análise |
| `resumo_diario_gerente` | Marketing | nenhuma | Header antigo (substituído pelo util) | ⚠️ Deprecated |
| `alerta_coordenacao` | Utilitário | {{1}} = telefone | Alerta coordenação sobre aluno | ✅ Ativo |
| `atualizar_status_lead` | Utilitário | {{1}}=vendedor, {{2}}=lead_nome, {{3}}=lead_telefone | Pergunta ao vendedor status do lead | ⏳ Em análise |
| `lembrete_escala` | Utilitário | gerente_nome (nomeada) | Lembrete semanal de escala para Leybian | ✅ Ativo |
| `lembrete_lead_pausado` | Utilitário | (a verificar) | Lembra vendedor de lead pausado | ✅ Ativo |

**Regra importante:** Templates de Marketing NÃO permitem enviar mensagem de texto livre depois deles sem o usuário responder primeiro. Usar sempre Utilitário para fluxos onde o bot envia template + texto em seguida.

---

## Fluxo Principal — Lead Novo

```
Cliente manda msg no WhatsApp do bot
  ↓
/webhook POST recebe
  ↓
Identifica número (é vendedor? é cliente?)
  ↓
processarMensagemBot()
  ↓
verificarConsentimento() → se novo, envia aviso LGPD
  ↓
getVendedorDoTelefone() → qual vendedor é responsável?
  ↓
Verifica status_de_leads → se 'aluno', manda pra Coordenação
  ↓
askAI() → Groq → Groq2 → Gemini (com RAG + histórico)
  ↓
detectarTipo() → 'lead' | 'aluno' | 'desconhecido'
  ↓
Extrai dados do reply (nome, turma, horário)
  ↓
Se confirmado (bot disse "Seus dados foram registrados"):
  → notificarVendedor() → template notificacao_novo_lead
  ↓
salvarMensagem() → Supabase
```

---

## Fluxo — Atualização de Status pelo Vendedor

```
Bot manda template 'atualizar_status_lead' para vendedor
(lead sem contato há 7-30 dias, status=novo ou sem status)
  ↓
Vendedor responde: "perdido - sem interesse" ou "em_andamento"
  ↓
/webhook identifica que é vendedor respondendo
  ↓
parseia: status + motivo na mesma mensagem (separados por " - ")
  ↓
Se perdido/pausado SEM motivo → pede motivo em mensagem separada
  ↓
Atualiza status_de_leads no Supabase
  ↓
Confirma para o vendedor: "✅ Nome → Status"
  ↓
Se tem mais leads na fila → pergunta próximo
```

`pendentesAtualizacao` — objeto em memória por telefone de vendedor:
```javascript
{ atual: {telefone, nome}, fila: [...restantes], aguardandoMotivo: false }
```

---

## Agendamentos Automáticos

| Função | Horário | Frequência |
|---|---|---|
| `checkInatividade()` | contínuo | a cada 30 min |
| `enviarResumoDiario()` | 11:00 UTC (08:00 BRT) | diário |
| `checkLeadsPausados()` | junto com resumo | diário |
| `agendarLembreteEscala()` | segunda 10:00 UTC | semanal |
| `enviarAlertaVendedor('Rebecca')` | 15:00 UTC (12:00 BRT) | diário |
| `enviarAlertaVendedor('Paulo')` | 20:00 UTC (17:00 BRT) | diário |
| `enviarAlertaVendedor('Taynara')` | 17:00 UTC (14:00 BRT) | diário |
| `gerarRelatorioMensal()` | dia 1 de cada mês junto com resumo | mensal |

---

## Rotas Admin (requerem header `x-admin-token`)

| Rota | Descrição |
|---|---|
| `GET /status` | status do bot, modelo IA ativo, fallbacks |
| `GET /reset/:telefone` | zera conversa de um número |
| `GET /reset-all` | zera todas as conversas |
| `GET /buscar/:telefone` | dados do lead na memória |
| `GET /reengajar/:telefone` | dispara reengajamento manual |
| `GET /classificar-antigos` | IA classifica leads >30 dias |
| `GET /processar-novos` | processa backlog completo |
| `GET /relatorio-mensal` | gera relatório mensal manualmente |
| `POST /simulate` | simula mensagem de um número |

---

## Funções Principais

### IA e Conversa
- **`askAI(telefone, mensagem)`** — orquestra Groq → Gemini com fallback automático
- **`buscarRAG(mensagem)`** — busca keywords na base de conhecimento para enriquecer o prompt
- **`getBaseConhecimento()`** — carrega FAQ da escola do Supabase
- **`detectarTipo(mensagem, reply)`** — classifica: 'lead' | 'aluno' | 'desconhecido'
  - ⚠️ "prova" sozinha NÃO classifica como aluno (muito genérico). Só "minha prova" ou "prova amanhã"

### Vendedores
- **`getVendedor()`** — round-robin baseado no horário e escala do banco
- **`getVendedorDoTelefone(telefone)`** — retorna vendedor cacheado ou sorteia novo
- **`getEscala()`** — cache de 5 min da escala de vendedores
- **`notificarVendedor(telefone, vendedor)`** — envia `notificacao_novo_lead` para o vendedor certo
- **`notificarCoordenacao(telefone)`** — envia `alerta_coordenacao` (variável POSICIONAL `{{1}}`)
- **`enviarAlertaVendedor(nome, numero)`** — pergunta ao vendedor sobre lead 7-30 dias sem status

### Persistência
- **`salvarMensagem(tel, msg, de, vendedor, tipo)`** — INSERT em `conversas`
- **`carregarEstadoBot()`** — restaura memória (`dadosLead`, `ultimaAtividade`, etc.) no startup
- **`salvarEstadoBot(telefone)`** — persiste estado individual em `estado_bot`
- **`getHistorico(telefone)`** — carrega histórico do Supabase se não estiver em RAM

### Reengajamento e Inatividade
- **`checkInatividade()`** — verifica leads sem resposta há 24h+, envia `reengajamento_inicial`
  - Fallback DB: busca direto em `conversas` (não depende de `estado_bot`)
  - Não reenvia se já enviou nos últimos 7 dias
- **`classificarLeadIA(texto)`** — IA classifica conversa de um lead (perdido/matriculado/etc.)
- **`classificarLeadsAntigos()`** — classifica automaticamente leads >30 dias

### Relatórios
- **`enviarResumoDiario()`** — envia às 08:00 BRT para Leybian:
  - Template `resumo_diario_util` (Utilitário, abre janela 24h) + texto com dados
  - Status geral filtra apenas leads do mês atual (reinicia todo mês automaticamente)
  - "Novo" = sem_status + status 'novo' combinados
- **`gerarRelatorioMensal()`** — no dia 1, gera análise via OpenRouter e envia para Leybian

---

## Memória em RAM (perdida no restart, persistida via estado_bot)

```javascript
conversas          // histórico de chat por telefone
dadosLead          // {nome, turma, horario, confirmado, notificado} por telefone
ultimaAtividade    // timestamp última mensagem por telefone
reengajamentoEnviado // boolean por telefone
vendedorPorTelefone  // cache vendedor por telefone
pendentesAtualizacao // fila de leads para perguntar ao vendedor
lidToPhone         // mapeamento LID → telefone (WhatsApp privacy)
```

---

## Problemas Conhecidos e Bugs Corrigidos

### Bugs já corrigidos (julho/2026)
1. **`const vendedor` → `let vendedor`** — erro "Assignment to constant variable" quando lead era aluno
2. **`total` e `viaBot` undefined** no relatório mensal — variáveis não declaradas antes do uso
3. **Template `resumo_diario_gerente` era Marketing** — substituído por `resumo_diario_util` (Utilitário)
4. **`detectarTipo`** — palavra "prova" sozinha classificava qualquer lead como aluno (ex: "Prova Linguaskill")
5. **`notificarCoordenacao`** — enviava variável nomeada mas template usa posicional (`{{1}}`)
6. **`enviarAlertaVendedor`** — buscava vendedor em `status_de_leads` (errado) → corrigido para `leads_resumo`
7. **Resumo diário "Leads novos: 0"** — filtro `.in('tipo', [...])` na view que não tem campo tipo
8. **Status geral filtrado por mês** — antes mostrava histórico todo (todos os meses), agora só mês atual
9. **`checkInatividade` DB fallback** — não dependia de `estado_bot`, busca direto em `conversas`

### Pendências abertas
- **Paulo banido permanentemente** — número +55 21 97233-1685 banido pela Meta. Appeal via Business Support Home (botão "Solicite a análise"). Causa: trocou de celular e voltou pro antigo, Meta detectou como atividade suspeita.
- **Template `atualizar_status_lead`** — criado, aguardando aprovação Meta (desde 29/06)
- **Template `resumo_diario_util`** — criado, aguardando aprovação Meta (desde 01/07)
- **Migração WANotifier → WABA principal** — Rebecca e Taynara ainda no WANotifier separado. Para migrar: remover do WANotifier → aguardar → adicionar ao WABA principal → atualizar variáveis do Railway
- **Rota `/reengajar/:telefone` duplicada** — existe duas vezes no código (linha 2308 e 2327), precisa remover uma

---

## Problema Recorrente — git index corrompido

Quando o git trava com "bad signature" ou "index file corrupt":
```powershell
del .git\index.lock
del .git\index
git reset
git add index.js
git commit -m "mensagem"
git push
```

Nunca usar o Edit tool com caracteres acentuados diretamente em arquivos grandes — corrrompe o arquivo com null bytes. **Sempre usar scripts Python** para editar o `index.js`.

---

## Estrutura de Arquivos do Projeto

```
RASTRO_BOOT/
├── index.js              # código principal (2356 linhas)
├── package.json
├── CLAUDE.md             # contexto para o Claude
├── PROJETO_RESUMO.md     # este arquivo
└── .env                  # não commitado (variáveis locais)
```

---

## Contexto de Negócio

- **Escola:** CNA Recreio — escola de idiomas no Rio de Janeiro
- **Gerente:** Leybian — recebe resumo diário e relatório mensal via WhatsApp
- **Vendedores:** Rebecca, Paulo (banido), Taynara
- **Coordenação:** recebe alertas quando lead já é aluno atual da escola
- **Leads:** chegam pelo WhatsApp do bot, são qualificados pela IA e repassados para o vendedor da vez
- **CRM:** frontend separado (CRM-WHATSAPP) que lê do Supabase — mostra conversas, status, vendedor
