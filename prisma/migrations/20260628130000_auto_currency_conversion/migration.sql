-- CreateTable
CREATE TABLE "public"."ExpenseAutoCurrencyConversion" (
    "id" SERIAL NOT NULL,
    "originalExpenseId" UUID NOT NULL,
    "sourceOffsetExpenseId" UUID NOT NULL,
    "targetExpenseId" UUID NOT NULL,
    "fromCurrency" TEXT NOT NULL,
    "toCurrency" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "rateDate" TIMESTAMP(3) NOT NULL,
    "rateOverridden" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT,
    "convertedAmount" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpenseAutoCurrencyConversion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseAutoCurrencyConversion_originalExpenseId_key" ON "public"."ExpenseAutoCurrencyConversion"("originalExpenseId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseAutoCurrencyConversion_sourceOffsetExpenseId_key" ON "public"."ExpenseAutoCurrencyConversion"("sourceOffsetExpenseId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseAutoCurrencyConversion_targetExpenseId_key" ON "public"."ExpenseAutoCurrencyConversion"("targetExpenseId");

-- AddForeignKey
ALTER TABLE "public"."ExpenseAutoCurrencyConversion" ADD CONSTRAINT "ExpenseAutoCurrencyConversion_originalExpenseId_fkey" FOREIGN KEY ("originalExpenseId") REFERENCES "public"."Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExpenseAutoCurrencyConversion" ADD CONSTRAINT "ExpenseAutoCurrencyConversion_sourceOffsetExpenseId_fkey" FOREIGN KEY ("sourceOffsetExpenseId") REFERENCES "public"."Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExpenseAutoCurrencyConversion" ADD CONSTRAINT "ExpenseAutoCurrencyConversion_targetExpenseId_fkey" FOREIGN KEY ("targetExpenseId") REFERENCES "public"."Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;
