'use client';

import { useState, type FormEvent } from 'react';
import { DISCOUNTS, orderTotal, type OrderStatus, type ProcureState } from '../../../lib/procure';
import { useProcure } from '../use-procure';

interface DraftLine {
  productId: string;
  quantity: string;
}

export function OrdersClient({ initial }: { initial: ProcureState }) {
  const { state, apply } = useProcure(initial);
  const [open, setOpen] = useState(false);
  const [supplierId, setSupplierId] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ productId: '', quantity: '1' }]);
  const [discountCode, setDiscountCode] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [statusFilter, setStatusFilter] = useState<'All' | OrderStatus>('All');
  const [expanded, setExpanded] = useState<number | undefined>();
  const [quantityDraft, setQuantityDraft] = useState<Record<string, string>>({});

  const supplierName = (id: number) => state.suppliers.find((s) => s.id === id)?.name ?? 'Unknown';
  const product = (id: number) => state.products.find((p) => p.id === id);
  const supplierProducts = state.products.filter(
    (p) => !p.archived && String(p.supplierId) === supplierId,
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (supplierId === '') {
      setError('Choose a supplier');
      return;
    }
    const parsed = lines
      .filter((line) => line.productId !== '')
      .map((line) => ({ productId: Number(line.productId), quantity: Number(line.quantity) }));
    if (parsed.length === 0) {
      setError('Add at least one line item');
      return;
    }
    const code = discountCode.trim().toUpperCase();
    if (code !== '' && DISCOUNTS[code] === undefined) {
      setError(`Unknown discount code ${code}`);
      return;
    }
    setError(undefined);
    await apply({ type: 'createOrder', supplierId: Number(supplierId), lines: parsed, discountCode: code, note });
    setOpen(false);
    setSupplierId('');
    setLines([{ productId: '', quantity: '1' }]);
    setDiscountCode('');
    setNote('');
  }

  const visible = state.orders.filter((order) => statusFilter === 'All' || order.status === statusFilter);

  return (
    <main>
      <h1>Purchase orders</h1>
      {open ? null : (
        <button type="button" onClick={() => setOpen(true)}>
          New purchase order
        </button>
      )}
      {open ? (
        <form onSubmit={submit} className="panel" aria-label="New purchase order">
          <label htmlFor="order-supplier">Supplier</label>
          <select
            id="order-supplier"
            value={supplierId}
            onChange={(event) => {
              setSupplierId(event.target.value);
              setLines([{ productId: '', quantity: '1' }]);
            }}
          >
            <option value="">Choose a supplier</option>
            {state.suppliers
              .filter((supplier) => supplier.active)
              .map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
          </select>
          <fieldset>
            <legend>Line items</legend>
            {lines.map((line, index) => (
              <div key={index}>
                <label htmlFor={`line-product-${index + 1}`}>Line {index + 1} product</label>
                <select
                  id={`line-product-${index + 1}`}
                  value={line.productId}
                  disabled={supplierId === ''}
                  onChange={(event) =>
                    setLines(lines.map((l, i) => (i === index ? { ...l, productId: event.target.value } : l)))
                  }
                >
                  <option value="">{supplierId === '' ? 'Choose a supplier first' : 'Choose a product'}</option>
                  {supplierProducts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.sku})
                    </option>
                  ))}
                </select>
                <label htmlFor={`line-quantity-${index + 1}`}>Line {index + 1} quantity</label>
                <input
                  id={`line-quantity-${index + 1}`}
                  type="number"
                  min="1"
                  value={line.quantity}
                  onChange={(event) =>
                    setLines(lines.map((l, i) => (i === index ? { ...l, quantity: event.target.value } : l)))
                  }
                />
              </div>
            ))}
            <button type="button" onClick={() => setLines([...lines, { productId: '', quantity: '1' }])}>
              Add line item
            </button>
          </fieldset>
          <label htmlFor="order-discount">Discount code</label>
          <input id="order-discount" value={discountCode} onChange={(event) => setDiscountCode(event.target.value)} />
          <label htmlFor="order-note">Internal note</label>
          <input id="order-note" value={note} onChange={(event) => setNote(event.target.value)} />
          {error === undefined ? null : (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit">Create order</button>
          <button type="button" onClick={() => setOpen(false)}>
            Discard
          </button>
        </form>
      ) : null}
      <label htmlFor="order-filter">Show</label>
      <select
        id="order-filter"
        value={statusFilter}
        onChange={(event) => setStatusFilter(event.target.value as 'All' | OrderStatus)}
      >
        <option>All</option>
        <option>Draft</option>
        <option>Approved</option>
        <option>Shipped</option>
        <option>Cancelled</option>
      </select>
      <p role="status" aria-label="Order count">
        {visible.length} order(s)
      </p>
      <ul aria-label="Orders">
        {visible.map((order) => (
          <li key={order.id}>
            <span>
              {order.number} — {supplierName(order.supplierId)} — {order.status} — total $
              {orderTotal(order, state.products).toFixed(2)}
              {order.discountCode === '' ? '' : ` (code ${order.discountCode})`}
            </span>
            <button type="button" onClick={() => setExpanded(expanded === order.id ? undefined : order.id)}>
              {expanded === order.id ? `Hide ${order.number}` : `Details of ${order.number}`}
            </button>
            {order.status === 'Draft' ? (
              <>
                <button type="button" onClick={() => apply({ type: 'setOrderStatus', id: order.id, status: 'Approved' })}>
                  Approve {order.number}
                </button>
                <button type="button" onClick={() => apply({ type: 'setOrderStatus', id: order.id, status: 'Cancelled' })}>
                  Cancel {order.number}
                </button>
              </>
            ) : null}
            {order.status === 'Approved' ? (
              <button type="button" onClick={() => apply({ type: 'setOrderStatus', id: order.id, status: 'Shipped' })}>
                Ship {order.number}
              </button>
            ) : null}
            {expanded === order.id ? (
              <table aria-label={`Lines of ${order.number}`}>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Quantity</th>
                    <th>Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((line) => {
                    const item = product(line.productId);
                    const key = `${order.id}:${line.productId}`;
                    const editable = order.status === 'Draft' || order.status === 'Approved';
                    return (
                      <tr key={line.productId}>
                        <td>{item?.name ?? 'Unknown'}</td>
                        <td>
                          {editable ? (
                            <>
                              <label htmlFor={`qty-${key}`}>Quantity of {item?.name}</label>
                              <input
                                id={`qty-${key}`}
                                type="number"
                                min="1"
                                value={quantityDraft[key] ?? String(line.quantity)}
                                onChange={(event) =>
                                  setQuantityDraft({ ...quantityDraft, [key]: event.target.value })
                                }
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  apply({
                                    type: 'setLineQuantity',
                                    orderId: order.id,
                                    productId: line.productId,
                                    quantity: Number(quantityDraft[key] ?? line.quantity),
                                  })
                                }
                              >
                                Update quantity of {item?.name}
                              </button>
                            </>
                          ) : (
                            <span>{line.quantity}</span>
                          )}
                        </td>
                        <td>${((item?.price ?? 0) * line.quantity).toFixed(2)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : null}
          </li>
        ))}
      </ul>
    </main>
  );
}
