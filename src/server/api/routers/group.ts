import { TRPCError } from '@trpc/server';
import { nanoid } from 'nanoid';
import { z } from 'zod';

import { simplifyDebts } from '~/lib/simplify';
import { createTRPCRouter, groupProcedure, protectedProcedure } from '~/server/api/trpc';
import { sendGroupSimplifyDebtsToggleNotification } from '~/server/api/services/notificationService';
import { SplitType } from '@prisma/client';
import {
  defaultSplitInputSchema,
  deserializeDefaultSplit,
  parseSerializedDefaultSplit,
  serializeDefaultSplit,
} from '~/lib/defaultSplit';

const moveDefaultSplitShare = (
  shares: Record<string, string>,
  guestUserId: number,
  targetUserId: number,
) => {
  const guestKey = String(guestUserId);
  const targetKey = String(targetUserId);

  if (!(guestKey in shares)) {
    return shares;
  }

  const guestShare = BigInt(shares[guestKey] ?? '0');
  const targetShare = BigInt(shares[targetKey] ?? '0');
  const nextShares = { ...shares };
  const nextTargetShare = targetShare + guestShare;

  delete nextShares[guestKey];

  if (0n === nextTargetShare) {
    delete nextShares[targetKey];
  } else {
    nextShares[targetKey] = nextTargetShare.toString();
  }

  return nextShares;
};

