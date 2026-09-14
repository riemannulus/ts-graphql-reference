-- Paid Order facts and their finance link become permanent audit evidence once
-- checkout commits. Keep their economic basis stable and allow only the one
-- forward state transition used by this PoC.
CREATE OR REPLACE FUNCTION keep_order_flow_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."flowId" IS DISTINCT FROM OLD."flowId"
    OR NEW."buyerId" IS DISTINCT FROM OLD."buyerId"
    OR NEW."commissionTypeId" IS DISTINCT FROM OLD."commissionTypeId"
    OR NEW."slotId" IS DISTINCT FROM OLD."slotId"
    OR NEW."titleSnapshot" IS DISTINCT FROM OLD."titleSnapshot"
    OR NEW."amount" IS DISTINCT FROM OLD."amount"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'Order_basis_immutable: order % economic basis is immutable', OLD."id"
      USING ERRCODE = '23514', CONSTRAINT = 'Order_basis_immutable';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
    OLD."state" = 'REQUESTED' AND NEW."state" = 'PAID'
  ) THEN
    RAISE EXCEPTION 'Order_state_transition: order % has an invalid state transition', OLD."id"
      USING ERRCODE = '23514', CONSTRAINT = 'Order_state_transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION keep_order_payment_evidence_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
    OR NEW."flowId" IS DISTINCT FROM OLD."flowId"
    OR NEW."amount" IS DISTINCT FROM OLD."amount"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."referenceId" IS DISTINCT FROM OLD."referenceId"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'OrderPayment_basis_immutable: payment % economic basis is immutable', OLD."id"
      USING ERRCODE = '23514', CONSTRAINT = 'OrderPayment_basis_immutable';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
    OLD."state" = 'PENDING' AND NEW."state" = 'PAID'
  ) THEN
    RAISE EXCEPTION 'OrderPayment_state_transition: payment % has an invalid state transition', OLD."id"
      USING ERRCODE = '23514', CONSTRAINT = 'OrderPayment_state_transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "OrderPayment_evidence_immutable"
BEFORE UPDATE ON "OrderPayment"
FOR EACH ROW EXECUTE FUNCTION keep_order_payment_evidence_immutable();

CREATE FUNCTION reject_order_financial_link_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'OrderFinancialLink_append_only: payment-to-reservation link % cannot be changed', OLD."orderPaymentId"
    USING ERRCODE = '23514', CONSTRAINT = 'OrderFinancialLink_append_only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "OrderFinancialLink_append_only"
BEFORE UPDATE OR DELETE ON "OrderFinancialLink"
FOR EACH ROW EXECUTE FUNCTION reject_order_financial_link_mutation();
