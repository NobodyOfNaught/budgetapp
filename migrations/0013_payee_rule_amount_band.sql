-- Payee rule price bands (PR 34) — two nullable columns, additive under the
-- expand/contract rule. Nothing on `main` today reads or writes them, and
-- NULL on both — every existing rule — means "no price condition", which is
-- exactly how rules behave now.
--
-- One merchant can mean different things at different prices. The owner's
-- dance studio charges $20–$40 for a weekly class night and $80–$115 for an
-- event; both arrive as "DANCE JAM", and a text-only rule can only give them
-- the same category. A band on the rule splits them: "DANCE JAM, up to $50"
-- goes to the class category, and a plain "DANCE JAM" rule behind it catches
-- everything else.
--
-- Stored as a non-negative MAGNITUDE in the budget's currency, in minor
-- units, both ends inclusive. Magnitude because a refund and a charge of the
-- same size belong in the same band; budget currency because a CAD account's
-- 57.45 is about $42, and judging it by "57" would put it on the wrong side
-- of a $50 line. See src/import/rules.ts.
ALTER TABLE payee_rules ADD COLUMN amount_min_minor INTEGER;
ALTER TABLE payee_rules ADD COLUMN amount_max_minor INTEGER;
