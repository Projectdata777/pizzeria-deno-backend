/**
 * Webhook Retell AI — Événements post-appel (Deno Deploy)
 */

import { db } from './db.ts';
import config from './config.ts';

async function verifySignature(req: Request, body: string): Promise<boolean> {
  const secret = config.security.webhookSecret;
  if (!secret || secret === 'changeme') return true;

  const sig = req.headers.get('x-retell-signature');
  if (!sig) return false;

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    const expected = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    if (expected.length !== sig.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}

export async function handleRetellWebhook(req: Request): Promise<Response> {
  const bodyText = await req.text();

  if (!await verifySignature(req, bodyText)) {
    return new Response(JSON.stringify({ error: 'Signature invalide' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = JSON.parse(bodyText) as Record<string, unknown>;
  const event = body.event as string;
  const callObj = (body.call as Record<string, unknown>) ?? {};
  const callId = (callObj.call_id ?? '') as string;

  const response = new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  (async () => {
    try {
      switch (event) {
        case 'call_ended': {
          const durationSec = typeof callObj.duration_ms === 'number'
            ? Math.round(callObj.duration_ms / 1000) : 0;
          await db.from('calls').update({
            status: 'completed',
            ended_at: new Date().toISOString(),
            duration_seconds: durationSec,
            recording_url: (callObj.recording_url as string) ?? null,
          }).eq('retell_call_id', callId);
          console.log(`✅ Webhook call_ended — ${callId}`);
          break;
        }
        case 'call_analyzed': {
          const analysis = (callObj.call_analysis as Record<string, unknown>) ?? {};
          await db.from('calls').update({
            call_successful: (analysis.call_successful as boolean) ?? null,
            user_sentiment: (analysis.user_sentiment as string) ?? null,
            summary: (analysis.call_summary as string) ?? null,
          }).eq('retell_call_id', callId);
          console.log(`✅ Webhook call_analyzed — ${callId}`);
          break;
        }
      }
    } catch (err) {
      console.error('❌ Retell webhook erreur:', err);
    }
  })();

  return response;
}
