import type {
  Prisma,
  Currency,
  LedgerTxType,
  LedgerRefType,
  AccountOwnerType,
} from "@prisma/client";
import { round2, SYSTEM_ACCOUNTS, type SystemAccountOwner } from "@/lib/money";

// Low-level double-entry ledger primitives. All functions take a Prisma
// transaction client so callers compose them inside a single atomic
// transaction (see settlement.ts).

type Tx = Prisma.TransactionClient;

/** A transfer can fail loudly when an invariant would be violated. */
export class LedgerError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

/** Get (or lazily create) a ledger account for an owner + currency. */
export async function getOrCreateAccount(
  tx: Tx,
  opts: {
    ownerId: string;
    ownerType: AccountOwnerType;
    currency: Currency;
    agentId?: string | null;
  },
) {
  const existing = await tx.ledgerAccount.findUnique({
    where: { ownerId_currency: { ownerId: opts.ownerId, currency: opts.currency } },
  });
  if (existing) return existing;
  return tx.ledgerAccount.create({
    data: {
      ownerId: opts.ownerId,
      ownerType: opts.ownerType,
      currency: opts.currency,
      agentId: opts.agentId ?? null,
    },
  });
}

/** Resolve a system account (escrow / escrow_stake / platform). */
export function systemAccount(tx: Tx, owner: SystemAccountOwner, currency: Currency) {
  return getOrCreateAccount(tx, { ownerId: owner, ownerType: "system", currency });
}

/**
 * Post a double-entry transaction: debit `fromAccountId`, credit `toAccountId`,
 * write an immutable LedgerTransaction row. Either side may be null only for
 * explicit mint/burn (not used in normal flows). Refuses to overdraw a
 * non-system account so balances never go negative unexpectedly.
 */
export async function postTransaction(
  tx: Tx,
  args: {
    fromAccountId: string | null;
    toAccountId: string | null;
    amount: number;
    currency: Currency;
    type: LedgerTxType;
    referenceId?: string | null;
    referenceType: LedgerRefType;
    description?: string;
    idempotencyKey?: string;
  },
) {
  const amount = round2(args.amount);
  if (amount <= 0) {
    throw new LedgerError("NON_POSITIVE_AMOUNT", `Amount must be > 0 (got ${amount}).`);
  }

  if (args.idempotencyKey) {
    const dup = await tx.ledgerTransaction.findUnique({
      where: { idempotencyKey: args.idempotencyKey },
    });
    if (dup) {
      throw new LedgerError(
        "DUPLICATE_TX",
        `Transaction ${args.idempotencyKey} already exists (idempotency guard).`,
      );
    }
  }

  if (args.fromAccountId) {
    const from = await tx.ledgerAccount.findUniqueOrThrow({
      where: { id: args.fromAccountId },
    });
    if (round2(from.balance - amount) < 0) {
      throw new LedgerError(
        "INSUFFICIENT_FUNDS",
        `Account ${from.ownerId} balance ${from.balance} < ${amount} ${args.currency}.`,
      );
    }
    await tx.ledgerAccount.update({
      where: { id: from.id },
      data: { balance: round2(from.balance - amount) },
    });
  }

  if (args.toAccountId) {
    const to = await tx.ledgerAccount.findUniqueOrThrow({
      where: { id: args.toAccountId },
    });
    await tx.ledgerAccount.update({
      where: { id: to.id },
      data: { balance: round2(to.balance + amount) },
    });
  }

  return tx.ledgerTransaction.create({
    data: {
      fromAccountId: args.fromAccountId,
      toAccountId: args.toAccountId,
      amount,
      currency: args.currency,
      type: args.type,
      referenceId: args.referenceId ?? null,
      referenceType: args.referenceType,
      description: args.description,
      idempotencyKey: args.idempotencyKey,
      status: "completed",
    },
  });
}

/**
 * Sum of all account balances per currency — must stay constant across the
 * lifetime of the system (modulo seeded mints). Used by the invariant check.
 */
export async function balanceTotals(tx: Tx, currency: Currency): Promise<number> {
  const accounts = await tx.ledgerAccount.findMany({ where: { currency } });
  return round2(accounts.reduce((sum, a) => sum + a.balance, 0));
}

export { SYSTEM_ACCOUNTS };
