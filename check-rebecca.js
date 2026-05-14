/**
 * check-rebecca.js — diagnóstico de mensagens da Rebecca no banco
 * Uso: node check-rebecca.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function main() {
    // 1. Quais valores únicos de 'vendedor' existem no banco?
    const { data: vendedores } = await supabase
        .from('conversas')
        .select('vendedor')
        .order('vendedor');

    const unique = [...new Set(vendedores.map(r => JSON.stringify(r.vendedor)))].map(v => JSON.parse(v));
    console.log('\n📊 Valores de "vendedor" no banco:');
    unique.forEach(v => console.log(`   "${v}"`));

    // 2. Contagem por vendedor
    console.log('\n📊 Contagem de registros por vendedor:');
    for (const v of unique) {
        const { count } = await supabase
            .from('conversas')
            .select('id', { count: 'exact', head: true })
            .eq('vendedor', v);
        console.log(`   "${v}": ${count} registros`);
    }

    // 3. Últimas 5 mensagens de 'Rebecca' (qualquer grafia)
    const { data: recentRebecca } = await supabase
        .from('conversas')
        .select('telefone, mensagem, de, vendedor, tipo, created_at')
        .in('vendedor', ['Rebeca', 'Rebecca', 'rebeca', 'rebecca'])
        .order('created_at', { ascending: false })
        .limit(5);

    console.log('\n📋 Últimas 5 mensagens da Rebecca:');
    if (!recentRebecca?.length) {
        console.log('   ❌ Nenhuma encontrada!');
    } else {
        recentRebecca.forEach(r => {
            console.log(`   [${r.created_at?.slice(0,19)}] de=${r.de} vendedor="${r.vendedor}" tel=${r.telefone}`);
            console.log(`      msg: ${r.mensagem?.slice(0,60)}`);
        });
    }

    // 4. Verificar se a webhook-vendedor está sendo chamada com o nome certo
    console.log('\n💡 O valor "vendedor" vem do parâmetro ?vendedor= na URL do webhook Z-API.');
    console.log('   Verifique se a URL está configurada como: /webhook-vendedor?vendedor=Rebecca');
}

main().catch(console.error);
