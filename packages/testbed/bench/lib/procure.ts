/**
 * In-memory procurement state for the long-flow bench. Lives on `globalThis`
 * like the expenses store so every route bundle shares one instance; seeded
 * fat enough (dozens of rows) that observations carry real context pressure,
 * and restored verbatim by `POST /api/reset`.
 */

export type Terms = 'Net 30' | 'Net 60' | 'Prepaid';
export type Unit = 'Each' | 'Box' | 'Ream' | 'Pallet';
export type OrderStatus = 'Draft' | 'Approved' | 'Shipped' | 'Cancelled';

export interface Supplier {
  id: number;
  name: string;
  email: string;
  country: string;
  terms: Terms;
  active: boolean;
}

export interface Product {
  id: number;
  sku: string;
  name: string;
  price: number;
  unit: Unit;
  supplierId: number;
  stock: number;
  archived: boolean;
}

export interface OrderLine {
  productId: number;
  quantity: number;
}

export interface Order {
  id: number;
  number: string;
  supplierId: number;
  lines: OrderLine[];
  discountCode: string;
  note: string;
  status: OrderStatus;
}

export interface ProcureState {
  suppliers: Supplier[];
  products: Product[];
  orders: Order[];
}

interface ProcureStore extends ProcureState {
  nextSupplierId: number;
  nextProductId: number;
  nextOrderId: number;
}

const COUNTRIES = ['Germany', 'Poland', 'Spain', 'Sweden', 'Netherlands', 'Italy'] as const;

/** Discount codes the order form honours; anything else is rejected. */
export const DISCOUNTS: Readonly<Record<string, number>> = { SPRING10: 0.1, BULK25: 0.25 };

function seeded(): ProcureStore {
  const supplierNames = [
    'Alder Office Supply',
    'Old Mill Pulp',
    'Brightline Toners',
    'Cobalt Packaging',
    'Delta Desk Works',
    'Evergreen Labels',
    'Fjord Furniture',
    'Granite Stationery',
  ];
  const suppliers: Supplier[] = supplierNames.map((name, index) => ({
    id: index + 1,
    name,
    email: `orders@${name.toLowerCase().replace(/[^a-z]+/g, '-')}.example`,
    country: COUNTRIES[index % COUNTRIES.length]!,
    terms: (['Net 30', 'Net 60', 'Prepaid'] as const)[index % 3]!,
    active: true,
  }));
  const units: Unit[] = ['Each', 'Box', 'Ream', 'Pallet'];
  const nouns = ['Binder', 'Envelope', 'Marker', 'Notebook', 'Stapler', 'Folder', 'Tape', 'Label'];
  const sizes = ['Small', 'Medium', 'Large', 'XL', 'Mini'];
  const products: Product[] = [];
  for (let index = 0; index < 40; index += 1) {
    const noun = nouns[index % nouns.length]!;
    const size = sizes[Math.floor(index / nouns.length) % sizes.length]!;
    products.push({
      id: index + 1,
      sku: `SKU-${String(1000 + index)}`,
      name: `${size} ${noun}`,
      price: Number((1.5 + ((index * 7) % 23) * 0.85).toFixed(2)),
      unit: units[index % units.length]!,
      supplierId: (index % suppliers.length) + 1,
      stock: 10 + ((index * 13) % 90),
      archived: false,
    });
  }
  const orders: Order[] = [1, 2, 3, 4, 5, 6].map((n) => ({
    id: n,
    number: `PO-${1000 + n}`,
    supplierId: ((n - 1) % suppliers.length) + 1,
    lines: [
      { productId: n, quantity: 2 + n },
      { productId: n + 8, quantity: 1 },
    ],
    discountCode: '',
    note: '',
    status: (['Draft', 'Approved', 'Draft', 'Shipped', 'Draft', 'Cancelled'] as const)[n - 1]!,
  }));
  return {
    suppliers,
    products,
    orders,
    nextSupplierId: suppliers.length + 1,
    nextProductId: products.length + 1,
    nextOrderId: orders.length + 1,
  };
}

const holder = globalThis as typeof globalThis & { e2eProcureStore?: ProcureStore };

function store(): ProcureStore {
  holder.e2eProcureStore ??= seeded();
  return holder.e2eProcureStore;
}

export function resetProcure(): void {
  holder.e2eProcureStore = seeded();
}

/** Defensive deep copy of the public state. */
export function readProcure(): ProcureState {
  const state = store();
  return JSON.parse(
    JSON.stringify({ suppliers: state.suppliers, products: state.products, orders: state.orders }),
  ) as ProcureState;
}

/** Order total after the discount code, rounded to cents. */
export function orderTotal(order: Order, products: readonly Product[]): number {
  const gross = order.lines.reduce((sum, line) => {
    const product = products.find((candidate) => candidate.id === line.productId);
    return sum + (product === undefined ? 0 : product.price * line.quantity);
  }, 0);
  const rate = DISCOUNTS[order.discountCode] ?? 0;
  return Math.round(gross * (1 - rate) * 100) / 100;
}

export type ProcureCommand =
  | { type: 'addSupplier'; name: string; email: string; country: string; terms: Terms }
  | { type: 'toggleSupplier'; id: number }
  | { type: 'addProduct'; sku: string; name: string; price: number; unit: Unit; supplierId: number }
  | { type: 'setStock'; id: number; stock: number }
  | { type: 'archiveProduct'; id: number }
  | {
      type: 'createOrder';
      supplierId: number;
      lines: OrderLine[];
      discountCode: string;
      note: string;
    }
  | { type: 'setLineQuantity'; orderId: number; productId: number; quantity: number }
  | { type: 'setOrderStatus'; id: number; status: OrderStatus };

/** Applies one command; unknown ids are ignored so a stale click never throws. */
export function applyProcure(command: ProcureCommand): ProcureState {
  const state = store();
  switch (command.type) {
    case 'addSupplier':
      state.suppliers.push({
        id: state.nextSupplierId,
        name: command.name,
        email: command.email,
        country: command.country,
        terms: command.terms,
        active: true,
      });
      state.nextSupplierId += 1;
      break;
    case 'toggleSupplier': {
      const supplier = state.suppliers.find((candidate) => candidate.id === command.id);
      if (supplier) supplier.active = !supplier.active;
      break;
    }
    case 'addProduct':
      state.products.push({
        id: state.nextProductId,
        sku: command.sku,
        name: command.name,
        price: command.price,
        unit: command.unit,
        supplierId: command.supplierId,
        stock: 0,
        archived: false,
      });
      state.nextProductId += 1;
      break;
    case 'setStock': {
      const product = state.products.find((candidate) => candidate.id === command.id);
      if (product) product.stock = command.stock;
      break;
    }
    case 'archiveProduct': {
      const product = state.products.find((candidate) => candidate.id === command.id);
      if (product) product.archived = true;
      break;
    }
    case 'createOrder':
      state.orders.push({
        id: state.nextOrderId,
        number: `PO-${1000 + state.nextOrderId}`,
        supplierId: command.supplierId,
        lines: command.lines.filter((line) => line.quantity > 0),
        discountCode: command.discountCode,
        note: command.note,
        status: 'Draft',
      });
      state.nextOrderId += 1;
      break;
    case 'setLineQuantity': {
      const order = state.orders.find((candidate) => candidate.id === command.orderId);
      const line = order?.lines.find((candidate) => candidate.productId === command.productId);
      if (line) line.quantity = command.quantity;
      break;
    }
    case 'setOrderStatus': {
      const order = state.orders.find((candidate) => candidate.id === command.id);
      if (order) order.status = command.status;
      break;
    }
  }
  return readProcure();
}
