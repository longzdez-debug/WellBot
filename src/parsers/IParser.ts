import { Ad, Platform } from '../types';

export interface ParseOptions {
  /**
   * Fast mode is used after the initial baseline. Parsers should prioritize
   * the newest page/feed and avoid expensive deep pagination.
   */
  fast?: boolean;
}

export interface IParser {
  platform: Platform;
  parseUrl(url: string, options?: ParseOptions): Promise<Ad[]>;
}
