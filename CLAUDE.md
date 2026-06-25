# Contexto do Projeto — Studio Rastro Bot

## Infraestrutura
- Bot rodando no **Railway**: `https://cursobot-production.up.railway.app`
- Banco de dados: **Supabase** (`https://gnyvfslxoiobgmohejqf.supabase.co`)
- Tabela principal: `conversas` (campos: `telefone`, `mensagem`, `de`, `vendedor`, `tipo`, `created_at`)

## Números de WhatsApp
| Número | Nome | Conexão | Status no CRM |
|--------|------|---------|---------------|
| +55 21 97038-9751 | Bot principal | Z-API | ✅ Já salva no CRM |
| +55 21 97912-9143 | Studio Rastro | Meta Cloud API | ❌ Ainda não salva no CRM |

## Meta Cloud API — Studio Rastro
- **WABA ID:** 1943356066360185
- **Phone Number ID:** 1235565206304512
- **Token:** `META_TOKEN_STUDIO_RASTRO` (no .env do Railway)
- **Webhook configurado:** `https://cursobot-production.up.railway.app/webhook`
- **META_VERIFY_TOKEN:** `cna_recreio_2024` (no Railway Variables)
- **Campo `messages`:** ✅ Assinado no painel Meta

## Problema atual (jun/2025)
O número +55 21 97912-9143 está usando o **WhatsApp Business App no celular**.
Para a Cloud API funcionar (e o webhook receber mensagens), o número precisa ser registrado via API (`request_code` + `register`).

**Erro encontrado:** Rate limit no `request_code` por tentativas repetidas.
**Causa raiz:** O número ainda está ativo no WhatsApp Business App — precisa migrar ou usar Coexistência.

## ⚠️ DECISÃO PENDENTE — Coexistência Meta

A Meta lançou a **Coexistência** (fev/2025) que permite usar o WhatsApp Business App no celular E a Cloud API AO MESMO TEMPO no mesmo número.

**Como funciona:**
- Mensagens sincronizadas em tempo real nos dois lados
- Histórico dos últimos 6 meses sincronizado
- Precisa abrir o app no celular pelo menos a cada 14 dias (ou desativa)

**Como habilitar:**
- Requer processo de **Embedded Signup** da Meta
- Normalmente feito por plataformas BSP (Wati, SleekFlow, WANotifier etc.)
- Também pode ser implementado diretamente no próprio app Meta do desenvolvedor

**Referências:**
- https://wanotifier.com/whatsapp-coexistence-guide/
- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview/

## Histórico de mensagens no Supabase
- Mensagens do bot principal salvas até **13/06/2025**
- A partir de 14/06/2025 em diante: objetivo é capturar via webhook da Meta Cloud API

## Código relevante no index.js
- `salvarMensagem()` — função que faz INSERT na tabela `conversas`
- `/webhook` (GET) — verificação do webhook Meta (usa `META_VERIFY_TOKEN`)
- `/webhook` (POST) — recebe mensagens Meta Cloud API e Z-API (já implementado)
- `/webhook-vendedor` (POST) — exclusivo para mensagens de vendedores via Z-API
