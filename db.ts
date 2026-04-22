import { createClient } from 'npm:@supabase/supabase-js@2';
import config from './config.ts';

export const db = createClient(config.supabase.url, config.supabase.serviceKey);

export interface Restaurant {
  id: string;
  name: string;
  type: string;
  address?: string;
  phone?: string;
  owner_phone: string;
  owner_email?: string;
  retell_phone?: string;
  retell_agent_id?: string;
  zadarma_number?: string;
  is_active: boolean;
  config_json: Record<string, unknown>;
  monthly_price?: number;
  plan?: string;
}

export interface Customer {
  id: string;
  restaurant_id: string;
  phone: string;
  first_name?: string;
  last_name?: string;
  order_count: number;
  total_spent: number;
  favorite_items: string[];
  loyalty_points: number;
  is_vip: boolean;
  sms_opt_out: boolean;
  last_order_date?: string;
}

export interface OrderItem {
  nom: string;
  qte: number;
  prix: number;
  notes?: string;
}
