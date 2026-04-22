import config from './config.ts';
import type { OrderItem } from './db.ts';

async function twilioSms(to: string, body: string): Promise<{success:boolean;sid?:string;error?:string}> {
  const {accountSid,authToken,smsFrom} = config.twilio;
  if (!accountSid||!authToken||!smsFrom) return {success:false,error:'Twilio non configuré'};
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,{
      method:'POST',
      headers:{'Authorization':`Basic ${btoa(`${accountSid}:${authToken}`)}`,'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({To:to,From:smsFrom,Body:body}).toString()
    });
    const d = await res.json() as {sid?:string;message?:string};
    if (!res.ok) throw new Error(d.message||String(res.status));
    return {success:true,sid:d.sid};
  } catch(err) { return {success:false,error:String(err)}; }
}

export function formatOwnerMessage(opts:{restaurantName:string;orderItems:OrderItem[];orderType:string;deliveryAddress?:string;pickupTime?:string;total:number;callerPhone?:string;delayMinutes?:number;customerName?:string;isVip?:boolean}):string {
  const now = new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
  const typeLabel = opts.orderType==='livraison'?'🚗 Livraison':opts.orderType==='retrait'?'🏃 Retrait':'📞 Sur place';
  return ['━━━━━━━━━━━━━━━━━━━━',`🍕 ${opts.restaurantName.toUpperCase()}`,...(opts.isVip?['⭐ CLIENT VIP']:[]),`🕐 ${now}  ${typeLabel}`,'━━━━━━━━━━━━━━━━━━━━',...opts.orderItems.map(i=>`${i.qte}x ${i.nom}${i.notes?` (${i.notes})`:''}  →  ${(i.prix*i.qte).toFixed(2)}€`),'━━━━━━━━━━━━━━━━━━━━',`💰 TOTAL : ${opts.total.toFixed(2)}€`,...(opts.orderType==='livraison'&&opts.deliveryAddress?[`📍 ${opts.deliveryAddress}`]:[]),...(opts.pickupTime?[`⏰ ${opts.pickupTime}`]:[]),...(opts.delayMinutes?[`⌛ Délai : ${opts.delayMinutes} min`]:[]),...(opts.callerPhone?[`📞 ${opts.callerPhone}`]:[]),...(opts.customerName?[`👤 ${opts.customerName}`]:[])].join('\n');
}
export async function notifyOwnerSms(p:string,m:string):Promise<void>{const r=await twilioSms(p,m);if(r.success)console.log(`✅ SMS→${p}`);}
export async function notifyOwnerPush(t:string,m:string,n:string):Promise<void>{if(!t)return;try{await fetch(`${config.ntfy.baseUrl}/${t}`,{method:'POST',headers:{'Title':`🍕 Nouvelle commande — ${n}`,'Priority':'high','Tags':'pizza,bell','Content-Type':'text/plain; charset=utf-8'},body:m});}catch(e){console.error('ntfy error:',e);}}
export async function notifyClient(opts:{clientPhone:string;restaurantName:string;orderItems:OrderItem[];total:number;orderType:string;delayMinutes?:number;deliveryAddress?:string}):Promise<void>{const delay=opts.delayMinutes??30;const typeLabel=opts.orderType==='livraison'?`Livraison dans ${delay} min à ${opts.deliveryAddress||'votre adresse'}`:`Retrait prêt dans ${delay} min`;await twilioSms(opts.clientPhone,`✅ Commande confirmée — ${opts.restaurantName}\n${opts.orderItems.map(i=>`• ${i.qte}x ${i.nom}`).join('\n')}\nTotal: ${opts.total.toFixed(2)}€\n${typeLabel}\nMerci ! 🍕`);}
export async function sendMarketingSms(opts:{clientPhone:string;message:string;promoCode?:string}):Promise<{success:boolean;sid?:string;error?:string}>{return twilioSms(opts.clientPhone,opts.promoCode?`${opts.message}\n\nCode promo: ${opts.promoCode} 🎁`:opts.message);}
