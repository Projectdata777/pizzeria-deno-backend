/**
 * Routes API — Dashboard + restaurants + relances (Deno Deploy)
 */

import { db } from './db.ts';
import { sendMarketingSms } from './notifications.ts';
import config from './config.ts';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function parseBody(req: Request): Promise<Record<string, unknown>> {
  try { return await req.json() as Record<string, unknown>; }
  catch { return {}; }
}

export async function handleApi(req: Request, url: URL): Promise<Response> {
  const path = url.pathname.replace(/^\/api/, '');
  const method = req.method;

  if (path === '/health') {
    return json({ status: 'ok', service: 'Pizzeria Vocal SaaS Deno', version: '3.0.0', timestamp: new Date().toISOString() });
  }

  if (path === '/dashboard/overview' && method === 'GET') {
    try {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const monthAgo = new Date(Date.now() - 30 * 86400000);
      const [restaurants, callsToday, callsTotal, ordersToday, revenueRes, customersTotal] = await Promise.all([
        db.from('restaurants').select('id', { count: 'exact', head: true }).eq('is_active', true),
        db.from('calls').select('id', { count: 'exact', head: true }).gte('started_at', today.toISOString()),
        db.from('calls').select('id', { count: 'exact', head: true }),
        db.from('orders').select('id, total').gte('created_at', today.toISOString()),
        db.from('orders').select('total').gte('created_at', monthAgo.toISOString()),
        db.from('customers').select('id', { count: 'exact', head: true }),
      ]);
      const revenueToday = (ordersToday.data ?? []).reduce((s, o) => s + parseFloat(o.total ?? 0), 0);
      const revenueMonth = (revenueRes.data ?? []).reduce((s, o) => s + parseFloat(o.total ?? 0), 0);
      return json({
        restaurants: restaurants.count ?? 0,
        calls_today: callsToday.count ?? 0,
        calls_total: callsTotal.count ?? 0,
        orders_today: ordersToday.data?.length ?? 0,
        revenue_today: revenueToday.toFixed(2),
        revenue_month: revenueMonth.toFixed(2),
        avg_basket: ordersToday.data?.length ? (revenueToday / ordersToday.data.length).toFixed(2) : '0',
        customers_total: customersTotal.count ?? 0,
        conversion_rate: callsToday.count ? Math.round(((ordersToday.data?.length ?? 0) / callsToday.count) * 100) : 0,
      });
    } catch (err) { return json({ error: String(err) }, 500); }
  }

  if (path === '/restaurants' && method === 'GET') {
    const { data, error } = await db.from('restaurants').select('*').order('created_at', { ascending: false });
    if (error) return json({ error: error.message }, 500);
    return json(data ?? []);
  }

  if (path === '/restaurants' && method === 'POST') {
    const body = await parseBody(req);
    const { name, type, address, phone, owner_phone, owner_email, config_json } = body as Record<string, string>;
    if (!name || !owner_phone) return json({ error: 'name et owner_phone requis' }, 400);
    const { data, error } = await db.from('restaurants').insert({
      name, type: type || 'pizza', address, phone, owner_phone, owner_email,
      config_json: config_json || {},
    }).select().single();
    if (error) return json({ error: error.message }, 500);
    return json(data, 201);
  }

  const restaurantIdMatch = path.match(/^\/restaurants\/([^/]+)$/);
  if (restaurantIdMatch) {
    const id = restaurantIdMatch[1];
    if (method === 'GET') {
      const { data, error } = await db.from('restaurants').select('*').eq('id', id).single();
      if (error) return json({ error: 'Restaurant introuvable' }, 404);
      return json(data);
    }
    if (method === 'PATCH') {
      const body = await parseBody(req);
      const { data, error } = await db.from('restaurants').update({ ...body, updated_at: new Date().toISOString() }).eq('id', id).select().single();
      if (error) return json({ error: error.message }, 500);
      return json(data);
    }
  }

  const delayMatch = path.match(/^\/restaurants\/([^/]+)\/delay$/);
  if (delayMatch && method === 'PUT') {
    const id = delayMatch[1];
    const body = await parseBody(req);
    const delay_minutes = body.delay_minutes as number;
    if (typeof delay_minutes !== 'number' || delay_minutes < 5 || delay_minutes > 120) {
      return json({ error: 'delay_minutes entre 5 et 120' }, 400);
    }
    const { data: current } = await db.from('restaurants').select('config_json').eq('id', id).single();
    const newConfig = { ...(current?.config_json ?? {}), delay_minutes };
    await db.from('restaurants').update({ config_json: newConfig }).eq('id', id);
    return json({ success: true, delay_minutes });
  }

  const statsMatch = path.match(/^\/restaurants\/([^/]+)\/stats$/);
  if (statsMatch && method === 'GET') {
    const id = statsMatch[1];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const [calls, orders] = await Promise.all([
      db.from('calls').select('id', { count: 'exact', head: true }).eq('restaurant_id', id).gte('started_at', today.toISOString()),
      db.from('orders').select('total').eq('restaurant_id', id).gte('created_at', today.toISOString()),
    ]);
    const revenue = (orders.data ?? []).reduce((s, o) => s + parseFloat(o.total ?? 0), 0);
    return json({ calls_today: calls.count ?? 0, orders_today: orders.data?.length ?? 0, revenue_today: revenue.toFixed(2) });
  }

  if (path === '/calls' && method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const restaurantId = url.searchParams.get('restaurant_id');
    let query = db.from('calls').select('*, restaurants(name, type)').order('started_at', { ascending: false }).limit(limit);
    if (restaurantId) query = query.eq('restaurant_id', restaurantId);
    const { data, error } = await query;
    if (error) return json({ error: error.message }, 500);
    return json(data ?? []);
  }

  if (path === '/orders' && method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const restaurantId = url.searchParams.get('restaurant_id');
    const period = url.searchParams.get('period');
    let query = db.from('orders').select('*, restaurants(name), customers(first_name, phone)').order('created_at', { ascending: false }).limit(limit);
    if (restaurantId) query = query.eq('restaurant_id', restaurantId);
    if (period === 'today') { const t = new Date(); t.setHours(0,0,0,0); query = query.gte('created_at', t.toISOString()); }
    else if (period === 'week') query = query.gte('created_at', new Date(Date.now() - 7*86400000).toISOString());
    else if (period === 'month') query = query.gte('created_at', new Date(Date.now() - 30*86400000).toISOString());
    const { data, error } = await query;
    if (error) return json({ error: error.message }, 500);
    return json(data ?? []);
  }

  if (path === '/orders/revenue' && method === 'GET') {
    const period = url.searchParams.get('period') || 'month';
    let since: Date;
    if (period === 'week') since = new Date(Date.now() - 7*86400000);
    else if (period === 'year') since = new Date(Date.now() - 365*86400000);
    else since = new Date(Date.now() - 30*86400000);
    const { data } = await db.from('orders').select('created_at, total').gte('created_at', since.toISOString()).order('created_at');
    const byDay: Record<string, number> = {};
    for (const order of data ?? []) {
      const day = order.created_at.split('T')[0];
      byDay[day] = (byDay[day] || 0) + parseFloat(order.total ?? 0);
    }
    return json(Object.entries(byDay).map(([date, revenue]) => ({ date, revenue: parseFloat(revenue.toFixed(2)) })));
  }

  if (path === '/customers' && method === 'GET') {
    const restaurantId = url.searchParams.get('restaurant_id');
    let query = db.from('customers').select('*').order('order_count', { ascending: false });
    if (restaurantId) query = query.eq('restaurant_id', restaurantId);
    const { data, error } = await query;
    if (error) return json({ error: error.message }, 500);
    return json(data ?? []);
  }

  if (path === '/relances' && method === 'GET') {
    const restaurantId = url.searchParams.get('restaurant_id');
    let query = db.from('sms_relances').select('*, customers(first_name, phone)').order('created_at', { ascending: false });
    if (restaurantId) query = query.eq('restaurant_id', restaurantId);
    const { data, error } = await query;
    if (error) return json({ error: error.message }, 500);
    return json(data ?? []);
  }

  if (path === '/relances/campaign' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const { restaurant_id, campaign_name, message, promo_code, discount_pct, trigger_type, inactive_days } = body as Record<string, unknown>;
      if (!restaurant_id || !message) return json({ error: 'restaurant_id et message requis' }, 400);
      const since = inactive_days ? new Date(Date.now() - (inactive_days as number) * 86400000).toISOString() : null;
      let query = db.from('customers').select('*').eq('restaurant_id', restaurant_id).eq('sms_opt_out', false).gt('order_count', 0);
      if (since) query = (query as unknown as typeof query).lt('last_order_date', since);
      const { data: customers } = await query;
      if (!customers?.length) return json({ sent: 0, message: 'Aucun client éligible' });
      let sent = 0;
      for (const customer of customers) {
        const personalMessage = (message as string).replace('{prenom}', customer.first_name || 'cher client');
        const result = await sendMarketingSms({ clientPhone: customer.phone, message: personalMessage, promoCode: promo_code as string });
        if (result.success) {
          sent++;
          await db.from('sms_relances').insert({
            restaurant_id, customer_id: customer.id, phone_to: customer.phone,
            message: personalMessage, promo_code, discount_pct,
            status: 'sent', twilio_sid: result.sid,
            sent_at: new Date().toISOString(),
            campaign_name, trigger_type: trigger_type || 'manual',
          });
        }
      }
      return json({ sent, total_eligible: customers.length });
    } catch (err) { return json({ error: String(err) }, 500); }
  }

  if (path === '/saas/revenue' && method === 'GET') {
    const { data: restaurants } = await db.from('restaurants').select('id, name, monthly_price, plan, is_active');
    const active = (restaurants ?? []).filter(r => r.is_active);
    const mrr = active.reduce((s, r) => s + parseFloat(r.monthly_price || 99), 0);
    return json({
      mrr: mrr.toFixed(2),
      restaurants_total: restaurants?.length ?? 0,
      restaurants_active: active.length,
      arr: (mrr * 12).toFixed(2),
      avg_revenue_per_restaurant: active.length ? (mrr / active.length).toFixed(2) : '0',
    });
  }

  if (path === '/check-retell' && method === 'GET') {
    if (url.searchParams.get('secret') !== 'PIZZERIA_SETUP_2024') return json({ error: 'Forbidden' }, 403);
    try {
      const res = await fetch(`https://api.retellai.com/v2/phone-number/+33189480917`, {
        headers: { 'Authorization': `Bearer ${config.retell.apiKey}` },
      });
      const data = await res.json();
      return json({ success: true, phone_number: '+33189480917', retell_data: data });
    } catch (err) { return json({ error: String(err) }, 500); }
  }

  return json({ error: 'Not found' }, 404);
}
