import { test, expect } from '../fixtures/test';
import { AppShellPage } from '../pages/AppShellPage';

async function expectHealthyPage(shell: AppShellPage) {
  await shell.expectNoCrashFallback();
}

test('@smoke main navigation pages render without obvious breakage', async ({ page }) => {
  const shell = new AppShellPage(page);

  await shell.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expectHealthyPage(shell);

  await shell.openSection('Inbound');
  await expect(page).toHaveURL(/\/vendors$/);
  await expect(page.getByText('Vendors')).toBeVisible();
  await expectHealthyPage(shell);

  await shell.clickNavLink('Purchase Orders');
  await expect(page).toHaveURL(/\/purchase-orders$/);
  await expect(page.getByRole('heading', { name: 'Purchase Orders' })).toBeVisible();
  await expectHealthyPage(shell);

  await shell.openSection('Outbound');
  await expect(page).toHaveURL(/\/sales-orders$/);
  await expect(page.getByRole('heading', { name: 'Sales Orders' })).toBeVisible();
  await expectHealthyPage(shell);

  await shell.clickNavLink('Shipments');
  await expect(page).toHaveURL(/\/shipments$/);
  await expect(page.getByRole('heading', { name: 'Shipments' })).toBeVisible();
  await expectHealthyPage(shell);

  await shell.openSection('Inventory');
  await shell.clickNavLink('Available-to-Promise');
  await expect(page).toHaveURL(/\/atp$/);
  await expect(page.getByRole('heading', { name: 'Available to Promise' })).toBeVisible();
  await expectHealthyPage(shell);

  await shell.openSection('Master Data');
  await expect(page).toHaveURL(/\/items$/);
  await expect(page.getByRole('heading', { name: 'Items' })).toBeVisible();
  await expectHealthyPage(shell);
});
