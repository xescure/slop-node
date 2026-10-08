-- Schema version 4: the catch-up order follows the votes.
--
-- getVotesAfter lists main votes by the moment each was made, its
-- validity_from, then by row ID, which breaks ties within one millisecond and
-- is never reused: upstream's caller reads them a page at a time and lists the
-- staple of each vote read [Keeta TS] index.js:69633-69702. The main network's
-- representatives key their catch-up feed the same way.
--
-- Staples are no longer listed by the moment this node applied them, so the
-- index on that order is dropped; the columns stay, written as before.
CREATE INDEX votes_catch_up ON votes (validity_from, id) WHERE ledger = 'main';

DROP INDEX staples_catch_up;
