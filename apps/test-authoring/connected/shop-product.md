# Green Trail product rules

### Account, routes, and saved state

- G1. The shop opens at `/` with links to Catalog, Basket, and Account. Catalog uses `/catalog`, details use `/products/:id`, basket uses `/cart`, checkout uses `/checkout` and `/checkout/review`, and receipts use `/orders/:id/receipt`. Account links to `/account/addresses`, `/account/orders`, and `/account/wishlist`. Orders have `/account/orders/:id` details. Navigation uses ordinary links, forms, buttons, and labelled controls.
- G2. Each local app starts signed in as `account-ada`, Ada Green. No login, external account, payment service, or fulfillment service is needed. First use in a new browser profile creates the documented data once. Navigation, a second tab, and reload retain that account's data. Shop snapshots share the same product rules and starting data. The expense snapshot has its own data.
- G3. Account and Expenses each expose a "Reset demo data" button with confirmation. Confirmation restores that app's starting data, clears its draft and query, and returns to its initial route. Cancelling confirmation changes nothing. A new pristine browser profile gives the same initial state. Reset affects only this local app.
- G4. Every state-changing operation commits its complete durable update before a success message, navigation, or changed data-backed view acknowledges success. Pending actions keep the prior saved view and prevent duplicate submission. Failure leaves prior visible saved data and durable data unchanged, retains editable form input, and shows a visible error with a retry action. It never announces success. Retrying the same operation cannot duplicate a record or order. Navigation after an acknowledged success and reload show the committed data. Within one profile, saves execute in submission order and later reads use the latest committed state.
- G5. IDs identify records. Labels, names, positions, and current sort order never identify records. New address, expense, and order IDs use monotonic counters in their own collection and are never reused after deletion. One operation changing several fields commits all of them or none. There is no background data change or dependence on elapsed real time.
- G6. USD values use integer cents and render as `$0.00` with exactly two decimal places. No tax or other charge applies. Catalog prices cannot be edited. Product quantities accept only ASCII integer strings with a value from 1 through 9. An add that would exceed 9 rejects the whole addition with a visible error. Invalid quantity input preserves the previous quantity. Removal is a separate action.
- G7. The product clock is always `2026-10-18T12:00:00.000Z`, epoch milliseconds `1792324800000`. Creation and policy timestamps use integer UTC milliseconds. Browser locale, wall time, time zone, and waiting do not change eligibility.

### Available products and account data

DATA-CATALOG. The complete catalog is below. These prices and eligibility flags are authoritative. The initial basket is empty, no code is applied, and there is no checkout draft.

| Stable product ID | Name | Price | Eligible merchandise |
| --- | --- | ---: | --- |
| trail-pack | Trail Backpack | $80.00 | Yes |
| camp-jacket | Camp Jacket | $50.00 | Yes |
| titanium-mug | Titanium Mug | $25.00 | Yes |
| cafe-mug | Café Mug | $20.00 | Yes |
| gift-card-25 | $25 Gift Card | $25.00 | No |
| enamel-cup | Enamel Cup | $24.99 | Yes |
| steel-bottle | Steel Bottle | $25.01 | Yes |

DATA-ADDRESSES. Address insertion order is the table order. All three have recipient Ada Green, city Warsaw, country Poland. The initial default is `address-home`. Labels may repeat.

| Stable address ID | Label | Street | Postal code |
| --- | --- | --- | --- |
| address-home | Home | 10 Oak Street | 00-001 |
| address-office | Work | 20 Pine Street | 00-002 |
| address-studio | Home | 30 Elm Street | 00-003 |

DATA-WISHLIST. The initial saved list contains only `titanium-mug`. Its count is 1.
DATA-ORDERS. The complete initial order list is below. IDs remain distinct even when timestamps and statuses match. Each order shows its ID, policy version, UTC creation time, status, and Ada Green at 10 Oak Street, Warsaw 00-001, Poland. New purchases add new orders without replacing these records.

| Stable order ID | Policy version | Created UTC | Status |
| --- | ---: | --- | --- |
| order-v2-recent | 2 | 2026-10-18T08:00:00.000Z | placed |
| order-v2-packed | 2 | 2026-10-18T08:00:00.000Z | packed |
| order-v2-shipped | 2 | 2026-10-18T08:00:00.000Z | shipped |
| order-v2-cancelled | 2 | 2026-10-18T08:00:00.000Z | cancelled |
| order-v1-edge | 1 | 2026-10-17T12:00:00.000Z | processing |
| order-v1-expired | 1 | 2026-10-17T11:59:59.999Z | processing |
| order-v2-old-detail | 2 | 2026-10-17T00:00:00.000Z | processing |
| order-v2-old-list | 2 | 2026-10-17T00:00:00.000Z | processing |

### Shipping addresses

