// Scratch verification for backend fixes. Runs against qa/data-verify/pos.db.
process.env.MARTPOS_DATA_DIR = 'qa/data-verify';
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { initDatabase, execToObject, execToObjects, getDatabase, flushSave } = require('../lib/database');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : extra); }
}
function throwsMsg(name, fn, substr) {
  try { fn(); fail++; console.log('  FAIL (no throw)', name); }
  catch (e) {
    const m = (e && e.message) || String(e);
    ok(name, m.includes(substr), `got: ${m}`);
  }
}

(async () => {
  await initDatabase();
  const items = execToObjects('SELECT * FROM items LIMIT 5');
  const item = items[0];
  console.log('item:', item.code, item.name, 'stock', item.stock);

  const { createPurchaseOrder, convertPurchaseOrderToPurchase } = require('../lib/purchaseOrders');
  const { completePurchase } = require('../lib/purchases');
  const { createEstimate, convertEstimateToInvoice } = require('../lib/estimates');
  const { completeSale, recordInvoicePayment, createSaleReturn, cancelInvoice, deleteInvoice, getInvoice } = require('../lib/invoices');
  const { createPurchaseReturn } = require('../lib/purchaseReturns');
  const { saveParty, getParty, addPartyPayment, calculatePartyOutstanding } = require('../lib/parties');
  const partyReports = require('../lib/reporting/parties');
  const { parseRange } = require('../lib/reportUtils');
  const { saveItem, getItem, deleteItem } = require('../lib/items');
  const { addExpense, deleteExpense, getExpense } = require('../lib/expenses');
  const { createUser, authenticate } = require('../lib/users');
  const { createDeliveryChallan } = require('../lib/deliveryChallans');
  const { createCreditNote } = require('../lib/creditDebitNotes');

  // --- #16: PO with real item must succeed
  const po = createPurchaseOrder([{ code: item.code, item_id: item.id, quantity: 5, price: 25 }], { userId: 1 });
  ok('createPurchaseOrder succeeds', po && po.order_no && po.items[0].name === item.name, JSON.stringify(po && po.items));
  throwsMsg('PO unknown item throws', () => createPurchaseOrder([{ code: 'NOPE-X', quantity: 1, price: 1 }]), 'Unknown item');
  throwsMsg('PO bad qty throws', () => createPurchaseOrder([{ code: item.code, quantity: -2, price: 1 }]), 'Invalid quantity');

  // --- #4: completePurchase validations
  throwsMsg('completePurchase negative qty', () =>
    completePurchase([{ code: item.code, quantity: -3, price: 10, mrp: 50 }]), 'Invalid quantity');
  throwsMsg('completePurchase zero price', () =>
    completePurchase([{ code: item.code, quantity: 1, price: 0, mrp: 50 }]), 'Invalid purchase price');
  throwsMsg('completePurchase overpaid', () =>
    completePurchase([{ code: item.code, quantity: 1, price: 10, mrp: 50 }], { paid: 999999 }), 'Paid amount cannot exceed purchase total');
  throwsMsg('completePurchase NaN paid', () =>
    completePurchase([{ code: item.code, quantity: 1, price: 10, mrp: 50 }], { paid: 'abc' }), 'Invalid paid amount');
  throwsMsg('completePurchase non-supplier party', () =>
    completePurchase([{ code: item.code, quantity: 1, price: 10, mrp: 50 }], { partyId: 1 }), 'supplier');

  // sale_price not overwritten when absent
  const itemBefore = getItem(item.id);
  const pur = completePurchase([{ code: item.code, quantity: 2, price: 10, mrp: 200 }], { userId: 1 });
  const itemAfter = getItem(item.id);
  ok('sale_price preserved when absent', parseFloat(itemAfter.sale_price) === parseFloat(itemBefore.sale_price),
    `${itemBefore.sale_price} -> ${itemAfter.sale_price}`);
  const pur2 = completePurchase([{ code: item.code, quantity: 1, price: 10, mrp: 200, sale_price: 150 }], { userId: 1 });
  ok('sale_price written when explicit', parseFloat(getItem(item.id).sale_price) === 150);

  // --- #9: purchase return refund model
  const sup = saveParty({ name: 'VerifySupplier', type: 'supplier', opening_balance: 0 });
  const supPurchase = completePurchase([{ code: item.code, quantity: 10, price: 10, mrp: 200 }], { partyId: sup.id, paid: 0 });
  const pret = createPurchaseReturn(supPurchase.id, [{ purchase_item_id: supPurchase.items[0].id, quantity: 4 }], 1);
  const dueSup = supPurchase.total - supPurchase.paid;
  ok('purchase return refund_amount', Math.abs(pret.refund_amount - Math.max(0, pret.total - dueSup)) < 0.01,
    `total ${pret.total} refund ${pret.refund_amount} due ${dueSup}`);
  const supRefundRow = execToObject("SELECT * FROM payments WHERE ref_type='purchase_return' AND ref_id=?", [pret.id]);
  ok('purchase_return refund payment row', !supRefundRow || supRefundRow.direction === 'in');
  throwsMsg('purchase return bad qty', () =>
    createPurchaseReturn(supPurchase.id, [{ purchase_item_id: supPurchase.items[0].id, quantity: 0 }]), 'Invalid return quantity');

  // --- #3: numbering never reuses
  const cart1 = { [item.code]: { item_id: item.id, name: item.name, price: parseFloat(item.sale_price), quantity: 1, gst_percent: 18, mrp: parseFloat(item.mrp), stock: 999 } };
  const inv1 = completeSale(cart1, { userId: 1 });
  const inv1no = inv1.invoice_no;
  deleteInvoice(inv1.id, 1);
  const inv2 = completeSale(cart1, { userId: 1 });
  ok('invoice number not reused after delete', inv2.invoice_no !== inv1no, `${inv1no} vs ${inv2.invoice_no}`);

  // --- #5: sale validations
  throwsMsg('sale bad payment method', () => completeSale(cart1, { paymentMethod: 'Cheque' }), 'Invalid payment method');
  throwsMsg('sale negative paid', () => completeSale(cart1, { paid: -5 }), 'Invalid paid amount');
  throwsMsg('sale NaN paid', () => completeSale(cart1, { paid: 'x' }), 'Invalid paid amount');
  const bigQtyCart = { [item.code]: { item_id: item.id, name: item.name, price: parseFloat(item.sale_price), quantity: 999999, gst_percent: 0 } };
  throwsMsg('sale insufficient stock', () => completeSale(bigQtyCart, {}), 'Insufficient stock');
  const badQtyCart = { [item.code]: { item_id: item.id, name: item.name, price: parseFloat(item.sale_price), quantity: -2, gst_percent: 0 } };
  throwsMsg('sale bad qty', () => completeSale(badQtyCart, {}), 'Invalid quantity');

  // --- #6: recordInvoicePayment
  const cust = saveParty({ name: 'VerifyCust', type: 'customer', opening_balance: 0, credit_limit: 0 });
  const invUnpaid = completeSale(cart1, { paid: 0, partyId: cust.id, userId: 1 });
  throwsMsg('overpay due rejected', () => recordInvoicePayment(invUnpaid.id, invUnpaid.total + 50), 'Amount exceeds outstanding due');
  throwsMsg('zero payment rejected', () => recordInvoicePayment(invUnpaid.id, 0), 'Invalid payment amount');
  const afterPay = recordInvoicePayment(invUnpaid.id, Math.round(invUnpaid.total / 2), 'UPI', 1);
  ok('partial payment recorded', afterPay.status === 'partial');
  const ipay = execToObject("SELECT * FROM payments WHERE ref_type='invoice' AND ref_id=?", [invUnpaid.id]);
  ok('invoice payment ref_type set', !!ipay, 'no invoice payment row');

  // --- credit limit
  const custLim = saveParty({ name: 'VerifyCustLimit', type: 'customer', opening_balance: 0, credit_limit: 10 });
  throwsMsg('credit limit exceeded', () => completeSale(cart1, { paid: 0, partyId: custLim.id }), 'Credit limit exceeded');

  // --- #7: sale return accounting
  const invFull = completeSale(cart1, { partyId: cust.id, userId: 1 }); // fully paid
  const line = invFull.items[0];
  const sret = createSaleReturn(invFull.id, [{ invoice_item_id: line.id, quantity: 1 }], 1);
  ok('sale return full refund', Math.abs(sret.refund_amount - sret.total) < 0.01, `total ${sret.total} refund ${sret.refund_amount}`);
  const refundRow = execToObject("SELECT * FROM payments WHERE ref_type='sale_return' AND ref_id=?", [sret.id]);
  ok('sale_return refund payment row', !!refundRow && refundRow.direction === 'out');
  throwsMsg('return on over-return', () => createSaleReturn(invFull.id, [{ invoice_item_id: line.id, quantity: 1 }]), 'more than sold');
  throwsMsg('return bad qty', () => createSaleReturn(invFull.id, [{ invoice_item_id: line.id, quantity: 'x' }]), 'Invalid return quantity');

  // outstanding == ledger for customer
  const cust2 = saveParty({ name: 'VerifyCust2', type: 'customer', opening_balance: 50 });
  const invA = completeSale(cart1, { paid: 0, partyId: cust2.id, userId: 1 });
  const sretA = createSaleReturn(invA.id, [{ invoice_item_id: invA.items[0].id, quantity: 1 }], 1); // all credit, refund 0
  addPartyPayment(cust2.id, 20, 'Cash', 'test receipt', 1);
  const range = parseRange({ from: '2020-01-01', to: '2099-01-01' });
  const partyObj = getParty(cust2.id);
  const led = partyReports.customerLedger(cust2.id, range);
  const closing = led.rows[led.rows.length - 1].balance;
  ok('customer ledger closing == outstanding', Math.abs(closing - partyObj.outstanding) < 0.01,
    `closing ${closing} outstanding ${partyObj.outstanding}`);

  // --- #11: cancelInvoice refund
  const invC = completeSale(cart1, { partyId: cust2.id, userId: 1 });
  cancelInvoice(invC.id, 1);
  const cRef = execToObject("SELECT * FROM payments WHERE ref_type='invoice_refund' AND ref_id=?", [invC.id]);
  ok('cancel refund row', !!cRef && cRef.direction === 'out' && Math.abs(cRef.amount - invC.total) < 0.01);
  const partyObj2 = getParty(cust2.id);
  const led2 = partyReports.customerLedger(cust2.id, range);
  ok('ledger==outstanding after cancel', Math.abs(led2.rows[led2.rows.length - 1].balance - partyObj2.outstanding) < 0.01,
    `${led2.rows[led2.rows.length - 1].balance} vs ${partyObj2.outstanding}`);
  throwsMsg('payment on cancelled', () => recordInvoicePayment(invC.id, 10), 'cancelled');
  throwsMsg('return on cancelled', () => createSaleReturn(invC.id, [{ invoice_item_id: invC.items[0].id, quantity: 1 }]), 'cancelled');

  // --- #2: estimate -> invoice (nested transaction)
  const est = createEstimate({ [item.code]: { item_id: item.id, name: 'HACKED', price: parseFloat(item.sale_price), quantity: 1 } }, { userId: 1 });
  ok('estimate uses DB name', est.items[0].name === item.name, est.items[0].name);
  const conv = convertEstimateToInvoice(est.id, { userId: 1 });
  ok('estimate converted to invoice', !!conv.invoice && !!conv.invoice.invoice_no);

  // --- #16: challan / credit note
  const dc = createDeliveryChallan([{ code: item.code, quantity: 1, price: 10 }], { userId: 1 });
  ok('challan resolves item', dc.items[0].name === item.name);
  const cn = createCreditNote([{ code: item.code, quantity: 1, price: 10 }], { userId: 1 });
  ok('credit note resolves item', cn.items[0].name === item.name);
  throwsMsg('challan unknown item', () => createDeliveryChallan([{ code: 'ZZZ', quantity: 1, price: 1 }]), 'Unknown item');

  // --- #13: items
  throwsMsg('item stock negative', () => saveItem({ code: 'TST1', name: 'T', purchase_price: 10, sale_price: 20, mrp: 25, stock: -1 }), 'negative');
  const zeroItem = saveItem({ code: 'TST-ZERO', name: 'ZeroStock', purchase_price: 10, sale_price: 20, mrp: 25, stock: 0 });
  ok('item stock 0 allowed', !!zeroItem.id);
  throwsMsg('item bad sale price', () => saveItem({ code: 'TST2', name: 'T2', purchase_price: 10, sale_price: 'abc' }), 'Sale price must be greater than 0');
  throwsMsg('item bad gst', () => saveItem({ code: 'TST3', name: 'T3', purchase_price: 10, sale_price: 20, gst_percent: 150 }), 'Invalid GST percent');
  deleteItem(zeroItem.id);
  throwsMsg('delete item with history', () => deleteItem(item.id), 'transaction history');

  // --- #14: parties
  throwsMsg('dup party name', () => saveParty({ name: 'verifycust', type: 'customer' }), 'already exists');
  throwsMsg('negative opening', () => saveParty({ name: 'X1', type: 'customer', opening_balance: -5 }), 'Invalid opening balance');
  throwsMsg('payment bad method', () => addPartyPayment(cust.id, 10, 'Cheque'), 'Invalid payment method');
  throwsMsg('payment bad amount', () => addPartyPayment(cust.id, 'x'), 'Invalid payment amount');

  // --- #15: users
  throwsMsg('empty username', () => createUser('  ', 'pass123', 'cashier'), 'Username is required');
  throwsMsg('short password', () => createUser('u1', 'ab', 'cashier'), 'at least 4');
  throwsMsg('dup username', () => createUser('admin', 'pass123', 'cashier'), 'Username already exists');
  ok('authenticate non-string safe', authenticate({ u: 1 }, null) === null);

  // --- #12: expenses
  throwsMsg('expense bad amount', () => addExpense('x', 'abc'), 'greater than 0');
  const exp = addExpense('test', 50, 'n', 1);
  ok('expense created', !!exp.id);
  deleteExpense(exp.id);
  ok('expense deleted', !getExpense(exp.id));

  // --- #10: supplier ledger reconciliation
  const supLed = partyReports.supplierLedger(sup.id, range);
  const supObj = getParty(sup.id);
  ok('supplier ledger closing == outstanding', Math.abs(supLed.rows[supLed.rows.length - 1].balance - supObj.outstanding) < 0.01,
    `${supLed.rows[supLed.rows.length - 1].balance} vs ${supObj.outstanding}`);

  flushSave();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
