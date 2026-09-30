import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.describe('date picker', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/date-picker');
  });

  test('navigates three months ahead and books the required date', async ({ screen }) => {
    const dateInput = screen.getByPlaceholder('Select date');
    await dateInput.tap();
    await expect(screen.getByTestId('month-label')).toHaveText('June 2026');

    const nextMonth = screen.getByRole('button', '›');
    await nextMonth.tap();
    await nextMonth.tap();
    await nextMonth.tap();
    await expect(screen.getByTestId('month-label')).toHaveText('September 2026');

    await screen.getByRole('button', '17').tap();
    await expect(screen.getByTestId('month-label')).toHaveCount(0);
    await expect(dateInput).toHaveValue('2026-09-17');

    await screen.getByRole('button', 'Confirm booking').tap();
    await expect(screen.getByTestId('success-message')).toHaveText(
      'Appointment booked for September 17, 2026',
    );
  });

  test('confirming without the exact date shows the error', async ({ screen }) => {
    await screen.getByRole('button', 'Confirm booking').tap();
    await expect(screen.getByTestId('error-message')).toHaveText('Pick the exact requested date');

    await screen.getByPlaceholder('Select date').tap();
    await screen.getByRole('button', '17').tap();
    await expect(screen.getByPlaceholder('Select date')).toHaveValue('2026-06-17');
    await screen.getByRole('button', 'Confirm booking').tap();
    await expect(screen.getByTestId('error-message')).toHaveText('Pick the exact requested date');
  });
});
