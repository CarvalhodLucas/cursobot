/**
 * check-escala.js — diagnóstico da escala_vendedores
 * Uso: node check-escala.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const DIAS = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];

async function main() {
    const { data, error } = await supabase
        .from('escala_vendedores')
        .select('*')
        .order('dia_semana')
        .order('hora_inicio');

    if (error) { console.error('❌', error.message); return; }

    if (!data || data.length === 0) {
        console.log('⚠️  Tabela escala_vendedores está VAZIA — bot usa fallback alternado pra tudo!');
        return;
    }

    console.log('\n📅 ESCALA CONFIGURADA:\n');
    for (const e of data) {
        const dia = DIAS[e.dia_semana] || `dia ${e.dia_semana}`;
        const ini = `${Math.floor(e.hora_inicio)}:${String(Math.round((e.hora_inicio % 1) * 60)).padStart(2,'0')}`;
        const fim = `${Math.floor(e.hora_fim)}:${String(Math.round((e.hora_fim % 1) * 60)).padStart(2,'0')}`;
        const extra = e.sabado_paridade ? ` [sáb ${e.sabado_paridade}]` : '';
        console.log(`  ${dia.padEnd(9)} ${ini} – ${fim}  → ${e.vendedor}${extra}`);
    }

    // Simula o horário do incidente: Quarta 9:11
    console.log('\n🔍 SIMULANDO Quarta-feira 09:11 (dia=3, hora=9.183):');
    const hora = 9 + 11/60;
    const dia = 3;
    const match = data.find(e => {
        return e.dia_semana === dia &&
               hora >= (e.hora_inicio - 0.02) &&
               hora < (e.hora_fim + 0.02);
    });

    if (match) {
        console.log(`  ✅ Encontrou entrada → vendedor: ${match.vendedor} (${match.hora_inicio}h–${match.hora_fim}h)`);
    } else {
        console.log(`  ❌ NENHUMA entrada cobre Quarta 09:11 → fallback alternado disparou!`);
        console.log(`     Isso explica o Paulo ter recebido um lead às 9:11.`);
    }

    // Mostra todas as quartas
    const quartas = data.filter(e => e.dia_semana === 3);
    if (quartas.length === 0) {
        console.log('\n  ⚠️  Não há NENHUM horário cadastrado para Quarta-feira!');
    } else {
        console.log('\n  Horários de Quarta cadastrados:');
        quartas.forEach(e => {
            const ini = `${Math.floor(e.hora_inicio)}:${String(Math.round((e.hora_inicio % 1) * 60)).padStart(2,'0')}`;
            const fim = `${Math.floor(e.hora_fim)}:${String(Math.round((e.hora_fim % 1) * 60)).padStart(2,'0')}`;
            console.log(`    ${ini} – ${fim} → ${e.vendedor}`);
        });
    }
}

main().catch(console.error);
