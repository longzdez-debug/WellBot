export interface User {
  id: number;
  telegram_id: number;
  username: string | null;
  created_at: Date;
}

export interface Link {
  id: number;
  user_id: number;
  url: string;
  platform: Platform;
  is_active: boolean;
  error_count: number;
  last_parsed_at: Date | null;
  created_at: Date;
}

export interface Ad {
  id?: number;
  link_id?: number;
  external_id: string;
  title: string;
  description?: string | null;
  price?: string | null;
  image_url?: string | null;
  ad_url: string;
  location?: string | null;
  address?: string | null;
  created_at?: Date;
  published_at?: Date | null;
  updated_at?: Date | null;
  market_status?: 'below_market' | 'market' | 'above_market' | null;
  market_percent?: number | null;
  market_median?: number | null;
}

export type Platform = 'kufar' | 'onliner' | 'av';