export const groupRouter = createTRPCRouter({
  create: protectedProcedure
    .input(z.object({ name: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const group = await ctx.db.group.create({
        data: {
          name: input.name,
          publicId: nanoid(),
          userId: ctx.session.user.id,
          groupUsers: {
            create: {
              userId: ctx.session.user.id,
            },
          },
        },
      });

      return group;
    }),

  getAllGroups: protectedProcedure.query(async ({ ctx }) => {
    const groups = await ctx.db.groupUser.findMany({
      where: {
        userId: ctx.session.user.id,
      },
      include: {
        group: {
          include: {
            groupUsers: {
              include: {
                user: true,
              },
            },
          },
        },
      },
    });

    return groups;
  }),

  getAllGroupsWithBalances: protectedProcedure
    .input(z.object({ getArchived: z.boolean() }).optional())
    .query(async ({ ctx, input }) => {
      const groups = await ctx.db.groupUser.findMany({
        where: {
          userId: ctx.session.user.id,
          group: {
            archivedAt: input?.getArchived ? { not: null } : null,
          },
        },
        include: {
          group: {
            include: {
              groupBalances: {
                where: { userId: ctx.session.user.id },
              },
              // We can sort by group balance view instead
              expenses: {
                orderBy: {
                  createdAt: 'desc',
                },
                take: 1,
              },
            },
          },
        },
      });

      const sortedGroupsByLatestExpense = groups.sort((a, b) => {
        const aDate = a.group.expenses[0]?.createdAt ?? new Date(0);
        const bDate = b.group.expenses[0]?.createdAt ?? new Date(0);
        return bDate.getTime() - aDate.getTime();
      });

      const groupsWithBalances = sortedGroupsByLatestExpense.map((g) => {
        const balances: Record<string, bigint> = {};

        for (const balance of g.group.groupBalances) {
          balances[balance.currency] = (balances[balance.currency] ?? 0n) + balance.amount;
        }

        return {
          ...g.group,
          balances,
        };
      });

      return groupsWithBalances;
    }),

  joinGroup: protectedProcedure
    .input(z.object({ groupId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const group = await ctx.db.group.findFirst({
        where: {
          publicId: input.groupId,
        },
      });

      if (!group) {
        throw new Error('Group not found');
      }

      await ctx.db.groupUser.create({
        data: {
          groupId: group.id,
          userId: ctx.session.user.id,
        },
      });

      await ctx.db.groupDefaultSplit.deleteMany({ where: { groupId: group.id } });

      return group;
    }),

  getGroupDetails: groupProcedure.query(async ({ input, ctx }) => {
    const group = await ctx.db.group.findUnique({
      where: {
        id: input.groupId,
      },
      include: {
        groupUsers: {
          include: {
            user: true,
          },
        },
        groupBalances: true,
        groupDefaultSplit: true,
      },
    });

    if (!group) {
      return group;
    }

    if (group.simplifyDebts) {
      group.groupBalances = simplifyDebts(group.groupBalances);
    }

    const defaultSplit =
      group.groupDefaultSplit &&
      parseSerializedDefaultSplit(
        group.groupDefaultSplit.splitType,
        group.groupDefaultSplit.shares,
      );

    return {
      ...group,
      defaultSplit,
    };
  }),

  getGroupTotals: groupProcedure.query(async ({ input, ctx }) => {
    const totals = await ctx.db.expense.groupBy({
      by: 'currency',
      _sum: {
        amount: true,
      },
      where: {
        groupId: input.groupId,
        deletedAt: null,
        splitType: {
          not: SplitType.SETTLEMENT,
        },
      },
    });

    return totals;
  }),

  addMembers: groupProcedure
    .input(z.object({ userIds: z.array(z.number()) }))
    .mutation(async ({ input, ctx }) => {
      const groupUsers = await ctx.db.groupUser.createMany({
        data: input.userIds.map((userId) => ({
          groupId: input.groupId,
          userId,
        })),
      });

      await ctx.db.groupDefaultSplit.deleteMany({ where: { groupId: input.groupId } });

      return groupUsers;
    }),

  createGuestMember: groupProcedure
    .input(z.object({ name: z.string().trim().min(1).max(80) }))
    .mutation(async ({ input, ctx }) => {
      const guest = await ctx.db.$transaction(async (tx) => {
        const group = await tx.group.findUnique({
          where: { id: input.groupId },
          select: { archivedAt: true },
        });

        if (!group) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' });
        }

        if (group.archivedAt) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Cannot add guests to archived groups',
          });
        }

        const createdGuest = await tx.user.create({
          data: {
            name: input.name,
            isGuest: true,
            guestCreatedById: ctx.session.user.id,
          },
        });

        await tx.groupUser.create({
          data: {
            groupId: input.groupId,
            userId: createdGuest.id,
          },
        });

        await tx.groupDefaultSplit.deleteMany({ where: { groupId: input.groupId } });

        return createdGuest;
      });

      return guest;
    }),

  convertGuestMember: groupProcedure
    .input(z.object({ guestUserId: z.number(), targetUserId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const result = await ctx.db.$transaction(async (tx) => {
        const group = await tx.group.findUnique({
          where: { id: input.groupId },
          select: { id: true, userId: true, archivedAt: true },
        });

        if (!group) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' });
        }

        if (group.userId !== ctx.session.user.id) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Only group owner can convert guests',
          });
        }

        if (group.archivedAt) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Cannot convert guests in archived groups',
          });
        }

        if (input.guestUserId === input.targetUserId || group.userId === input.guestUserId) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid guest conversion' });
        }

        const [guestGroupUser, targetUser, targetGroupUser] = await Promise.all([
          tx.groupUser.findUnique({
            where: {
              groupId_userId: {
                groupId: input.groupId,
                userId: input.guestUserId,
              },
            },
            include: { user: true },
          }),
          tx.user.findUnique({ where: { id: input.targetUserId } }),
          tx.groupUser.findUnique({
            where: {
              groupId_userId: {
                groupId: input.groupId,
                userId: input.targetUserId,
              },
            },
          }),
        ]);

        if (!guestGroupUser || !guestGroupUser.user.isGuest) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Guest member not found' });
        }

        if (!targetUser || targetUser.isGuest) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Target user not found' });
        }

        if (!targetGroupUser) {
          await tx.groupUser.create({
            data: {
              groupId: input.groupId,
              userId: input.targetUserId,
            },
          });
        }

        const guestParticipants = await tx.expenseParticipant.findMany({
          where: {
            userId: input.guestUserId,
            expense: { groupId: input.groupId },
          },
          select: {
            expenseId: true,
            amount: true,
          },
        });
        const expenseIds = guestParticipants.map((participant) => participant.expenseId);
        const targetParticipants = expenseIds.length
          ? await tx.expenseParticipant.findMany({
              where: {
                userId: input.targetUserId,
                expenseId: { in: expenseIds },
              },
              select: {
                expenseId: true,
                amount: true,
              },
            })
          : [];
        const targetParticipantMap = new Map(
          targetParticipants.map((participant) => [participant.expenseId, participant]),
        );

        await Promise.all(
          guestParticipants.map(async (participant) => {
            const targetParticipant = targetParticipantMap.get(participant.expenseId);

            if (!targetParticipant) {
              await tx.expenseParticipant.update({
                where: {
                  expenseId_userId: {
                    expenseId: participant.expenseId,
                    userId: input.guestUserId,
                  },
                },
                data: { userId: input.targetUserId },
              });
              return;
            }

            const nextAmount = targetParticipant.amount + participant.amount;

            if (0n === nextAmount) {
              await tx.expenseParticipant.delete({
                where: {
                  expenseId_userId: {
                    expenseId: participant.expenseId,
                    userId: input.targetUserId,
                  },
                },
              });
            } else {
              await tx.expenseParticipant.update({
                where: {
                  expenseId_userId: {
                    expenseId: participant.expenseId,
                    userId: input.targetUserId,
                  },
                },
                data: { amount: nextAmount },
              });
            }

            await tx.expenseParticipant.delete({
              where: {
                expenseId_userId: {
                  expenseId: participant.expenseId,
                  userId: input.guestUserId,
                },
              },
            });
          }),
        );

        const [paidBy, addedBy, updatedBy, deletedBy] = await Promise.all([
          tx.expense.updateMany({
            where: { groupId: input.groupId, paidBy: input.guestUserId },
            data: { paidBy: input.targetUserId },
          }),
          tx.expense.updateMany({
            where: { groupId: input.groupId, addedBy: input.guestUserId },
            data: { addedBy: input.targetUserId },
          }),
          tx.expense.updateMany({
            where: { groupId: input.groupId, updatedBy: input.guestUserId },
            data: { updatedBy: input.targetUserId },
          }),
          tx.expense.updateMany({
            where: { groupId: input.groupId, deletedBy: input.guestUserId },
            data: { deletedBy: input.targetUserId },
          }),
        ]);

        const groupDefaultSplit = await tx.groupDefaultSplit.findUnique({
          where: { groupId: input.groupId },
        });

        if (groupDefaultSplit) {
          const parsedDefaultSplit = parseSerializedDefaultSplit(
            groupDefaultSplit.splitType,
            groupDefaultSplit.shares,
          );

          if (!parsedDefaultSplit) {
            await tx.groupDefaultSplit.delete({ where: { groupId: input.groupId } });
          } else {
            await tx.groupDefaultSplit.update({
              where: { groupId: input.groupId },
              data: {
                shares: moveDefaultSplitShare(
                  parsedDefaultSplit.shares,
                  input.guestUserId,
                  input.targetUserId,
                ),
              },
            });
          }
        }

        await tx.groupUser.delete({
          where: {
            groupId_userId: {
              groupId: input.groupId,
              userId: input.guestUserId,
            },
          },
        });

        return {
          participants: guestParticipants.length,
          expenses: paidBy.count + addedBy.count + updatedBy.count + deletedBy.count,
        };
      });

      return result;
    }),

  toggleSimplifyDebts: groupProcedure
    .input(z.object({ groupId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const group = await ctx.db.group.findUnique({
        where: {
          id: input.groupId,
        },
      });

      if (!group) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' });
      }

      if (group.archivedAt) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Cannot toggle simplify debts for archived groups',
        });
      }

      const isInGroup = await ctx.db.groupUser.findFirst({
        where: {
          groupId: input.groupId,
          userId: ctx.session.user.id,
        },
      });

      if (!isInGroup) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Only group members can toggle Simplify Debts',
        });
      }

      const simplifyDebtsInv = !group.simplifyDebts;

      await ctx.db.group.update({
        where: {
          id: input.groupId,
        },
        data: {
          simplifyDebts: simplifyDebtsInv,
        },
      });

      // Send notifications asynchronously
      void sendGroupSimplifyDebtsToggleNotification(
        input.groupId,
        ctx.session.user.id,
        simplifyDebtsInv,
      );

      return simplifyDebts;
    }),

  leaveGroup: groupProcedure
    .input(z.object({ groupId: z.number(), userId: z.number().optional() }))
    .mutation(async ({ input, ctx }) => {
      const userId = input.userId ?? ctx.session.user.id;

      const group = await ctx.db.group.findUnique({
        where: {
          id: input.groupId,
        },
      });
      if (!group) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' });
      }

      if (group.userId !== ctx.session.user.id && userId !== ctx.session.user.id) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Only group creator can remove someone from the group',
        });
      }

      const groupBalances = await ctx.db.balanceView.findMany({
        where: { groupId: input.groupId },
      });

      const finalGroupBalances = group.simplifyDebts ? simplifyDebts(groupBalances) : groupBalances;

      if (finalGroupBalances.some((b) => b.userId === userId && 0n !== b.amount)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'User has a non-zero balance in this group',
        });
      }

      const groupUser = await ctx.db.groupUser.delete({
        where: {
          groupId_userId: {
            groupId: input.groupId,
            userId,
          },
        },
      });

      await ctx.db.groupDefaultSplit.deleteMany({ where: { groupId: input.groupId } });

      return groupUser;
    }),

  upsertDefaultSplit: groupProcedure
    .input(
      z.object({
        groupId: z.number(),
        defaultSplit: defaultSplitInputSchema,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const parsed = deserializeDefaultSplit(input.defaultSplit);
      if (!parsed) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Malformed default split' });
      }

      const serialized = serializeDefaultSplit(parsed);

      const groupDefaultSplit = await ctx.db.groupDefaultSplit.upsert({
        where: { groupId: input.groupId },
        create: {
          groupId: input.groupId,
          splitType: serialized.splitType,
          shares: serialized.shares,
        },
        update: {
          splitType: serialized.splitType,
          shares: serialized.shares,
        },
      });

      return {
        splitType: groupDefaultSplit.splitType,
        shares: serialized.shares,
      };
    }),

  clearDefaultSplit: groupProcedure
    .input(z.object({ groupId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      await ctx.db.groupDefaultSplit.deleteMany({ where: { groupId: input.groupId } });
      return true;
    }),

  updateGroupDetails: groupProcedure
    .input(
      z.object({
        name: z.string().min(1),
        image: z.string().nullable().optional(),
        defaultCurrency: z.string().nullable().optional(),
        groupId: z.number(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const group = await ctx.db.group.findUnique({
        where: {
          id: input.groupId,
        },
      });

      if (!group) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' });
      }

      const updatedGroup = await ctx.db.group.update({
        where: {
          id: input.groupId,
        },
        data: {
          name: input.name,
          image: input.image,
          defaultCurrency: input.defaultCurrency,
        },
      });

      return updatedGroup;
    }),

  toggleArchive: groupProcedure
    .input(z.object({ groupId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const group = await ctx.db.group.findUnique({
        where: {
          id: input.groupId,
        },
        include: {
          groupBalances: true,
        },
      });

      if (!group) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' });
      }

      // Check if user is a member of the group
      const isInGroup = await ctx.db.groupUser.findFirst({
        where: {
          groupId: input.groupId,
          userId: ctx.session.user.id,
        },
      });

      if (!isInGroup) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Only group members can archive/unarchive the group',
        });
      }

      const isArchiving = !group.archivedAt;

      // Only check balances when archiving (not when unarchiving)
      if (isArchiving) {
        if (group?.simplifyDebts) {
          group.groupBalances = simplifyDebts(group.groupBalances);
        }

        const balanceWithNonZero = group.groupBalances.find((b) => 0n !== b.amount);

        if (balanceWithNonZero) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'Cannot archive group with outstanding balances. All balances must be settled first.',
          });
        }
      }

      const updatedGroup = await ctx.db.group.update({
        where: {
          id: input.groupId,
        },
        data: {
          archivedAt: isArchiving ? new Date() : null,
        },
      });

      return updatedGroup;
    }),

  delete: groupProcedure
    .input(z.object({ groupId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const group = await ctx.db.group.findUnique({
        where: {
          id: input.groupId,
        },
        include: {
          groupBalances: true,
        },
      });

      if (group?.userId !== ctx.session.user.id) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Only creator can delete the group' });
      }

      if (group?.simplifyDebts) {
        group.groupBalances = simplifyDebts(group.groupBalances);
      }

      const balanceWithNonZero = group?.groupBalances.find((b) => 0n !== b.amount);

      if (balanceWithNonZero) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You have a non-zero balance in this group',
        });
      }

      await ctx.db.group.delete({
        where: {
          id: input.groupId,
        },
      });

      return group;
    }),
});

export type GroupRouter = typeof groupRouter;
