import axios, { AxiosInstance } from 'axios';
import http from 'node:http';
import https from 'node:https';
import { Ad, Platform } from '../types';
import { logger } from '../utils/logger';
import { IParser } from './IParser';

export abstract class BaseParser implements IParser {
  abstract platform: Platform;
  protected axiosInstance: AxiosInstance;
  private userAgents: string[] = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ];

  constructor(axiosInstance?: AxiosInstance) {
    if (axiosInstance) {
      this.axiosInstance = axiosInstance;
    } else {
      this.axiosInstance = axios.create({
        timeout: 4500,
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
        },
        httpAgent: new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16 }),
        httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16 }),
      });
    }
  }

  protected getRandomUserAgent(): string {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  private isRetryable(error: unknown): boolean {
    if (!axios.isAxiosError(error)) return true;
    const axiosError = error as AxiosError;
    if (!axiosError.response) return true;
    const status = axiosError.response.status;
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }

  protected async fetchWithRetry(url: string, retries: number = 2): Promise<string> {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`Unsupported parser URL protocol: ${parsedUrl.protocol}`);
    }
    const attempts = Math.max(1, Math.floor(retries));
    let lastError: unknown;

    for (let i = 0; i < attempts; i++) {
      try {
        const response = await this.axiosInstance.get(url, {
          timeout: 4200,
          headers: {
            'User-Agent': this.getRandomUserAgent(),
            'Host': new URL(url).hostname,
          },
        });
        if (typeof response.data !== 'string') return JSON.stringify(response.data);
        return response.data;
      } catch (error: unknown) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const retryable = this.isRetryable(error);
        logger.warn(`Fetch attempt ${i + 1}/${attempts} failed for ${url}`, {
          platform: this.platform,
          error: message,
          retryable,
        });
        if (!retryable || i >= attempts - 1) break;
        const backoff = Math.min(1500, 200 * 2 ** i);
        const jitter = Math.floor(Math.random() * 100);
        await this.sleep(backoff + jitter);
      }
    }

    throw lastError instanceof Error ? lastError : new Error('All retry attempts failed');
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  abstract parseUrl(url: string): Promise<Ad[]>;
}
