-- Transfer fee rows (PR 16) — one additive, nullable column, safe under
-- the expand/contract rule (see the plan's "Guarding the shared production
-- database"). Nothing on `main` today reads or writes it.
--
-- The case that forced it: a Vancity bill payment of 1900.31 CAD arriving
-- in a Wise CAD balance as 1900.00 CAD, the 0.31 being Wise's fee. Both
-- legs are CAD, so PR 14's exact-opposite rule refused the link outright
-- and there was no way to record the movement as a transfer at all.
--
-- Linking such a pair shrinks the outflow leg to the amount that actually
-- ARRIVED (so the two legs are an exact pair, keeping the Ready to Assign
-- neutrality PR 14 rests on) and books the difference as its own ordinary
-- transaction in the same account. The account balance is unchanged --
-- -1900.00 + -0.31 is still -1900.31 -- but the fee is now real,
-- categorizable spending instead of 31 cents silently vanishing from the
-- budget while net worth quietly dropped.
--
-- This column points that fee row back at the transfer leg it was carved
-- out of, which is what makes the whole operation reversible: unlinking
-- adds the fee back onto the leg and removes the fee row, and deleting the
-- leg takes its fee row with it (see softDeleteTransactionCascade). Without
-- it, undoing a mistaken link would silently leave the leg short and a
-- stray fee row behind -- exactly the kind of quiet drift the rest of this
-- schema goes out of its way to prevent.
--
-- NULL -- every row today, and every row that isn't a carved-out fee --
-- means "not a transfer fee", so existing behaviour is untouched.
ALTER TABLE transactions ADD COLUMN fee_for_transaction_id TEXT;

-- Only ever looked up by the leg it belongs to (unlink, delete cascade),
-- and only a handful of rows will be non-NULL, so a partial index keeps it
-- off the write path for ordinary transactions -- the same shape as the
-- import-dedupe index in 0005.
CREATE INDEX transactions_fee_for_idx ON transactions (fee_for_transaction_id)
  WHERE fee_for_transaction_id IS NOT NULL;
