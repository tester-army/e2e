# Everyday expenses product rules

- G1. The expense app opens its list at `/expenses`, edits at `/expenses/:id`, and overview at `/expenses/overview`. Navigation uses ordinary links, forms, buttons, and labelled controls.

- G2. Each local app starts signed in as `account-ada`, Ada Green. No login, external account, payment service, or fulfillment service is needed. First use in a new browser profile creates the documented data once. Navigation, a second tab, and reload retain that account's data. Shop snapshots share the same product rules and starting data. The expense snapshot has its own data.

- G3. Account and Expenses each expose a "Reset demo data" button with confirmation. Confirmation restores that app's starting data, clears its draft and query, and returns to its initial route. Cancelling confirmation changes nothing. A new pristine browser profile gives the same initial state. Reset affects only this local app.

- G4. Every state-changing operation commits its complete durable update before a success message, navigation, or changed data-backed view acknowledges success. Pending actions keep the prior saved view and prevent duplicate submission. Failure leaves prior visible saved data and durable data unchanged, retains editable form input, and shows a visible error with a retry action. It never announces success. Retrying the same operation cannot duplicate a record or order. Navigation after an acknowledged success and reload show the committed data. Within one profile, saves execute in submission order and later reads use the latest committed state.

- G5. IDs identify records. Labels, names, positions, and current sort order never identify records. New address, expense, and order IDs use monotonic counters in their own collection and are never reused after deletion. One operation changing several fields commits all of them or none. There is no background data change or dependence on elapsed real time.

- G6. USD values use integer cents and render as `$0.00` with exactly two decimal places.

- G7. The product clock is always `2026-10-18T12:00:00.000Z`, epoch milliseconds `1792324800000`. Creation and policy timestamps use integer UTC milliseconds. Browser locale, wall time, time zone, and waiting do not change eligibility.

DATA-EXPENSES. The initial category filter is All. The complete category choices are Meals, Travel, and Supplies. The list initially contains `expense-meal`, "Lunch", $12.00, Meals, created at `2026-10-17T10:00:00.000Z`, followed by `expense-travel`, "Train", $20.00, Travel, created at `2026-10-17T11:00:00.000Z`. New records append to that creation order. The overview initially totals $32.00.

- EXP1. The list has All and the published category filters. It contains exactly the matching records in stable creation order, with ID order for equal creation times. Its total sums only those visible records. An empty category shows "No expenses" and $0.00. The overview lists all records and their total in the same order.

- EXP2. Open an expense by its ID. Saving atomically updates description, amount, and category while preserving its ID and creation position. The return link and browser Back retain the list filter. After save, that list refreshes membership and amounts. The new category, overview, and reload retain the updated record. A category change never deletes it.

- EXP3. Description trims outer ASCII whitespace, U+0009 through U+000D and U+0020, and preserves the remaining Unicode text. An empty description rejects the save. Amount input trims that whitespace and accepts only one or more ASCII digits followed optionally by a dot and one or two ASCII digits. Leading zeroes are accepted. A leading dot, trailing dot, sign, exponent, comma, embedded whitespace, non-ASCII digits, or excess fractional digits rejects the save. There is no implicit rounding.

- EXP4. The amount must be 1 through 9999999 cents inclusive, or $0.01 through $99,999.99. Parse the decimal text exactly into cents before range checks. Reject any creation or edit whose resulting all-record total would exceed 9007199254740991 cents. Store and sum exact integers. Reject before a durable or visible saved-state change, with an error naming the invalid amount or total.

- EXP5. Repeating an unchanged save does not duplicate the expense. Cancel discards editor changes and returns to the prior list filter with the saved record unchanged. Create, edit, and confirmed delete follow G4. Cancelled deletion changes nothing.
