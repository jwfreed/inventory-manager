import { expect, type Page } from '@playwright/test';

export class AppShellPage {
  constructor(private readonly page: Page) {}

  async goto(pathname: string): Promise<void> {
    await this.page.goto(pathname, { waitUntil: 'domcontentloaded' });
    await expect(this.page).toHaveURL(new RegExp(`${pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  }

  async openSection(sectionLabel: string): Promise<void> {
    await this.page.getByRole('button', { name: sectionLabel }).click();
  }

  async clickNavLink(label: string): Promise<void> {
    await this.page.getByRole('link', { name: label }).click();
  }

  async expectNoCrashFallback(): Promise<void> {
    await expect(this.page.getByRole('heading', { name: 'Something went wrong' })).toHaveCount(0);
  }
}
