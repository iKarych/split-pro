import { HeartHandshakeIcon, Landmark, RefreshCcwDot, X } from 'lucide-react';
import { useTranslation } from 'next-i18next';
import Link from 'next/link';
import { useRouter } from 'next/router';
import React, { useCallback } from 'react';

import { type CurrencyCode, isCurrencyCode } from '~/lib/currency';
import { useAddExpenseStore } from '~/store/addStore';
import { api } from '~/utils/api';

import { toast } from 'sonner';
import { useTranslationWithUtils } from '~/hooks/useTranslationWithUtils';
import { cronToBackend } from '~/lib/cron';
import { cn } from '~/lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import AddBankTransactions from './AddBankTransactions';
import { CategoryPicker } from './CategoryPicker';
import { CurrencyPicker } from './CurrencyPicker';
import { DateSelector } from './DateSelector';
import { RecurrenceInput } from './RecurrenceInput';
import { SelectUserOrGroup } from './SelectUserOrGroup';
import { PayerSelectionForm, SplitExpenseForm } from './SplitTypeSection';
import { UploadFile } from './UploadFile';
import { UserInput } from './UserInput';
import { CurrencyInput } from '../ui/currency-input';
import { CurrencyConversion } from '../Friend/CurrencyConversion';
import { currencyConversion, getRatePrecision } from '~/utils/numbers';
import { CurrencyConversionIcon } from '../ui/categoryIcons';
import { useSession } from 'next-auth/react';
import { Label } from '../ui/label';

