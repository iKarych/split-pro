import { type User } from '@prisma/client';
import { CheckIcon, SearchIcon } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { EntityAvatar } from '~/components/ui/avatar';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { useTranslationWithUtils } from '~/hooks/useTranslationWithUtils';
import { api } from '~/utils/api';

export const ConvertGuestMember: React.FC<{
  groupId: number;
  guestUser: User;
  children: React.ReactNode;
  onConverted?: () => void;
}> = ({ groupId, guestUser, children, onConverted }) => {
  const { displayName, t } = useTranslationWithUtils();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedUser, setSelectedUser] = useState<User | null>(null);

  const utils = api.useUtils();
  const trimmedQuery = query.trim();
  const usersQuery = api.user.searchUsers.useQuery(
    { query: trimmedQuery },
    { enabled: open && 2 <= trimmedQuery.length },
  );
  const convertGuestMemberMutation = api.group.convertGuestMember.useMutation();

  const users = useMemo(
    () => usersQuery.data?.filter((user) => user.id !== guestUser.id) ?? [],
    [guestUser.id, usersQuery.data],
  );

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);

    if (!nextOpen) {
      setQuery('');
      setSelectedUser(null);
    }
  }, []);

  const handleConfirm = useCallback(() => {
    if (!selectedUser) {
      return;
    }

    convertGuestMemberMutation.mutate(
      {
        groupId,
        guestUserId: guestUser.id,
        targetUserId: selectedUser.id,
      },
      {
        onSuccess: () => {
          toast.success(t('group_details.messages.guest_converted'));
          utils.group.getGroupDetails.invalidate({ groupId }).catch(console.error);
          utils.expense.getGroupExpenses.invalidate({ groupId }).catch(console.error);
          utils.group.getAllGroupsWithBalances.invalidate().catch(console.error);
          utils.user.getFriends.invalidate().catch(console.error);
          onConverted?.();
          handleOpenChange(false);
        },
        onError: () => {
          toast.error(t('errors.something_went_wrong'));
        },
      },
    );
  }, [
    convertGuestMemberMutation,
    groupId,
    guestUser.id,
    handleOpenChange,
    onConverted,
    selectedUser,
    t,
    utils.expense.getGroupExpenses,
    utils.group.getAllGroupsWithBalances,
    utils.group.getGroupDetails,
    utils.user.getFriends,
  ]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('group_details.group_info.convert_guest_details.title')}</DialogTitle>
          <DialogDescription>
            {t('group_details.group_info.convert_guest_details.description', {
              guest: displayName(guestUser),
            })}
          </DialogDescription>
        </DialogHeader>

        <Input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedUser(null);
          }}
          placeholder={t('group_details.group_info.convert_guest_details.search_placeholder')}
          rightIcon={<SearchIcon className="text-muted-foreground size-4" />}
        />

        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
          {2 > trimmedQuery.length ? (
            <p className="text-muted-foreground text-sm">
              {t('group_details.group_info.convert_guest_details.min_query')}
            </p>
          ) : null}
          {2 <= trimmedQuery.length && !usersQuery.isPending && 0 === users.length ? (
            <p className="text-muted-foreground text-sm">
              {t('group_details.group_info.convert_guest_details.no_results')}
            </p>
          ) : null}
          {users.map((user) => {
            const isSelected = selectedUser?.id === user.id;

            return (
              <Button
                key={user.id}
                variant="ghost"
                className="flex h-auto justify-between px-0 py-2"
                onClick={() => setSelectedUser(user)}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <EntityAvatar entity={user} size={32} />
                  <div className="min-w-0 text-left">
                    <p className="truncate">{displayName(user)}</p>
                    {user.email ? (
                      <p className="text-muted-foreground truncate text-xs">{user.email}</p>
                    ) : null}
                  </div>
                </div>
                {isSelected ? <CheckIcon className="text-primary size-4" /> : null}
              </Button>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)}>
            {t('actions.cancel')}
          </Button>
          <Button
            disabled={!selectedUser || convertGuestMemberMutation.isPending}
            loading={convertGuestMemberMutation.isPending}
            onClick={handleConfirm}
          >
            {t('group_details.group_info.convert_guest')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
