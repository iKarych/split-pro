import { type Prisma, SplitType, type User } from '@prisma/client';
import { nanoid } from 'nanoid';

import { db } from '~/server/db';
import { type SplitwiseGroup, type SplitwiseUser } from '~/types';

import type { CreateExpense } from '~/types/expense.types';
import { sendExpensePushNotification } from './notificationService';
import { createRecurringExpenseJob } from './scheduleService';
import { currencyConversion, getCurrencyHelpers } from '~/utils/numbers';
import { type CurrencyCode, isCurrencyCode } from '~/lib/currency';
import { DEFAULT_CATEGORY } from '~/lib/category';
import { extractTemplateExpenseId } from '~/lib/cron';
import { currencyRateProvider } from './currencyRateService';

export async function joinGroup(userId: number, publicGroupId: string) {
  const group = await db.group.findUnique({
    where: {
      publicId: publicGroupId,
    },
  });

  if (!group) {
    throw new Error('Group not found');
  }

  await db.groupUser.create({
    data: {
      groupId: group.id,
      userId,
    },
  });

  return group;
}

const shouldUseAutomaticCurrencyConversion = (
  from: string,
  automaticCurrencyConversion: CreateExpense['automaticCurrencyConversion'],
): automaticCurrencyConversion is NonNullable<CreateExpense['automaticCurrencyConversion']> =>
  Boolean(
    automaticCurrencyConversion &&
    isCurrencyCode(from) &&
    isCurrencyCode(automaticCurrencyConversion.to) &&
    from !== automaticCurrencyConversion.to,
  );

const normalizeConvertedParticipants = ({
  from,
  to,
  rate,
  paidBy,
  participants,
}: {
  from: CurrencyCode;
  to: CurrencyCode;
  rate: number;
  paidBy: number;
  participants: { userId: number; amount: bigint }[];
}) => {
  const convertedParticipants = participants.map((participant) => ({
    userId: participant.userId,
    amount: currencyConversion({ from, to, amount: participant.amount, rate }),
  }));
  const remainder = convertedParticipants.reduce(
    (sum, participant) => sum + participant.amount,
    0n,
  );

  if (0n === remainder) {
    return convertedParticipants;
  }

  const balancingParticipant =
    convertedParticipants.find((participant) => participant.userId === paidBy) ??
    convertedParticipants[0];

  if (balancingParticipant) {
    balancingParticipant.amount -= remainder;
  }

  return convertedParticipants;
};

const buildAutomaticCurrencyConversionEntries = ({
  groupId,
  paidBy,
  amount,
  currency,
  participants,
  expenseDate,
  automaticCurrencyConversion,
}: {
  groupId: number | null;
  paidBy: number;
  amount: bigint;
  currency: string;
  participants: { userId: number; amount: bigint }[];
  expenseDate?: Date;
  automaticCurrencyConversion: NonNullable<CreateExpense['automaticCurrencyConversion']>;
}) => {
  const from = currency as CurrencyCode;
  const to = automaticCurrencyConversion.to as CurrencyCode;
  const rate = automaticCurrencyConversion.rate;
  const name = `${from} → ${to} @ ${rate}`;
  const convertedAmount = currencyConversion({ from, to, amount, rate });

  return {
    convertedAmount,
    sourceOffset: {
      name,
      currency: from,
      amount: -amount,
      paidBy,
      splitType: SplitType.CURRENCY_CONVERSION,
      category: DEFAULT_CATEGORY,
      groupId,
      expenseDate,
      participants: participants.map((participant) => ({
        userId: participant.userId,
        amount: -participant.amount,
      })),
    },
    targetAccounting: {
      name,
      currency: to,
      amount: convertedAmount,
      paidBy,
      splitType: SplitType.CURRENCY_CONVERSION,
      category: DEFAULT_CATEGORY,
      groupId,
      expenseDate,
      participants: normalizeConvertedParticipants({
        from,
        to,
        rate,
        paidBy,
        participants,
      }),
    },
  };
};