export const AddOrEditExpensePage: React.FC<{
  enableSendingInvites: boolean;
  expenseId?: string;
  bankConnectionEnabled: boolean;
}> = ({ enableSendingInvites, expenseId, bankConnectionEnabled }) => {
  const showFriends = useAddExpenseStore((s) => s.showFriends);
  const amount = useAddExpenseStore((s) => s.amount);
  const isNegative = useAddExpenseStore((s) => s.isNegative);
  const participants = useAddExpenseStore((s) => s.participants);
  const group = useAddExpenseStore((s) => s.group);
  const currency = useAddExpenseStore((s) => s.currency);
  const category = useAddExpenseStore((s) => s.category);
  const description = useAddExpenseStore((s) => s.description);
  const isFileUploading = useAddExpenseStore((s) => s.isFileUploading);
  const amtStr = useAddExpenseStore((s) => s.amountStr);
  const expenseDate = useAddExpenseStore((s) => s.expenseDate);
  const isExpenseSettled = useAddExpenseStore((s) => s.canSplitScreenClosed);
  const paidBy = useAddExpenseStore((s) => s.paidBy);
  const splitType = useAddExpenseStore((s) => s.splitType);
  const fileKey = useAddExpenseStore((s) => s.fileKey);
  const currentUser = useAddExpenseStore((s) => s.currentUser);
  const splitShares = useAddExpenseStore((s) => s.splitShares);
  const transactionId = useAddExpenseStore((s) => s.transactionId);
  const cronExpression = useAddExpenseStore((s) => s.cronExpression);
  const multipleTransactions = useAddExpenseStore((s) => s.multipleTransactions);

  const { t, displayName, generateSplitDescription, getCurrencyHelpersCached } =
    useTranslationWithUtils();

  const {
    setCurrency,
    setCategory,
    setDescription,
    setAmount,
    setAmountStr,
    resetState,
    setSplitScreenOpen,
    setExpenseDate,
    setMultipleTransactions,
    setIsTransactionLoading,
    setSingleTransaction,
  } = useAddExpenseStore((s) => s.actions);

  const addExpenseMutation = api.expense.addOrEditExpense.useMutation();
  const updateProfile = api.user.updateUserDetail.useMutation();
  const { update } = useSession();
  const editingExpenseQuery = api.expense.getExpenseDetails.useQuery(
    { expenseId: expenseId ?? '' },
    { enabled: Boolean(expenseId), refetchOnReconnect: false, refetchOnWindowFocus: false },
  );
  const [automaticConversionRate, setAutomaticConversionRate] = React.useState('');
  const [automaticConversionRateOverridden, setAutomaticConversionRateOverridden] =
    React.useState(false);
  const [automaticConversionTargetCurrencyOverride, setAutomaticConversionTargetCurrencyOverride] =
    React.useState<CurrencyCode | null>(null);
  const initializedAutomaticConversionExpenseIdRef = React.useRef<string | undefined>(undefined);

  const automaticConversionDefaultTargetCurrency = React.useMemo<CurrencyCode | null>(() => {
    if (group?.defaultCurrency && isCurrencyCode(group.defaultCurrency)) {
      return group.defaultCurrency;
    }

    const preferredCurrency = currentUser?.defaultCurrency ?? currentUser?.currency;
    return preferredCurrency && isCurrencyCode(preferredCurrency) ? preferredCurrency : null;
  }, [currentUser?.currency, currentUser?.defaultCurrency, group?.defaultCurrency]);

  const automaticConversionTargetCurrency =
    automaticConversionTargetCurrencyOverride ?? automaticConversionDefaultTargetCurrency;

  const automaticConversionPanelVisible = Boolean(
    automaticConversionDefaultTargetCurrency && isCurrencyCode(currency) && 0n !== amount,
  );

  const automaticConversionEnabled = Boolean(
    automaticConversionTargetCurrency &&
    currency !== automaticConversionTargetCurrency &&
    isCurrencyCode(currency) &&
    0n !== amount,
  );

  const automaticConversionRateQuery = api.expense.getCurrencyRate.useQuery(
    {
      from: currency,
      to: automaticConversionTargetCurrency ?? currency,
      date: expenseDate ?? new Date(),
    },
    {
      enabled: automaticConversionEnabled && !automaticConversionRateOverridden,
    },
  );

  const automaticConversionPairRef = React.useRef('');
  const automaticConversionDefaultTargetRef = React.useRef<CurrencyCode | null>(null);

  React.useEffect(() => {
    if (automaticConversionDefaultTargetRef.current === automaticConversionDefaultTargetCurrency) {
      return;
    }

    automaticConversionDefaultTargetRef.current = automaticConversionDefaultTargetCurrency;
    setAutomaticConversionTargetCurrencyOverride(null);
  }, [automaticConversionDefaultTargetCurrency]);

  React.useEffect(() => {
    if (
      !expenseId ||
      initializedAutomaticConversionExpenseIdRef.current === expenseId ||
      !editingExpenseQuery.data?.autoCurrencyConversion
    ) {
      return;
    }

    initializedAutomaticConversionExpenseIdRef.current = expenseId;
    const { rate, rateOverridden, toCurrency } = editingExpenseQuery.data.autoCurrencyConversion;
    automaticConversionPairRef.current = `${currency}-${toCurrency}`;
    if (isCurrencyCode(toCurrency)) {
      setAutomaticConversionTargetCurrencyOverride(toCurrency);
    }
    const precision = getRatePrecision(rate);
    setAutomaticConversionRate(rate.toFixed(precision));
    setAutomaticConversionRateOverridden(rateOverridden);
  }, [currency, editingExpenseQuery.data?.autoCurrencyConversion, expenseId]);

  React.useEffect(() => {
    const pairKey = `${currency}-${automaticConversionTargetCurrency ?? ''}`;
    if (automaticConversionPairRef.current === pairKey) {
      return;
    }

    automaticConversionPairRef.current = pairKey;
    setAutomaticConversionRate('');
    setAutomaticConversionRateOverridden(false);
  }, [automaticConversionTargetCurrency, currency]);

  React.useEffect(() => {
    if (!automaticConversionEnabled || automaticConversionRateOverridden) {
      return;
    }

    if (automaticConversionRateQuery.isPending) {
      setAutomaticConversionRate('');
      return;
    }

    if (automaticConversionRateQuery.data?.rate) {
      const precision = getRatePrecision(automaticConversionRateQuery.data.rate);
      setAutomaticConversionRate(automaticConversionRateQuery.data.rate.toFixed(precision));
    }
  }, [
    automaticConversionEnabled,
    automaticConversionRateOverridden,
    automaticConversionRateQuery.data?.rate,
    automaticConversionRateQuery.isPending,
  ]);

  const automaticConversionRateNumber = Number(automaticConversionRate);
  const automaticConversionBlocked =
    automaticConversionEnabled &&
    (automaticConversionRateQuery.isPending ||
      !automaticConversionRate ||
      Number.isNaN(automaticConversionRateNumber) ||
      automaticConversionRateNumber <= 0);

  const automaticConvertedAmount = React.useMemo(() => {
    if (
      !automaticConversionEnabled ||
      !automaticConversionTargetCurrency ||
      !automaticConversionRate ||
      Number.isNaN(automaticConversionRateNumber) ||
      automaticConversionRateNumber <= 0
    ) {
      return null;
    }

    return currencyConversion({
      from: currency,
      to: automaticConversionTargetCurrency,
      amount,
      rate: automaticConversionRateNumber,
    });
  }, [
    amount,
    automaticConversionEnabled,
    automaticConversionRate,
    automaticConversionRateNumber,
    automaticConversionTargetCurrency,
    currency,
  ]);

  const onCurrencyPick = useCallback(
    (newCurrency: CurrencyCode | null) => {
      if (!newCurrency) {
        return;
      }

      updateProfile.mutate({ currency: newCurrency });

      previousCurrencyRef.current = currency;
      setCurrency(newCurrency);
    },
    [currency, setCurrency, updateProfile],
  );

  const router = useRouter();

  const onUpdateAmount = useCallback(
    ({ strValue, bigIntValue }: { strValue?: string; bigIntValue?: bigint }) => {
      if (strValue !== undefined) {
        setAmountStr(strValue);
      }
      if (bigIntValue !== undefined) {
        setAmount(bigIntValue);
      }
      previousCurrencyRef.current = null;
    },
    [setAmount, setAmountStr],
  );

  const onChangeAutomaticConversionRate = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const raw = event.target.value.replace(',', '.');
      if ('' === raw) {
        setAutomaticConversionRate('');
        setAutomaticConversionRateOverridden(true);
        return;
      }

      if (!/^[0-9]*\.?[0-9]*$/.test(raw)) {
        return;
      }

      const [integerPart = '', decimalPart = ''] = raw.split('.');
      const trimmedDecimalPart = decimalPart.slice(0, 10);
      setAutomaticConversionRate(
        raw.includes('.') ? `${integerPart}.${trimmedDecimalPart}` : integerPart,
      );
      setAutomaticConversionRateOverridden(true);
    },
    [],
  );

  const resetAutomaticConversionRate = useCallback(() => {
    setAutomaticConversionRateOverridden(false);
    if (automaticConversionRateQuery.data?.rate) {
      const precision = getRatePrecision(automaticConversionRateQuery.data.rate);
      setAutomaticConversionRate(automaticConversionRateQuery.data.rate.toFixed(precision));
    }
  }, [automaticConversionRateQuery.data?.rate]);

  const onChangeAutomaticConversionTargetCurrency = useCallback(
    (newCurrency: CurrencyCode | null) => {
      setAutomaticConversionTargetCurrencyOverride(newCurrency);
    },
    [],
  );

  const resetAutomaticConversionTargetCurrency = useCallback(() => {
    setAutomaticConversionTargetCurrencyOverride(null);
  }, []);

  const addExpense = useCallback(async () => {
    if (!paidBy) {
      return;
    }

    if (!isExpenseSettled) {
      setSplitScreenOpen(true);
      return;
    }

    if (automaticConversionBlocked) {
      toast.error(t('errors.currency_conversion_failed'));
      return;
    }

    setMultipleTransactions([]);
    setIsTransactionLoading(false);

    const sign = isNegative ? -1n : 1n;

    try {
      await addExpenseMutation.mutateAsync(
        [
          {
            name: description,
            currency,
            amount: amount * sign,
            groupId: group?.id ?? null,
            splitType,
            participants: participants.map((p) => ({
              userId: p.id,
              amount: (p.amount ?? 0n) * sign,
            })),
            paidBy: paidBy.id,
            category,
            fileKey,
            expenseDate,
            expenseId,
            transactionId,
            cronExpression: cronExpression ? cronToBackend(cronExpression) : undefined,
            automaticCurrencyConversion:
              automaticConversionEnabled && automaticConversionTargetCurrency
                ? {
                    to: automaticConversionTargetCurrency,
                    rate: automaticConversionRateNumber,
                    rateDate: expenseDate,
                    rateOverridden: automaticConversionRateOverridden,
                  }
                : undefined,
          },
        ],
        {
          onSuccess: (d) => {
            if (d) {
              if (multipleTransactions.length > 0) {
                const allTransactions = [...multipleTransactions];
                const transactionToAdd = allTransactions.pop();
                if (transactionToAdd) {
                  setMultipleTransactions(allTransactions);
                  setSingleTransaction(transactionToAdd);
                }
                return;
              } else {
                const id = d.length > 0 ? d[0]?.id : expenseId;

                let navPromise: () => Promise<any> = () => Promise.resolve(true);

                const { friendId, groupId } = router.query;

                if (friendId && !groupId) {
                  navPromise = () => router.push(`/balances/${friendId as string}/expenses/${id}`);
                } else if (groupId) {
                  navPromise = () => router.push(`/groups/${groupId as string}/expenses/${id}`);
                } else {
                  navPromise = () => router.push(`/expenses/${id}?keepAdding=1`);
                }

                if (expenseId) {
                  navPromise = async () => router.back();
                }

                navPromise().catch(console.error);
                update((session: any) => ({
                  ...session,
                  user: {
                    ...(session?.user ?? {}),
                    currency,
                  },
                })).catch(console.error);
              }
            }
          },
        },
      );
    } catch (error) {
      console.error(error);
      if (error instanceof Error) {
        toast.error(error.message);
      } else {
        toast.error('An unexpected error occurred while submitting the expense.');
      }
    }
  }, [
    setSplitScreenOpen,
    description,
    currency,
    isNegative,
    amount,
    participants,
    category,
    expenseDate,
    expenseId,
    router,
    addExpenseMutation,
    group,
    paidBy,
    splitType,
    fileKey,
    isExpenseSettled,
    setMultipleTransactions,
    transactionId,
    setIsTransactionLoading,
    cronExpression,
    multipleTransactions,
    setSingleTransaction,
    update,
    automaticConversionBlocked,
    automaticConversionEnabled,
    automaticConversionRateNumber,
    automaticConversionRateOverridden,
    automaticConversionTargetCurrency,
    t,
  ]);

  const handleDescriptionChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setDescription(e.target.value.toString() ?? '');
    },
    [setDescription],
  );

  const clearTransaction = useCallback(() => {
    resetState();
    setMultipleTransactions([]);
  }, [resetState, setMultipleTransactions]);

  const previousCurrencyRef = React.useRef<CurrencyCode | null>(null);

  const onConvertAmount: React.ComponentProps<typeof CurrencyConversion>['onSubmit'] = useCallback(
    ({ amount: absAmount, rate }) => {
      if (!previousCurrencyRef.current) {
        return;
      }

      const targetAmount =
        (absAmount >= 0n ? 1n : -1n) *
        currencyConversion({
          amount: absAmount,
          rate,
          from: previousCurrencyRef.current,
          to: currency,
        });
      setAmount(targetAmount);
      setAmountStr(getCurrencyHelpersCached(currency).toUIString(targetAmount, false, true));
      previousCurrencyRef.current = null;
    },
    [setAmount, setAmountStr, currency, getCurrencyHelpersCached],
  );

  const currencyConversionComponent = React.useMemo(() => {
    if (
      currency === previousCurrencyRef.current ||
      previousCurrencyRef.current === null ||
      !amount ||
      0n === amount
    ) {
      return null;
    }

    return (
      <CurrencyConversion
        onSubmit={onConvertAmount}
        amount={amount}
        currency={previousCurrencyRef.current}
        editingTargetCurrency={currency}
      >
        <Button size="icon" variant="secondary" className="size-8">
          <CurrencyConversionIcon className="size-4" />
        </Button>
      </CurrencyConversion>
    );
  }, [amount, currency, onConvertAmount]);

  const onBackButtonPress = useCallback(() => {
    router.back();
  }, [router]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" className="text-primary px-0" onClick={onBackButtonPress}>
          {t('actions.cancel')}
        </Button>
        <div className="text-center">
          {expenseId ? t('actions.edit_expense') : t('actions.add_expense')}
        </div>
        <Button
          variant="ghost"
          className="text-primary px-0"
          disabled={
            addExpenseMutation.isPending ||
            !amount ||
            '' === description ||
            isFileUploading ||
            automaticConversionBlocked
          }
          onClick={addExpense}
        >
          {t('actions.save')}
        </Button>{' '}
      </div>
      <UserInput />
      {showFriends || (1 === participants.length && !group) ? (
        <SelectUserOrGroup enableSendingInvites={enableSendingInvites} />
      ) : (
        <>
          <div className="mt-4 flex gap-2 sm:mt-10">
            <CategoryPicker category={category} onCategoryPick={setCategory} />
            <Input
              placeholder={t('expense_details.add_expense_details.description_placeholder')}
              value={description}
              onChange={handleDescriptionChange}
              className="text-lg placeholder:text-sm"
              autoFocus
            />
          </div>
          <div className="flex gap-2">
            <CurrencyPicker currentCurrency={currency} onCurrencyPick={onCurrencyPick} />
            <CurrencyInput
              placeholder={t('expense_details.add_expense_details.amount_placeholder')}
              currency={currency}
              strValue={amtStr}
              allowNegative
              hideSymbol
              onValueChange={onUpdateAmount}
              rightIcon={currencyConversionComponent}
            />
          </div>
          {automaticConversionPanelVisible && automaticConversionTargetCurrency ? (
            <div className="rounded-md border px-3 py-2 text-sm">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex flex-col gap-1">
                  <Label>{t('currency_conversion.target_currency')}</Label>
                  <div className="flex items-center gap-2">
                    <CurrencyPicker
                      currentCurrency={automaticConversionTargetCurrency}
                      onCurrencyPick={onChangeAutomaticConversionTargetCurrency}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-9 shrink-0"
                      disabled={
                        !automaticConversionTargetCurrencyOverride ||
                        automaticConversionTargetCurrencyOverride ===
                          automaticConversionDefaultTargetCurrency
                      }
                      onClick={resetAutomaticConversionTargetCurrency}
                    >
                      <RefreshCcwDot className="size-4" />
                      <span className="sr-only">{t('currency_conversion.reset_target')}</span>
                    </Button>
                  </div>
                </div>
                <div className="flex flex-1 flex-col gap-1">
                  <Label>{t('currency_conversion.automatic_rate')}</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label={t('currency_conversion.rate')}
                      type="number"
                      min={0}
                      value={automaticConversionRate}
                      inputMode="decimal"
                      onChange={onChangeAutomaticConversionRate}
                      placeholder={automaticConversionEnabled ? undefined : '1'}
                      disabled={
                        !automaticConversionEnabled ||
                        (automaticConversionRateQuery.isPending &&
                          !automaticConversionRateOverridden)
                      }
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-9 shrink-0"
                      disabled={
                        !automaticConversionEnabled ||
                        automaticConversionRateQuery.isPending ||
                        !automaticConversionRateQuery.data?.rate ||
                        !automaticConversionRateOverridden
                      }
                      onClick={resetAutomaticConversionRate}
                    >
                      <RefreshCcwDot className="size-4" />
                      <span className="sr-only">{t('currency_conversion.reset_rate')}</span>
                    </Button>
                  </div>
                </div>
                <div className="text-muted-foreground flex flex-col gap-1 sm:min-w-44">
                  <span>
                    1 {currency} = {automaticConversionRate || '-'}{' '}
                    {automaticConversionTargetCurrency}
                  </span>
                  {!automaticConversionEnabled ? (
                    <span>{t('currency_conversion.no_conversion_needed')}</span>
                  ) : null}
                  {automaticConversionRateQuery.isPending && !automaticConversionRateOverridden ? (
                    <span>{t('currency_conversion.fetching_rate')}</span>
                  ) : null}
                  {automaticConvertedAmount !== null ? (
                    <span>
                      {t('currency_conversion.converted_amount')}:{' '}
                      {getCurrencyHelpersCached(automaticConversionTargetCurrency).toUIString(
                        automaticConvertedAmount,
                      )}
                    </span>
                  ) : null}
                  {automaticConversionRateOverridden ? (
                    <span>{t('currency_conversion.manual_override')}</span>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}
          <div className="h-[180px]">
            {amount && '' !== description ? (
              <>
                <div className="flex flex-col items-center justify-center text-sm text-gray-400 sm:mt-4 sm:flex-row">
                  <p>{t(`ui.expense.${isNegative ? 'received_by' : 'paid_by'}`)}</p>
                  <PayerSelectionForm>
                    <Button
                      variant="ghost"
                      className="text-primary h-8 max-w-full min-w-0 justify-start px-1.5 py-0 text-base sm:max-w-none"
                    >
                      <span className="max-w-full truncate">
                        {displayName(paidBy, currentUser?.id, 'dativus')}
                      </span>
                    </Button>
                  </PayerSelectionForm>
                  <p>{t('ui.and')} </p>
                  <SplitExpenseForm>
                    <Button variant="ghost" className="text-primary h-8 px-1.5 py-0 text-base">
                      {generateSplitDescription(
                        splitType,
                        participants,
                        splitShares,
                        paidBy,
                        currentUser,
                      )}
                    </Button>
                  </SplitExpenseForm>
                </div>

                <div className="mt-4 flex items-start justify-between sm:mt-10">
                  <DateSelector
                    mode="single"
                    required
                    selected={expenseDate}
                    onSelect={setExpenseDate}
                  />
                  <div className="flex items-center gap-4">
                    <UploadFile />
                    <Button
                      className="min-w-[100px]"
                      size="sm"
                      loading={addExpenseMutation.isPending || isFileUploading}
                      disabled={
                        addExpenseMutation.isPending ||
                        !amount ||
                        '' === description ||
                        isFileUploading ||
                        !isExpenseSettled ||
                        automaticConversionBlocked
                      }
                      onClick={addExpense}
                    >
                      {t('actions.save')}
                    </Button>
                  </div>
                </div>
              </>
            ) : null}
          </div>
          <div className="flex items-center justify-evenly px-4 lg:px-0">
            {!expenseId && (
              <RecurrenceInput>
                <Button variant="ghost" size="sm">
                  <RefreshCcwDot
                    className={cn(
                      cronExpression && 'text-primary',
                      (!amtStr || !description) && 'invisible',
                      'size-6',
                    )}
                  />
                  <span className="sr-only">Toggle recurring expense options</span>
                </Button>
              </RecurrenceInput>
            )}
            <SponsorUs />
            <div className="flex gap-2">
              <AddBankTransactions bankConnectionEnabled={bankConnectionEnabled}>
                <Button
                  variant="ghost"
                  className="hover:text-foreground/80 items-center justify-between px-2"
                >
                  <Landmark
                    className={cn(transactionId ? 'text-primary' : 'text-white-500', 'h-6 w-6')}
                  />
                </Button>
              </AddBankTransactions>
              <Button
                variant="ghost"
                className={cn('px-2', transactionId ? 'text-red-500' : 'invisible')}
                disabled={!transactionId}
                onClick={clearTransaction}
              >
                <X className="h-6 w-6" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

const SponsorUs = () => {
  const { t } = useTranslation();
  return (
    <div className="flex justify-center">
      <Link href="https://github.com/sponsors/krokosik" target="_blank" className="mx-auto">
        <Button
          variant="outline"
          className="text-md hover:text-foreground/80 justify-between rounded-full border-pink-500"
        >
          <div className="flex items-center gap-4">
            <HeartHandshakeIcon className="h-5 w-5 text-pink-500" />
            {t('expense_details.add_expense_details.sponsor_us')}
          </div>
        </Button>
      </Link>
    </div>
  );
};
