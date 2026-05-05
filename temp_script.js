
  // ─── FALLBACK DEFENSIVO PARA crmConfig ───────────────────────────────────────
  // Garante que crmConfig sempre existe, mesmo que este arquivo seja carregado
  // antes (ou fora) do index.html que o define globalmente.
  // NUNCA sobrescreve um crmConfig já declarado pelo index.html principal.
  if (typeof crmConfig === 'undefined') {
    var crmConfig = (function () {
      try {
        const saved = localStorage.getItem('crm_config');
        if (saved) return JSON.parse(saved);
      } catch (_) {}
      return {
        vendedores: [],
        crm: {
          periodoLeads: 'mes',
          nomeDashboard: 'CRM WhatsApp',
          autoRefresh: true,
          botUrl: localStorage.getItem('crm_bot_url') || '',
          tema: 'dark',
          github: ''
        }
      };
    })();
    console.warn('[temp_script.js] crmConfig não estava definido globalmente — usando fallback do localStorage.');
  }
  // ─────────────────────────────────────────────────────────────────────────────

  const SUPABASE_URL = 'https://gnyvfslxoiobgmohejqf.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdueXZmc2x4b2lvYmdtb2hlanFmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMTcwNTYsImV4cCI6MjA5Mjg5MzA1Nn0.wwk_IKVia7R3_QTjnbDcRxWA_HQwHURO5lXcHIAzgRc';

  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY
  };

  async function sbGet(path) {
    const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, { headers });
    if (!r.ok) throw new Error('Supabase error: ' + r.status);
    return r.json();
  }

  async function sbUpsert(table, data) {
    const r = await fetch(SUPABASE_URL + '/rest/v1/' + table, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify(data)
    });
    if (!r.ok) throw new Error('Supabase error: ' + r.status);
  }

  function todayRange() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
    return { start, end };
  }

  function fmtHora(iso) {
    return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function fmtTel(tel) {
    if (!tel) return '—';
    const t = String(tel).replace(/\D/g,'');
    if (t.length >= 11) return t.replace(/(\d{2})(\d{2})(\d{5})(\d{4})/, '+$1 $2 $3-$4');
    return tel;
  }

  function initials(tel) {
    const t = String(tel || '').replace(/\D/g,'').slice(-4);
    return t.slice(0,2).toUpperCase() || '??';
  }

  // ─── NAVIGATION ──────────────────────────────

  // ─── BOT IA LOGIC ────────────────────────────
  const SIM_PROFILES = {
    lead:    'Oi, vi o Instagram de vocês. Meu filho tem 9 anos, tem turma pra ele?',
    aluno:   'Oi, sou aluna da turma de terça. Posso faltar semana que vem?',
    preco:   'Quanto custa o curso por mês?',
    ambiguo: 'Oi',
    custom:  ''
  };

  const BOT_SYSTEM_PROMPT = `Você é a assistente virtual de uma escola de idiomas no Recreio dos Bandeirantes, Rio de Janeiro. Fale sempre em português. Seja simpática e profissional. Responda de forma curta (máximo 3 linhas). Identifique se a mensagem é de um ALUNO (já estuda) ou LEAD (quer se matricular) e responda adequadamente.`;

  async function loadBotIAView(shouldLog = true) {
    // Try to fetch live status from bot server
    const botUrl = crmConfig.crm.botUrl || localStorage.getItem('crm_bot_url') || '';
    
    let modelo = 'groq';
    let fallbacks = 0;
    let ultimoWebhook = null;
    let uptime = null;
    let conversasAtivas = null;

    if (botUrl) {
      try {
        const res = await fetch(botUrl.replace(/\/$/, '') + '/status', { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const s = await res.json();
          modelo = s.modelo || 'groq';
          fallbacks = s.fallbacksHoje || 0;
          ultimoWebhook = s.ultimoWebhook || null;
          uptime = s.uptime || null;
          conversasAtivas = s.conversasAtivas ?? null;
          if (shouldLog) addBotLog('✅', `Status atualizado: ${modelo === 'groq' ? 'Groq ativo' : 'Gemini fallback'} — ${fallbacks} fallbacks hoje`);
        }
      } catch (e) {
        // Bot offline or URL not configured — use localStorage fallback
        modelo = localStorage.getItem('crm_modelo_ativo') || 'groq';
        fallbacks = parseInt(localStorage.getItem('crm_fallbacks_hoje') || '0');
        ultimoWebhook = localStorage.getItem('crm_ultimo_webhook');
        if (shouldLog) addBotLog('⚠️', 'Não foi possível conectar ao servidor do bot. Usando dados em cache.');
      }
    } else {
      // No URL configured — use localStorage
      modelo = localStorage.getItem('crm_modelo_ativo') || 'groq';
      fallbacks = parseInt(localStorage.getItem('crm_fallbacks_hoje') || '0');
      ultimoWebhook = localStorage.getItem('crm_ultimo_webhook');
    }

    // Render cards
    const modeloVal = document.getElementById('botModeloVal');
    const cardModelo = document.getElementById('cardModelo');
    if (modelo === 'gemini') {
      modeloVal.textContent = 'Gemini Flash — Fallback';
      modeloVal.style.color = 'var(--yellow)';
      cardModelo.style.borderColor = 'var(--yellow)';
    } else {
      modeloVal.textContent = 'Groq — LLaMA 3.3 70B';
      modeloVal.style.color = 'var(--green)';
      cardModelo.style.borderColor = 'var(--green)';
    }

    const fallbackEl = document.getElementById('botFallbacksVal');
    fallbackEl.textContent = fallbacks;
    if (fallbacks > 0) {
      fallbackEl.style.color = 'var(--red)';
      document.getElementById('cardFallbacks').style.borderColor = 'var(--red)';
    } else {
      fallbackEl.style.color = '';
      document.getElementById('cardFallbacks').style.borderColor = '';
    }

    const webhookEl = document.getElementById('botWebhookVal');
    if (ultimoWebhook) {
      const d = new Date(ultimoWebhook);
      webhookEl.textContent = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      webhookEl.style.color = '';
    } else {
      webhookEl.textContent = 'Nenhum registrado';
      webhookEl.style.color = 'var(--muted2)';
    }

    // Memory/Conversas card
    const memEl = document.getElementById('botMemoryVal');
    if (conversasAtivas !== null) {
      memEl.textContent = conversasAtivas + (conversasAtivas === 1 ? ' conversa' : ' conversas');
      memEl.style.color = conversasAtivas > 0 ? 'var(--blue)' : 'var(--muted2)';
    } else {
      memEl.textContent = '--';
      memEl.style.color = 'var(--muted2)';
    }

    // Status line
    const dot = document.querySelector('#botStatusLine .status-dot');
    const txt = document.getElementById('botStatusText');
    const uptimeStr = uptime ? ` • Uptime: ${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m` : '';

    if (!botUrl) {
      dot.style.background = 'var(--muted2)';
      txt.style.color = 'var(--muted2)';
      txt.textContent = '— URL do bot não configurada em Configurações → CRM';
    } else if (modelo === 'gemini') {
      dot.style.background = 'var(--yellow)';
      txt.style.color = 'var(--yellow)';
      txt.textContent = '⚠ Operando em modo fallback — Groq indisponível' + uptimeStr;
    } else {
      dot.style.background = 'var(--green)';
      txt.style.color = 'var(--green)';
      txt.textContent = '● Sistema operando normalmente' + uptimeStr;
    }

    // Render log
    renderBotLog();
  }

  function updateSimInput() {
    const profile = document.getElementById('simProfile').value;
    document.getElementById('simInput').value = SIM_PROFILES[profile] || '';
  }

  function inferTipo(msg, reply) {
    const m = (msg + ' ' + reply).toLowerCase();
    if (m.includes('coordena') || m.includes('sou aluno') || m.includes('minha aula') || m.includes('mensalidade') || m.includes('já estudo')) return 'aluno';
    if (m.includes('comercial') || m.includes('matricul') || m.includes('quero aprender') || m.includes('turma') || m.includes('tem vaga') || m.includes('quanto custa')) return 'lead';
    return 'indefinido';
  }

  async function simulateResponse() {
    const inputEl = document.getElementById('simInput');
    const msg = inputEl.value.trim();
    if (!msg) return;

    // Limpa o campo imediatamente
    inputEl.value = '';

    const btn = document.getElementById('btnSimular');
    btn.disabled = true;
    btn.textContent = 'Aguardando...';

    const chat = document.getElementById('simChat');
    // Clear placeholder if present
    if (chat.querySelector('[style*="margin:auto"]')) chat.innerHTML = '';

    // Add user bubble
    const userBubble = document.createElement('div');
    userBubble.className = 'msg-bubble msg-user';
    userBubble.textContent = msg;
    chat.appendChild(userBubble);
    chat.scrollTop = chat.scrollHeight;

    // Loading bot bubble
    const botBubble = document.createElement('div');
    botBubble.className = 'msg-bubble msg-bot';
    botBubble.textContent = '...';
    chat.appendChild(botBubble);
    chat.scrollTop = chat.scrollHeight;

    const t0 = Date.now();
    let reply = '';
    let success = true;

    // Verify bot URL is configured
    const botUrl = crmConfig.crm.botUrl || '';
    if (!botUrl) {
      botBubble.className = 'msg-bubble msg-bot';
      botBubble.innerHTML = '⚠ Configure a URL do bot em <strong>Configurações → CRM → URL do Servidor Bot</strong> para usar o simulador.';
      chat.scrollTop = chat.scrollHeight;
      btn.disabled = false;
      btn.textContent = 'Simular Resposta';
      return;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(botUrl.replace(/\/$/, '') + '/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mensagem: msg }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      
      if (!res.ok) throw new Error('Erro HTTP ' + res.status);
      const data = await res.json();
      reply = data.reply || 'Sem resposta.';
      // Use tipo from bot directly (more accurate than local inference)
      const tipoBot = data.tipo || inferTipo(msg, reply);
      const elapsed = Date.now() - t0;
      const tipoColors = { lead: 'var(--green)', aluno: 'var(--blue)', indefinido: 'var(--muted2)' };
      const modeloBadge = data.modelo === 'gemini' ? '<span style="background:var(--yellow);color:#000;padding:1px 6px;border-radius:4px;font-size:0.6rem;font-weight:700">gemini</span>' : '';
      botBubble.innerHTML = `
        ${reply}
        <div class="sim-meta" style="color:var(--muted2)">
          <span style="background:${tipoColors[tipoBot]};color:#000;padding:1px 6px;border-radius:4px;font-size:0.6rem;font-weight:700">${tipoBot}</span>
          ${modeloBadge}
          <span>${elapsed}ms</span>
        </div>
      `;
      chat.scrollTop = chat.scrollHeight;
      addBotLog('✅', `Simulação: "${msg.substring(0,40)}..." → ${tipoBot} (${elapsed}ms)`);
      
      // Atualiza os cards do topo para refletir o modelo que foi usado/status atual (silenciosamente)
      loadBotIAView(false);

      btn.disabled = false;
      btn.textContent = 'Simular Resposta';
      return;
    } catch (e) {
      console.error('Erro de conexão com o bot:', e);
      reply = '⚠ Não foi possível conectar ao bot. Verifique se ele está rodando e a URL está correta.';
      success = false;
    }

    const elapsed = Date.now() - t0;
    const tipo = inferTipo(msg, reply);

    // Update bot bubble
    const tipoColors = { lead: 'var(--green)', aluno: 'var(--blue)', indefinido: 'var(--muted2)' };
    botBubble.innerHTML = `
      ${reply}
      <div class="sim-meta" style="color:var(--muted2)">
        <span style="background:${tipoColors[tipo]};color:#000;padding:1px 6px;border-radius:4px;font-size:0.6rem;font-weight:700">${tipo}</span>
        <span>${elapsed}ms</span>
      </div>
    `;
    chat.scrollTop = chat.scrollHeight;

    // Log event
    addBotLog(success ? '✅' : '⚠️', `Simulação: "${msg.substring(0,40)}..." → ${tipo} (${elapsed}ms)`);

    btn.disabled = false;
    btn.textContent = 'Simular Resposta';
  }

  function addBotLog(icon, desc) {
    const log = JSON.parse(localStorage.getItem('crm_bot_log') || '[]');
    log.unshift({ icon, desc, ts: new Date().toISOString() });
    if (log.length > 100) log.pop();
    localStorage.setItem('crm_bot_log', JSON.stringify(log));
    renderBotLog();
  }

  function renderBotLog() {
    const el = document.getElementById('botLogList');
    if (!el) return;
    const log = JSON.parse(localStorage.getItem('crm_bot_log') || '[]');
    if (!log.length) {
      el.innerHTML = '<div class="empty-state">// nenhum evento registrado</div>';
      return;
    }
    el.innerHTML = `<div class="event-list">${log.map(e => {
      const d = new Date(e.ts);
      const ts = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' +
                 d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      return `<div class="event-item">
        <span style="font-size:1rem">${e.icon}</span>
        <span class="event-time">${ts}</span>
        <span class="event-desc">${e.desc}</span>
      </div>`;
    }).join('')}</div>`;
  }

  function clearBotLog() {
    localStorage.removeItem('crm_bot_log');
    renderBotLog();
  }

  // ─── CLOCK ───────────────────────────────────
  function updateClock() {
    document.getElementById('clock').textContent = new Date().toLocaleTimeString('pt-BR');
  }
  setInterval(updateClock, 1000);
  updateClock();

  // ─── MÉTRICAS ────────────────────────────────
  async function loadMetrics() {
    const { start, end } = todayRange();

    // Total hoje (mensagens únicas por telefone = conversas)
    const [todayRows, totalRows, leadsHoje, alunosHoje] = await Promise.all([
      sbGet(`conversas?select=telefone&created_at=gte.${start}&created_at=lt.${end}`),
      sbGet(`conversas?select=id`),
      sbGet(`conversas?select=telefone&tipo=eq.lead&de=eq.cliente&created_at=gte.${start}&created_at=lt.${end}`),
      sbGet(`conversas?select=telefone&tipo=eq.aluno&de=eq.cliente&created_at=gte.${start}&created_at=lt.${end}`)
    ]);

    const telefonesHoje = new Set(todayRows.map(r => r.telefone));
    const leadsUnicos = new Set(leadsHoje.map(r => r.telefone));
    const alunosUnicos = new Set(alunosHoje.map(r => r.telefone));

    document.getElementById('metConv').textContent = telefonesHoje.size;
    document.getElementById('metAlunos').textContent = alunosUnicos.size;
    document.getElementById('metLeads').textContent = leadsUnicos.size;
    document.getElementById('metTotal').textContent = totalRows.length;
    document.getElementById('metConvTrend').textContent = telefonesHoje.size + ' únicos';
    document.getElementById('metLeadsTrend').textContent = leadsUnicos.size + ' hoje';
  }

  // ─── CONVERSAS RECENTES ──────────────────────
  let allConvsData = {};
  let activeChatTel = null;

  async function loadConversas() {
    const { start, end } = todayRange();
    document.getElementById('convList').innerHTML = '<div class="state-msg"><span class="spinner"></span><div style="margin-top:8px">Carregando...</div></div>';

    // Pegar todas mensagens de hoje, ordenadas
    const rows = await sbGet(`conversas?select=*&created_at=gte.${start}&created_at=lt.${end}&order=created_at.asc&limit=500`);

    if (!rows.length) {
      document.getElementById('convList').innerHTML = '<div class="state-msg"><div class="icon">💬</div><div>Nenhuma conversa hoje ainda</div></div>';
      return;
    }

    // Agrupar por telefone
    const byTel = {};
    rows.forEach(r => {
      if (!byTel[r.telefone]) byTel[r.telefone] = { telefone: r.telefone, msgs: [], tipo: r.tipo || 'desconhecido', vendedor: r.vendedor, lastTime: r.created_at };
      byTel[r.telefone].msgs.push(r);
      byTel[r.telefone].lastTime = r.created_at;
      if (r.tipo && r.tipo !== 'desconhecido') byTel[r.telefone].tipo = r.tipo;
      if (r.vendedor) byTel[r.telefone].vendedor = r.vendedor;
    });

    // Ordenar por mais recente e filtrar
    let convs = Object.values(byTel);
    if (currentNumeroFilter === 'coord') {
      convs = convs.filter(c => c.tipo === 'aluno');
    } else if (currentNumeroFilter !== 'todos') {
      convs = convs.filter(c => c.vendedor === currentNumeroFilter);
    }
    convs.sort((a,b) => new Date(b.lastTime) - new Date(a.lastTime));
    
    if (convs.length === 0 && currentNumeroFilter !== 'todos') {
      const msg = currentNumeroFilter === 'coord' ? 'da Coordenação' : `de ${currentNumeroFilter}`;
      document.getElementById('convList').innerHTML = `<div class="state-msg"><div>Nenhuma conversa encaminhada para ${msg}</div></div>`;
      return;
    }

    allConvsData = byTel;

    const listEl = document.getElementById('convList');
    listEl.innerHTML = '';

    convs.forEach((conv, i) => {
      const lastMsg = conv.msgs[conv.msgs.length - 1];
      const preview = lastMsg ? lastMsg.mensagem.substring(0, 50) + (lastMsg.mensagem.length > 50 ? '...' : '') : '';
      const tipo = conv.tipo;
      const avClass = tipo === 'lead' ? 'lead' : tipo === 'aluno' ? 'aluno' : '';

      const item = document.createElement('div');
      item.className = 'conv-item';
      item.innerHTML = `
        <div class="conv-av ${avClass}">${initials(conv.telefone)}</div>
        <div class="conv-info">
          <div class="conv-name" style="font-family:var(--mono);font-size:0.72rem">${fmtTel(conv.telefone)}</div>
          <div class="conv-preview">${preview || '—'}</div>
        </div>
        <div class="conv-meta">
          <div class="conv-time">${fmtHora(conv.lastTime)}</div>
          <span class="badge ${tipo==='lead'?'badge-green':tipo==='aluno'?'badge-blue':'badge-muted'}" style="font-size:0.55rem">${tipo}</span>
        </div>
      `;
      item.onclick = () => showConv(conv, item);
      listEl.appendChild(item);
    });

    // Abrir primeira conversa no desktop se nenhuma estiver aberta
    const currentChatId = document.querySelector('.chat-detail-name')?.textContent;
    if (convs.length && window.innerWidth > 768 && !currentChatId) {
      const firstItem = listEl.querySelector('.conv-item');
      showConv(convs[0], firstItem);
    }
  }

  async function showConv(conv, itemEl, isAutoRefresh = false) {
    // Highlight na lista
    document.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
    if (itemEl) itemEl.classList.add('active');
    else {
      // Se não passou o itemEl, tenta achar na lista pelo telefone
      const items = document.querySelectorAll('.conv-item');
      items.forEach(el => {
        if (el.innerHTML.includes(fmtTel(conv.telefone))) el.classList.add('active');
      });
    }

    // Verifica se o usuário está no fim do scroll antes de atualizar
    const oldMsgsEl = document.getElementById('chatMsgs');
    const wasAtBottom = oldMsgsEl ? (oldMsgsEl.scrollHeight - oldMsgsEl.scrollTop <= oldMsgsEl.clientHeight + 60) : true;

    activeChatTel = conv.telefone;
    const isMobile = window.innerWidth <= 768;

    // Se estivermos abrindo, mostramos um loading state no detalhe
    if (!isMobile && !document.getElementById('chatMsgs')) {
      document.getElementById('chatDetail').innerHTML = '<div class="state-msg"><span class="spinner"></span></div>';
    }

    try {
      // Buscar histórico completo (últimas 200 mensagens)
      const fullMsgs = await sbGet(`conversas?select=*&telefone=eq.${conv.telefone}&order=created_at.desc&limit=200`);
      const newMsgs = fullMsgs.reverse();

      // Se for auto-refresh e as mensagens forem as mesmas, não faz nada para evitar flicker
      if (isAutoRefresh && allConvsData[conv.telefone] && allConvsData[conv.telefone].msgs) {
        const currentMsgs = allConvsData[conv.telefone].msgs;
        if (currentMsgs.length === newMsgs.length) {
          const lastOld = currentMsgs[currentMsgs.length - 1];
          const lastNew = newMsgs[newMsgs.length - 1];
          if (lastOld && lastNew && lastOld.id === lastNew.id) {
            return; // Nenhuma mensagem nova
          }
        }
      }
      
      conv.msgs = newMsgs;
      // Atualiza o cache local
      if (allConvsData[conv.telefone]) {
        allConvsData[conv.telefone].msgs = conv.msgs;
      }
    } catch (e) {
      console.error("Erro ao buscar histórico:", e);
    }

    const msgsHtml = conv.msgs.map(m => {
      const isBot = m.de === 'bot';
      const wrapClass = isBot ? 'bot' : 'user';
      const bubbleClass = isBot ? 'ai' : 'user';
      const tagClass = isBot ? 'ai-tag' : '';
      const tagLabel = isBot ? '🤖 Bot IA · ' + fmtHora(m.created_at) : '👤 Cliente · ' + fmtHora(m.created_at);
      return `
        <div class="msg-wrap ${wrapClass}">
          <div class="msg-bubble ${bubbleClass}">${m.mensagem}</div>
          <div class="msg-tag ${tagClass}">${tagLabel}</div>
        </div>
      `;
    }).join('');

    const subText = `${conv.vendedor || '—'} · ${conv.tipo || 'desconhecido'} · ${fmtHora(conv.lastTime)}`;

    if (isMobile) {
      document.getElementById('mobileDetailName').textContent = fmtTel(conv.telefone);
      document.getElementById('mobileDetailSub').textContent = subText;
      document.getElementById('mobileDetailMsgs').innerHTML = msgsHtml;
      const mMsgsEl = document.getElementById('mobileDetailMsgs');
      if (mMsgsEl && (!isAutoRefresh || wasAtBottom)) {
        mMsgsEl.scrollTop = mMsgsEl.scrollHeight;
      }
      document.getElementById('mobileOverlay').classList.add('open');
    } else {
      document.getElementById('chatDetail').innerHTML = `
        <div class="chat-detail-head">
          <div>
            <div class="chat-detail-name" style="font-family:var(--mono);font-size:0.8rem">${fmtTel(conv.telefone)}</div>
            <div class="chat-detail-sub">${subText}</div>
          </div>
          <div class="chat-detail-actions">
            <span class="badge ${conv.tipo==='lead'?'badge-green':conv.tipo==='aluno'?'badge-blue':'badge-muted'}">${conv.tipo || '—'}</span>
          </div>
        </div>
        <div style="position:relative; flex:1; overflow:hidden; display:flex; flex-direction:column">
          <div class="chat-msgs" id="chatMsgs" onscroll="handleChatScroll()">${msgsHtml}</div>
          <div class="btn-scroll-bottom" id="scrollBtn" onclick="scrollToBottomMsgs()">↓</div>
        </div>
      `;
      const msgsEl = document.getElementById('chatMsgs');
      if (msgsEl && (!isAutoRefresh || wasAtBottom)) {
        msgsEl.scrollTop = msgsEl.scrollHeight;
        // Scroll extra para garantir
        setTimeout(() => { if(msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight; }, 50);
      }
    }
  }

  function scrollToBottomMsgs() {
    const el = document.getElementById('chatMsgs');
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }

  function handleChatScroll() {
    const el = document.getElementById('chatMsgs');
    const btn = document.getElementById('scrollBtn');
    if (!el || !btn) return;
    const isAtBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 100;
    if (isAtBottom) btn.classList.remove('show');
    else btn.classList.add('show');
  }

  function closeMobileOverlay() {
    document.getElementById('mobileOverlay').classList.remove('open');
  }

  // ─── VENDEDORES HOJE ─────────────────────────
  async function loadVendedores() {
    const { start, end } = todayRange();
    const rows = await sbGet(`conversas?select=vendedor,telefone&de=eq.cliente&created_at=gte.${start}&created_at=lt.${end}`);

    const byVend = {};
    rows.forEach(r => {
      const v = r.vendedor || 'desconhecido';
      if (!byVend[v]) byVend[v] = new Set();
      byVend[v].add(r.telefone);
    });

    const el = document.getElementById('vendedoresTable');
    if (!Object.keys(byVend).length) {
      el.innerHTML = '<div class="state-msg">Sem dados hoje</div>';
      return;
    }

    el.innerHTML = Object.entries(byVend).map(([nome, tels]) => `
      <div class="num-row">
        <div class="num-indicator" style="background:var(--green)"></div>
        <div>
          <div class="num-name">${nome}</div>
          <div class="num-number">${tels.size} conversa${tels.size !== 1 ? 's' : ''} hoje</div>
        </div>
        <div class="num-stat">
          <div class="num-stat-val" style="color:var(--green)">${tels.size}</div>
          <div class="num-stat-key">atend.</div>
        </div>
        <span class="badge badge-green">ATIVO</span>
      </div>
    `).join('');
  }

  // ─── LEADS DE HOJE ───────────────────────────
  let leadsData = [];

  async function loadLeads() {
    const { start, end } = todayRange();
    const rows = await sbGet(`conversas?select=telefone,vendedor,created_at&tipo=eq.lead&de=eq.cliente&created_at=gte.${start}&created_at=lt.${end}&order=created_at.desc`);

    // Deduplica por telefone (pega o mais recente)
    const seen = new Set();
    leadsData = [];
    rows.forEach(r => {
      if (!seen.has(r.telefone)) {
        seen.add(r.telefone);
        leadsData.push(r);
      }
    });

    const el = document.getElementById('leadsTable');
    if (!leadsData.length) {
      el.innerHTML = '<div class="state-msg">Nenhum lead hoje ainda</div>';
      return;
    }

    el.innerHTML = leadsData.map(r => `
      <div class="lead-row">
        <div class="lead-name" style="font-family:var(--mono);font-size:0.72rem">${fmtTel(r.telefone)}</div>
        <div><span class="badge badge-green" style="font-size:0.6rem">${r.vendedor || '—'}</span></div>
        <div class="lead-time">${fmtHora(r.created_at)}</div>
      </div>
    `).join('');
  }

  // ─── GRÁFICO 7 DIAS ──────────────────────────
  async function loadChart() {
    const days = [];
    const labels = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
    const today = new Date();

    for (let i = 6; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      const start = d.toISOString();
      const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString();
      days.push({ label: i === 0 ? 'Hoje' : labels[d.getDay()], start, end });
    }

    const counts = await Promise.all(days.map(d =>
      sbGet(`conversas?select=telefone&de=eq.cliente&created_at=gte.${d.start}&created_at=lt.${d.end}`)
        .then(rows => { const s = new Set(rows.map(r => r.telefone)); return s.size; })
        .catch(() => 0)
    ));

    const max = Math.max(...counts, 1);
    const chartEl = document.getElementById('chartArea');
    chartEl.innerHTML = '<div class="chart-bars"></div>';
    const barsEl = chartEl.querySelector('.chart-bars');

    days.forEach((d, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'bar-wrap';
      const bar = document.createElement('div');
      bar.className = 'bar' + (i === 6 ? ' today' : '');
      bar.style.height = Math.max((counts[i] / max) * 52, 2) + 'px';
      bar.title = `${d.label}: ${counts[i]} conversas`;
      const label = document.createElement('div');
      label.className = 'bar-label';
      label.textContent = d.label;
      wrap.appendChild(bar);
      wrap.appendChild(label);
      barsEl.appendChild(wrap);
    });
  }

  // ─── EXPORT XLSX (CSV) ───────────────────────
  function exportLeads() {
    if (!leadsData.length) return;
    const rows = [['Telefone','Vendedor','Hora']];
    leadsData.forEach(r => rows.push([fmtTel(r.telefone), r.vendedor || '—', fmtHora(r.created_at)]));
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = 'leads_' + new Date().toISOString().slice(0,10) + '.csv';
    a.click(); URL.revokeObjectURL(url);
  }

  // ─── LEADS TAB LOGIC ─────────────────────────
  let fullLeadsData = [];

  async function loadLeadsView() {
    const period = document.getElementById('leadFilterPeriod').value;
    const vend = document.getElementById('leadFilterVend').value;
    const search = document.getElementById('leadFilterSearch').value.toLowerCase();

    // Date range
    const now = new Date();
    let start, end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
    
    if (period === 'hoje') {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    } else if (period === '7d') {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).toISOString();
    } else if (period === 'mes') {
      start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    } else {
      start = '2000-01-01T00:00:00.000Z'; // Tudo
    }

    document.getElementById('fullLeadsTableBody').innerHTML = '<div class="state-msg"><span class="spinner"></span><div style="margin-top:8px">Carregando leads...</div></div>';

    try {
      // Buscar todas as mensagens de leads no período e todos os status
      const [rows, statusRows] = await Promise.all([
        sbGet(`conversas?select=*&tipo=eq.lead&created_at=gte.${start}&created_at=lt.${end}&order=created_at.asc`),
        sbGet('status_de_leads?select=*')
      ]);

      const statusMap = {};
      statusRows.forEach(s => statusMap[s.telefone] = s);

      // Agrupar por telefone
      const leadsMap = {};
      rows.forEach(r => {
        if (!leadsMap[r.telefone]) {
          const st = statusMap[r.telefone] || {};
          leadsMap[r.telefone] = {
            telefone: r.telefone,
            msgs: [],
            primeiroContato: r.created_at,
            vendedor: r.vendedor,
            status: st.status || 'novo',
            nota: st.anotacao || ''
          };
        }
        leadsMap[r.telefone].msgs.push(r);
        leadsMap[r.telefone].ultimaMensagem = r.mensagem;
        leadsMap[r.telefone].ultimoContato = r.created_at;
        if (r.vendedor) leadsMap[r.telefone].vendedor = r.vendedor; // Pega o vendedor mais recente se houver
      });

      let leadsList = Object.values(leadsMap).sort((a,b) => new Date(b.ultimoContato) - new Date(a.ultimoContato));

      // Aplicar filtros locais (Vendedor e Busca)
      if (vend !== 'todos') {
        leadsList = leadsList.filter(l => l.vendedor === vend);
      }
      if (search) {
        leadsList = leadsList.filter(l => String(l.telefone).includes(search));
      }

      fullLeadsData = leadsList;

      // Calcular Métricas
      const total = leadsList.length;
      const matriculados = leadsList.filter(l => l.status === 'matriculado').length;
      const andamento = leadsList.filter(l => l.status === 'em_andamento').length;
      const taxa = total > 0 ? Math.round((matriculados / total) * 100) : 0;

      document.getElementById('metLeadsTotal').textContent = total;
      document.getElementById('metLeadsConv').textContent = matriculados;
      document.getElementById('metLeadsAnd').textContent = andamento;
      document.getElementById('metLeadsTaxa').textContent = taxa + '%';

      // Render Table
      const tbody = document.getElementById('fullLeadsTableBody');
      if (leadsList.length === 0) {
        tbody.innerHTML = '<div class="state-msg">Nenhum lead encontrado para os filtros.</div>';
        return;
      }

      const statusLabels = {
        'novo': 'Novo',
        'em_andamento': 'Em Andamento',
        'matriculado': 'Matriculado',
        'perdido': 'Perdido'
      };

      tbody.innerHTML = leadsList.map(l => {
        const preview = l.ultimaMensagem.substring(0, 40) + (l.ultimaMensagem.length > 40 ? '...' : '');
        const hasNota = l.nota.trim().length > 0;
        return `
          <div class="fl-row" onclick="openLeadModal('${l.telefone}', '${l.vendedor || ''}', '${l.primeiroContato}')">
            <div class="fl-phone">${fmtTel(l.telefone)}</div>
            <div><span class="badge badge-muted" style="font-size:0.6rem">${l.vendedor || '—'}</span></div>
            <div class="fl-msg-count">${l.msgs.length}</div>
            <div class="fl-preview">${preview || '—'}</div>
            <div class="fl-time">${new Date(l.primeiroContato).toLocaleDateString('pt-BR')} ${fmtHora(l.primeiroContato)}</div>
            <div><span class="badge badge-${l.status}">${statusLabels[l.status] || l.status}</span></div>
            <div class="fl-action" title="${hasNota ? 'Ver anotação' : 'Adicionar anotação'}">${hasNota ? '📝' : '➕'}</div>
          </div>
        `;
      }).join('');

    } catch (e) {
      console.error(e);
      document.getElementById('fullLeadsTableBody').innerHTML = '<div class="state-msg">Erro ao carregar leads.</div>';
    }
  }

  function exportFullLeads() {
    if (!fullLeadsData.length) return;
    const rows = [['Telefone','Vendedor','Total Mensagens','Primeiro Contato','Ultimo Contato','Status','Anotação']];
    fullLeadsData.forEach(l => {
      rows.push([
        fmtTel(l.telefone), 
        l.vendedor || '—', 
        l.msgs.length,
        new Date(l.primeiroContato).toLocaleString('pt-BR'),
        new Date(l.ultimoContato).toLocaleString('pt-BR'),
        l.status,
        (l.nota || '').replace(/\n/g, ' ') // remove quebras para csv
      ]);
    });
    const csv = rows.map(r => r.join(';')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = 'relatorio_leads_' + new Date().toISOString().slice(0,10) + '.csv';
    a.click(); URL.revokeObjectURL(url);
  }

  let currentModalLead = null;

  async function openLeadModal(telefone, vendedor, primeiroContato) {
    currentModalLead = telefone;
    document.getElementById('lmTitle').textContent = fmtTel(telefone);
    document.getElementById('lmSub').textContent = `Vendedor: ${vendedor || '—'} · Desde: ${new Date(primeiroContato).toLocaleDateString('pt-BR')}`;
    
    // Load local data from fullLeadsData
    const leadData = fullLeadsData.find(l => l.telefone === telefone);
    document.getElementById('lmStatus').value = leadData ? leadData.status : 'novo';
    document.getElementById('lmNota').value = leadData ? leadData.nota : '';
    
    document.getElementById('lmChat').innerHTML = '<div class="state-msg"><span class="spinner"></span></div>';
    document.getElementById('leadModal').classList.add('open');

    // Fetch chat history
    try {
      const fullMsgs = await sbGet(`conversas?select=*&telefone=eq.${telefone}&order=created_at.desc&limit=100`);
      const msgs = fullMsgs.reverse();
      
      const msgsHtml = msgs.map(m => {
        const isBot = m.de === 'bot';
        return `
          <div class="msg-wrap ${isBot ? 'bot' : 'user'}">
            <div class="msg-bubble ${isBot ? 'ai' : 'user'}">${m.mensagem}</div>
            <div class="msg-tag ${isBot ? 'ai-tag' : ''}">${isBot ? '🤖 Bot IA' : '👤 Cliente'} · ${fmtHora(m.created_at)}</div>
          </div>
        `;
      }).join('');
      
      document.getElementById('lmChat').innerHTML = msgsHtml || '<div class="state-msg">Sem mensagens</div>';
      const chatEl = document.getElementById('lmChat');
      setTimeout(() => chatEl.scrollTop = chatEl.scrollHeight, 50);
    } catch (e) {
      document.getElementById('lmChat').innerHTML = '<div class="state-msg">Erro ao carregar histórico</div>';
    }
  }

  function closeLeadModal() {
    document.getElementById('leadModal').classList.remove('open');
    currentModalLead = null;
  }

  async function saveLeadModal() {
    if (!currentModalLead) return;
    const status = document.getElementById('lmStatus').value;
    const nota = document.getElementById('lmNota').value;
    const btn = document.querySelector('.lead-modal-footer .primary');
    
    btn.textContent = 'Salvando...';
    btn.disabled = true;

    try {
      await sbUpsert('status_de_leads', {
        telefone: currentModalLead,
        status: status,
        anotacao: nota,
        atualizado_em: new Date().toISOString()
      });
      
      btn.textContent = 'Salvar';
      btn.disabled = false;
      closeLeadModal();
      loadLeadsView(); // Refresh table
    } catch (e) {
      console.error(e);
      btn.textContent = 'Erro!';
      setTimeout(() => { btn.textContent = 'Salvar'; btn.disabled = false; }, 2000);
    }
  }

  // ─── NAVEGAÇÃO / VIEWS ─────────────────────
  function showView(view) {
    const allViews = ['viewDashboard', 'viewLeads', 'viewConfig', 'viewBotIA', 'viewRelatorios'];
    const allNavs = ['navDashboard', 'navConversas', 'navLeads', 'navRelatorios', 'navConfig', 'navBotIA'];
    
    // Esconder tudo primeiro para evitar duplicação
    allViews.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.setProperty('display', 'none', 'important');
    });
    allNavs.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('active');
    });

    const topTitle = document.getElementById('topbarTitle');

    if (view === 'dashboard' || view === 'conversas') {
      const viewDash = document.getElementById('viewDashboard');
      viewDash.style.setProperty('display', 'flex', 'important');
      
      const met = document.getElementById('dashboardMetrics');
      const grid = document.getElementById('mainContentGrid');
      const side = document.getElementById('sidePanels');
      const chatGrid = document.getElementById('chatContainerGrid');

      if (view === 'dashboard') {
        document.getElementById('navDashboard').classList.add('active');
        met.style.removeProperty('display');
        side.style.removeProperty('display');
        grid.style.removeProperty('display');
        chatGrid.style.height = '65vh';
        topTitle.textContent = '// dashboard — visão geral';
      } else {
        document.getElementById('navConversas').classList.add('active');
        met.style.setProperty('display', 'none', 'important');
        side.style.setProperty('display', 'none', 'important');
        grid.style.setProperty('display', 'block', 'important');
        chatGrid.style.height = 'calc(100vh - 170px)';
        topTitle.textContent = '// conversas — todas';
      }
    } else if (view === 'leads') {
      document.getElementById('navLeads').classList.add('active');
      document.getElementById('viewLeads').style.setProperty('display', 'flex', 'important');
      topTitle.textContent = '// leads — gestão completa';
      loadLeadsView();
    } else if (view === 'config') {
      document.getElementById('navConfig').classList.add('active');
      document.getElementById('viewConfig').style.setProperty('display', 'flex', 'important');
      topTitle.textContent = '// configurações — sistema';
      loadConfigView();
    } else if (view === 'botia') {
      document.getElementById('navBotIA').classList.add('active');
      document.getElementById('viewBotIA').style.setProperty('display', 'flex', 'important');
      topTitle.textContent = '// bot ia — monitoramento';
      loadBotIAView();
    } else if (view === 'relatorios') {
      document.getElementById('navRelatorios').classList.add('active');
      document.getElementById('viewRelatorios').style.setProperty('display', 'flex', 'important');
      topTitle.textContent = '// relatórios — métricas e desempenho';
      loadRelatorios();
    }

    if (window.innerWidth <= 768) {
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('sidebarOverlay').classList.remove('open');
    }
  }

  // ─── RELATÓRIOS LOGIC ────────────────────────
  async function loadRelatorios() {
    const period = document.getElementById('reportFilterPeriod').value;
    const { start, end } = getDateRange(period);

    // Loading stats...
    const statsIds = ['repTotalLeads','repTotalAlunos','repTotalMsgs','repTaxa'];
    statsIds.forEach(id => document.getElementById(id).innerHTML = '<span class="spinner" style="width:12px;height:12px"></span>');

    try {
      // Busca todas as mensagens do período para processar localmente
      // Limit 5000 para relatórios (ajustar conforme escala)
      const rows = await sbGet(`conversas?select=*&created_at=gte.${start}&created_at=lt.${end}&order=created_at.asc&limit=5000`);
      
      // 1. Métricas Gerais
      const leadsSet = new Set(rows.filter(r => r.tipo === 'lead' && r.de === 'cliente').map(r => r.telefone));
      const alunosSet = new Set(rows.filter(r => r.tipo === 'aluno' && r.de === 'cliente').map(r => r.telefone));
      const totalMsgs = rows.length;
      const taxa = totalMsgs > 0 ? ((alunosSet.size / (leadsSet.size + alunosSet.size || 1)) * 100).toFixed(1) : 0;

      document.getElementById('repTotalLeads').textContent = leadsSet.size;
      document.getElementById('repTotalAlunos').textContent = alunosSet.size;
      document.getElementById('repTotalMsgs').textContent = totalMsgs;
      document.getElementById('repTaxa').textContent = taxa + '%';

      // 2. Gráfico de Leads por Dia
      renderLineChart(rows, start, end);

      // 3. Desempenho por Vendedor
      const vendors = {};
      rows.forEach(r => {
        const v = r.vendedor || 'Desconhecido';
        if (!vendors[v]) vendors[v] = { leads: new Set(), msgs: 0, hours: {} };
        if (r.tipo === 'lead' && r.de === 'cliente') vendors[v].leads.add(r.telefone);
        vendors[v].msgs++;
        const hour = new Date(r.created_at).getHours();
        vendors[v].hours[hour] = (vendors[v].hours[hour] || 0) + 1;
      });

      const vendorTable = document.getElementById('reportVendorTable');
      vendorTable.innerHTML = Object.keys(vendors).map(v => {
        const hPico = Object.entries(vendors[v].hours).sort((a,b) => b[1] - a[1])[0]?.[0] || '--';
        return `
          <tr>
            <td style="font-weight:600">${v}</td>
            <td>${vendors[v].leads.size}</td>
            <td>${vendors[v].msgs}</td>
            <td>${hPico}h</td>
          </tr>
        `;
      }).join('');

      // 4. Mapa de Calor
      renderHeatmap(rows);

      // Cache rows para exportação
      window.lastReportRows = rows;

    } catch (e) {
      console.error(e);
      statsIds.forEach(id => document.getElementById(id).textContent = 'Erro');
    }
  }

  function renderLineChart(rows, start, end) {
    const leadsByDay = {};
    const sDate = new Date(start);
    const eDate = new Date(end);
    
    // Inicializa dias
    for(let d = new Date(sDate); d < eDate; d.setDate(d.getDate() + 1)) {
      leadsByDay[d.toISOString().split('T')[0]] = 0;
    }

    rows.forEach(r => {
      if (r.tipo === 'lead' && r.de === 'cliente') {
        const day = r.created_at.split('T')[0];
        if (leadsByDay[day] !== undefined) leadsByDay[day]++;
      }
    });

    const entries = Object.entries(leadsByDay);
    if (!entries.length) return;

    const max = Math.max(...entries.map(e => e[1]), 5);
    const svg = document.getElementById('reportLeadsChart');
    const w = 800;
    const h = 200;
    const padding = 20;
    
    const points = entries.map((e, i) => {
      const x = (i / (entries.length - 1 || 1)) * (w - padding * 2) + padding;
      const y = h - padding - (e[1] / max) * (h - padding * 2);
      return `${x},${y}`;
    }).join(' ');

    svg.innerHTML = `
      <polyline points="${points}" fill="none" stroke="var(--green)" stroke-width="2" />
      ${entries.map((e, i) => {
        const x = (i / (entries.length - 1 || 1)) * (w - padding * 2) + padding;
        const y = h - padding - (e[1] / max) * (h - padding * 2);
        return `<circle cx="${x}" cy="${y}" r="3" fill="var(--green)" title="${e[0]}: ${e[1]}">
          <title>${e[0]}: ${e[1]} leads</title>
        </circle>`;
      }).join('')}
      <line x1="${padding}" y1="${h-padding}" x2="${w-padding}" y2="${h-padding}" stroke="var(--border)" />
    `;
  }

  function renderHeatmap(rows) {
    const grid = document.getElementById('reportHeatmap');
    // Remove células antigas (mantém labels dos dias)
    const labels = Array.from(grid.children).slice(0, 8);
    grid.innerHTML = '';
    labels.forEach(l => grid.appendChild(l));

    const matrix = Array(14).fill(0).map(() => Array(7).fill(0)); // 8h às 21h
    let max = 1;

    rows.forEach(r => {
      const d = new Date(r.created_at);
      const day = (d.getDay() + 6) % 7; // Seg=0, Dom=6
      const hour = d.getHours();
      if (hour >= 8 && hour <= 21) {
        matrix[hour - 8][day]++;
        if (matrix[hour - 8][day] > max) max = matrix[hour - 8][day];
      }
    });

    for(let h = 8; h <= 21; h++) {
      const label = document.createElement('div');
      label.className = 'heatmap-label';
      label.textContent = h + 'h';
      grid.appendChild(label);

      for(let d = 0; d < 7; d++) {
        const val = matrix[h - 8][d];
        const opacity = val === 0 ? 0.02 : 0.1 + (val / max) * 0.9;
        const cell = document.createElement('div');
        cell.className = 'heatmap-cell';
        cell.style.background = `rgba(0, 217, 126, ${opacity})`;
        cell.title = `${val} mensagens`;
        cell.textContent = val > 0 ? val : '';
        grid.appendChild(cell);
      }
    }
  }

  function exportReportCSV() {
    const rows = window.lastReportRows;
    if (!rows || !rows.length) return alert('Nenhum dado para exportar');
    
    const csvRows = [['Telefone','Vendedor','Tipo','De','Data','Mensagem']];
    rows.forEach(r => {
      csvRows.push([
        r.telefone, 
        r.vendedor || '', 
        r.tipo || '', 
        r.de, 
        new Date(r.created_at).toLocaleString('pt-BR'),
        (r.mensagem || '').replace(/\n/g, ' ').replace(/;/g, ',')
      ]);
    });

    const csvContent = "\uFEFF" + csvRows.map(e => e.join(";")).join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `relatorio_crm_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
  }

  function getDateRange(period) {
    const now = new Date();
    let start = new Date();
    let end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

    if (period === 'hoje') {
      start.setHours(0,0,0,0);
    } else if (period === '7d') {
      start.setDate(now.getDate() - 7);
    } else if (period === 'mes') {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
      start = new Date(2000, 0, 1);
    }
    return { start: start.toISOString(), end: end.toISOString() };
  }

  // ─── CONFIG TAB LOGIC ────────────────────────
  let crmConfig = {
    vendedores: [
      { id: 1, nome: 'Rebeca', whatsapp: '5521999999999', horarios: { manha: ['08:00', '12:00'], tarde: ['13:00', '18:00'], noite: ['19:00', '22:00'] }, ativo: true },
      { id: 2, nome: 'Paulo', whatsapp: '5521888888888', horarios: { manha: ['08:00', '12:00'], tarde: ['13:00', '18:00'], noite: ['19:00', '22:00'] }, ativo: true }
    ],
    bot: { coordenacao: '5521777777777', nomeEscola: 'nossa escola de idiomas', ativo: true, msgForaHorario: 'Olá! No momento estamos fora do horário de atendimento...' },
    crm: { periodoLeads: 'mes', nomeDashboard: 'Escola de Idiomas', autoRefresh: true, botUrl: '', tema: 'dark', github: 'https://github.com/CarvalhodLucas/CRM-WhatsApp' }
  };

  function applyTheme() {
    const theme = crmConfig.crm.tema || 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  }

  // ─── BASE DE CONHECIMENTO (RAG) ───────────
  let baseConhecimento = [];

  async function loadBaseConhecimento() {
    const tableBody = document.getElementById('ragTableBody');
    tableBody.innerHTML = '<tr><td colspan="5" class="state-msg"><span class="spinner"></span></td></tr>';
    
    try {
      baseConhecimento = await sbGet('base_conhecimento?order=created_at.desc');
      renderBaseTable();
    } catch (e) {
      console.error("Erro ao carregar base:", e);
      tableBody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--red)">Erro ao carregar dados</td></tr>';
    }
  }

  function renderBaseTable() {
    const body = document.getElementById('ragTableBody');
    if (!baseConhecimento.length) {
      body.innerHTML = '<tr><td colspan="5" class="empty-state" style="padding:40px">// nenhuma entrada cadastrada</td></tr>';
      return;
    }

    const catBadges = {
      professores: 'badge-blue',
      metodologia: 'badge-green',
      material:    'badge-yellow',
      espanhol:    'badge-purple-rag',
      online:      'badge-cyan',
      ia_robotica: 'badge-orange',
      endereco:    'badge-gray',
      vagas:       'badge-green',
      horario:     'badge-pink',
      nivelamento: 'badge-yellow',
      outro:       'badge-muted'
    };

    body.innerHTML = baseConhecimento.map(entry => `
      <tr id="rag-row-${entry.id}">
        <td><span class="badge ${catBadges[entry.categoria] || 'badge-muted'}">${entry.categoria}</span></td>
        <td><span class="rag-keyword" title="${entry.palavras_chave}">${entry.palavras_chave}</span></td>
        <td>
          <div class="rag-res-container" onmouseenter="showRagTooltip(event, this)" onmouseleave="hideRagTooltip()">
            <div class="rag-res-preview">${entry.resposta}</div>
            <div style="display:none" class="full-text">${entry.resposta.replace(/\n/g, '<br>')}</div>
          </div>
        </td>
        <td>
          <div class="switch" style="transform: scale(0.7); origin: left center;">
            <input type="checkbox" ${entry.ativo ? 'checked' : ''} onchange="toggleBaseAtivo(${entry.id}, this.checked)">
            <span class="slider"></span>
          </div>
        </td>
        <td style="text-align:center">
          <div class="rag-actions">
            <button class="rag-btn edit" onclick="openBaseModal(${entry.id})" title="Editar">✏️</button>
            <button class="rag-btn delete" onclick="deleteBaseEntry(${entry.id})" title="Excluir">🗑️</button>
          </div>
        </td>
      </tr>
    `).join('');
  }

  function showRagTooltip(e, el) {
    const tooltip = document.getElementById('ragGlobalTooltip');
    const fullText = el.querySelector('.full-text').innerHTML;
    tooltip.innerHTML = fullText;
    tooltip.style.display = 'block';
    
    const rect = el.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    
    let top = rect.top - tooltipRect.height - 12;
    // Se estourar o topo da janela, abre pra baixo
    if (top < 20) {
      top = rect.bottom + 12;
    }
    
    tooltip.style.top = top + 'px';
    tooltip.style.left = rect.left + 'px';
    tooltip.style.opacity = '1';
    tooltip.style.transform = 'translateY(0) scale(1)';
  }

  function hideRagTooltip() {
    const tooltip = document.getElementById('ragGlobalTooltip');
    tooltip.style.opacity = '0';
    tooltip.style.transform = 'translateY(10px) scale(0.95)';
    setTimeout(() => {
      if (tooltip.style.opacity === '0') tooltip.style.display = 'none';
    }, 200);
  }

  function openBaseModal(id = null) {
    const modal = document.getElementById('ragModal');
    const title = document.getElementById('ragModalTitle');
    const btnSave = document.getElementById('btnSaveRag');
    
    // Reset fields
    document.getElementById('ragId').value = id || '';
    document.getElementById('ragCategoria').value = 'professores';
    document.getElementById('ragPalavras').value = '';
    document.getElementById('ragResposta').value = '';
    document.getElementById('ragAtivo').checked = true;

    if (id) {
      title.textContent = 'Editar entrada';
      const entry = baseConhecimento.find(e => e.id === id);
      if (entry) {
        document.getElementById('ragCategoria').value = entry.categoria;
        document.getElementById('ragPalavras').value = entry.palavras_chave;
        document.getElementById('ragResposta').value = entry.resposta;
        document.getElementById('ragAtivo').checked = entry.ativo;
      }
    } else {
      title.textContent = 'Nova entrada na Base';
    }

    modal.classList.add('open');
  }

  function closeBaseModal() {
    document.getElementById('ragModal').classList.remove('open');
  }

  async function saveBaseEntry() {
    const btn = document.getElementById('btnSaveRag');
    const id = document.getElementById('ragId').value;
    const data = {
      categoria: document.getElementById('ragCategoria').value,
      palavras_chave: document.getElementById('ragPalavras').value.trim(),
      resposta: document.getElementById('ragResposta').value.trim(),
      ativo: document.getElementById('ragAtivo').checked
    };

    if (!data.palavras_chave || !data.resposta) return alert('Preencha palavras-chave e resposta');

    btn.textContent = 'Salvando...';
    btn.disabled = true;

    try {
      if (id) {
        // UPDATE
        const res = await fetch(SUPABASE_URL + '/rest/v1/base_conhecimento?id=eq.' + id, {
          method: 'PATCH',
          headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify(data)
        });
        if (!res.ok) throw new Error('Update failed');
      } else {
        // CREATE
        await sbUpsert('base_conhecimento', [data]);
      }

      showToast();
      closeBaseModal();
      loadBaseConhecimento();
    } catch (e) {
      console.error(e);
      alert('Erro ao salvar');
    } finally {
      btn.textContent = 'Salvar';
      btn.disabled = false;
    }
  }

  async function deleteBaseEntry(id) {
    if (!confirm('Tem certeza que deseja excluir esta entrada factual?')) return;
    
    try {
      const res = await fetch(SUPABASE_URL + '/rest/v1/base_conhecimento?id=eq.' + id, {
        method: 'DELETE',
        headers: headers
      });
      if (!res.ok) throw new Error('Delete failed');
      showToast();
      loadBaseConhecimento();
    } catch (e) {
      console.error(e);
      alert('Erro ao excluir');
    }
  }

  async function toggleBaseAtivo(id, status) {
    try {
      await fetch(SUPABASE_URL + '/rest/v1/base_conhecimento?id=eq.' + id, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ativo: status })
      });
      showToast();
    } catch (e) {
      console.error(e);
      alert('Erro ao atualizar status');
      loadBaseConhecimento(); // Reload to revert UI
    }
  }

  function loadConfigView() {
    const saved = localStorage.getItem('crm_config');
    if (saved) crmConfig = JSON.parse(saved);

    // Render Vendedores
    renderConfigVendedores();

    // Fill Bot
    document.getElementById('cfgBotCoord').value = crmConfig.bot.coordenacao || '';
    document.getElementById('cfgBotNome').value = crmConfig.bot.nomeEscola || '';
    document.getElementById('cfgBotAtivo').checked = crmConfig.bot.ativo;
    document.getElementById('cfgBotMsgFora').value = crmConfig.bot.msgForaHorario || '';
    updateSwitchLabel('cfgBotAtivo', 'cfgBotAtivoLabel', 'Ativo', 'Pausado');

    // Fill CRM
    document.getElementById('cfgCrmPeriodo').value = crmConfig.crm.periodoLeads || 'mes';
    document.getElementById('cfgCrmNome').value = crmConfig.crm.nomeDashboard || '';
    document.getElementById('cfgCrmRefresh').checked = crmConfig.crm.autoRefresh;
    document.getElementById('cfgCrmBotUrl').value = crmConfig.crm.botUrl || '';
    document.getElementById('cfgCrmTema').value = crmConfig.crm.tema || 'dark';
    document.getElementById('cfgCrmGithub').value = crmConfig.crm.github || '';
    updateSwitchLabel('cfgCrmRefresh', 'cfgCrmRefreshLabel', 'Ativo', 'Desativado');
    
    // Set listeners for switches
    document.getElementById('cfgBotAtivo').onchange = (e) => updateSwitchLabel('cfgBotAtivo', 'cfgBotAtivoLabel', 'Ativo', 'Pausado');
    document.getElementById('cfgCrmRefresh').onchange = (e) => updateSwitchLabel('cfgCrmRefresh', 'cfgCrmRefreshLabel', 'Ativo', 'Desativado');

    renderNumerosSidebar();
    loadBaseConhecimento();
  }

  function renderNumerosSidebar() {
    const raw = localStorage.getItem('crm_numeros');
    const defaultNums = [
      { id: 'paulo', nome: 'Paulo', vendedor: 'Paulo', status: 'ativo' },
      { id: 'rebeca', nome: 'Rebeca', vendedor: 'Rebeca', status: 'ativo' }
    ];
    let nums = raw ? JSON.parse(raw) : defaultNums;
    nums = nums.filter(n => n.id !== 'coord');
    if (!raw) localStorage.setItem('crm_numeros', JSON.stringify(defaultNums));

    const colors = { ativo: 'var(--green)', inativo: 'var(--yellow)', desconectado: 'var(--muted2)' };
    const list = document.getElementById('sidebarNumeros');
    const todosHtml = `<div class="sub-nav-item active" onclick="filterByNumero('todos', this)"><span class="status-dot-mini" style="background:var(--text)"></span> Todos</div>`;
    
    list.innerHTML = todosHtml + nums.map(n => `
      <div class="sub-nav-item" onclick="filterByNumero('${n.vendedor}', this)">
        <span class="status-dot-mini" style="background:${colors[n.status]}"></span> ${n.nome}
      </div>
    `).join('');
  }

  let currentNumeroFilter = 'todos';
  function filterByNumero(vendedor, el) {
    document.querySelectorAll('.sub-nav-item').forEach(i => i.classList.remove('active'));
    el.classList.add('active');
    currentNumeroFilter = vendedor;
    
    // Mostra Dashboard/Conversas se não estiver nelas
    const currentView = document.querySelector('.nav-item.active')?.id;
    if (currentView !== 'navDashboard' && currentView !== 'navConversas') {
      showView('conversas');
    }
    
    loadConversas(); // Recarrega com filtro (ajustar loadConversas para usar currentNumeroFilter)
  }

  function renderConfigVendedores() {
    const list = document.getElementById('configVendedoresList');
    list.innerHTML = crmConfig.vendedores.map((v, idx) => `
      <div class="config-card">
        <div class="config-card-header">
          <div class="config-card-title">${v.nome || 'Novo Vendedor'}</div>
          <button class="action-btn secondary" style="color:var(--red); padding:4px 8px; font-size:0.65rem" onclick="removeVendedor(${idx})">Remover</button>
        </div>
        <div class="config-card-body">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Nome</label>
              <input type="text" class="filter-input" value="${v.nome}" onchange="updateVendedor(${idx}, 'nome', this.value)">
            </div>
            <div class="form-group">
              <label class="form-label">WhatsApp</label>
              <input type="text" class="filter-input" value="${v.whatsapp}" onchange="updateVendedor(${idx}, 'whatsapp', this.value)">
            </div>
          </div>
          
          <div class="form-group">
            <label class="form-label">Horários de Atendimento</label>
            <div class="horarios-grid">
              <div class="horario-item">
                <div class="horario-label">Manhã</div>
                <div class="horario-inputs">
                  <input type="text" class="horario-input" value="${v.horarios.manha[0]}" onchange="updateHorario(${idx}, 'manha', 0, this.value)">
                  <span class="horario-sep">-</span>
                  <input type="text" class="horario-input" value="${v.horarios.manha[1]}" onchange="updateHorario(${idx}, 'manha', 1, this.value)">
                </div>
              </div>
              <div class="horario-item">
                <div class="horario-label">Tarde</div>
                <div class="horario-inputs">
                  <input type="text" class="horario-input" value="${v.horarios.tarde[0]}" onchange="updateHorario(${idx}, 'tarde', 0, this.value)">
                  <span class="horario-sep">-</span>
                  <input type="text" class="horario-input" value="${v.horarios.tarde[1]}" onchange="updateHorario(${idx}, 'tarde', 1, this.value)">
                </div>
              </div>
              <div class="horario-item">
                <div class="horario-label">Noite</div>
                <div class="horario-inputs">
                  <input type="text" class="horario-input" value="${v.horarios.noite[0]}" onchange="updateHorario(${idx}, 'noite', 0, this.value)">
                  <span class="horario-sep">-</span>
                  <input type="text" class="horario-input" value="${v.horarios.noite[1]}" onchange="updateHorario(${idx}, 'noite', 1, this.value)">
                </div>
              </div>
            </div>
          </div>

          <div class="form-group">
            <label class="switch-container">
              <div class="switch">
                <input type="checkbox" ${v.ativo ? 'checked' : ''} onchange="updateVendedor(${idx}, 'ativo', this.checked)">
                <span class="slider"></span>
              </div>
              <span style="font-size:0.75rem">${v.ativo ? 'Ativo' : 'Inativo'}</span>
            </label>
          </div>
          
          <div style="display:flex; gap:10px; margin-top:8px">
            <button class="action-btn primary" style="padding:6px; font-size:0.7rem; flex:1" onclick="saveConfig('vendedores')">Salvar Vendedor</button>
            <button class="action-btn secondary" style="padding:6px; font-size:0.7rem; flex:1; border-color:var(--blue); color:var(--blue)" onclick="openScaleModal('${v.nome}')">📅 Editar Escala</button>
          </div>
        </div>
      </div>
    `).join('');
  }

  function updateVendedor(idx, field, val) { crmConfig.vendedores[idx][field] = val; }
  function updateHorario(idx, period, pos, val) { crmConfig.vendedores[idx].horarios[period][pos] = val; }
  
  function addVendedor() {
    crmConfig.vendedores.push({
      id: Date.now(),
      nome: 'Novo Vendedor',
      whatsapp: '',
      horarios: { manha: ['08:00', '12:00'], tarde: ['13:00', '18:00'], noite: ['19:00', '22:00'] },
      ativo: true
    });
    renderConfigVendedores();
  }

  function removeVendedor(idx) {
    if (confirm('Deseja remover este vendedor?')) {
      crmConfig.vendedores.splice(idx, 1);
      localStorage.setItem('crm_config', JSON.stringify(crmConfig));
      renderConfigVendedores();
      showToast();
    }
  }

  function saveConfig(section) {
    if (section === 'bot') {
      crmConfig.bot.coordenacao = document.getElementById('cfgBotCoord').value;
      crmConfig.bot.nomeEscola = document.getElementById('cfgBotNome').value;
      crmConfig.bot.ativo = document.getElementById('cfgBotAtivo').checked;
      crmConfig.bot.msgForaHorario = document.getElementById('cfgBotMsgFora').value;
    } else if (section === 'crm') {
      crmConfig.crm.periodoLeads = document.getElementById('cfgCrmPeriodo').value;
      crmConfig.crm.nomeDashboard = document.getElementById('cfgCrmNome').value;
      crmConfig.crm.autoRefresh = document.getElementById('cfgCrmRefresh').checked;
      crmConfig.crm.botUrl = document.getElementById('cfgCrmBotUrl').value.trim();
      crmConfig.crm.tema = document.getElementById('cfgCrmTema').value;
      crmConfig.crm.github = document.getElementById('cfgCrmGithub').value.trim();
      document.querySelector('.logo-sub').textContent = crmConfig.crm.nomeDashboard;
      applyTheme();
    }
    
    localStorage.setItem('crm_config', JSON.stringify(crmConfig));
    showToast();
  }

  let currentScaleVendedor = '';
  let currentScaleRows = [];

  async function openScaleModal(vendedor) {
    currentScaleVendedor = vendedor;
    document.getElementById('smVendedor').textContent = vendedor;
    document.getElementById('scaleTableBody').innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px"><span class="spinner"></span></td></tr>';
    document.getElementById('scaleModal').classList.add('open');
    
    try {
      const data = await sbGet(`escala_vendedores?vendedor=eq.${vendedor}`);
      currentScaleRows = data;
      renderScaleRows();
    } catch (e) {
      console.error(e);
      document.getElementById('scaleTableBody').innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--red)">Erro ao carregar escala</td></tr>';
    }
  }

  function renderScaleRows() {
    const body = document.getElementById('scaleTableBody');
    body.innerHTML = currentScaleRows.map((r, i) => `
      <tr>
        <td>
          <select class="scale-input" onchange="updateScaleRow(${i}, 'dia_semana', this.value === 'null' ? null : parseInt(this.value))">
            <option value="null" ${r.dia_semana === null ? 'selected' : ''}>Dias Úteis</option>
            <option value="1" ${r.dia_semana === 1 ? 'selected' : ''}>Segunda</option>
            <option value="2" ${r.dia_semana === 2 ? 'selected' : ''}>Terça</option>
            <option value="3" ${r.dia_semana === 3 ? 'selected' : ''}>Quarta</option>
            <option value="4" ${r.dia_semana === 4 ? 'selected' : ''}>Quinta</option>
            <option value="5" ${r.dia_semana === 5 ? 'selected' : ''}>Sexta</option>
            <option value="6" ${r.dia_semana === 6 ? 'selected' : ''}>Sábado</option>
            <option value="0" ${r.dia_semana === 0 ? 'selected' : ''}>Domingo</option>
          </select>
        </td>
        <td><input type="number" step="0.01" class="scale-input" value="${r.hora_inicio ?? ''}" onchange="updateScaleRow(${i}, 'hora_inicio', parseFloat(this.value))"></td>
        <td><input type="number" step="0.01" class="scale-input" value="${r.hora_fim ?? ''}" onchange="updateScaleRow(${i}, 'hora_fim', parseFloat(this.value))"></td>
        <td>
          <select class="scale-input" onchange="updateScaleRow(${i}, 'tipo', this.value)">
            <option value="exclusivo" ${r.tipo === 'exclusivo' ? 'selected' : ''}>Exclusivo</option>
            <option value="rodizio" ${r.tipo === 'rodizio' ? 'selected' : ''}>Rodízio</option>
          </select>
        </td>
        <td>
          <select class="scale-input" onchange="updateScaleRow(${i}, 'sabado_paridade', this.value === 'null' ? null : this.value)">
            <option value="null" ${r.sabado_paridade === null ? 'selected' : ''}>-</option>
            <option value="par" ${r.sabado_paridade === 'par' ? 'selected' : ''}>Par</option>
            <option value="impar" ${r.sabado_paridade === 'impar' ? 'selected' : ''}>Ímpar</option>
            <option value="sempre" ${r.sabado_paridade === 'sempre' ? 'selected' : ''}>Sempre</option>
          </select>
        </td>
        <td style="text-align:center">
          <button class="action-btn" style="color:var(--red); font-size:1rem" onclick="removeScaleRow(${i})">×</button>
        </td>
      </tr>
    `).join('');
  }

  function updateScaleRow(i, field, val) { currentScaleRows[i][field] = val; }
  function addScaleRow() {
    currentScaleRows.push({ vendedor: currentScaleVendedor, dia_semana: null, hora_inicio: 8, hora_fim: 12, tipo: 'exclusivo', sabado_paridade: null });
    renderScaleRows();
  }
  function removeScaleRow(i) {
    currentScaleRows.splice(i, 1);
    renderScaleRows();
  }
  function closeScaleModal() { document.getElementById('scaleModal').classList.remove('open'); }

  async function saveScale() {
    const btn = document.querySelector('#scaleModal .primary');
    btn.textContent = 'Salvando...';
    btn.disabled = true;

    try {
      // 1. Deletar escala antiga
      await fetch(SUPABASE_URL + '/rest/v1/escala_vendedores?vendedor=eq.' + currentScaleVendedor, {
        method: 'DELETE',
        headers: headers
      });

      // 2. Inserir nova
      if (currentScaleRows.length > 0) {
        const rowsToSave = currentScaleRows.map(r => {
           const { id, created_at, ...cleanRow } = r;
           return cleanRow;
        });
        await fetch(SUPABASE_URL + '/rest/v1/escala_vendedores', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify(rowsToSave)
        });
      }

      btn.textContent = 'Salvar Escala Completa';
      btn.disabled = false;
      closeScaleModal();
      showToast();
    } catch (e) {
      console.error(e);
      btn.textContent = 'Erro!';
      setTimeout(() => { btn.textContent = 'Salvar Escala Completa'; btn.disabled = false; }, 2000);
    }
  }

  async function testBotConnection() {
    const url = document.getElementById('cfgCrmBotUrl').value.trim();
    const btn = document.getElementById('btnTestBot');
    if (!url) return alert('Insira a URL primeiro');
    
    btn.textContent = 'Testando...';
    btn.disabled = true;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url.replace(/\/$/, '') + '/', { signal: controller.signal });
      clearTimeout(timeoutId);
      
      if (res.ok) {
        btn.textContent = '✅ Sucesso!';
        btn.style.color = 'var(--green)';
      } else {
        throw new Error();
      }
    } catch (e) {
      btn.textContent = '❌ Falha';
      btn.style.color = 'var(--red)';
      alert('Não foi possível conectar. Verifique se o bot está rodando e a URL está correta (ex: http://localhost:3000)');
    } finally {
      setTimeout(() => {
        btn.textContent = 'Testar Conexão';
        btn.style.color = '';
        btn.disabled = false;
      }, 3000);
    }
  }

  function updateSwitchLabel(id, labelId, activeText, inactiveText) {
    const checked = document.getElementById(id).checked;
    document.getElementById(labelId).textContent = checked ? activeText : inactiveText;
  }

  function showToast() {
    const t = document.getElementById('toast');
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2000);
  }

  // ─── SIDEBAR ─────────────────────────────────
  function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebarOverlay').classList.toggle('open');
  }

  // ─── INIT ────────────────────────────────────
  async function init() {
    // Load config
    const saved = localStorage.getItem('crm_config');
    if (saved) {
      crmConfig = JSON.parse(saved);
      applyTheme();
      document.querySelector('.logo-sub').textContent = crmConfig.crm.nomeDashboard;
      if (document.getElementById('leadFilterPeriod')) {
        document.getElementById('leadFilterPeriod').value = crmConfig.crm.periodoLeads;
      }
    }

    try {
      await Promise.all([
        loadMetrics(),
        loadConversas(),
        loadVendedores(),
        loadLeads(),
        loadChart()
      ]);

      // Listener para o Enter no simulador
      const simInput = document.getElementById('simInput');
      if (simInput) {
        simInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            simulateResponse();
          }
        });
      }

      const pill = document.getElementById('statusPill');
      pill.className = 'status-pill';
      document.getElementById('statusText').textContent = 'Bot ativo — dados ao vivo';
    } catch (e) {
      console.error(e);
      const pill = document.getElementById('statusPill');
      pill.style.background = 'var(--red-dim)';
      pill.style.color = 'var(--red)';
      document.getElementById('statusText').textContent = 'Erro ao carregar dados';
    }
  }

  init();

  // Auto-refresh a cada 60 segundos (respeitando config)
  setInterval(async () => {
    if (crmConfig.crm.autoRefresh === false) return;

    await loadMetrics();
    await loadConversas();
    await loadVendedores();
    await loadLeads();
    await loadChart();
    
    // Se tiver um chat aberto, atualiza ele também
    if (activeChatTel && allConvsData[activeChatTel]) {
      showConv(allConvsData[activeChatTel], null, true);
    }
  }, 60000);
