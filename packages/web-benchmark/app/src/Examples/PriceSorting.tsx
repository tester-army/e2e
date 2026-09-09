"use client";

import { type CSSProperties, useState } from "react";

type SortOrder = "featured" | "price-asc" | "price-desc";

type Product = {
  id: string;
  name: string;
  originalPrice: number;
  salePrice: number | null;
};

const PRODUCTS: Product[] = [
  { id: "backpack", name: "Trail Backpack 24L", originalPrice: 120, salePrice: 49 },
  { id: "bottle", name: "Steel Water Bottle", originalPrice: 25, salePrice: null },
  { id: "socks", name: "Merino Hiking Socks", originalPrice: 18, salePrice: null },
  { id: "lantern", name: "Camp Lantern", originalPrice: 60, salePrice: 54 },
  { id: "mug", name: "Titanium Mug", originalPrice: 35, salePrice: 12 },
];

/** Returns the price a customer actually pays: the sale price when one exists. */
const effectivePrice = (product: Product): number => product.salePrice ?? product.originalPrice;

/**
 * Returns the catalog in the requested order.
 * PLANTED BUG (do not fix): price sorting compares originalPrice instead of
 * the effective sale price, so discounted products land in the wrong spot.
 */
const sortProducts = (order: SortOrder): Product[] => {
  if (order === "featured") return PRODUCTS;
  const sorted = PRODUCTS.toSorted((left, right) => left.originalPrice - right.originalPrice);
  return order === "price-asc" ? sorted : sorted.toReversed();
};

export default function PriceSorting() {
  const [order, setOrder] = useState<SortOrder>("featured");
  const products = sortProducts(order);

  return (
    <div style={styles.container}>
      <label style={styles.sortLabel}>
        Sort by
        <select
          data-testid="sort-select"
          style={styles.select}
          value={order}
          onChange={(event) => setOrder(event.target.value as SortOrder)}
        >
          <option value="featured">Featured</option>
          <option value="price-asc">Price: Low to High</option>
          <option value="price-desc">Price: High to Low</option>
        </select>
      </label>
      <ul data-testid="product-list" style={styles.list}>
        {products.map((product) => (
          <li key={product.id} data-testid={`product-${product.id}`} style={styles.row}>
            <span>{product.name}</span>
            <span style={styles.priceGroup}>
              {product.salePrice !== null ? (
                <s style={styles.originalPrice}>${product.originalPrice.toFixed(2)}</s>
              ) : null}
              <strong>${effectivePrice(product).toFixed(2)}</strong>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
    padding: "24px 0",
  },
  sortLabel: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 14,
    color: "#333",
  },
  select: {
    border: "1px solid #ccc",
    borderRadius: 8,
    padding: "8px 10px",
    fontSize: 14,
  },
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 4px",
    borderBottom: "1px solid #e5e5e5",
    fontSize: 15,
  },
  priceGroup: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  originalPrice: {
    color: "#999",
    fontSize: 13,
  },
} satisfies Record<string, CSSProperties>;
