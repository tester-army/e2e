---
'e2e': patch
---

A `unique()` value is templated in a recording in every spelling a URL gives it: as typed, percent-encoded (`Acme%20Corp` in a path), and form-encoded (`Acme+Corp` in a search query). A step that ends on a search result or on a page whose path carries the value replays and passes its end check with the next run's value; before, the encoded form stayed literal and the step handed off after replaying every action.
