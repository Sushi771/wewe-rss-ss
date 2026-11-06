-- Diagnostic evidence only. Prior request rows, outcomes and budgets are untouched.
-- Separate table preserves the previous binary's positional request INSERT contract.
CREATE TABLE xhs_unbound_source_receipts (
 operation_id TEXT PRIMARY KEY NOT NULL REFERENCES xhs_unbound_owner_requests(operation_id),
 document TEXT NOT NULL
);
