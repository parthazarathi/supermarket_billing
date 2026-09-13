/* Thermal receipt printing - renders an invoice to a hidden iframe sized for
   58mm / 80mm / 100mm paper and calls window.print(). Template is configured
   via settings (receipt_* keys) and previewed on the Settings page.
   All styles are scoped under .rp so previewing never affects the app. */
const ReceiptPrinter = (() => {

  const FONT_FAMILIES = [
    ["'Courier New', monospace", 'Courier New (thermal mono)'],
    ['monospace', 'Monospace'],
    ['Arial, sans-serif', 'Arial'],
    ['Tahoma, sans-serif', 'Tahoma'],
    ['Verdana, sans-serif', 'Verdana'],
    ['Georgia, serif', 'Georgia'],
  ];

  const DEFAULTS = {
    printer_width: '80',        // 58 | 80 | 100 mm
    font_size: '12',            // base px
    font_family: "'Courier New', monospace",
    header: '',                 // extra line(s) under shop name, e.g. address
    footer: 'Thank you! Visit again',
    show_gstin: '1',
    show_customer: '1',
    show_cashier: '1',
    show_mrp: '0',
    show_hsn: '0',
    show_savings: '1',
    show_gst_breakup: '1',
  };

  function config() {
    const s = (typeof state !== 'undefined' && state.settings) || {};
    const cfg = {};
    for (const [k, v] of Object.entries(DEFAULTS)) {
      cfg[k] = s[`receipt_${k}`] !== undefined && s[`receipt_${k}`] !== '' ? s[`receipt_${k}`] : v;
    }
    return cfg;
  }

  // Whole numbers print without decimals; decimals print minimally (60 -> "60",
  // 11.80 -> "11.8", 36.66 -> "36.66")
  const money2 = (n) => {
    const v = Number(n) || 0;
    return Number.isInteger(v)
      ? v.toLocaleString('en-IN', { maximumFractionDigits: 0 })
      : v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  };
  const escH = (v) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

  function fmtDT(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function styles(w, fs, ff) {
    const sub = Math.max(9, fs - 2);
    return `
      .rp, .rp * { margin: 0; padding: 0; box-sizing: border-box; }
      .rp { width: ${w}mm; font-family: ${ff}; font-size: ${fs}px; color: #000; padding: 3mm; background: #fff; }
      .rp .center { text-align: center; }
      .rp .bold { font-weight: 700; }
      .rp .big { font-size: ${Math.round(fs * 1.35)}px; font-weight: 700; }
      .rp .sub { font-size: ${sub}px; }
      .rp .hr { border-top: 1px dashed #000; margin: 4px 0; }
      .rp .rrow { display: flex; justify-content: space-between; gap: 4px; }
      .rp table { width: 100%; border-collapse: collapse; }
      .rp th { border-top: 1px dashed #000; border-bottom: 1px dashed #000; text-align: left; font-size: ${sub}px; padding: 2px 0; }
      .rp td { padding: 2px 0; vertical-align: top; }
      .rp td.c, .rp th.c { text-align: center; }
      .rp td.r, .rp th.r { text-align: right; }
      .rp .tot { font-size: ${Math.round(fs * 1.15)}px; font-weight: 700; }
    `;
  }

  function bodyHtml(invoice, cfg, settings) {
    const s = settings || {};
    const shop = s.shop_name || 'Mart POS';
    const on = (k) => cfg[k] === '1';

    const items = invoice.items || [];
    const showMrp = on('show_mrp');
    const showHsn = on('show_hsn');

    const headCols = ['#', 'Item' + (showHsn ? '/HSN' : ''), 'Qty', 'Rate', 'Amt'];

    const itemRows = items.map((it, i) => {
      const name = escH(it.name) + (showHsn && it.hsn ? `<br><span class="sub">HSN ${escH(it.hsn)}</span>` : '');
      const rate = showMrp && it.mrp && Number(it.mrp) > Number(it.price)
        ? `<span class="sub">${money2(it.mrp)}</span><br>${money2(it.price)}`
        : money2(it.price);
      return `<tr>
        <td class="c">${i + 1}</td>
        <td>${name}</td>
        <td class="c">${money2(it.quantity)}</td>
        <td class="r">${rate}</td>
        <td class="r">${money2(it.line_total)}</td>
      </tr>`;
    }).join('');

    const savings = items.reduce((t, it) => t + Math.max(0, (Number(it.mrp) || Number(it.price)) - Number(it.price)) * (Number(it.quantity) || 0), 0)
      + (Number(invoice.discount) || 0) + items.reduce((t, it) => t + (Number(it.discount) || 0), 0);

    const due = Math.max(0, (Number(invoice.total) || 0) - (Number(invoice.paid) || 0));
    const change = Math.max(0, (Number(invoice.paid) || 0) - (Number(invoice.total) || 0));

    return `
      <div class="center">
        <div class="big">${escH(shop)}</div>
        ${cfg.header ? `<div class="sub">${escH(cfg.header).replace(/\n/g, '<br>')}</div>` : ''}
        ${on('show_gstin') && s.gstin ? `<div class="sub">GSTIN: ${escH(s.gstin)}</div>` : ''}
      </div>
      <div class="hr"></div>
      <div class="rrow"><span>Bill: <b>${escH(invoice.invoice_no)}</b></span><span>${escH(fmtDT(invoice.created_at))}</span></div>
      ${on('show_cashier') && invoice.cashier ? `<div class="rrow"><span>Cashier: ${escH(invoice.cashier)}</span></div>` : ''}
      ${on('show_customer') && invoice.party_name ? `<div class="rrow"><span>Customer: ${escH(invoice.party_name)}${invoice.party_phone ? ' · ' + escH(invoice.party_phone) : ''}</span></div>` : ''}
      <table><thead><tr>${headCols.map((h, i) => `<th class="${i === 0 ? 'c' : i >= 2 ? 'r' : ''}">${h}</th>`).join('')}</tr></thead>
      <tbody>${itemRows}</tbody></table>
      <div class="hr"></div>
      <div class="rrow"><span>Items: ${items.length}</span><span>Qty: ${money2(items.reduce((t, i) => t + (Number(i.quantity) || 0), 0))}</span></div>
      <div class="rrow"><span>Subtotal</span><span>${money2(invoice.subtotal)}</span></div>
      ${Number(invoice.discount) ? `<div class="rrow"><span>Discount</span><span>-${money2(invoice.discount)}</span></div>` : ''}
      ${on('show_gst_breakup') && Number(invoice.tax) ? `
        ${Number(invoice.cgst) ? `<div class="rrow"><span>CGST</span><span>${money2(invoice.cgst)}</span></div>` : ''}
        ${Number(invoice.sgst) ? `<div class="rrow"><span>SGST</span><span>${money2(invoice.sgst)}</span></div>` : ''}
        ${Number(invoice.igst) ? `<div class="rrow"><span>IGST</span><span>${money2(invoice.igst)}</span></div>` : ''}
      ` : ''}
      <div class="hr"></div>
      <div class="rrow tot"><span>TOTAL</span><span>₹ ${money2(invoice.total)}</span></div>
      <div class="rrow"><span>Paid (${escH(invoice.payment_method || 'Cash')})</span><span>₹ ${money2(invoice.paid)}</span></div>
      ${due > 0 ? `<div class="rrow bold"><span>Balance Due</span><span>₹ ${money2(due)}</span></div>` : ''}
      ${change > 0 ? `<div class="rrow"><span>Change</span><span>₹ ${money2(change)}</span></div>` : ''}
      ${on('show_savings') && savings > 0 ? `<div class="center bold" style="margin-top:4px">You saved ₹ ${money2(savings)}</div>` : ''}
      <div class="hr"></div>
      ${cfg.footer ? `<div class="center">${escH(cfg.footer).replace(/\n/g, '<br>')}</div>` : ''}`;
  }

  function fullDoc(invoice, cfg, settings) {
    const w = parseInt(cfg.printer_width, 10) || 80;
    const fs = parseInt(cfg.font_size, 10) || 12;
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { size: ${w}mm auto; margin: 0; }
      body { margin: 0; }
      ${styles(w, fs, cfg.font_family || DEFAULTS.font_family)}
    </style></head><body><div class="rp">${bodyHtml(invoice, cfg, settings)}</div></body></html>`;
  }

  function print(invoice, cfg) {
    const c = cfg || config();
    const s = (typeof state !== 'undefined' && state.settings) || {};
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.appendChild(frame);
    const doc = frame.contentWindow.document;
    doc.open();
    doc.write(fullDoc(invoice, c, s));
    doc.close();
    const doPrint = () => {
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } catch (e) { /* noop */ }
    };
    frame.onload = () => { doPrint(); setTimeout(() => frame.remove(), 60000); };
    setTimeout(doPrint, 400); // fallback when onload doesn't refire
  }

  function preview(container, cfg) {
    const c = cfg || config();
    const s = (typeof state !== 'undefined' && state.settings) || {};
    const w = parseInt(c.printer_width, 10) || 80;
    const fs = parseInt(c.font_size, 10) || 12;
    container.innerHTML = `
      <style>${styles(w, fs, c.font_family || DEFAULTS.font_family)}
        .receipt-preview-wrap { background: #fff; border: 1px solid #ddd; margin: 0 auto;
          box-shadow: 0 2px 8px rgba(0,0,0,.12); width: ${w}mm; overflow: hidden; }
        .receipt-preview-wrap .rp { width: ${w}mm; }
      </style>
      <div class="receipt-preview-wrap"><div class="rp">${bodyHtml(sampleInvoice(), c, s)}</div></div>`;
  }

  function sampleInvoice() {
    const now = new Date().toISOString();
    return {
      invoice_no: 'INV-SAMPLE-0001',
      created_at: now,
      cashier: 'Cashier Name',
      party_name: 'Walk-in Customer',
      party_phone: '',
      subtotal: 160,
      discount: 0,
      tax: 7.8,
      cgst: 3.9,
      sgst: 3.9,
      igst: 0,
      total: 167.8,
      paid: 170,
      payment_method: 'Cash',
      items: [
        { name: 'Amul Milk 1L', hsn: '0401', quantity: 2, price: 60, mrp: 60, discount: 0, line_total: 120 },
        { name: 'Sample Snack Pack', hsn: '1905', quantity: 1, price: 10, mrp: 12, discount: 0, line_total: 11.8 },
        { name: 'Sample Soap Bar', hsn: '3401', quantity: 1, price: 30, mrp: 35, discount: 0, line_total: 36 },
      ]
    };
  }

  return { DEFAULTS, FONT_FAMILIES, config, buildHtml: fullDoc, print, preview, sampleInvoice };
})();

window.ReceiptPrinter = ReceiptPrinter;
