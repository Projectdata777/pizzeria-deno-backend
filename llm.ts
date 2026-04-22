import Anthropic from 'npm:@anthropic-ai/sdk';
import { db } from './db.ts';
import type { Restaurant, Customer, OrderItem } from './db.ts';
import config from './config.ts';
import { notifyOwnerSms, notifyOwnerPush, notifyClient, formatOwnerMessage } from './notifications.ts';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

interface RetellMessage {
  interaction_type: 'call_details'|'response_required'|'reminder_required'|'update_only';
  call?: { call_id: string; from_number?: string; to_number?: string; };
  transcript?: Array<{ role: 'agent'|'user'; content: string }>;
  response_id?: number;
}
interface OrderState {
  articles: OrderItem[];
  type: 'livraison'|'retrait'|'sur_place'|'inconnu';
  adresse_livraison?: string;
  heure_souhaitee?: string;
  total_estime: number;
}
interface SessionContext {
  callId: string; restaurant: Restaurant|null; customer: Customer|null;
  orderState: OrderState; history: Array<{role:'system'|'user'|'assistant';content:string}>;
  upsellDone: boolean; notificationSent: boolean; clientSmsSent: boolean;
  language: 'fr'|'en'|'ar'; callerPhone: string; callStartTime: number;
}

async function findRestaurantByPhone(phone: string): Promise<Restaurant|null> {
  const {data} = await db.from('restaurants').select('*').or(`retell_phone.eq.${phone},phone.eq.${phone},zadarma_number.eq.${phone}`).eq('is_active',true).limit(1).single();
  return data as Restaurant|null;
}
async function findOrCreateCustomer(phone: string, restaurantId: string): Promise<Customer|null> {
  if (!phone||!restaurantId) return null;
  const {data:existing} = await db.from('customers').select('*').eq('restaurant_id',restaurantId).eq('phone',phone).single();
  if (existing) return existing as Customer;
  const {data:created} = await db.from('customers').insert({restaurant_id:restaurantId,phone}).select().single();
  return created as Customer|null;
}
function buildSystemPrompt(ctx: SessionContext): string {
  const r = ctx.restaurant;
  if (!r) return 'Tu es un assistant téléphonique pour restaurant. Prends les commandes. Parle français.';
  const cfg = r.config_json as Record<string,unknown>;
  const delay = (cfg?.delay_minutes as number)??30;
  const hoursText = cfg?.hours ? Object.entries(cfg.hours as Record<string,string>).map(([d,h])=>`${d}: ${h}`).join('\n') : 'Voir avec le restaurant';
  const vip = ctx.customer&&ctx.customer.order_count>0 ? `\n## CLIENT FIDÈLE\nPrénom: ${ctx.customer.first_name||'inconnu'}\nCommandes: ${ctx.customer.order_count}` : '';
  return `Tu es l'assistant vocal de ${r.name} (${r.type}). Prénom: Alex.\n\n## RÈGLES\n- Réponds en ${ctx.language==='ar'?'arabe':ctx.language==='en'?'anglais':'français'}\n- Appel vocal: pas de listes\n- Une question à la fois\n\n## HORAIRES\n${hoursText}\n\n## DÉLAI\n${delay} minutes\n\n## FLOW\n1. Accueil: "Bonjour, ${r.name}, Alex à l'appareil"\n2. Prendre les articles\n3. Livraison ou retrait ?\n4. Si livraison: adresse complète\n5. Si retrait: heure\n6. UPSELL (1 fois)\n7. Récapitulatif${vip}\n\n## INTERDICTIONS\n- Ne pas inventer prix/articles\n- Max 1 upsell`;
}
function extractOrder(history: SessionContext['history']): Partial<OrderState> {
  const text = history.map(h=>h.content).join('\n').toLowerCase();
  const type = text.includes('livraison')?'livraison':text.includes('retrait')||text.includes('sur place')?'retrait':'inconnu';
  const addr = text.match(/(?:adresse|livrer)[^\n.]*?(\d+[^,.]+)/i);
  return { type, adresse_livraison: addr?.[1] };
}
async function saveCall(callId: string, ctx: SessionContext, status: string): Promise<void> {
  if (!callId) return;
  const transcript = ctx.history.filter(h=>h.role!=='system').map(h=>`[${h.role==='user'?'Client':'Agent'}] ${h.content}`).join('\n');
  await db.from('calls').upsert({ retell_call_id:callId, restaurant_id:ctx.restaurant?.id??null, customer_id:ctx.customer?.id??null, from_number:ctx.callerPhone, to_number:ctx.restaurant?.retell_phone??null, status, transcript, duration_seconds:Math.round((Date.now()-ctx.callStartTime)/1000), started_at:new Date(ctx.callStartTime).toISOString() });
}
async function finalizeCall(ctx: SessionContext): Promise<void> {
  if (!ctx.restaurant||ctx.notificationSent) return;
  ctx.notificationSent = true;
  const orderState = {...ctx.orderState,...extractOrder(ctx.history)};
  const cfg = ctx.restaurant.config_json as Record<string,unknown>;
  const delay = (cfg?.delay_minutes as number)??30;
  const ntfyTopic = (cfg?.ntfy_topic as string)||'';
  const message = formatOwnerMessage({ restaurantName:ctx.restaurant.name, orderItems:orderState.articles, orderType:orderState.type as 'livraison'|'retrait'|'sur_place'|'inconnu', deliveryAddress:orderState.adresse_livraison, pickupTime:orderState.heure_souhaitee, total:orderState.total_estime, callerPhone:ctx.callerPhone, delayMinutes:delay, customerName:ctx.customer?.first_name??undefined, isVip:ctx.customer?.is_vip??false });
  await Promise.allSettled([ notifyOwnerSms(ctx.restaurant.owner_phone,message), ntfyTopic?notifyOwnerPush(ntfyTopic,message,ctx.restaurant.name):Promise.resolve() ]);
  if (ctx.callerPhone&&orderState.articles.length>0&&!ctx.clientSmsSent) {
    ctx.clientSmsSent=true;
    await notifyClient({ clientPhone:ctx.callerPhone, restaurantName:ctx.restaurant.name, orderItems:orderState.articles, total:orderState.total_estime, orderType:orderState.type, delayMinutes:delay, deliveryAddress:orderState.adresse_livraison });
  }
  if (orderState.articles.length>0) {
    await db.from('orders').insert({ restaurant_id:ctx.restaurant.id, customer_id:ctx.customer?.id??null, items:orderState.articles, type:orderState.type==='livraison'?'livraison':'retrait', delivery_address:orderState.adresse_livraison??null, total:orderState.total_estime, status:'new' });
  }
}

