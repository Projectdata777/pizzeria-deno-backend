/**
 * Config — Variables d'environnement Deno Deploy
 */

export const config = {
  baseUrl: Deno.env.get('BASE_URL') || 'http://localhost:8000',

  retell: {
    apiKey: Deno.env.get('RETELL_API_KEY') || '',
  },

  anthropic: {
    apiKey: Deno.env.get('ANTHROPIC_API_KEY') || '',
    model: Deno.env.get('ANTHROPIC_MODEL') || 'claude-haiku-4-5-20251001',
  },

  twilio: {
    accountSid: Deno.env.get('TWILIO_ACCOUNT_SID') || '',
    authToken:  Deno.env.get('TWILIO_AUTH_TOKEN') || '',
    smsFrom:    Deno.env.get('TWILIO_SMS_FROM') || '',
  },

  supabase: {
    url:        Deno.env.get('SUPABASE_URL') || '',
    serviceKey: Deno.env.get('SUPABASE_SERVICE_KEY') || '',
  },

  zadarma: {
    apiKey:    Deno.env.get('ZADARMA_API_KEY') || '',
    apiSecret: Deno.env.get('ZADARMA_API_SECRET') || '',
  },

  ntfy: {
    baseUrl: Deno.env.get('NTFY_BASE_URL') || 'https://ntfy.sh',
  },

  security: {
    webhookSecret: Deno.env.get('WEBHOOK_SECRET') || 'changeme',
    allowedOrigins: (Deno.env.get('ALLOWED_ORIGINS') || 'http://localhost:5173').split(',').map(o => o.trim()),
  },
};

export default config;
