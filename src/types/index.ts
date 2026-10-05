export interface User {
  id: number; telegram_id: number; username: string | null; created_at: Date;
  config?: Record<string, unknown> | null; source_key?: string | null; next_check_at?: Date | null; priority?: number;
}
export interface Link {
  id: number; user_id: number; url: string; platform: Platform;
  config?: Record<string, unknown> | null; source_key?: string | null; next_check_at?: Date | null;
  is_active: boolean; error_count: number; last_parsed_at: Date | null; created_at: Date;
}
export interface Ad {
  id?: number; link_id?: number; external_id: string; title: string; description?: string | null;
  price?: string | null; image_url?: string | null; ad_url: string; location?: string | null; address?: string | null;
  published_at?: Date | null; detected_at?: Date | null; first_seen_at?: Date | null;
  first_seen_source?: string | null; first_seen_rank?: number | null; updated_at?: Date | null; created_at?: Date;
  condition?: string | null; is_company?: boolean | null;
  market_status?: 'below_market' | 'market' | 'above_market' | null; market_percent?: number | null; market_median?: number | null;
  market_low?: number | null; market_high?: number | null; sell_fast?: number | null; sell_normal?: number | null; sell_max?: number | null;
  market_sample_size?: number | null; market_confidence?: 'low' | 'medium' | 'high' | null; market_quality?: number | null;
  market_group?: string | null;
}
export type Platform = 'kufar' | 'onliner' | 'av';
