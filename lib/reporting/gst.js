const { q, qOne, r2 } = require('../reportUtils');
const { getSetting } = require('../settings');
const { salesAggregates, purchaseAggregates } = require('./common');

// GST on sales is recorded per invoice (cgst/sgst/igst columns).
// invoice.subtotal is the taxable value after line discounts; invoice.discount
// is the additional bill-level discount.

function salesSummary(range) {
  const s = salesAggregates(range);
  return {
    summary: {
      taxable: r2(s.gross_sales - s.discounts),
      cgst: s.cgst,
      sgst: s.sgst,
      igst: s.igst,
      total_gst: s.tax,
      invoice_value: s.grand_total,
      bills: s.bills
    }
  };
}

function purchaseSummary(range) {
  const p = purchaseAggregates(range);
  const gstType = getSetting('gst_type', 'intra');
  const tax = p.tax;
  const cgst = gstType === 'inter' ? 0 : r2(tax / 2);
  const sgst = gstType === 'inter' ? 0 : r2(tax - cgst);
  const igst = gstType === 'inter' ? tax : 0;
  return {
    summary: {
      taxable: r2(p.subtotal - p.discount),
      cgst,
      sgst,
      igst,
      input_gst: r2(tax),
      invoice_value: p.total,
      invoices: p.invoices
    }
  };
}

// Distribute each invoice's bill discount and actual recorded tax amounts
// across GST rates in proportion to each line's taxable value.
function rateWiseSales(range) {
  const lines = q(`
    SELECT i.id as invoice_id, i.subtotal, i.discount, i.tax, i.cgst, i.sgst, i.igst,
      ii.gst_percent, (ii.quantity * ii.price - ii.discount) as line_taxable
    FROM invoice_items ii JOIN invoices i ON ii.invoice_id = i.id
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
  `, [range.start, range.end]);

  const byInvoice = {};
  lines.forEach(l => {
    byInvoice[l.invoice_id] = byInvoice[l.invoice_id] || { lines: [], subtotal: l.subtotal, discount: l.discount, tax: l.tax, cgst: l.cgst, sgst: l.sgst, igst: l.igst, lineTotal: 0 };
    byInvoice[l.invoice_id].lines.push(l);
    byInvoice[l.invoice_id].lineTotal += parseFloat(l.line_taxable) || 0;
  });

  const byRate = {};
  for (const inv of Object.values(byInvoice)) {
    const lineTotal = inv.lineTotal || 1;
    for (const l of inv.lines) {
      const share = (parseFloat(l.line_taxable) || 0) / lineTotal;
      const rate = parseFloat(l.gst_percent) || 0;
      byRate[rate] = byRate[rate] || { rate, taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0 };
      // taxable share scales with bill discount via the invoice's actual tax base
      const taxableBase = (parseFloat(inv.subtotal) - parseFloat(inv.discount)) || 0;
      byRate[rate].taxable += share * taxableBase;
      byRate[rate].cgst += share * (parseFloat(inv.cgst) || 0);
      byRate[rate].sgst += share * (parseFloat(inv.sgst) || 0);
      byRate[rate].igst += share * (parseFloat(inv.igst) || 0);
      byRate[rate].tax += share * (parseFloat(inv.tax) || 0);
    }
  }

  const rows = Object.values(byRate)
    .sort((a, b) => a.rate - b.rate)
    .map(r => ({
      rate: r.rate,
      taxable: r2(r.taxable),
      cgst: r2(r.cgst),
      sgst: r2(r.sgst),
      igst: r2(r.igst),
      total_tax: r2(r.tax)
    }));
  return { rows };
}