- ADDR1. Add an address with required label, recipient, street, city, postal code, and country fields. Trim outer ASCII whitespace, U+0009 through U+000D and U+0020, from each field. Reject an empty result. Preserve all remaining Unicode text without case conversion or normalization. Equal labels or address text remain separate records with separate IDs. The list uses insertion order. A first address becomes the default.
- ADDR2. The address book can set a default and delete a saved address. Repeatedly selecting the current default changes nothing. Deleting the default selects the earliest remaining address by insertion order. Deleting a nondefault preserves the default. An empty address book has no default.
- ADDR3. A checkout draft starts with no manual choice and resolves to the current default each time checkout or review is shown, including after address-book navigation. Choosing an address in checkout stores that stable ID as a manual choice. A manual choice survives navigation, reload, and later default changes.
- ADDR4. Deleting the manually chosen address clears that manual choice. The draft then follows the current default, including the fallback in ADDR2. An empty address book shows that an address is required and blocks order placement. "Use account default" explicitly clears a manual choice.
- ADDR5. Review shows the full resolved destination. Placement commits the quoted amount, line items, and a copy of that destination in one order. The receipt preserves those copies after later address, basket, or default changes. A successful placement clears the basket and draft and creates a version 2 placed order at G7. Repeated submission of that placement returns the same order.

### Basket and promotions

- PROMO1. Repeated additions of a product merge its quantity into one line. The line keeps its first insertion position. Removing and re-adding a product appends a line. Basket, review, the place-order button, and receipt show the same line amounts and payable amount.
- PROMO2. Trim outer ASCII whitespace from the code and uppercase only ASCII a through z. `SAVE10` is the only accepted code. An unknown or empty code shows an error and preserves the prior saved code. "Remove code" clears it. Applying the same code twice applies it once.
- PROMO3. `SAVE10` subtracts exactly 1000 cents once when the sum of eligible merchandise price times quantity is at least 7500 cents. The 7500-cent boundary is inclusive. Gift cards contribute neither to eligibility nor to the discounted merchandise. An accepted code remains on an ineligible basket, shows "Not eligible", and subtracts zero.
- PROMO4. Delivery is 500 cents for a nonempty basket and zero for an empty basket. Payable equals all line amounts plus delivery minus the applicable discount. Every add, quantity change, removal, route return, and reload uses the current lines and catalog eligibility. An empty basket cannot enter review or place an order.
- PROMO5. At the published prices, all seven products total 25000 cents at quantity 1. Quantities of at most 9 bound every basket subtotal at 225000 cents and the payable amount at 225500 cents before discount. These values are exact safe integers. No user price input or additional product can enter this catalog.

### Catalog navigation

- CAT1. Search applies on Search or Enter. The committed visible query is Unicode NFC with outer Unicode White_Space trimmed. That trim set is U+0009 through U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000 through U+200A, U+2028, U+2029, U+202F, U+205F, and U+3000. Matching uses substring inclusion after locale-independent Unicode lowercase mapping and a final NFC on both query and product name. Accents remain significant. Empty queries show all products. No matches shows "No products".
- CAT2. Results sort by that lowercase NFC product-name key in Unicode code-point order, then by stable product ID in ASCII order. Equal names remain distinct products. Details show the selected product ID, name, and price. Unknown product IDs show "Product not found" with a catalog return link.
- CAT3. Catalog URLs contain only `q` when nonempty. Encode its NFC, trimmed, case-preserved query as UTF-8 percent escapes with uppercase hex. Leave only ASCII letters, digits, `-._~` unescaped. Spaces use `%20` and literal plus uses `%2B`. Incoming plus means space. Use the first `q` if repeated and remove unrecognized parameters when canonicalizing. Invalid percent escapes, invalid UTF-8, or non-scalar Unicode show "Invalid search link" with Clear search and do not run a partial search.
- CAT4. A direct catalog link restores the committed input, exact result set, and order. Committing search or Clear search replaces that catalog history entry. Clear search removes `q`. Opening details adds a history entry and carries the same public `q`. Browser Back and the detail "Back to catalog" link restore the query, results, and canonical catalog URL together.
- CAT5. A shareable catalog or product URL carries only the product ID and public query. It contains no account ID, address, basket, saved membership, credential, or expense data.

### Order cancellation

- ORDER1. Stored policy version selects the rule. Version 1 permits cancellation of a noncancelled order when its age is from 0 through 86400000 milliseconds inclusive. Version 1 has no additional status restriction. Version 2 permits cancellation only in placed or processing status, regardless of age. Packed and shipped version 2 orders cannot be cancelled. Unknown policy versions or unknown statuses show an unsupported-policy error and cannot cancel.
- ORDER2. List and detail offer the same eligibility and resulting state. Cancellation follows G4 and atomically changes the status to cancelled before success. An already cancelled order stays cancelled and cannot cause another cancellation effect. Confirmation cancellation changes nothing. A failed save leaves both views at the previous status with an error.
- ORDER3. Orders sort by creation time descending, then stable ID in ASCII ascending order. An empty list shows "No orders". Status and policy never change because of real waiting or a remote job. Both cancellation entry points and reload show the committed state.

### Wishlist

- WISH1. Save adds one stable product ID. Saving an existing member changes nothing. Unsave removes that ID once, and repeating it changes nothing. Every shop route shows the same count and membership. An empty list alone shows "No saved products".
- WISH2. Items display in save order. Removing then saving an item appends it. Membership and order survive route changes and reload. Save and Unsave follow G4, including prior visible membership and count plus an error on persistence failure. They never acknowledge a membership update that was not committed.
- WISH3. Saved membership belongs to account-ada's local account data. It never enters a catalog or product URL. This local app has one account and makes no multi-account isolation promise.