const createAutomaticCurrencyConversionPair = async (
  tx: Prisma.TransactionClient,
  {
    originalExpenseId,
    currentUserId,
    groupId,
    paidBy,
    amount,
    currency,
    participants,
    expenseDate,
    automaticCurrencyConversion,
  }: {
    originalExpenseId: string;
    currentUserId: number;
    groupId: number | null;
    paidBy: number;
    amount: bigint;
    currency: string;
    participants: { userId: number; amount: bigint }[];
    expenseDate?: Date;
    automaticCurrencyConversion: NonNullable<CreateExpense['automaticCurrencyConversion']>;
  },
) => {
  const { sourceOffset, targetAccounting, convertedAmount } =
    buildAutomaticCurrencyConversionEntries({
      groupId,
      paidBy,
      amount,
      currency,
      participants,
      expenseDate,
      automaticCurrencyConversion,
    });
  const { participants: targetParticipants, ...targetAccountingData } = targetAccounting;
  const { participants: sourceOffsetParticipants, ...sourceOffsetData } = sourceOffset;

  const targetExpense = await tx.expense.create({
    data: {
      ...targetAccountingData,
      addedBy: currentUserId,
      expenseParticipants: {
        create: getNonZeroParticipants(targetParticipants),
      },
    },
  });

  const sourceOffsetExpense = await tx.expense.create({
    data: {
      ...sourceOffsetData,
      addedBy: currentUserId,
      conversionToId: targetExpense.id,
      expenseParticipants: {
        create: getNonZeroParticipants(sourceOffsetParticipants),
      },
    },
  });

  await tx.expenseAutoCurrencyConversion.create({
    data: {
      originalExpenseId,
      sourceOffsetExpenseId: sourceOffsetExpense.id,
      targetExpenseId: targetExpense.id,
      fromCurrency: currency,
      toCurrency: automaticCurrencyConversion.to,
      rate: automaticCurrencyConversion.rate,
      rateDate: automaticCurrencyConversion.rateDate,
      rateOverridden: automaticCurrencyConversion.rateOverridden,
      provider: currencyRateProvider.providerName,
      convertedAmount,
    },
  });
};

const syncAutomaticCurrencyConversion = async (
  tx: Prisma.TransactionClient,
  params: {
    originalExpenseId: string;
    currentUserId: number;
    groupId: number | null;
    paidBy: number;
    amount: bigint;
    currency: string;
    participants: { userId: number; amount: bigint }[];
    expenseDate?: Date;
    automaticCurrencyConversion?: CreateExpense['automaticCurrencyConversion'];
  },
) => {
  const existingConversion = await tx.expenseAutoCurrencyConversion.findUnique({
    where: { originalExpenseId: params.originalExpenseId },
  });

  if (!shouldUseAutomaticCurrencyConversion(params.currency, params.automaticCurrencyConversion)) {
    if (!existingConversion) {
      return;
    }

    await tx.expenseAutoCurrencyConversion.delete({
      where: { id: existingConversion.id },
    });
    await tx.expense.updateMany({
      where: {
        id: { in: [existingConversion.sourceOffsetExpenseId, existingConversion.targetExpenseId] },
      },
      data: { deletedAt: new Date(), deletedBy: params.currentUserId },
    });
    return;
  }

  if (!existingConversion) {
    await createAutomaticCurrencyConversionPair(tx, {
      ...params,
      automaticCurrencyConversion: params.automaticCurrencyConversion,
    });
    return;
  }

  const { sourceOffset, targetAccounting, convertedAmount } =
    buildAutomaticCurrencyConversionEntries({
      ...params,
      automaticCurrencyConversion: params.automaticCurrencyConversion,
    });
  const { participants: targetParticipants, ...targetAccountingData } = targetAccounting;
  const { participants: sourceOffsetParticipants, ...sourceOffsetData } = sourceOffset;

  await tx.expenseParticipant.deleteMany({
    where: {
      expenseId: {
        in: [existingConversion.sourceOffsetExpenseId, existingConversion.targetExpenseId],
      },
    },
  });

  await tx.expense.update({
    where: { id: existingConversion.targetExpenseId },
    data: {
      ...targetAccountingData,
      updatedBy: params.currentUserId,
      deletedAt: null,
      deletedBy: null,
      expenseParticipants: {
        create: getNonZeroParticipants(targetParticipants),
      },
    },
  });

  await tx.expense.update({
    where: { id: existingConversion.sourceOffsetExpenseId },
    data: {
      ...sourceOffsetData,
      updatedBy: params.currentUserId,
      deletedAt: null,
      deletedBy: null,
      conversionToId: existingConversion.targetExpenseId,
      expenseParticipants: {
        create: getNonZeroParticipants(sourceOffsetParticipants),
      },
    },
  });

  await tx.expenseAutoCurrencyConversion.update({
    where: { id: existingConversion.id },
    data: {
      fromCurrency: params.currency,
      toCurrency: params.automaticCurrencyConversion.to,
      rate: params.automaticCurrencyConversion.rate,
      rateDate: params.automaticCurrencyConversion.rateDate,
      rateOverridden: params.automaticCurrencyConversion.rateOverridden,
      provider: currencyRateProvider.providerName,
      convertedAmount,
    },
  });
};

