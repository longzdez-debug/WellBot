import { IParser } from './IParser';
import { FastKufarParser } from './FastKufarParser';
import { OnlinerParser } from './OnlinerParser';
import { AvParser } from './AvParser';
import { Platform } from '../types';

export class ParserFactory {
  private static parsers: Map<Platform, IParser> = new Map<Platform, IParser>([
    // Monitoring only needs the newest page. Full historical pagination is intentionally
    // kept out of the hot path so a new listing can reach Telegram with minimal latency.
    ['kufar', new FastKufarParser()],
    ['onliner', new OnlinerParser()],
    ['av', new AvParser()],
  ]);

  static getParser(platform: Platform): IParser | null {
    return this.parsers.get(platform) || null;
  }
}
