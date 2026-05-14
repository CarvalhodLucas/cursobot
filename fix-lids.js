/**
 * fix-lids.js — migração única: resolve LIDs do WhatsApp → telefones reais no banco
 * Uso: node fix-lids.js
 */
require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Instâncias dos vendedores
const INSTANCIAS = [
    { nome: 'Paulo',  instanceId: '3F2C566A6A43D19367C3AAA33AE3F93B', token: '25451602CE9391A183986DD8' },
    { nome: 'Rebecca', instanceId: '3F2C553C134731A2853862108CBB360D', token: '3AAB3A6433183E828BFB1070' },
];

async function getChats(instancia) {
    const url = `https://api.z-api.io/instances/${instancia.instanceId}/token/${instancia.token}/chats`;
    try {
        const resp = await axios.get(url, {
            headers: { 'Client-Token': CLIENT_TOKEN },
            timeout: 15000
        });
        return resp.data;
    } catch (e) {
        console.error(`❌ Erro buscando chats de ${instancia.nome}:`, e.response?.data || e.message);
        return null;
    }
}

async function resolveLidViaApi(instancia, lid) {
    // Tenta resolver um LID específico para telefone real
    const endpoints = [
        `contacts/${lid}@lid`,
        `contacts/${lid}`,
        `phone-exists/${lid}`,
    ];
    for (const ep of endpoints) {
        try {
            const resp = await axios.get(
                `https://api.z-api.io/instances/${instancia.instanceId}/token/${instancia.token}/${ep}`,
                { headers: { 'Client-Token': CLIENT_TOKEN }, timeout: 8000 }
            );
            const d = resp.data;
            const phone = d.phone || d.id?.split('@')[0] || d.inputPhone || d.jid?.split('@')[0] || '';
            const tel = phone.replace(/\D/g, '');
            if (tel && tel.length >= 10 && !tel.includes('lid')) return tel;
        } catch(e) { /* tenta próximo */ }
    }
    return null;
}

async function fixLids() {
    // Busca todos os telefones no banco que parecem ser LIDs (sem prefixo 55, 10+ dígitos)
    const { data: lidRows, error } = await supabase
        .from('conversas')
        .select('telefone')
        .not('telefone', 'ilike', '55%')
        .order('created_at', { ascending: false });

    if (error) { console.error('❌ Erro lendo banco:', error.message); return; }

    const lidsNoBanco = [...new Set(lidRows.map(r => r.telefone))];
    console.log(`📊 LIDs encontrados no banco: ${lidsNoBanco.length}`);
    if (lidsNoBanco.length === 0) { console.log('✅ Nenhum LID para corrigir!'); return; }

    const lidToPhone = new Map();

    // Estratégia 1: busca todos os chats e tenta cruzar pelo nome/contexto
    for (const inst of INSTANCIAS) {
        console.log(`\n🔍 Buscando chats individuais de ${inst.nome}...`);
        const chats = await getChats(inst);
        if (!chats) continue;
        const lista = (Array.isArray(chats) ? chats : (chats.value || [])).filter(c => !c.isGroup);
        console.log(`   ${lista.length} chats individuais`);
        for (const chat of lista) {
            const phone = (chat.phone || '').replace(/\D/g, '');
            if (!phone || phone.length < 10) continue;
            // Verifica se esse telefone já está no banco como LID alternativo
            // Tenta resolver o chatLid se disponível
            const chatLid = chat.chatLid || chat.lid || '';
            const lid = chatLid ? chatLid.split('@')[0] : null;
            if (lid && lidsNoBanco.includes(lid)) {
                let tel = phone;
                if (tel.length === 10 || tel.length === 11) tel = '55' + tel;
                lidToPhone.set(lid, tel);
                console.log(`   🔗 ${lid} → ${tel} (${chat.name || '?'})`);
            }
        }
    }

    // Estratégia 2: consulta cada LID individualmente nas instâncias
    const lidsRestantes = lidsNoBanco.filter(l => !lidToPhone.has(l));
    if (lidsRestantes.length > 0) {
        console.log(`\n🔍 Consultando ${lidsRestantes.length} LIDs diretamente nas instâncias...`);
        for (const lid of lidsRestantes) {
            for (const inst of INSTANCIAS) {
                const tel = await resolveLidViaApi(inst, lid);
                if (tel && tel !== lid && tel.startsWith('55') && (tel.length === 12 || tel.length === 13)) {
                    lidToPhone.set(lid, tel);
                    console.log(`   🔗 ${lid} → ${tel} (via ${inst.nome})`);
                    break;
                }
            }
        }
    }

    if (lidToPhone.size === 0) {
        console.log('\n⚠️  Z-API não expõe mapeamento LID→telefone via API REST.');
        console.log('   Os LIDs serão resolvidos automaticamente conforme os clientes responderem.');
        console.log('   O bot já está configurado para fazer isso em tempo real.');
        return;
    }

    // Atualiza o banco
    console.log(`\n✅ Resolvidos ${lidToPhone.size} LIDs. Atualizando banco...`);
    let atualizados = 0;
    for (const [lid, phone] of lidToPhone) {
        const { error: updErr, count } = await supabase
            .from('conversas')
            .update({ telefone: phone })
            .eq('telefone', lid);
        if (updErr) {
            console.error(`   ❌ Erro atualizando ${lid}:`, updErr.message);
        } else {
            console.log(`   ✅ ${lid} → ${phone}`);
            atualizados++;
        }
    }
    console.log(`\n🎉 Concluído! ${atualizados} LIDs corrigidos no banco.`);
}

fixLids().catch(console.error);
