/**
 * Pizzeria Vocal SaaS — Backend Deno Deploy
 * Point d'entrée unique : HTTP + WebSocket
 */

import config from './config.ts';
import { handleLlmWebSocket } from './llm.ts';
import { handleApi } from './routes.ts';
import { handleRetellWebhook } from './webhook.ts';

// ─── CORS headers ─────────────────────────────────────────────────────────────
function corsHeaders(origin: string | null): HeadersInit {
  const allowed = config.security.allowedOrigins;
  const allowOrigin = !origin || allowed.includes(origin) || allowed.includes('*')
    ? (origin || '*')
    : allowed[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-retell-signature',
    'Access-Control-Allow-Credentials': 'true',
  };
}

// ─── Serveur principal ────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const origin = req.headers.get('Origin');

  // Preflight CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  // ── WebSocket LLM (Retell) ──────────────────────────────────────────────────
  if (url.pathname === '/llm-websocket') {
    const upgrade = req.headers.get('Upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }
    console.log(`🔌 WebSocket upgrade depuis IP: ${req.headers.get('CF-Connecting-IP') || 'unknown'}`);
    return handleLlmWebSocket(req);
  }

  // ── Webhook Retell ──────────────────────────────────────────────────────────
  if (url.pathname === '/webhook/retell') {
    const res = await handleRetellWebhook(req);
    for (const [k, v] of Object.entries(corsHeaders(origin))) {
      res.headers.set(k, v);
    }
    return res;
  }

  // ── API Routes ──────────────────────────────────────────────────────────────
  if (url.pathname.startsWith('/api')) {
    const res = await handleApi(req, url);
    for (const [k, v] of Object.entries(corsHeaders(origin))) {
      res.headers.set(k, v);
    }
    return res;
  }

  // ── 404 ─────────────────────────────────────────────────────────────────────
  return new Response('Not found', { status: 404, headers: corsHeaders(origin) });
});

console.log('🍕 Pizzeria Vocal SaaS — Deno Deploy démarré');
console.log(`   WebSocket : /llm-websocket`);
console.log(`   API       : /api/*`);
console.log(`   Webhook   : /webhook/retell`);