function hsnSales(range) {
  const lines = q(`
    SELECT COALESCE(NULLIF(it.hsn, ''), '-') as hsn, ii.name as item_name,
      ii.gst_percent, ii.quantity, (ii.quantity * ii.price - ii.discount) as line_taxable,
      i.id as invoice_id, i.subtotal as inv_subtotal, i.discount as inv_discount,
      i.cgst as inv_cgst, i.sgst as inv_sgst, i.igst as inv_igst, i.tax as inv_tax
    FROM invoice_items ii
    JOIN invoices i ON ii.invoice_id = i.id
    LEFT JOIN items it ON ii.item_id = it.id
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
  `, [range.start, range.end]);

  // Invoice line totals for share calculation
  const invLineTotals = {};
  lines.forEach(l => {
    invLineTotals[l.invoice_id] = (invLineTotals[l.invoice_id] || 0) + (parseFloat(l.line_taxable) || 0);
  });

  const byHsn = {};
  for (const l of lines) {
    const key = `${l.hsn}|${l.gst_percent}`;
    const share = (parseFloat(l.line_taxable) || 0) / (invLineTotals[l.invoice_id] || 1);
    const taxableBase = (parseFloat(l.inv_subtotal) - parseFloat(l.inv_discount)) || 0;
    byHsn[key] = byHsn[key] || { hsn: l.hsn, rate: parseFloat(l.gst_percent) || 0, qty: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    byHsn[key].qty += parseFloat(l.quantity) || 0;
    byHsn[key].taxable += share * taxableBase;
    byHsn[key].cgst += share * (parseFloat(l.inv_cgst) || 0);
    byHsn[key].sgst += share * (parseFloat(l.inv_sgst) || 0);
    byHsn[key].igst += share * (parseFloat(l.inv_igst) || 0);
  }

  const rows = Object.values(byHsn)
    .sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate)
    .map(r => ({
      hsn: r.hsn,
      rate: r.rate,
      qty: r2(r.qty),
      taxable: r2(r.taxable),
      cgst: r2(r.cgst),
      sgst: r2(r.sgst),
      igst: r2(r.igst),
      total_tax: r2(r.cgst + r.sgst + r.igst)
    }));
  return { rows };
}

// Purchase tax is only stored as a total per purchase; split per gst_type setting.
function hsnPurchases(range) {
  const gstType = getSetting('gst_type', 'intra');
  const rows = q(`
    SELECT COALESCE(NULLIF(it.hsn, ''), '-') as hsn, pi.gst_percent,
      SUM(pi.quantity) as qty, SUM(pi.quantity * pi.price) as taxable,
      SUM(pi.line_total - pi.quantity * pi.price) as tax
    FROM purchase_items pi
    JOIN purchases p ON pi.purchase_id = p.id
    LEFT JOIN items it ON pi.item_id = it.id
    WHERE p.created_at >= ? AND p.created_at <= ?
    GROUP BY hsn, pi.gst_percent ORDER BY hsn
  `, [range.start, range.end]);

  return {
    rows: rows.map(r => {
      const tax = parseFloat(r.tax) || 0;
      const isInter = gstType === 'inter';
      return {
        hsn: r.hsn,
        rate: parseFloat(r.gst_percent) || 0,
        qty: r2(r.qty),
        taxable: r2(r.taxable),
        cgst: isInter ? 0 : r2(tax / 2),
        sgst: isInter ? 0 : r2(tax - r2(tax / 2)),
        igst: isInter ? r2(tax) : 0,
        total_tax: r2(tax)
      };
    })
  };
}

// GST on sales returns + credit notes issued in the range
function returnsSummary(range) {
  const ret = qOne(`
    SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total
    FROM sale_returns WHERE created_at >= ? AND created_at <= ?
  `, [range.start, range.end]);

  const retTax = qOne(`
    SELECT COALESCE(SUM(sri.amount - sri.amount / (1 + COALESCE(ii.gst_percent, 0) / 100.0)), 0) as tax
    FROM sale_return_items sri
    JOIN sale_returns sr ON sri.return_id = sr.id
    LEFT JOIN invoice_items ii ON sri.invoice_item_id = ii.id
    WHERE sr.created_at >= ? AND sr.created_at <= ?
  `, [range.start, range.end]);

  const cn = qOne(`
    SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total, COALESCE(SUM(tax), 0) as tax
    FROM credit_notes WHERE created_at >= ? AND created_at <= ?
  `, [range.start, range.end]);

  const gstType = getSetting('gst_type', 'intra');
  const tax = (parseFloat(retTax.tax) || 0) + (parseFloat(cn.tax) || 0);
  const cgst = gstType === 'inter' ? 0 : r2(tax / 2);
  const sgst = gstType === 'inter' ? 0 : r2(tax - cgst);

  return {
    summary: {
      sales_returns: ret.count || 0,
      sales_return_value: r2(ret.total),
      credit_notes: cn.count || 0,
      credit_note_value: r2(cn.total),
      cgst,
      sgst,
      igst: gstType === 'inter' ? r2(tax) : 0,
      total_gst_reversed: r2(tax)
    }
  };
}

module.exports = {
  salesSummary,
  purchaseSummary,
  rateWiseSales,
  hsnSales,
  hsnPurchases,
  returnsSummary
};