export async function createExpense(
  {
    groupId,
    paidBy,
    name,
    category,
    amount,
    splitType,
    currency,
    participants,
    expenseDate,
    fileKey,
    transactionId,
    cronExpression,
    automaticCurrencyConversion,
  }: CreateExpense & { cronExpression?: string },
  currentUserId: number,
  conversionFromParams?: CreateExpense,
) {
  const nonZeroParticipants = getNonZeroParticipants(participants);

  const conversionFrom = conversionFromParams
    ? {
        create: {
          ...conversionFromParams,
          addedBy: currentUserId,
          expenseParticipants: {
            create: getNonZeroParticipants(conversionFromParams.participants),
          },
        },
      }
    : undefined;
  if (conversionFrom) {
    // @ts-ignore
    delete conversionFrom.create.participants;
  }

  // Pre-generate UUID and create cron job if recurring (before transaction)
  let expenseId: string | undefined = undefined;
  let jobId: bigint | undefined = undefined;

  if (cronExpression) {
    const [{ gen_random_uuid }] = await db.$queryRaw<[{ gen_random_uuid: string }]>`
      SELECT gen_random_uuid()::text as gen_random_uuid
    `;
    expenseId = gen_random_uuid;

    const [{ schedule }] = await createRecurringExpenseJob(expenseId, cronExpression);
    jobId = schedule;
  }

  try {
    const createdExpense = await db.$transaction(async (tx) => {
      const expense = await tx.expense.create({
        data: {
          ...(expenseId && { id: expenseId }),
          groupId,
          paidBy,
          name,
          category,
          amount,
          splitType,
          currency,
          expenseParticipants: {
            create: nonZeroParticipants,
          },
          fileKey,
          addedBy: currentUserId,
          expenseDate,
          transactionId,
          conversionFrom,
        },
      });

      await syncAutomaticCurrencyConversion(tx, {
        originalExpenseId: expense.id,
        currentUserId,
        groupId,
        paidBy,
        amount,
        currency,
        participants: nonZeroParticipants,
        expenseDate,
        automaticCurrencyConversion,
      });

      if (expenseId && jobId) {
        await tx.expenseRecurrence.create({
          data: {
            expense: {
              connect: { id: expenseId },
            },
            job: {
              connect: { jobid: jobId },
            },
          },
        });
      }

      return expense;
    });
    if (!createdExpense) {
      throw new Error('Expense creation failed');
    }

    sendExpensePushNotification(createdExpense.id).catch(console.error);
    return createdExpense;
  } catch (error) {
    // If we created a cron job but transaction failed, clean up the cron job
    if (expenseId) {
      await db.$executeRaw`SELECT cron.unschedule(${`expense_recurring_${expenseId}`})`;
    }
    throw error;
  }
}

