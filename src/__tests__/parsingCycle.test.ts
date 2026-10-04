import { Ad, Link, User } from '../types';
import { NewAdSelector } from '../services/NewAdSelector';
import { AdPresenter } from '../services/AdPresenter';

// Duck-typed fake store
class FakeStore {
  private ads: Map<string, Ad> = new Map();
  private links: Link[] = [];
  private users: Map<number, User> = new Map();

  async createAd(linkId: number, adData: Ad): Promise<Ad> {
    const ad: Ad = {
      ...adData,
      id: this.ads.size + 1,
      link_id: linkId,
      created_at: new Date(),
    };
    this.ads.set(ad.external_id, ad);
    return ad;
  }

  async isNewAdForLink(_linkId: number, externalId: string): Promise<boolean> {
    return !this.ads.has(externalId);
  }

  async getActiveLinks(): Promise<Link[]> {
    return this.links.filter(l => l.is_active);
  }

  async getUserById(userId: number): Promise<User | null> {
    return this.users.get(userId) || null;
  }

  // Helper methods for test setup
  addLink(link: Link): void {
    this.links.push(link);
  }

  addUser(user: User): void {
    this.users.set(user.id, user);
  }

  getAdCount(): number {
    return this.ads.size;
  }

  getAd(externalId: string): Ad | undefined {
    return this.ads.get(externalId);
  }
}

describe('Parsing cycle with duck-typed store', () => {
  let store: FakeStore;
  let presenter: AdPresenter;

  beforeEach(() => {
    store = new FakeStore();
    presenter = new AdPresenter();
  });

  test('parsing cycle detects new ads', async () => {
    const link: Link = {
      id: 1,
      user_id: 1,
      url: 'https://kufar.by/l/minsk',
      platform: 'kufar',
      is_active: true,
      error_count: 0,
      last_parsed_at: null,
      created_at: new Date(),
    };
    store.addLink(link);

    const user: User = {
      id: 1,
      telegram_id: 12345,
      username: 'testuser',
      created_at: new Date(),
    };
    store.addUser(user);

    const parserAds: Ad[] = [
      { external_id: 'ad1', title: 'Ad 1', ad_url: 'https://kufar.by/ad1', price: '100 BYN' },
      { external_id: 'ad2', title: 'Ad 2', ad_url: 'https://kufar.by/ad2', price: '200 BYN' },
    ];

    // Simulate parsing cycle
    const links = await store.getActiveLinks();
    expect(links).toHaveLength(1);

    const newAds: Ad[] = [];
    for (const adData of parserAds) {
      const isNew = await store.isNewAdForLink(link.id, adData.external_id);
      if (isNew) {
        const ad = await store.createAd(link.id, adData);
        newAds.push(ad);
      }
    }

    expect(newAds).toHaveLength(2);
    expect(store.getAdCount()).toBe(2);
    expect(store.getAd('ad1')).toBeDefined();
    expect(store.getAd('ad2')).toBeDefined();
  });

  test('old ads are not re-notified', async () => {
    const link: Link = {
      id: 1,
      user_id: 1,
      url: 'https://kufar.by/l/minsk',
      platform: 'kufar',
      is_active: true,
      error_count: 0,
      last_parsed_at: null,
      created_at: new Date(),
    };
    store.addLink(link);

    // First parse - 2 ads
    const firstParseAds: Ad[] = [
      { external_id: 'ad1', title: 'Ad 1', ad_url: 'https://kufar.by/ad1' },
      { external_id: 'ad2', title: 'Ad 2', ad_url: 'https://kufar.by/ad2' },
    ];

    for (const adData of firstParseAds) {
      await store.createAd(link.id, adData);
    }

    // Second parse - same ads + 1 new
    const secondParseAds: Ad[] = [
      { external_id: 'ad1', title: 'Ad 1', ad_url: 'https://kufar.by/ad1' },
      { external_id: 'ad2', title: 'Ad 2', ad_url: 'https://kufar.by/ad2' },
      { external_id: 'ad3', title: 'Ad 3', ad_url: 'https://kufar.by/ad3' },
    ];

    const newAds: Ad[] = [];
    for (const adData of secondParseAds) {
      const isNew = await store.isNewAdForLink(link.id, adData.external_id);
      if (isNew) {
        const ad = await store.createAd(link.id, adData);
        newAds.push(ad);
      }
    }

    // Only ad3 should be new
    expect(newAds).toHaveLength(1);
    expect(newAds[0].external_id).toBe('ad3');
    expect(store.getAdCount()).toBe(3);
  });

  test('selector picks top-5, notifications newer on top', () => {
    const now = new Date();
    const ads: Ad[] = [
      { external_id: 'ad1', title: 'Old Ad', ad_url: 'url1', updated_at: new Date(now.getTime() - 3600000 * 24) },
      { external_id: 'ad2', title: 'Newer Ad', ad_url: 'url2', updated_at: new Date(now.getTime() - 3600000) },
      { external_id: 'ad3', title: 'Newest Ad', ad_url: 'url3', updated_at: now },
      { external_id: 'ad4', title: 'Ad 4', ad_url: 'url4', published_at: new Date(now.getTime() - 7200000) },
      { external_id: 'ad5', title: 'Ad 5', ad_url: 'url5', published_at: new Date(now.getTime() - 1800000) },
      { external_id: 'ad6', title: 'Ad 6', ad_url: 'url6' },
    ];

    const selected = NewAdSelector.pick(ads, 5);

    expect(selected).toHaveLength(5);
    // Should be sorted by freshness (newest first): updated_at > published_at > id
    expect(selected[0].external_id).toBe('ad3'); // updated_at: now
    expect(selected[1].external_id).toBe('ad5'); // published_at: now - 30min
    expect(selected[2].external_id).toBe('ad2'); // updated_at: now - 1hr
    expect(selected[3].external_id).toBe('ad4'); // published_at: now - 2hr
    expect(selected[4].external_id).toBe('ad1'); // updated_at: now - 24hr
  });

  test('presenter formats notification text', async () => {
    const ad: Ad = {
      external_id: 'ad1',
      title: 'Test Apartment',
      price: '500 BYN',
      ad_url: 'https://kufar.by/ad1',
      location: 'Минск',
      address: 'ул.Ленина, 1',
      published_at: new Date('2024-01-15T10:00:00Z'),
    };

    const formatted = await presenter.format(ad);

    expect(formatted.text).toContain('Test Apartment');
    expect(formatted.text).toContain('500 BYN');
    expect(formatted.text).toContain('https://kufar.by/ad1');
    expect(formatted.text).toContain('Минск');
    expect(formatted.text).toContain('ул.Ленина, 1');
  });
});
