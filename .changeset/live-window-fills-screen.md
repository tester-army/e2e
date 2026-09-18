---
'e2e': patch
---

The list reporter's live block now reaches the bottom of the terminal: the running tests take the rows under the log and the summary sits on the last rows, instead of the block stopping fourteen rows in and leaving the lower half of a tall terminal blank. The block gives rows back to the log as results print, and only once the log has grown down to the rows the running area needs does it scroll the log, as before.
