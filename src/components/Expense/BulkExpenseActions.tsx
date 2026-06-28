import { FolderInput, Trash2, X } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { useTranslationWithUtils } from '~/hooks/useTranslationWithUtils';
import { api } from '~/utils/api';

import { SimpleConfirmationDialog } from '../SimpleConfirmationDialog';
import { EntityAvatar } from '../ui/avatar';
import { Button } from '../ui/button';
import { AppDrawer } from '../ui/drawer';

interface BulkExpenseActionsProps {
  selectedExpenseIds: Set<string>;
  currentGroupId?: number;
  disabled?: boolean;
  onClearSelection: () => void;
}

export const BulkExpenseActions: React.FC<BulkExpenseActionsProps> = ({
  selectedExpenseIds,
  currentGroupId,
  disabled,
  onClearSelection,
}) => {
  const { t } = useTranslationWithUtils();
  const apiUtils = api.useUtils();
  const groupsQuery = api.group.getAllGroups.useQuery();
  const moveExpensesMutation = api.expense.moveExpensesToGroup.useMutation();
  const deleteExpensesMutation = api.expense.deleteExpenses.useMutation();
  const [isOpen, setIsOpen] = useState(false);

  const selectedCount = selectedExpenseIds.size;
  const selectedIds = useMemo(() => [...selectedExpenseIds], [selectedExpenseIds]);

  const moveExpenses = useCallback(
    async (targetGroupId: number | null) => {
      try {
        await moveExpensesMutation.mutateAsync({
          expenseIds: selectedIds,
          targetGroupId,
        });
        toast.success(t('expense_details.bulk_edit.move_success'));
        onClearSelection();
        setIsOpen(false);
        await apiUtils.invalidate();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t('errors.something_went_wrong'));
      }
    },
    [apiUtils, moveExpensesMutation, onClearSelection, selectedIds, t],
  );

  const deleteExpenses = useCallback(async () => {
    try {
      await deleteExpensesMutation.mutateAsync({ expenseIds: selectedIds });
      toast.success(t('expense_details.bulk_edit.delete_success'));
      onClearSelection();
      await apiUtils.invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.something_went_wrong'));
    }
  }, [apiUtils, deleteExpensesMutation, onClearSelection, selectedIds, t]);

  const isMutating = moveExpensesMutation.isPending || deleteExpensesMutation.isPending;

  if (0 === selectedCount) {
    return null;
  }

  return (
    <div className="bg-background/95 sticky bottom-4 z-20 mx-auto mt-4 flex max-w-xl items-center justify-between gap-2 rounded-md border p-2 shadow-lg backdrop-blur">
      <div className="min-w-0 px-2 text-sm">
        {t('expense_details.bulk_edit.selected_count', { count: selectedCount })}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <AppDrawer
          title={t('expense_details.bulk_edit.move_title')}
          open={isOpen}
          onOpenChange={setIsOpen}
          trigger={
            <Button size="sm" variant="secondary" disabled={disabled || isMutating}>
              <FolderInput className="mr-2 size-4" />
              {t('expense_details.bulk_edit.move')}
            </Button>
          }
        >
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground text-sm">
              {t('expense_details.bulk_edit.move_description', { count: selectedCount })}
            </p>
            <Button
              variant="outline"
              className="justify-start gap-3"
              disabled={isMutating}
              loading={moveExpensesMutation.isPending}
              onClick={() => moveExpenses(null)}
            >
              <FolderInput className="size-4" />
              {t('expense_details.bulk_edit.no_group')}
            </Button>
            {groupsQuery.data?.map((groupMembership) => {
              const group = groupMembership.group;
              const isCurrentGroup = group.id === currentGroupId;
              const isDisabled = Boolean(group.archivedAt) || isCurrentGroup;

              return (
                <Button
                  key={group.id}
                  variant="outline"
                  className="justify-start gap-3"
                  disabled={isMutating || isDisabled}
                  onClick={() => moveExpenses(group.id)}
                >
                  <EntityAvatar entity={group} size={25} />
                  <span className="min-w-0 truncate">{group.name}</span>
                </Button>
              );
            })}
          </div>
        </AppDrawer>
        <SimpleConfirmationDialog
          title={t('expense_details.bulk_edit.delete_title')}
          description={t('expense_details.bulk_edit.delete_description', { count: selectedCount })}
          hasPermission={!disabled}
          loading={deleteExpensesMutation.isPending}
          variant="destructive"
          onConfirm={deleteExpenses}
        >
          <Button size="sm" variant="destructive" disabled={disabled || isMutating}>
            <Trash2 className="mr-2 size-4" />
            {t('expense_details.bulk_edit.delete')}
          </Button>
        </SimpleConfirmationDialog>
        <Button
          size="sm"
          variant="ghost"
          className="px-2"
          disabled={isMutating}
          onClick={onClearSelection}
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
};
