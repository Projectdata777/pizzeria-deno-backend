/**
 * Notifications — SMS Twilio + ntfy push (Deno Deploy)
 */

import config from './config.ts';
import type { OrderItem } from './db.ts';

async function twilioSms(to: string, body: string): Promise<{ success: boolean; sid?: string; error?: string }> {
  const { accountSid, authToken, smsFrom } = config.twilio;
  if (!accountSid || !authToken || !smsFrom) {
    console.warn('⚠️  Twilio non configuré');
    return { success: false, error: 'Twilio non configuré' };
  }
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${btoa(`${accountSid}:${authToken}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: smsFrom, Body: body }).toString(),
      }
    );
    const data = await res.json() as { sid?: string; message?: string };
    if (!res.ok) throw new Error(data.message || String(res.status));
    return { success: true, sid: data.sid };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('❌ Twilio erreur:', error);
    return { success: false, error };
  }
}

export function formatOwnerMessage(opts: {
  restaurantName: string;
  orderItems: OrderItem[];
  orderType: 'livraison' | 'retrait' | 'sur_place' | 'inconnu';
  deliveryAddress?: string;
  pickupTime?: string;
  total: number;
  callerPhone?: string;
  delayMinutes?: number;
  customerName?: string;
  isVip?: boolean;
}): string {
  const now = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const typeEmoji = opts.orderType === 'livraison' ? '🚗' : opts.orderType === 'retrait' ? '🏃' : '📞';
  const typeLabel = opts.orderType === 'livraison' ? 'Livraison' : opts.orderType === 'retrait' ? 'Retrait' : 'Sur place';
  const lines: string[] = [
    `━━━━━━━━━━━━━━━━━━━━`,
    `🍕 ${opts.restaurantName.toUpperCase()}`,
    ...(opts.isVip ? ['⭐ CLIENT VIP'] : []),
    `🕐 ${now}  ${typeEmoji} ${typeLabel}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ...opts.orderItems.map(item => `${item.qte}x ${item.nom}${item.notes ? ` (${item.notes})` : ''}  →  ${(item.prix * item.qte).toFixed(2)}€`),
    `━━━━━━━━━━━━━━━━━━━━`,
    `💰 TOTAL : ${opts.total.toFixed(2)}€`,
    ...(opts.orderType === 'livraison' && opts.deliveryAddress ? [`📍 ${opts.deliveryAddress}`] : []),
    ...(opts.pickupTime ? [`⏰ ${opts.pickupTime}`] : []),
    ...(opts.delayMinutes ? [`⌛ Délai : ${opts.delayMinutes} min`] : []),
    ...(opts.callerPhone ? [`📞 ${opts.callerPhone}`] : []),
    ...(opts.customerName ? [`👤 ${opts.customerName}`] : []),
  ];
  return lines.join('\n');
}

export async function notifyOwnerSms(ownerPhone: string, message: string): Promise<void> {
  const result = await twilioSms(ownerPhone, message);
  if (result.success) console.log(`✅ SMS patron envoyé → ${ownerPhone}`);
}

export async function notifyOwnerPush(ntfyTopic: string, message: string, restaurantName: string): Promise<void> {
  if (!ntfyTopic) return;
  try {
    await fetch(`${config.ntfy.baseUrl}/${ntfyTopic}`, {
      method: 'POST',
      headers: {
        'Title': `🍕 Nouvelle commande — ${restaurantName}`,
        'Priority': 'high',
        'Tags': 'pizza,bell',
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: message,
    });
    console.log(`✅ Push ntfy envoyé → ${ntfyTopic}`);
  } catch (err) {
    console.error('❌ ntfy erreur:', err);
  }
}

export async function notifyClient(opts: {
  clientPhone: string;
  restaurantName: string;
  orderItems: OrderItem[];
  total: number;
  orderType: string;
  delayMinutes?: number;
  deliveryAddress?: string;
}): Promise<void> {
  const delay = opts.delayMinutes ?? 30;
  const typeLabel = opts.orderType === 'livraison'
    ? `Livraison estimée dans ${delay} min à ${opts.deliveryAddress || 'votre adresse'}`
    : `Retrait prêt dans ${delay} min`;
  const itemLines = opts.orderItems.map(i => `• ${i.qte}x ${i.nom}`).join('\n');
  const message = `✅ Commande confirmée — ${opts.restaurantName}\n\n${itemLines}\n\nTotal : ${opts.total.toFixed(2)}€\n${typeLabel}\n\nMerci de votre confiance ! 🍕`;
  await twilioSms(opts.clientPhone, message);
}

export async function sendMarketingSms(opts: {
  clientPhone: string;
  message: string;
  promoCode?: string;
}): Promise<{ success: boolean; sid?: string; error?: string }> {
  const fullMessage = opts.promoCode ? `${opts.message}\n\nCode promo : ${opts.promoCode} 🎁` : opts.message;
  return await twilioSms(opts.clientPhone, fullMessage);
}