export async function deleteExpense(expenseId: string, deletedBy: number) {
  const expense = await db.expense.findUnique({
    where: {
      id: expenseId,
    },
    include: {
      autoCurrencyConversion: true,
      recurrence: {
        include: {
          job: true,
        },
      },
    },
  });

  const operations = [];

  if (!expense) {
    throw new Error('Expense not found');
  }

  if (expense.conversionToId) {
    await deleteExpense(expense.conversionToId, deletedBy);
  }

  operations.push(
    db.expense.update({
      where: { id: expenseId },
      data: {
        deletedBy,
        deletedAt: new Date(),
      },
    }),
  );

  if (expense.autoCurrencyConversion) {
    operations.push(
      db.expense.updateMany({
        where: {
          id: {
            in: [
              expense.autoCurrencyConversion.sourceOffsetExpenseId,
              expense.autoCurrencyConversion.targetExpenseId,
            ],
          },
        },
        data: {
          deletedBy,
          deletedAt: new Date(),
        },
      }),
    );
  }

  if (expense.recurrence?.job) {
    const templateId = extractTemplateExpenseId(expense.recurrence.job.command);
    const isTemplate = templateId === expense.id;

    if (isTemplate) {
      // Template deletion stops the recurrence
      operations.push(db.$executeRaw`SELECT cron.unschedule(${expense.recurrence.job.jobname})`);
      operations.push(
        db.expenseRecurrence.delete({
          where: { id: expense.recurrence.id },
        }),
      );
    }
    // Derived expense deletion: just soft-delete, recurrence continues
  }

  await db.$transaction(operations);
  sendExpensePushNotification(expenseId).catch(console.error);
}

export async function editExpense(
  {
    expenseId,
    groupId,
    paidBy,
    name,
    category,
    amount,
    splitType,
    currency,
    participants,
    expenseDate,
    fileKey,
    transactionId,
    cronExpression,
    automaticCurrencyConversion,
  }: CreateExpense & { cronExpression?: string },
  currentUserId: number,
  conversionToParams?: CreateExpense,
) {
  if (!expenseId) {
    throw new Error('Expense ID is required for editing');
  }

  const expense = await db.expense.findUnique({
    where: { id: expenseId },
    include: {
      expenseParticipants: true,
      recurrence: {
        include: {
          job: true,
        },
      },
    },
  });

  if (!expense) {
    throw new Error('Expense not found');
  }

  // Determine if this is a template or derived expense
  const templateId = expense.recurrence?.job?.command
    ? extractTemplateExpenseId(expense.recurrence.job.command)
    : null;
  const isTemplate = templateId === expenseId;

  await db.$transaction(async (tx) => {
    await tx.expenseParticipant.deleteMany({
      where: {
        expenseId: expense.conversionToId ? { in: [expenseId, expense.conversionToId] } : expenseId,
      },
    });

    await tx.expense.update({
      where: { id: expenseId },
      data: {
        groupId,
        paidBy,
        name,
        category,
        amount,
        splitType,
        currency,
        expenseParticipants: {
          create: participants,
        },
        fileKey,
        transactionId,
        expenseDate,
        updatedBy: currentUserId,
      },
    });

    if (conversionToParams) {
      if (!expense.conversionToId) {
        throw new Error('Conversion to expense not found for editing');
      }
      const { participants: toParticipants, ...toExpenseData } = conversionToParams;

      await tx.expense.update({
        where: { id: expense.conversionToId },
        data: {
          ...toExpenseData,
          expenseParticipants: {
            create: toParticipants,
          },
          updatedBy: currentUserId,
        },
      });
    }

    if (!conversionToParams) {
      await syncAutomaticCurrencyConversion(tx, {
        originalExpenseId: expenseId,
        currentUserId,
        groupId,
        paidBy,
        amount,
        currency,
        participants,
        expenseDate,
        automaticCurrencyConversion,
      });
    }

    if (isTemplate && expense.recurrence?.job) {
      const currentSchedule = expense.recurrence.job.schedule;

      if (cronExpression && cronExpression !== currentSchedule) {
        await tx.$executeRaw`SELECT cron.alter_job(${expense.recurrence.job.jobid}, schedule := ${cronExpression})`;
      } else if (!cronExpression) {
        await tx.$executeRaw`SELECT cron.unschedule(${expense.recurrence.job.jobname})`;
        await tx.expenseRecurrence.delete({
          where: { id: expense.recurrence.id },
        });
      }
    }
  });
  sendExpensePushNotification(expenseId).catch(console.error);
  return { id: expenseId }; // Return the updated expense
}

