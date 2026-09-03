'use client';

import { useState, type FormEvent } from 'react';
import type { ProcureState, Unit } from '../../../lib/procure';
import { useProcure } from '../use-procure';

export function CatalogClient({ initial }: { initial: ProcureState }) {
  const { state, apply } = useProcure(initial);
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [unit, setUnit] = useState<Unit>('Each');
  const [supplierId, setSupplierId] = useState(String(initial.suppliers[0]?.id ?? 1));
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<number | undefined>();
  const [stockDraft, setStockDraft] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await apply({
      type: 'addProduct',
      sku: sku.trim(),
      name: name.trim(),
      price: Number(price),
      unit,
      supplierId: Number(supplierId),
    });
    setSku('');
    setName('');
    setPrice('');
  }

  const supplierName = (id: number) => state.suppliers.find((s) => s.id === id)?.name ?? 'Unknown';
  const needle = query.trim().toLowerCase();
  const visible = state.products.filter(
    (product) =>
      !product.archived &&
      (needle === '' ||
        product.name.toLowerCase().includes(needle) ||
        product.sku.toLowerCase().includes(needle) ||
        supplierName(product.supplierId).toLowerCase().includes(needle)),
  );

  return (
    <main>
      <h1>Catalog</h1>
      <form onSubmit={submit} aria-label="New product">
        <label htmlFor="product-sku">SKU</label>
        <input id="product-sku" value={sku} onChange={(event) => setSku(event.target.value)} required />
        <label htmlFor="product-name">Product name</label>
        <input id="product-name" value={name} onChange={(event) => setName(event.target.value)} required />
        <label htmlFor="product-price">Unit price</label>
        <input
          id="product-price"
          type="number"
          min="0"
          step="0.01"
          value={price}
          onChange={(event) => setPrice(event.target.value)}
          required
        />
        <label htmlFor="product-unit">Unit</label>
        <select id="product-unit" value={unit} onChange={(event) => setUnit(event.target.value as Unit)}>
          <option>Each</option>
          <option>Box</option>
          <option>Ream</option>
          <option>Pallet</option>
        </select>
        <label htmlFor="product-supplier">Supplier</label>
        <select
          id="product-supplier"
          value={supplierId}
          onChange={(event) => setSupplierId(event.target.value)}
        >
          {state.suppliers.map((supplier) => (
            <option key={supplier.id} value={supplier.id}>
              {supplier.name}
            </option>
          ))}
        </select>
        <button type="submit">Add product</button>
      </form>
      <label htmlFor="catalog-search">Search catalog</label>
      <input
        id="catalog-search"
        placeholder="Name, SKU or supplier"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <p role="status" aria-label="Catalog count">
        Showing {visible.length} of {state.products.filter((p) => !p.archived).length} products
      </p>
      <table aria-label="Products">
        <thead>
          <tr>
            <th>SKU</th>
            <th>Name</th>
            <th>Price</th>
            <th>Unit</th>
            <th>Supplier</th>
            <th>Stock</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((product) => (
            <tr key={product.id}>
              <td>{product.sku}</td>
              <td>{product.name}</td>
              <td>${product.price.toFixed(2)}</td>
              <td>{product.unit}</td>
              <td>{supplierName(product.supplierId)}</td>
              <td>
                {editingId === product.id ? (
                  <span>
                    <label htmlFor={`stock-${product.id}`}>New stock for {product.name}</label>
                    <input
                      id={`stock-${product.id}`}
                      type="number"
                      min="0"
                      value={stockDraft}
                      onChange={(event) => setStockDraft(event.target.value)}
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        await apply({ type: 'setStock', id: product.id, stock: Number(stockDraft) });
                        setEditingId(undefined);
                      }}
                    >
                      Save stock for {product.name}
                    </button>
                  </span>
                ) : (
                  <span>Stock: {product.stock}</span>
                )}
              </td>
              <td>
                {editingId === product.id ? null : (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(product.id);
                      setStockDraft(String(product.stock));
                    }}
                  >
                    Edit stock of {product.name}
                  </button>
                )}
                <button type="button" onClick={() => apply({ type: 'archiveProduct', id: product.id })}>
                  Archive {product.name}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
