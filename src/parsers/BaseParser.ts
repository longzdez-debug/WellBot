import axios, { AxiosError, AxiosInstance } from 'axios';
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
        timeout: 7000,
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
        },
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
    const attempts = Math.max(1, Math.floor(retries));
    let lastError: unknown;

    for (let i = 0; i < attempts; i++) {
      try {
        const response = await this.axiosInstance.get(url, {
          timeout: 6500,
          headers: {
            'User-Agent': this.getRandomUserAgent(),
            'Host': new URL(url).hostname,
          },
        });
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
        await this.sleep(250 * (i + 1));
      }
    }

    throw lastError instanceof Error ? lastError : new Error('All retry attempts failed');
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  abstract parseUrl(url: string): Promise<Ad[]>;
}