export async function reconcileRecurringAutomaticCurrencyConversions() {
  const recurrences = await db.expenseRecurrence.findMany({
    include: {
      job: true,
      expense: {
        where: {
          deletedAt: null,
          splitType: { not: SplitType.CURRENCY_CONVERSION },
        },
        include: {
          autoCurrencyConversion: true,
          expenseParticipants: true,
        },
      },
    },
  });

  await Promise.all(
    recurrences.map(async (recurrence) => {
      const templateId = extractTemplateExpenseId(recurrence.job.command);
      const template = recurrence.expense.find((expense) => expense.id === templateId);

      if (!template?.autoCurrencyConversion) {
        return;
      }

      const targetCurrency = template.autoCurrencyConversion.toCurrency;

      if (!isCurrencyCode(targetCurrency)) {
        return;
      }

      const missingConvertedExpenses = recurrence.expense.filter(
        (expense) => expense.id !== templateId && !expense.autoCurrencyConversion,
      );

      await Promise.all(
        missingConvertedExpenses.map(async (expense) => {
          if (!isCurrencyCode(expense.currency) || expense.currency === targetCurrency) {
            return;
          }

          const rate = await currencyRateProvider.getCurrencyRate(
            expense.currency,
            targetCurrency,
            expense.expenseDate,
          );

          await db.$transaction((tx) =>
            syncAutomaticCurrencyConversion(tx, {
              originalExpenseId: expense.id,
              currentUserId: expense.addedBy,
              groupId: expense.groupId,
              paidBy: expense.paidBy,
              amount: expense.amount,
              currency: expense.currency,
              participants: expense.expenseParticipants.map((participant) => ({
                userId: participant.userId,
                amount: participant.amount,
              })),
              expenseDate: expense.expenseDate,
              automaticCurrencyConversion: {
                to: targetCurrency,
                rate,
                rateDate: expense.expenseDate,
                rateOverridden: false,
              },
            }),
          );
        }),
      );
    }),
  );
}

export async function getCompleteFriendsDetails(userId: number) {
  const viewBalances = await db.balanceView.findMany({
    where: {
      userId,
    },
    include: {
      friend: true,
    },
  });

  const friends = viewBalances.reduce<
    Record<
      number,
      {
        id: number;
        email?: string | null;
        name?: string | null;
        balances: { currency: string; amount: bigint }[];
      }
    >
  >((acc, balance) => {
    const { friendId } = balance;
    acc[friendId] ??= {
      balances: [],
      id: friendId,
      email: balance.friend.email,
      name: balance.friend.name,
    };

    if (0n !== balance.amount) {
      acc[friendId]?.balances.push({
        currency: balance.currency,
        amount: balance.amount,
      });
    }

    return acc;
  }, {});

  return friends;
}

export async function getCompleteGroupDetails(userId: number) {
  const groups = await db.group.findMany({
    where: {
      groupUsers: {
        some: {
          userId,
        },
      },
    },
    include: {
      groupUsers: true,
      groupBalances: true,
    },
  });

  return groups;
}