export function handleLlmWebSocket(req: Request): Response {
  const {socket,response} = Deno.upgradeWebSocket(req);
  const ctx: SessionContext = { callId:'', restaurant:null, customer:null, orderState:{articles:[],type:'inconnu',total_estime:0}, history:[], upsellDone:false, notificationSent:false, clientSmsSent:false, language:'fr', callerPhone:'', callStartTime:Date.now() };

  socket.onopen = () => console.log('✅ Retell WS connecté');

  socket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data) as RetellMessage;
      if (msg.interaction_type==='call_details'&&msg.call) {
        ctx.callId=msg.call.call_id; ctx.callerPhone=msg.call.from_number||'';
        const toNum=msg.call.to_number||'';
        ctx.restaurant=await findRestaurantByPhone(toNum);
        if (ctx.callerPhone&&ctx.restaurant) ctx.customer=await findOrCreateCustomer(ctx.callerPhone,ctx.restaurant.id);
        ctx.history=[{role:'system',content:buildSystemPrompt(ctx)}];
        await db.from('calls').upsert({ retell_call_id:ctx.callId, restaurant_id:ctx.restaurant?.id??null, customer_id:ctx.customer?.id??null, from_number:ctx.callerPhone, to_number:toNum, status:'in_progress', started_at:new Date().toISOString() });
        try {
          const gr = await anthropic.messages.create({ model:config.anthropic.model, max_tokens:150, messages:[{role:'user',content:"Commence par le message d'accueil."}], system:ctx.history[0].content });
          const grText = gr.content[0].type==='text'?gr.content[0].text:'Bonjour, que puis-je faire pour vous ?';
          ctx.history.push({role:'assistant',content:grText});
          socket.send(JSON.stringify({response_type:'response',response_id:1,content:grText,content_complete:true,end_call:false}));
        } catch(e) {
          socket.send(JSON.stringify({response_type:'response',response_id:1,content:'Bonjour, je suis votre assistant.',content_complete:true,end_call:false}));
        }
        return;
      }
      if (msg.interaction_type==='response_required'&&msg.transcript) {
        const last = msg.transcript.filter(t=>t.role==='user').pop();
        if (!last) return;
        if (ctx.history.length<=1) {
          if (/[\u0600-\u06FF]/.test(last.content)) ctx.language='ar';
          else if (/\b(hello|hi|yes|no|please|i want|order)\b/i.test(last.content)) ctx.language='en';
        }
        ctx.history.push({role:'user',content:last.content});
        const resp = await anthropic.messages.create({ model:config.anthropic.model, max_tokens:500, messages:ctx.history.slice(1).map(h=>({role:h.role==='system'?'user':(h.role as 'user'|'assistant'),content:h.content})), system:ctx.history[0].content });
        const text = resp.content[0].type==='text'?resp.content[0].text:'...';
        ctx.history.push({role:'assistant',content:text});
        if (/récap|récapitulatif|votre commande est|total.*€|confirme votre commande/i.test(text)&&!ctx.notificationSent) finalizeCall(ctx).catch(console.error);
        socket.send(JSON.stringify({response_type:'response',response_id:msg.response_id??0,content:text,content_complete:true,end_call:false}));
      }
    } catch(err) { console.error('WS error:',err); }
  };

  socket.onclose = async () => {
    await finalizeCall(ctx).catch(console.error);
    await saveCall(ctx.callId,ctx,'completed').catch(console.error);
    if (ctx.callId) await db.from('calls').update({status:'completed',ended_at:new Date().toISOString(),duration_seconds:Math.round((Date.now()-ctx.callStartTime)/1000)}).eq('retell_call_id',ctx.callId);
  };
  socket.onerror = (err) => console.error('WS error:',err);
  return response;
}
