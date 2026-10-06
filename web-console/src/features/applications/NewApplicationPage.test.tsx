import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/render';

describe('NewApplicationPage', () => {
  it('registers an application and opens it', async () => {
    const { user, router } = await renderApp('/applications/new');
    const form = await screen.findByRole('form', { name: 'Register application' });
    await user.type(within(form).getByRole('textbox', { name: 'Name' }), 'fraud-scorer');
    await user.type(within(form).getByRole('textbox', { name: 'Description (optional)' }), 'Scores card payments for fraud');
    expect(within(form).getByRole('combobox', { name: 'Owner team' })).toHaveDisplayValue('Payments');
    await user.click(within(form).getByRole('button', { name: 'Register application' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'fraud-scorer' })).toBeInTheDocument();
    expect(router.state.location.pathname).toMatch(/^\/applications\/[0-9a-f-]{36}$/);
    expect(screen.getByText('Scores card payments for fraud, owned by Payments')).toBeInTheDocument();
  });

  it('shows the server field error on a bad name and focuses the field', async () => {
    const { user } = await renderApp('/applications/new');
    const form = await screen.findByRole('form', { name: 'Register application' });
    const name = within(form).getByRole('textbox', { name: 'Name' });
    await user.type(name, 'Billing_API');
    await user.click(within(form).getByRole('button', { name: 'Register application' }));

    await waitFor(() => expect(name).toHaveAttribute('aria-invalid', 'true'));
    expect(name).toHaveAccessibleDescription(/Must match "\[a-z0-9\]\[a-z0-9-\]\{0,62\}"\./);
    expect(name).toHaveFocus();
  });

  it('puts a duplicate name (409) on the name field', async () => {
    const { user } = await renderApp('/applications/new');
    const form = await screen.findByRole('form', { name: 'Register application' });
    const name = within(form).getByRole('textbox', { name: 'Name' });
    await user.type(name, 'billing-api');
    await user.click(within(form).getByRole('button', { name: 'Register application' }));

    expect(await within(form).findByText('An application named billing-api already exists.')).toBeInTheDocument();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveFocus();
  });

  it('offers only the teams where the caller may register', async () => {
    await renderApp('/applications/new', { role: 'OPERATOR' });
    const select = await screen.findByRole('combobox', { name: 'Owner team' });
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['Payments', 'Search']);
  });

  it('tells a viewer they cannot register and shows no form', async () => {
    await renderApp('/applications/new', { role: 'VIEWER' });
    expect(await screen.findByText('You cannot register applications')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Register application' })).not.toBeInTheDocument();
  });
});