export async function importUserBalanceFromSplitWise(
  currentUserId: number,
  splitWiseUsers: SplitwiseUser[],
) {
  const operations = [];

  const users = await createUsersFromSplitwise(splitWiseUsers);

  const userMap = users.reduce<Record<string, User>>((acc, user) => {
    if (user.email) {
      acc[user.email] = user;
    }

    return acc;
  }, {});

  const currencyHelperCache: Record<string, ReturnType<typeof getCurrencyHelpers>['toSafeBigInt']> =
    {};

  for (const user of splitWiseUsers) {
    const dbUser = userMap[user.email];
    if (!dbUser) {
      // oxlint-disable-next-line no-continue
      continue;
    }

    for (const balance of user.balance) {
      const currency = balance.currency_code;

      if (!currencyHelperCache[currency]) {
        currencyHelperCache[currency] = getCurrencyHelpers({
          currency: isCurrencyCode(currency) ? currency : 'USD',
        }).toSafeBigInt;
      }

      const amount = currencyHelperCache[currency](balance.amount);

      operations.push(
        db.expense.create({
          data: {
            name: 'Splitwise Balance Import',
            amount,
            currency,
            paidBy: currentUserId,
            splitType: SplitType.EQUAL,
            expenseParticipants: {
              create: [
                {
                  userId: currentUserId,
                  amount: amount,
                },
                {
                  userId: dbUser.id,
                  amount: -amount,
                },
              ],
            },
            addedBy: currentUserId,
            category: DEFAULT_CATEGORY,
          },
        }),
      );
    }
  }

  await db.$transaction(operations);
}

async function createUsersFromSplitwise(users: SplitwiseUser[]) {
  const userEmails = users.map((u) => u.email);

  const existingUsers = await db.user.findMany({
    where: {
      email: {
        in: userEmails,
      },
    },
  });

  const existingUserMap: Record<string, boolean> = {};

  for (const user of existingUsers) {
    if (user.email) {
      existingUserMap[user.email] = true;
    }
  }

  const newUsers = users.filter((u) => !existingUserMap[u.email]);

  await db.user.createMany({
    data: newUsers.map((u) => ({
      email: u.email,
      name: `${u.first_name}${u.last_name ? ` ${u.last_name}` : ''}`,
    })),
  });

  return db.user.findMany({
    where: {
      email: {
        in: userEmails,
      },
    },
  });
}

export async function importGroupFromSplitwise(
  currentUserId: number,
  splitWiseGroups: SplitwiseGroup[],
) {
  const splitwiseUserMap: Record<string, SplitwiseUser> = {};

  for (const group of splitWiseGroups) {
    for (const member of group.members) {
      splitwiseUserMap[member.id.toString()] = member;
    }
  }

  const users = await createUsersFromSplitwise(Object.values(splitwiseUserMap));

  const userMap = users.reduce<Record<string, User>>((acc, user) => {
    if (user.email) {
      acc[user.email] = user;
    }

    return acc;
  }, {});

  const missingGroups = await Promise.all(
    splitWiseGroups.map(async (group) => {
      const dbGroup = await db.group.findUnique({
        where: {
          splitwiseGroupId: group.id.toString(),
        },
      });

      return dbGroup ? null : group;
    }),
  );

  const operations = missingGroups
    .filter((g) => null !== g)
    .map((group) => {
      const groupmembers = group.members.map((member) => ({
        userId: userMap[member.email.toString()]!.id,
      }));

      return db.group.create({
        data: {
          name: group.name,
          splitwiseGroupId: group.id.toString(),
          publicId: nanoid(),
          userId: currentUserId,
          groupUsers: {
            create: groupmembers,
          },
        },
      });
    });

  await db.$transaction(operations);
}

const getNonZeroParticipants = (participants: { userId: number; amount: bigint }[]) =>
  participants.length > 1 ? participants.filter((p) => 0n !== p.amount) : participants;

interface HistoricalBalance {
  userId: number;
  friendId: number;
  groupId: number | null;
  currency: string;
  amount: bigint;
}

export const getHistoricalBalances = async (
  userId: number,
  friendId: number,
  currency: string,
  beforeDate: Date,
) =>
  db.$queryRaw<HistoricalBalance[]>`
        SELECT "userId", "friendId", "groupId", currency, amount
        FROM get_balance_at_date(${beforeDate})
        WHERE "userId" = ${userId} 
          AND "friendId" = ${friendId} 
          AND currency = ${currency}
          AND amount != 0
      `;
