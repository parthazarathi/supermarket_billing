/* Reports module - tabbed report browser for Mart POS.
   Loaded after script.js; shares its globals (state, api, esc, setStatus, renderView, can). */
const ReportsModule = (() => {

  // ---------- formatters ----------
  const fmtMoney = (n) => `₹ ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtNum = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const pad2 = (n) => String(n).padStart(2, '0');
  const localDateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const fmtDate = (iso) => {
    if (!iso) return '';
    const str = String(iso);
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str.split('-').reverse().join('-');
    const d = new Date(str);
    if (isNaN(d)) return str.slice(0, 10).split('-').reverse().join('-');
    return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()}`;
  };
  const fmtTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  const fmtDateTime = (iso) => (iso ? `${fmtDate(iso)} ${fmtTime(iso)}` : '');

  function cellValue(row, col) {
    const v = row[col.k];
    if (v === null || v === undefined) return '';
    switch (col.t) {
      case 'money': return fmtMoney(v);
      case 'num': return fmtNum(v);
      case 'qty': return fmtNum(v);
      case 'pct': return `${fmtNum(v)}%`;
      case 'date': return fmtDate(v);
      case 'datetime': return fmtDateTime(v);
      case 'time': return fmtTime(v);
      default: return v;
    }
  }

  // ---------- date presets ----------
  function presetRange(preset, from, to) {
    const today = new Date();
    const day = (offset) => { const d = new Date(today); d.setDate(d.getDate() + offset); return d; };
    const mondayOf = (d) => { const x = new Date(d); const wd = (x.getDay() + 6) % 7; x.setDate(x.getDate() - wd); return x; };
    switch (preset) {
      case 'yesterday': { const d = day(-1); return { from: localDateStr(d), to: localDateStr(d) }; }
      case 'this_week': { const m = mondayOf(today); return { from: localDateStr(m), to: localDateStr(today) }; }
      case 'last_week': { const m = mondayOf(today); m.setDate(m.getDate() - 7); const s = new Date(m); s.setDate(s.getDate() + 6); return { from: localDateStr(m), to: localDateStr(s) }; }
      case 'this_month': return { from: `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-01`, to: localDateStr(today) };
      case 'last_month': {
        const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        const last = new Date(today.getFullYear(), today.getMonth(), 0);
        return { from: localDateStr(first), to: localDateStr(last) };
      }
      case 'this_year': return { from: `${today.getFullYear()}-01-01`, to: localDateStr(today) };
      case 'custom': return { from, to };
      case 'today':
      default: { const t = localDateStr(today); return { from: t, to: t }; }
    }
  }

  // ---------- report registry ----------
  // column types: text | money | num | qty | pct | date | datetime
  const C = (k, l, t = 'text', total = false) => ({ k, l, t, total });
  const M = (k, l) => C(k, l, 'money', true);

  const CATEGORIES = [
    { id: 'overview', label: 'Overview' },
    { id: 'sales', label: 'Sales' },
    { id: 'inventory', label: 'Inventory' },
    { id: 'purchases', label: 'Purchases' },
    { id: 'profit-loss', label: 'Profit & Loss' },
    { id: 'payments', label: 'Payments' },
    { id: 'customers', label: 'Customers' },
    { id: 'suppliers', label: 'Suppliers' },
    { id: 'returns', label: 'Returns & Adj.' },
    { id: 'gst', label: 'GST / Tax' },
    { id: 'cashiers', label: 'Cashier / Staff' },
    { id: 'audit', label: 'Audit' },
  ];

  const REPORTS = {
    overview: { title: 'Business Overview', cat: 'overview', custom: 'overview', endpoint: '/api/reports/overview' },

    // ---- Sales ----
    'sales/summary': {
      title: 'Sales Summary', cat: 'sales', endpoint: '/api/reports/sales/summary',
      cards: [
        { k: 'gross_sales', l: 'Gross Sales' }, { k: 'sales_returns', l: 'Returns' },
        { k: 'discounts', l: 'Discounts' }, { k: 'net_sales', l: 'Net Sales', cls: 'green' },
        { k: 'tax', l: 'Tax Collected' }, { k: 'grand_total', l: 'Invoice Value' },
        { k: 'bills', l: 'Bills', t: 'num' }, { k: 'items_sold', l: 'Items Sold', t: 'qty' },
        { k: 'avg_bill', l: 'Avg Bill' }, { k: 'gross_profit', l: 'Gross Profit', cls: 'blue' },
      ]
    },
    'sales/day-wise': {
      title: 'Day-wise Sales', cat: 'sales', endpoint: '/api/reports/sales/day-wise', chart: 'net_sales',
      columns: [
        C('day', 'Date', 'date'), C('bills', 'Bills', 'num', true), C('items', 'Items Sold', 'qty', true),
        M('gross', 'Gross Sales'), M('discount', 'Discount'), M('returns', 'Returns'),
        M('net_sales', 'Net Sales'), M('profit', 'Profit'),
      ]
    },
    'sales/bill-wise': {
      title: 'Bill-wise Sales', cat: 'sales', endpoint: '/api/reports/sales/bill-wise', server: true, search: 'Invoice / customer / cashier',
      columns: [
        C('invoice_no', 'Invoice'), C('created_at', 'Date', 'date'), C('created_at', 'Time', 'time'),
        C('party_name', 'Customer'), C('cashier', 'Cashier'), C('payment_method', 'Payment'),
        M('subtotal', 'Subtotal'), M('discount', 'Discount'), M('tax', 'Tax'),
        M('total', 'Grand Total'), M('paid', 'Paid'), M('due', 'Balance'),
        { k: 'status', l: 'Status', t: 'status' },
      ]
    },
    'sales/item-wise': {
      title: 'Item-wise Sales', cat: 'sales', endpoint: '/api/reports/sales/item-wise',
      columns: [
        C('item', 'Item'), C('code', 'SKU / Barcode'), C('category', 'Category'),
        C('qty', 'Qty Sold', 'qty', true), M('sales', 'Sales Value'), M('cost', 'Purchase Cost'),
        M('profit', 'Profit'), C('margin', 'Margin %', 'pct'),
      ]
    },
    'sales/category-wise': {
      title: 'Category-wise Sales', cat: 'sales', endpoint: '/api/reports/sales/category-wise',
      columns: [
        C('category', 'Category'), C('qty', 'Qty Sold', 'qty', true), M('sales', 'Sales'),
        M('cost', 'Cost'), M('profit', 'Profit'), C('margin', 'Margin %', 'pct'),
      ]
    },
    'sales/customer-wise': {
      title: 'Customer-wise Sales', cat: 'sales', endpoint: '/api/reports/sales/customer-wise',
      columns: [
        C('customer', 'Customer'), C('bills', 'Bills', 'num', true), C('items', 'Items', 'qty', true),
        M('sales', 'Sales'), M('returns', 'Returns'), M('net_sales', 'Net Sales'),
        M('paid', 'Paid'), M('outstanding', 'Outstanding'),
      ]
    },
    'sales/cashier-wise': {
      title: 'Cashier-wise Sales', cat: 'sales', endpoint: '/api/reports/sales/cashier-wise',
      columns: [
        C('cashier', 'Cashier'), C('bills', 'Bills', 'num', true), C('items', 'Items Sold', 'qty', true),
        M('sales', 'Sales'), M('discount', 'Discount'), M('returns', 'Returns'), M('net_sales', 'Net Sales'),
      ]
    },
    'sales/payment-wise': {
      title: 'Payment Mode-wise Sales', cat: 'sales', endpoint: '/api/reports/sales/payment-wise',
      columns: [C('method', 'Payment Mode'), C('bills', 'Bills', 'num', true), M('amount', 'Amount'), C('percent', '% of Total', 'pct')]
    },
    'sales/hourly': {
      title: 'Hourly Sales', cat: 'sales', endpoint: '/api/reports/sales/hourly',
      columns: [C('hour', 'Hour'), C('bills', 'Bills', 'num', true), M('sales', 'Sales'), M('avg_bill', 'Avg Bill')]
    },
    'sales/discounts': {
      title: 'Discount Report', cat: 'sales', endpoint: '/api/reports/sales/discounts', server: true,
      columns: [
        C('invoice_no', 'Invoice'), C('created_at', 'Date', 'date'), C('cashier', 'Cashier'),
        C('customer', 'Customer'), M('subtotal', 'Subtotal'), M('discount', 'Discount'),
        C('discount_pct', 'Discount %', 'pct'), M('total', 'Final Amount'),
      ]
    },
    'sales/cancelled': {
      title: 'Cancelled / Void Bills', cat: 'sales', endpoint: '/api/reports/sales/cancelled', server: true,
      columns: [
        C('invoice_no', 'Invoice'), C('created_at', 'Date', 'date'), C('cashier', 'Cashier'),
        C('customer', 'Customer'), M('total', 'Original Amount'), C('cancel_reason', 'Reason'),
        C('cancelled_by', 'Cancelled By'), C('cancelled_at', 'Cancelled At', 'datetime'),
      ]
    },
    'sales/returns': {
      title: 'Sales Return Report', cat: 'sales', endpoint: '/api/reports/sales/returns', server: true,
      columns: [
        C('return_no', 'Return No'), C('invoice_no', 'Original Invoice'), C('created_at', 'Date', 'date'),
        C('customer', 'Customer'), C('item', 'Item'), C('quantity', 'Qty', 'qty', true),
        M('amount', 'Refund Amount'), C('reason', 'Reason'), C('processed_by', 'Processed By'),
      ]
    },

    // ---- Inventory ----
    'inventory/current-stock': {
      title: 'Current Stock', cat: 'inventory', endpoint: '/api/reports/inventory/current-stock', noDates: true, search: 'Item name / code', clientSearch: true,
      filters: [{ param: 'category', label: 'Category', source: 'categories' }],
      cards: [
        { k: 'items', l: 'Items', t: 'num' }, { k: 'qty', l: 'Total Quantity', t: 'qty' },
        { k: 'cost_value', l: 'Stock Value (Cost)' }, { k: 'sale_value', l: 'Value (Selling)' },
      ],
      columns: [
        C('name', 'Item'), C('code', 'Barcode'), C('category', 'Category'), M('purchase_price', 'Purchase Price'),
        M('sale_price', 'Selling Price'), C('stock', 'Qty', 'qty', true), M('stock_value', 'Stock Value'),
        C('low_stock', 'Min Level', 'qty'), { k: 'status', l: 'Status', t: 'stockStatus' },
      ]
    },
    'inventory/low-stock': {
      title: 'Low Stock', cat: 'inventory', endpoint: '/api/reports/inventory/low-stock', noDates: true,
      columns: [
        C('name', 'Item'), C('code', 'Barcode'), C('category', 'Category'), C('stock', 'Qty', 'qty', true),
        C('low_stock', 'Min Level', 'qty', true), M('stock_value', 'Stock Value'),
      ]
    },
    'inventory/out-of-stock': {
      title: 'Out of Stock', cat: 'inventory', endpoint: '/api/reports/inventory/out-of-stock', noDates: true,
      columns: [C('name', 'Item'), C('code', 'Barcode'), C('category', 'Category'), C('stock', 'Qty', 'qty'), C('low_stock', 'Min Level', 'qty')]
    },
    'inventory/valuation': {
      title: 'Stock Valuation', cat: 'inventory', endpoint: '/api/reports/inventory/valuation', noDates: true,
      cards: [
        { k: 'items', l: 'Items', t: 'num' }, { k: 'qty', l: 'Total Quantity', t: 'qty' },
        { k: 'cost_value', l: 'Cost Value' }, { k: 'sale_value', l: 'Selling Value' },
        { k: 'potential_profit', l: 'Potential Profit', cls: 'green' },
      ],
      columns: [
        C('name', 'Item'), C('stock', 'Qty', 'qty', true), M('purchase_price', 'Cost Price'),
        M('sale_price', 'Selling Price'), M('cost_value', 'Cost Value'), M('sale_value', 'Selling Value'),
        M('profit', 'Potential Profit'),
      ]
    },
    'inventory/ledger': {
      title: 'Stock Ledger', cat: 'inventory', endpoint: '/api/reports/inventory/ledger',
      picker: { param: 'item_id', source: 'items', label: 'Item' },
      columns: [
        C('date', 'Date', 'datetime'), C('type', 'Transaction'), C('ref', 'Reference'),
        C('opening', 'Opening', 'qty'), C('stock_in', 'Stock In', 'qty', true),
        C('stock_out', 'Stock Out', 'qty', true), C('closing', 'Closing', 'qty'), C('note', 'Note'),
      ]
    },
    'inventory/movement': {
      title: 'Stock Movement', cat: 'inventory', endpoint: '/api/reports/inventory/movement',
      columns: [
        C('item', 'Item'), C('opening', 'Opening', 'qty'), C('purchased', 'Purchased', 'qty', true),
        C('sales_return', 'Sales Return', 'qty', true), C('sold', 'Sold', 'qty', true),
        C('purchase_return', 'Purchase Return', 'qty', true), C('adj_in', 'Adj In', 'qty', true),
        C('adj_out', 'Adj Out', 'qty', true), C('closing', 'Closing', 'qty'),
      ]
    },
    'inventory/fast-moving': {
      title: 'Fast Moving Items', cat: 'inventory', endpoint: '/api/reports/inventory/fast-moving',
      columns: [C('rank', 'Rank'), C('name', 'Item'), C('qty', 'Qty Sold', 'qty', true), M('sales', 'Sales'), C('stock', 'Current Stock', 'qty')]
    },
    'inventory/slow-moving': {
      title: 'Slow Moving Items', cat: 'inventory', endpoint: '/api/reports/inventory/slow-moving',
      columns: [C('rank', 'Rank'), C('name', 'Item'), C('qty', 'Qty Sold', 'qty', true), M('sales', 'Sales'), C('stock', 'Current Stock', 'qty')]
    },
    'inventory/dead-stock': {
      title: 'Dead Stock', cat: 'inventory', endpoint: '/api/reports/inventory/dead-stock', noDates: true,
      filters: [{ param: 'days', label: 'No sales in', options: [[30, '30 days'], [60, '60 days'], [90, '90 days'], [180, '180 days']] }],
      columns: [
        C('item', 'Item'), C('code', 'Barcode'), C('category', 'Category'), C('stock', 'Stock', 'qty', true),
        M('stock_value', 'Stock Value'), C('last_sale', 'Last Sale', 'datetime'), C('days_since_sale', 'Days Idle', 'num'),
      ]
    },
    'inventory/adjustments': {
      title: 'Stock Adjustments / Damage / Wastage', cat: 'inventory', endpoint: '/api/reports/inventory/adjustments',
      filters: [{ param: 'adj_type', label: 'Type', options: [['', 'All'], ['adjustment', 'Adjustment'], ['damage', 'Damage'], ['wastage', 'Wastage']] }],
      columns: [
        C('date', 'Date', 'datetime'), C('item', 'Item'), C('type', 'Type'), C('old_qty', 'Old Qty', 'qty'),
        C('change', 'Change', 'qty', true), C('new_qty', 'New Qty', 'qty'), M('cost_value', 'Cost Value'),
        C('reason', 'Reason'), C('user', 'User'),
      ]
    },

    // ---- Purchases ----
    'purchases/summary': {
      title: 'Purchase Summary', cat: 'purchases', endpoint: '/api/reports/purchases/summary',
      cards: [
        { k: 'total', l: 'Total Purchase' }, { k: 'returns', l: 'Purchase Returns' },
        { k: 'net_purchase', l: 'Net Purchase', cls: 'green' }, { k: 'tax', l: 'Tax Paid' },
        { k: 'invoices', l: 'Invoices', t: 'num' }, { k: 'paid', l: 'Amount Paid' },
        { k: 'outstanding', l: 'Outstanding', cls: 'blue' },
      ]
    },
    'purchases/supplier-wise': {
      title: 'Supplier-wise Purchase', cat: 'purchases', endpoint: '/api/reports/purchases/supplier-wise',
      columns: [
        C('supplier', 'Supplier'), C('invoices', 'Invoices', 'num', true), M('amount', 'Purchase Amount'),
        M('returns', 'Returns'), M('paid', 'Payments'), M('outstanding', 'Outstanding'),
      ]
    },
    'purchases/item-wise': {
      title: 'Item-wise Purchase', cat: 'purchases', endpoint: '/api/reports/purchases/item-wise',
      columns: [
        C('item', 'Item'), C('code', 'Code'), C('qty', 'Qty Purchased', 'qty', true),
        M('amount', 'Purchase Amount'), M('avg_cost', 'Avg Cost'), M('last_price', 'Last Price'),
      ]
    },
    'purchases/invoices': {
      title: 'Purchase Invoices', cat: 'purchases', endpoint: '/api/reports/purchases/invoices', server: true, search: 'Purchase no / supplier',
      columns: [
        C('purchase_no', 'Invoice'), C('created_at', 'Date', 'date'), C('supplier', 'Supplier'),
        M('subtotal', 'Subtotal'), M('discount', 'Discount'), M('tax', 'Tax'), M('total', 'Grand Total'),
        M('paid', 'Paid'), M('balance', 'Balance'), { k: 'status', l: 'Status', t: 'status' },
      ]
    },
    'purchases/returns': {
      title: 'Purchase Returns', cat: 'purchases', endpoint: '/api/reports/purchases/returns', server: true,
      columns: [
        C('return_no', 'Return No'), C('purchase_no', 'Purchase'), C('created_at', 'Date', 'date'),
        C('supplier', 'Supplier'), C('item', 'Item'), C('quantity', 'Qty', 'qty', true),
        M('amount', 'Amount'), C('reason', 'Reason'), C('processed_by', 'Processed By'),
      ]
    },
    'purchases/payments': {
      title: 'Supplier Payments', cat: 'purchases', endpoint: '/api/reports/purchases/payments', server: true,
      columns: [
        C('created_at', 'Date', 'date'), C('supplier', 'Supplier'), C('method', 'Method'),
        M('amount', 'Amount'), C('note', 'Note'), C('entered_by', 'Entered By'),
      ]
    },
    'purchases/pending': {
      title: 'Pending Supplier Payments', cat: 'purchases', endpoint: '/api/reports/purchases/pending', noDates: true,
      columns: [
        C('supplier', 'Supplier'), C('purchase_no', 'Invoice'), C('created_at', 'Invoice Date', 'date'),
        M('total', 'Total'), M('paid', 'Paid'), M('balance', 'Balance'), C('age', 'Due Age (days)', 'num'),
      ]
    },
    'purchases/price-history': {
      title: 'Purchase Price History', cat: 'purchases', endpoint: '/api/reports/purchases/price-history', noDates: true,
      picker: { param: 'item_id', source: 'items', label: 'Item' },
      columns: [
        C('date', 'Date', 'date'), C('supplier', 'Supplier'), C('purchase_no', 'Invoice'),
        C('qty', 'Qty', 'qty'), M('price', 'Unit Price'), M('prev_price', 'Previous Price'), M('difference', 'Difference'),
      ]
    },

    // ---- Profit & Loss ----
    'profit-loss/summary': {
      title: 'Profit & Loss Summary', cat: 'profit-loss', endpoint: '/api/reports/profit-loss/summary',
      cards: [
        { k: 'gross_sales', l: 'Gross Sales' }, { k: 'sales_returns', l: 'Sales Returns' },
        { k: 'net_sales', l: 'Net Sales' }, { k: 'cogs', l: 'Cost of Goods Sold' },
        { k: 'gross_profit', l: 'Gross Profit', cls: 'green' }, { k: 'expenses', l: 'Expenses' },
        { k: 'net_profit', l: 'Net Profit', cls: 'blue' }, { k: 'gross_margin', l: 'Gross Margin', t: 'pct' },
        { k: 'net_margin', l: 'Net Margin', t: 'pct' },
      ]
    },
    'profit-loss/day-wise': {
      title: 'Day-wise Profit', cat: 'profit-loss', endpoint: '/api/reports/profit-loss/day-wise',
      columns: [
        C('day', 'Date', 'date'), M('sales', 'Sales'), M('cogs', 'COGS'), M('gross_profit', 'Gross Profit'),
        M('expenses', 'Expenses'), M('net_profit', 'Net Profit'),
      ]
    },
    'profit-loss/item-wise': {
      title: 'Item-wise Profit', cat: 'profit-loss', endpoint: '/api/reports/profit-loss/item-wise',
      columns: [
        C('item', 'Item'), C('qty', 'Qty Sold', 'qty', true), M('sales', 'Sales'), M('cost', 'Cost'),
        M('profit', 'Profit'), C('margin', 'Margin %', 'pct'),
      ]
    },
    'profit-loss/category-wise': {
      title: 'Category-wise Profit', cat: 'profit-loss', endpoint: '/api/reports/profit-loss/category-wise',
      columns: [
        C('category', 'Category'), C('qty', 'Qty', 'qty', true), M('sales', 'Sales'),
        M('cost', 'Cost'), M('profit', 'Profit'), C('margin', 'Margin %', 'pct'),
      ]
    },
    'profit-loss/expenses': {
      title: 'Expense Report', cat: 'profit-loss', endpoint: '/api/reports/profit-loss/expenses', server: true, search: 'Category / note',
      cards: [{ k: 'total', l: 'Total Expenses' }],
      columns: [
        C('created_at', 'Date', 'date'), C('category', 'Category'), C('description', 'Description'),
        M('amount', 'Amount'), C('payment_mode', 'Payment Mode'), C('entered_by', 'Entered By'),
      ]
    },
    'profit-loss/expense-categories': {
      title: 'Expense by Category', cat: 'profit-loss', endpoint: '/api/reports/profit-loss/expense-categories',
      columns: [C('category', 'Category'), C('transactions', 'Transactions', 'num', true), M('amount', 'Amount'), C('percent', '% of Total', 'pct')]
    },
    'profit-loss/income-expense': {
      title: 'Income vs Expense', cat: 'profit-loss', endpoint: '/api/reports/profit-loss/income-expense',
      cards: [{ k: 'income', l: 'Total Income', cls: 'green' }, { k: 'expenses', l: 'Total Expenses' }, { k: 'net', l: 'Net', cls: 'blue' }],
      columns: [C('day', 'Date', 'date'), M('income', 'Income'), M('expenses', 'Expenses'), M('net', 'Net')]
    },

    // ---- Payments ----
    'payments/summary': {
      title: 'Payment Collection Summary', cat: 'payments', endpoint: '/api/reports/payments/summary',
      cards: [{ k: 'collected', l: 'Total Collected', cls: 'green' }, { k: 'credit_sales', l: 'Credit (Unpaid)' }],
      columns: [C('method', 'Payment Mode'), M('amount', 'Amount'), C('percent', '% of Total', 'pct')]
    },
    'payments/daily': {
      title: 'Daily Payment Collection', cat: 'payments', endpoint: '/api/reports/payments/daily', dynamicMethods: true,
      columns: [C('day', 'Date', 'date')]
    },
    'payments/credit-sales': {
      title: 'Credit Sales / Customer Due', cat: 'payments', endpoint: '/api/reports/payments/credit-sales', server: true,
      columns: [
        C('customer', 'Customer'), C('phone', 'Phone'), C('invoice_no', 'Invoice'),
        C('created_at', 'Invoice Date', 'date'), M('total', 'Invoice Total'), M('paid', 'Paid'),
        M('balance', 'Balance'), C('age', 'Age (days)', 'num'),
      ]
    },
    'payments/collections': {
      title: 'Customer Payment Collection', cat: 'payments', endpoint: '/api/reports/payments/collections', server: true,
      columns: [
        C('created_at', 'Date', 'datetime'), C('customer', 'Customer'), C('reference', 'Reference'),
        C('method', 'Mode'), M('amount', 'Amount'), C('collected_by', 'Collected By'),
      ]
    },
    'payments/day-closing': {
      title: 'Cash Register / Day Closing', cat: 'payments', endpoint: '/api/reports/payments/day-closing', sessionBox: true,
      filters: [{ param: 'user_id', label: 'Cashier', source: 'users' }],
      columns: [
        C('user', 'Cashier'), C('opened_at', 'Opened', 'datetime'), C('closed_at', 'Closed', 'datetime'),
        { k: 'status', l: 'Status', t: 'status' },
        M('opening_cash', 'Opening'), M('cash_sales', 'Cash Sales'), M('cash_collections', 'Collections'),
        M('cash_purchase_payments', 'Purchase Paid'), M('cash_expenses', 'Expenses'), M('cash_refunds', 'Refunds'),
        M('expected_cash', 'Expected'), M('actual_cash', 'Actual'), M('difference', 'Difference'),
      ]
    },

    // ---- Customers ----
    'customers/summary': {
      title: 'Customer Sales Summary', cat: 'customers', endpoint: '/api/reports/customers/summary',
      columns: [
        C('customer', 'Customer'), C('phone', 'Phone'), C('bills', 'Bills', 'num', true),
        M('sales', 'Total Sales'), M('paid', 'Paid'), M('outstanding', 'Outstanding'),
      ]
    },
    'customers/ledger': {
      title: 'Customer Ledger', cat: 'customers', endpoint: '/api/reports/customers/ledger',
      picker: { param: 'party_id', source: 'customers', label: 'Customer' },
      columns: [
        C('date', 'Date', 'datetime'), C('type', 'Type'), C('ref', 'Reference'),
        M('debit', 'Debit'), M('credit', 'Credit'), M('balance', 'Balance'),
      ]
    },
    'customers/outstanding': {
      title: 'Customer Outstanding', cat: 'customers', endpoint: '/api/reports/customers/outstanding', noDates: true,
      cards: [{ k: 'total_outstanding', l: 'Total Outstanding', cls: 'blue' }],
      columns: [C('customer', 'Customer'), C('phone', 'Phone'), M('credit_limit', 'Credit Limit'), M('outstanding', 'Outstanding')]
    },
    'customers/history': {
      title: 'Customer Purchase History', cat: 'customers', endpoint: '/api/reports/customers/history', server: true,
      picker: { param: 'party_id', source: 'customers', label: 'Customer' },
      columns: [
        C('invoice_no', 'Invoice'), C('created_at', 'Date', 'date'), C('items', 'Items', 'qty', true),
        M('total', 'Total'), M('paid', 'Paid'), C('payment_method', 'Payment'), { k: 'status', l: 'Status', t: 'status' },
      ]
    },
    'customers/top': {
      title: 'Top Customers', cat: 'customers', endpoint: '/api/reports/customers/top',
      columns: [C('rank', 'Rank'), C('customer', 'Customer'), C('phone', 'Phone'), C('bills', 'Bills', 'num', true), M('sales', 'Total Sales'), M('avg_bill', 'Avg Bill')]
    },

    // ---- Suppliers ----
    'suppliers/summary': {
      title: 'Supplier Purchase Summary', cat: 'suppliers', endpoint: '/api/reports/suppliers/summary',
      columns: [
        C('supplier', 'Supplier'), C('phone', 'Phone'), C('invoices', 'Invoices', 'num', true),
        M('purchases', 'Purchases'), M('paid', 'Paid'), M('outstanding', 'Outstanding'),
      ]
    },
    'suppliers/ledger': {
      title: 'Supplier Ledger', cat: 'suppliers', endpoint: '/api/reports/suppliers/ledger',
      picker: { param: 'party_id', source: 'suppliers', label: 'Supplier' },
      columns: [
        C('date', 'Date', 'datetime'), C('type', 'Type'), C('ref', 'Reference'),
        M('debit', 'Debit'), M('credit', 'Credit'), M('balance', 'Balance'),
      ]
    },
    'suppliers/outstanding': {
      title: 'Supplier Outstanding', cat: 'suppliers', endpoint: '/api/reports/suppliers/outstanding', noDates: true,
      cards: [{ k: 'total_outstanding', l: 'Total Payable', cls: 'blue' }],
      columns: [C('supplier', 'Supplier'), C('phone', 'Phone'), M('outstanding', 'Outstanding')]
    },
    'suppliers/payments': {
      title: 'Supplier Payment History', cat: 'suppliers', endpoint: '/api/reports/suppliers/payments', server: true,
      columns: [
        C('created_at', 'Date', 'datetime'), C('supplier', 'Supplier'), C('method', 'Method'),
        M('amount', 'Amount'), C('note', 'Note'), C('entered_by', 'Entered By'),
      ]
    },
    'suppliers/top': {
      title: 'Top Suppliers', cat: 'suppliers', endpoint: '/api/reports/suppliers/top',
      columns: [C('rank', 'Rank'), C('supplier', 'Supplier'), C('invoices', 'Invoices', 'num', true), M('amount', 'Purchase Amount')]
    },

    // ---- Returns & Adjustments ----
    'returns/all': {
      title: 'Returns & Adjustments', cat: 'returns', endpoint: '/api/reports/returns/all',
      filters: [
        { param: 'type', label: 'Type', options: [['', 'All'], ['sale_return', 'Sales Return'], ['purchase_return', 'Purchase Return'], ['cancelled', 'Cancelled Bill'], ['adjustment', 'Stock Adjustment'], ['damage', 'Damage'], ['wastage', 'Wastage']] },
        { param: 'user_id', label: 'User', source: 'users' },
      ],
      columns: [
        C('created_at', 'Date', 'datetime'), C('type', 'Type'), C('ref', 'Reference'),
        C('doc', 'Document / Item'), C('party', 'Party'), M('amount', 'Amount'), C('reason', 'Reason'), C('user', 'User'),
      ]
    },

    // ---- GST ----
    'gst/sales': {
      title: 'GST Sales Summary', cat: 'gst', endpoint: '/api/reports/gst/sales',
      cards: [
        { k: 'taxable', l: 'Taxable Sales' }, { k: 'cgst', l: 'CGST' }, { k: 'sgst', l: 'SGST' },
        { k: 'igst', l: 'IGST' }, { k: 'total_gst', l: 'Total GST' }, { k: 'invoice_value', l: 'Invoice Value', cls: 'green' },
      ]
    },
    'gst/purchases': {
      title: 'GST Purchase Summary', cat: 'gst', endpoint: '/api/reports/gst/purchases',
      cards: [
        { k: 'taxable', l: 'Taxable Purchase' }, { k: 'cgst', l: 'CGST' }, { k: 'sgst', l: 'SGST' },
        { k: 'igst', l: 'IGST' }, { k: 'input_gst', l: 'Input GST' }, { k: 'invoice_value', l: 'Invoice Value', cls: 'green' },
      ]
    },
    'gst/rate-wise': {
      title: 'GST Rate-wise Sales', cat: 'gst', endpoint: '/api/reports/gst/rate-wise',
      columns: [
        C('rate', 'GST Rate', 'pct'), M('taxable', 'Taxable Value'), M('cgst', 'CGST'),
        M('sgst', 'SGST'), M('igst', 'IGST'), M('total_tax', 'Total Tax'),
      ]
    },
    'gst/hsn-sales': {
      title: 'HSN-wise Sales', cat: 'gst', endpoint: '/api/reports/gst/hsn-sales',
      columns: [
        C('hsn', 'HSN'), C('rate', 'GST Rate', 'pct'), C('qty', 'Quantity', 'qty', true),
        M('taxable', 'Taxable Value'), M('cgst', 'CGST'), M('sgst', 'SGST'), M('igst', 'IGST'), M('total_tax', 'Total Tax'),
      ]
    },
    'gst/hsn-purchases': {
      title: 'HSN-wise Purchases', cat: 'gst', endpoint: '/api/reports/gst/hsn-purchases',
      columns: [
        C('hsn', 'HSN'), C('rate', 'GST Rate', 'pct'), C('qty', 'Quantity', 'qty', true),
        M('taxable', 'Taxable Value'), M('cgst', 'CGST'), M('sgst', 'SGST'), M('igst', 'IGST'), M('total_tax', 'Total Tax'),
      ]
    },
    'gst/returns': {
      title: 'GST Returns / Credit Notes', cat: 'gst', endpoint: '/api/reports/gst/returns',
      cards: [
        { k: 'sales_returns', l: 'Sales Returns', t: 'num' }, { k: 'sales_return_value', l: 'Return Value' },
        { k: 'credit_notes', l: 'Credit Notes', t: 'num' }, { k: 'credit_note_value', l: 'Credit Note Value' },
        { k: 'cgst', l: 'CGST Reversed' }, { k: 'sgst', l: 'SGST Reversed' },
        { k: 'igst', l: 'IGST Reversed' }, { k: 'total_gst_reversed', l: 'Total GST Reversed' },
      ]
    },

    // ---- Cashier / Staff ----
    'cashiers/sales': {
      title: 'Cashier Sales', cat: 'cashiers', endpoint: '/api/reports/cashiers/sales',
      columns: [
        C('cashier', 'Cashier'), C('bills', 'Bills', 'num', true), M('sales', 'Sales'),
        M('discount', 'Discount'), M('returns', 'Returns'), M('net_sales', 'Net Sales'), M('avg_bill', 'Avg Bill'),
      ]
    },
    'cashiers/payments': {
      title: 'Cashier Payment Collection', cat: 'cashiers', endpoint: '/api/reports/cashiers/payments', dynamicMethods: true,
      columns: [C('cashier', 'Cashier')]
    },
    'cashiers/discounts': {
      title: 'Cashier Discounts', cat: 'cashiers', endpoint: '/api/reports/cashiers/discounts', server: true,
      columns: [
        C('cashier', 'Cashier'), C('invoice_no', 'Invoice'), C('created_at', 'Date', 'date'),
        C('customer', 'Customer'), M('subtotal', 'Subtotal'), M('discount', 'Discount'),
        C('discount_pct', 'Discount %', 'pct'), M('total', 'Final'),
      ]
    },
    'cashiers/returns': {
      title: 'Cashier Returns', cat: 'cashiers', endpoint: '/api/reports/cashiers/returns', server: true,
      columns: [
        C('cashier', 'Cashier'), C('return_no', 'Return No'), C('invoice_no', 'Invoice'),
        C('created_at', 'Date', 'datetime'), M('total', 'Amount'), C('reason', 'Reason'),
      ]
    },
    'cashiers/sessions': {
      title: 'Cashier Shift / Settlement', cat: 'cashiers', endpoint: '/api/reports/cashiers/sessions', sessionBox: true,
      filters: [{ param: 'user_id', label: 'Cashier', source: 'users' }],
      columns: [
        C('user', 'Cashier'), C('opened_at', 'Opened', 'datetime'), C('closed_at', 'Closed', 'datetime'),
        { k: 'status', l: 'Status', t: 'status' },
        M('opening_cash', 'Opening'), M('cash_sales', 'Cash Sales'), M('expected_cash', 'Expected'),
        M('actual_cash', 'Actual'), M('difference', 'Difference'),
      ]
    },

    // ---- Audit ----
    'audit': {
      title: 'Audit Log', cat: 'audit', endpoint: '/api/reports/audit', server: true, search: 'Reference / description / user',
      filters: [{ param: 'user_id', label: 'User', source: 'users' }],
      columns: [
        C('created_at', 'Date/Time', 'datetime'), C('username', 'User'), C('action', 'Action'),
        C('module', 'Module'), C('reference', 'Reference'), C('old_value', 'Old Value'),
        C('new_value', 'New Value'), C('description', 'Description'),
      ]
    },
  };

  const PRESETS = [
    ['today', 'Today'], ['yesterday', 'Yesterday'], ['this_week', 'This Week'], ['last_week', 'Last Week'],
    ['this_month', 'This Month'], ['last_month', 'Last Month'], ['this_year', 'This Year'], ['custom', 'Custom Range'],
  ];

  // ---------- state ----------
  function rpt() {
    if (!state.rpt) {
      const today = localDateStr(new Date());
      state.rpt = {
        cat: 'overview', key: 'overview', preset: 'today', from: today, to: today,
        data: null, loading: false, error: '', page: 1, search: '', filters: {}, meta: null
      };
    }
    return state.rpt;
  }

  function currentDef() { return REPORTS[rpt().key] || REPORTS.overview; }

  function reportsInCat(cat) {
    return Object.entries(REPORTS).filter(([, d]) => d.cat === cat).map(([k, d]) => ({ key: k, ...d }));
  }

  // ---------- data loading ----------
  function buildQuery(forExport = false) {
    const s = rpt();
    const def = currentDef();
    const params = new URLSearchParams();
    if (!def.noDates) { params.set('from', s.from); params.set('to', s.to); }
    if (def.server) {
      params.set('page', forExport ? 1 : s.page);
      params.set('per_page', forExport ? 100000 : 50);
    }
    if (def.search && s.search) params.set('q', s.search);
    if (def.picker && s.filters[def.picker.param]) params.set(def.picker.param, s.filters[def.picker.param]);
    (def.filters || []).forEach(f => { if (s.filters[f.param]) params.set(f.param, s.filters[f.param]); });
    return params.toString();
  }

  async function loadMeta() {
    if (rpt().meta) return;
    try {
      const data = await api('/api/reports/meta');
      rpt().meta = data.report || {};
    } catch (e) { rpt().meta = {}; }
  }

  async function load() {
    const s = rpt();
    const def = currentDef();
    if (def.picker && !s.filters[def.picker.param]) {
      s.data = null; s.error = '';
      renderView();
      return;
    }
    s.loading = true; s.error = '';
    renderView();
    try {
      const data = await api(`${def.endpoint}?${buildQuery()}`);
      s.data = data.report || {};
      s.loading = false;
    } catch (err) {
      s.error = err.message;
      s.data = null;
      s.loading = false;
    }
    renderView();
  }

  function applyPreset(preset) {
    const s = rpt();
    s.preset = preset;
    if (preset !== 'custom') {
      const r = presetRange(preset);
      s.from = r.from; s.to = r.to;
      s.page = 1;
      load();
    } else {
      renderView();
    }
  }

  function setReport(key) {
    const s = rpt();
    s.key = key;
    s.cat = REPORTS[key].cat;
    s.page = 1; s.search = ''; s.data = null; s.error = '';
    s.filters = {};
    load();
  }

  // ---------- rendering ----------
  function render(view) {
    const s = rpt();
    if (!s.meta) {
      loadMeta().then(() => { if (state.view === 'reports') renderView(); });
    }

    view.innerHTML = `
      <div class="rpt-layout">
        <aside class="rpt-nav" role="navigation" aria-label="Report categories">
          ${CATEGORIES.map(c => `
            <button class="rpt-nav-btn ${s.cat === c.id ? 'active' : ''}" data-cat="${c.id}">${esc(c.label)}</button>
          `).join('')}
        </aside>
        <div class="rpt-main">
          <div class="rpt-tabs" role="tablist">
            ${reportsInCat(s.cat).map(r => `
              <button class="rpt-tab ${s.key === r.key ? 'active' : ''}" data-rpt="${esc(r.key)}" role="tab" aria-selected="${s.key === r.key}">${esc(r.title)}</button>
            `).join('')}
          </div>
          ${renderFilterBar()}
          <div id="rptContent" class="rpt-content"></div>
        </div>
      </div>`;

    view.querySelectorAll('[data-cat]').forEach(btn => {
      btn.addEventListener('click', () => {
        const cat = btn.dataset.cat;
        const first = reportsInCat(cat)[0];
        if (first) setReport(first.key);
      });
    });
    view.querySelectorAll('[data-rpt]').forEach(btn => {
      btn.addEventListener('click', () => { if (btn.dataset.rpt !== s.key) setReport(btn.dataset.rpt); });
    });

    bindFilterBar(view);
    renderContent();
  }

  function renderFilterBar() {
    const s = rpt();
    const def = currentDef();
    const customVisible = s.preset === 'custom';
    return `
      <div class="rpt-filters card">
        <div class="rpt-preset-row">
          ${PRESETS.map(([id, label]) => `
            <button class="chip ${s.preset === id ? 'active' : ''}" data-preset="${id}">${label}</button>
          `).join('')}
        </div>
        <div class="rpt-filter-row">
          ${!def.noDates ? `
            <div class="rpt-date-fields" style="${customVisible ? '' : 'display:none'}">
              <label>From <input type="date" id="rptFrom" value="${esc(s.from)}" max="${esc(s.to)}"></label>
              <label>To <input type="date" id="rptTo" value="${esc(s.to)}" min="${esc(s.from)}"></label>
            </div>` : ''}
          ${def.picker ? `<label class="rpt-picker">${esc(def.picker.label)} <select id="rptPicker"></select></label>` : ''}
          ${(def.filters || []).map(f => `
            <label class="rpt-picker">${esc(f.label)} <select data-filter="${esc(f.param)}" id="rptF_${esc(f.param)}"></select></label>
          `).join('')}
          ${def.search ? `<input id="rptSearch" class="rpt-search" placeholder="${esc(def.search)}" value="${esc(s.search)}" />` : ''}
          <div class="rpt-actions">
            ${s.preset === 'custom' && !def.noDates ? `<button class="btn" id="rptShow">Show Report</button>` : ''}
            <button class="btn ghost" id="rptReset">Reset</button>
            ${def.endpoint ? `<button class="btn ghost" id="rptCsv">Export CSV</button><button class="btn ghost" id="rptPrint">Print</button>` : ''}
          </div>
        </div>
        <div class="rpt-range-hint">${def.noDates ? 'Showing current snapshot' : `Period: ${fmtDate(s.from)} to ${fmtDate(s.to)}`}</div>
      </div>`;
  }

  function fillSelect(sel, source, current, allLabel) {
    const meta = rpt().meta || {};
    const items = source === 'users' ? (meta.users || []) :
      source === 'customers' ? (meta.customers || []) :
      source === 'suppliers' ? (meta.suppliers || []) :
      source === 'categories' ? (meta.categories || []).map(c => ({ id: c, name: c })) :
      (meta.items || []);
    sel.innerHTML = (allLabel !== null ? `<option value="">${esc(allLabel)}</option>` : '') +
      items.map(i => `<option value="${i.id}" ${String(i.id) === String(current) ? 'selected' : ''}>${esc(i.name)}${i.code ? ' (' + esc(i.code) + ')' : ''}</option>`).join('');
  }

  function bindFilterBar(view) {
    const s = rpt();
    const def = currentDef();
    view.querySelectorAll('[data-preset]').forEach(btn => {
      btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
    });
    const fromEl = view.querySelector('#rptFrom');
    const toEl = view.querySelector('#rptTo');
    if (fromEl) fromEl.addEventListener('change', () => { s.from = fromEl.value; });
    if (toEl) toEl.addEventListener('change', () => { s.to = toEl.value; });

    const picker = view.querySelector('#rptPicker');
    if (picker && def.picker) {
      fillSelect(picker, def.picker.source, s.filters[def.picker.param], `-- Select ${def.picker.label} --`);
      picker.addEventListener('change', () => {
        s.filters[def.picker.param] = picker.value;
        s.page = 1;
        load();
      });
    }

    (def.filters || []).forEach(f => {
      const sel = view.querySelector(`#rptF_${f.param}`);
      if (!sel) return;
      if (f.source) {
        fillSelect(sel, f.source, s.filters[f.param], 'All');
      } else {
        sel.innerHTML = (f.options || []).map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(s.filters[f.param] ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('');
      }
      sel.addEventListener('change', () => {
        s.filters[f.param] = sel.value;
        s.page = 1;
        load();
      });
    });

    const searchEl = view.querySelector('#rptSearch');
    if (searchEl) {
      let t;
      searchEl.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          s.search = searchEl.value.trim();
          if (def.server) { s.page = 1; load(); } else { renderContent(); }
        }, 350);
      });
    }

    const showBtn = view.querySelector('#rptShow');
    if (showBtn) showBtn.addEventListener('click', () => {
      if (!s.from || !s.to) return setStatus('Select both From and To dates', 'error');
      if (s.from > s.to) return setStatus('From date cannot be after To date', 'error');
      s.page = 1;
      load();
    });

    const resetBtn = view.querySelector('#rptReset');
    if (resetBtn) resetBtn.addEventListener('click', () => {
      const today = localDateStr(new Date());
      s.preset = 'today'; s.from = today; s.to = today;
      s.page = 1; s.search = ''; s.filters = {};
      if (def.picker) { s.data = null; renderView(); } else load();
    });

    const csvBtn = view.querySelector('#rptCsv');
    if (csvBtn) csvBtn.addEventListener('click', exportCsv);
    const printBtn = view.querySelector('#rptPrint');
    if (printBtn) printBtn.addEventListener('click', printReport);
  }

  function renderContent() {
    const s = rpt();
    const def = currentDef();
    const el = document.getElementById('rptContent');
    if (!el) return;

    if (def.custom === 'overview') return renderOverview(el);

    if (s.loading) {
      el.innerHTML = `<div class="rpt-loading"><div class="rpt-spinner"></div>Loading report...</div>`;
      return;
    }
    if (s.error) {
      el.innerHTML = `<div class="rpt-empty">Could not load report: ${esc(s.error)}</div>`;
      return;
    }
    if (def.picker && !s.filters[def.picker.param]) {
      el.innerHTML = `<div class="rpt-empty">Select ${/^[aeiou]/i.test(def.picker.label) ? 'an' : 'a'} ${esc(def.picker.label.toLowerCase())} to view this report.</div>`;
      return;
    }
    if (!s.data) {
      el.innerHTML = `<div class="rpt-empty">No data loaded.</div>`;
      return;
    }

    let html = '';
    if (def.sessionBox) html += renderSessionBox();
    if (def.cards && s.data.summary) html += renderCards(def.cards, s.data.summary);
    if (def.chart && (s.data.rows || []).length) html += renderChart(s.data.rows, def.chart);

    let columns = def.columns || [];
    if (def.dynamicMethods && s.data.methods) {
      columns = [...columns, ...s.data.methods.map(m => ({ k: m, l: m, t: 'money', total: true })), { k: 'total', l: 'Total', t: 'money', total: true }];
    }

    let rows = s.data.rows || [];
    if (def.clientSearch && s.search) {
      const q = s.search.toLowerCase();
      rows = rows.filter(r => Object.values(r).some(v => String(v ?? '').toLowerCase().includes(q)));
    } else if (!def.server && s.search && def.search) {
      const q = s.search.toLowerCase();
      rows = rows.filter(r => Object.values(r).some(v => String(v ?? '').toLowerCase().includes(q)));
    }

    if (def.sortable !== false && columns.length) {
      rows = applySort(rows);
    }

    if (columns.length) {
      html += renderTable(columns, rows, def);
    } else if (!def.cards) {
      html += `<div class="rpt-empty">No data found for the selected period.</div>`;
    }

    if (def.server) html += renderPagination();

    el.innerHTML = html;

    // bind sorting
    el.querySelectorAll('th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const k = th.dataset.sort;
        if (s.sortKey === k) s.sortDir = -(s.sortDir || 1); else { s.sortKey = k; s.sortDir = 1; }
        renderContent();
      });
    });
    el.querySelectorAll('[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        s.page = parseInt(btn.dataset.page, 10);
        load();
      });
    });
    const openBtn = el.querySelector('#rptSessionOpen');
    if (openBtn) openBtn.addEventListener('click', openSessionFlow);
    const closeBtn = el.querySelector('#rptSessionClose');
    if (closeBtn) closeBtn.addEventListener('click', closeSessionFlow);
  }

  function applySort(rows) {
    const s = rpt();
    if (!s.sortKey) return rows;
    const dir = s.sortDir || 1;
    return [...rows].sort((a, b) => {
      const va = a[s.sortKey], vb = b[s.sortKey];
      const na = parseFloat(va), nb = parseFloat(vb);
      if (!isNaN(na) && !isNaN(nb)) return (na - nb) * dir;
      return String(va ?? '').localeCompare(String(vb ?? '')) * dir;
    });
  }

  function renderCards(cards, summary) {
    return `<div class="cards rpt-cards">${cards.map(c => {
      const v = summary[c.k];
      const shown = c.t === 'num' || c.t === 'qty' ? fmtNum(v) : c.t === 'pct' ? `${fmtNum(v)}%` : fmtMoney(v);
      return `<div class="card ${c.cls || ''}"><div class="label">${esc(c.l)}</div><div class="value">${shown}</div></div>`;
    }).join('')}</div>`;
  }

  function renderChart(rows, key) {
    const vals = rows.map(r => parseFloat(r[key]) || 0);
    const max = Math.max(...vals, 1);
    return `
      <div class="card rpt-chart-card">
        <h3>Sales trend</h3>
        <div class="rpt-chart">
          ${rows.map((r, i) => `
            <div class="rpt-bar-col" title="${esc(fmtDate(r.day))}: ${fmtMoney(vals[i])}">
              <div class="rpt-bar" style="height:${Math.max(2, vals[i] / max * 100)}%"></div>
              <div class="rpt-bar-label">${esc(String(r.day).slice(8, 10))}</div>
            </div>`).join('')}
        </div>
        <div class="muted" style="margin-top:6px">Net sales per day (hover bars for values)</div>
      </div>`;
  }

  function renderTable(columns, rows, def) {
    const s = rpt();
    const totals = {};
    columns.forEach(c => { if (c.total) totals[c.k] = 0; });
    rows.forEach(r => columns.forEach(c => { if (c.total) totals[c.k] += parseFloat(r[c.k]) || 0; }));

    const hasTotals = Object.keys(totals).length > 0 && rows.length > 0;
    return `
      <div class="card table-wrap rpt-table-wrap">
        <table class="rpt-table">
          <thead><tr>${columns.map(c =>
            `<th data-sort="${esc(c.k)}" class="${c.t === 'money' || c.t === 'num' || c.t === 'qty' || c.t === 'pct' ? 'num' : ''}">
              ${esc(c.l)}${s.sortKey === c.k ? (s.sortDir === 1 ? ' ▲' : ' ▼') : ''}</th>`
          ).join('')}</tr></thead>
          <tbody>
            ${rows.map(r => `<tr>${columns.map(c => {
              let v = cellValue(r, c);
              let cls = '';
              if (c.t === 'money' || c.t === 'num' || c.t === 'qty' || c.t === 'pct') cls = 'num';
              if (c.t === 'status') {
                const st = String(r[c.k] || '');
                v = `<span class="badge badge-${esc(st)}">${esc(st)}</span>`;
                return `<td>${v}</td>`;
              }
              if (c.t === 'stockStatus') {
                const st = String(r[c.k] || '');
                v = `<span class="badge badge-${st === 'OK' ? 'paid' : st === 'Low' ? 'partial' : 'cancelled'}">${esc(st)}</span>`;
                return `<td>${v}</td>`;
              }
              return `<td class="${cls}">${typeof v === 'string' && v.includes('₹') ? v : esc(v)}</td>`;
            }).join('')}</tr>`).join('') || `<tr><td colspan="${columns.length}" class="rpt-empty-cell">No data found for the selected period.</td></tr>`}
          </tbody>
          ${hasTotals ? `<tfoot><tr>${columns.map((c, i) =>
            `<td class="${c.t === 'money' || c.t === 'num' || c.t === 'qty' || c.t === 'pct' ? 'num' : ''}">${i === 0 ? 'Total' : c.total ? (c.t === 'money' ? fmtMoney(totals[c.k]) : fmtNum(totals[c.k])) : ''}</td>`
          ).join('')}</tr></tfoot>` : ''}
        </table>
      </div>
      <div class="muted rpt-count">${def.server ? `${s.data.total || 0} records` : `${rows.length} rows`}</div>`;
  }

  function renderPagination() {
    const s = rpt();
    const total = s.data.total || 0;
    const perPage = s.data.per_page || 50;
    const pages = Math.max(1, Math.ceil(total / perPage));
    if (pages <= 1) return '';
    const cur = s.data.page || 1;
    return `
      <div class="rpt-pagination">
        <button class="btn ghost sm" data-page="${cur - 1}" ${cur <= 1 ? 'disabled' : ''}>← Prev</button>
        <span>Page ${cur} of ${pages}</span>
        <button class="btn ghost sm" data-page="${cur + 1}" ${cur >= pages ? 'disabled' : ''}>Next →</button>
      </div>`;
  }

  function renderSessionBox() {
    const sess = state.cashSession;
    return `
      <div class="card rpt-session-box">
        <h3>Cash drawer</h3>
        ${sess && sess.status === 'open' ? `
          <p class="muted">Session open since ${fmtDateTime(sess.opened_at)} · Opening cash ${fmtMoney(sess.opening_cash)}
          ${sess.figures ? ` · Expected now ${fmtMoney(sess.figures.expected_cash)}` : ''}</p>
          <button class="btn" id="rptSessionClose">Close session & count cash</button>
        ` : `
          <p class="muted">No open cash session for your account.</p>
          <button class="btn green" id="rptSessionOpen">Open cash session</button>
        `}
      </div>`;
  }

  async function refreshSession() {
    try {
      const data = await api('/api/cash-session');
      state.cashSession = data.session;
    } catch (e) { state.cashSession = null; }
  }

  async function openSessionFlow() {
    const amount = prompt('Opening cash in drawer (₹):', '0');
    if (amount === null) return;
    try {
      await api('/api/cash-session/open', { method: 'POST', body: { opening_cash: parseFloat(amount) || 0 } });
      setStatus('Cash session opened', 'ok');
      await refreshSession();
      renderContent();
      load();
    } catch (err) { setStatus(err.message, 'error'); }
  }

  async function closeSessionFlow() {
    const sess = state.cashSession;
    const expected = sess && sess.figures ? sess.figures.expected_cash : 0;
    const amount = prompt(`Expected cash: ${fmtMoney(expected)}\nEnter actual counted cash (₹):`, expected);
    if (amount === null) return;
    try {
      await api('/api/cash-session/close', { method: 'POST', body: { closing_cash: parseFloat(amount) || 0 } });
      setStatus('Cash session closed', 'ok');
      await refreshSession();
      renderContent();
      load();
    } catch (err) { setStatus(err.message, 'error'); }
  }

  // ---------- overview ----------
  function renderOverview(el) {
    const s = rpt();
    if (s.loading) {
      el.innerHTML = `<div class="rpt-loading"><div class="rpt-spinner"></div>Loading overview...</div>`;
      return;
    }
    if (s.error) {
      el.innerHTML = `<div class="rpt-empty">Could not load report: ${esc(s.error)}</div>`;
      return;
    }
    const d = s.data || {};
    const sm = d.summary || {};
    const cards = [
      { k: 'total_sales', l: 'Total Sales', cls: 'green' },
      { k: 'total_purchase', l: 'Total Purchase' },
      { k: 'gross_profit', l: 'Gross Profit', cls: 'blue' },
      { k: 'expenses', l: 'Expenses' },
      { k: 'net_profit', l: 'Net Profit', cls: sm.net_profit >= 0 ? 'green' : '' },
      { k: 'bills', l: 'Bills', t: 'num' },
      { k: 'items_sold', l: 'Items Sold', t: 'qty' },
      { k: 'avg_bill', l: 'Avg Bill' },
      { k: 'sales_returns', l: 'Sales Returns' },
      { k: 'purchase_returns', l: 'Purchase Returns' },
      { k: 'discounts', l: 'Discounts Given' },
      { k: 'tax_collected', l: 'Tax Collected' },
      { k: 'customer_outstanding', l: 'Customer Due' },
      { k: 'supplier_outstanding', l: 'Supplier Due' },
    ];
    let html = renderCards(cards, sm);
    if ((d.by_day || []).length) {
      html += renderChart(d.by_day.map(r => ({ ...r, net_sales: r.net_sales })), 'net_sales');
      html += `<h3 class="rpt-subhead">Day-wise Sales</h3>`;
      html += renderTable([
        C('day', 'Date', 'date'), C('bills', 'Bills', 'num', true), C('items', 'Items Sold', 'qty', true),
        M('gross', 'Sales'), M('returns', 'Returns'), M('net_sales', 'Net Sales'), M('profit', 'Profit'),
      ], d.by_day, {});
    } else {
      html += `<div class="rpt-empty">No sales found for the selected period.</div>`;
    }
    el.innerHTML = html;
  }

  // ---------- export / print ----------
  async function allRowsForExport() {
    const s = rpt();
    const def = currentDef();
    if (def.custom === 'overview') {
      const cols = [C('day', 'Date'), C('bills', 'Bills', 'num', true), C('items', 'Items', 'qty', true), M('gross', 'Sales'), M('returns', 'Returns'), M('net_sales', 'Net Sales'), M('profit', 'Profit')];
      return { columns: cols, rows: (s.data && s.data.by_day) || [] };
    }
    if (def.server) {
      const data = await api(`${def.endpoint}?${buildQuery(true)}`);
      const rep = data.report || {};
      let columns = def.columns || [];
      if (def.dynamicMethods && rep.methods) {
        columns = [...columns, ...rep.methods.map(m => ({ k: m, l: m, t: 'money' })), { k: 'total', l: 'Total', t: 'money' }];
      }
      return { columns, rows: rep.rows || [] };
    }
    let columns = def.columns || [];
    if (def.dynamicMethods && s.data && s.data.methods) {
      columns = [...columns, ...s.data.methods.map(m => ({ k: m, l: m, t: 'money' })), { k: 'total', l: 'Total', t: 'money' }];
    }
    return { columns, rows: (s.data && s.data.rows) || [] };
  }

  function exportHeaderLines() {
    const s = rpt();
    const def = currentDef();
    const shop = (state.settings && state.settings.shop_name) || 'Mart POS';
    return [
      shop,
      `Report: ${def.title}`,
      def.noDates ? 'Snapshot (current)' : `Period: ${s.from} to ${s.to}`,
      `Generated: ${fmtDateTime(new Date().toISOString())}`,
    ];
  }

  async function exportCsv() {
    try {
      const { columns, rows } = await allRowsForExport();
      const escCsv = (v) => {
        const str = String(v ?? '');
        return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
      };
      const lines = exportHeaderLines().map(l => escCsv(l));
      lines.push('');
      lines.push(columns.map(c => escCsv(c.l)).join(','));
      rows.forEach(r => lines.push(columns.map(c => escCsv(rawCell(r, c))).join(',')));
      // totals
      const totals = {};
      let anyTotal = false;
      columns.forEach(c => { if (c.total) { totals[c.k] = 0; anyTotal = true; } });
      if (anyTotal && rows.length) {
        rows.forEach(r => columns.forEach(c => { if (c.total) totals[c.k] += parseFloat(r[c.k]) || 0; }));
        lines.push(columns.map((c, i) => escCsv(i === 0 ? 'Total' : c.total ? totals[c.k].toFixed(2) : '')).join(','));
      }
      const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${currentDef().title.replace(/[^a-z0-9]+/gi, '_')}_${rpt().from}_${rpt().to}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus('Report exported', 'ok');
    } catch (err) {
      setStatus(err.message, 'error');
    }
  }

  function rawCell(row, col) {
    const v = row[col.k];
    if (v === null || v === undefined) return '';
    if (col.t === 'date') return fmtDate(v);
    if (col.t === 'datetime') return fmtDateTime(v);
    if (col.t === 'time') return fmtTime(v);
    return v;
  }

  async function printReport() {
    try {
      const { columns, rows } = await allRowsForExport();
      const head = exportHeaderLines().map(l => `<div>${esc(l)}</div>`).join('');
      const body = rows.map(r =>
        `<tr>${columns.map(c => `<td>${esc(cellValue(r, c))}</td>`).join('')}</tr>`
      ).join('');
      const totals = {};
      let anyTotal = false;
      columns.forEach(c => { if (c.total) { totals[c.k] = 0; anyTotal = true; } });
      rows.forEach(r => columns.forEach(c => { if (c.total) totals[c.k] += parseFloat(r[c.k]) || 0; }));
      const foot = anyTotal && rows.length
        ? `<tr class="tot">${columns.map((c, i) => `<td>${i === 0 ? 'Total' : c.total ? fmtMoney(totals[c.k]) : ''}</td>`).join('')}</tr>`
        : '';
      const w = window.open('', '_blank');
      if (!w) return setStatus('Popup blocked - allow popups to print', 'error');
      w.document.write(`<!doctype html><html><head><title>${esc(currentDef().title)}</title>
        <style>
          body{font-family:Arial,sans-serif;padding:24px;color:#111}
          .hdr{margin-bottom:16px}.hdr div:first-child{font-size:18px;font-weight:700}
          table{border-collapse:collapse;width:100%;font-size:12px}
          th,td{border:1px solid #ccc;padding:6px 8px;text-align:left}
          th{background:#f1f5f9}tr.tot td{font-weight:700;border-top:2px solid #333}
        </style></head><body>
        <div class="hdr">${head}</div>
        <table><thead><tr>${columns.map(c => `<th>${esc(c.l)}</th>`).join('')}</tr></thead>
        <tbody>${body || `<tr><td colspan="${columns.length}">No data</td></tr>`}${foot}</tbody></table>
        </body></html>`);
      w.document.close();
      w.focus();
      w.print();
    } catch (err) {
      setStatus(err.message, 'error');
    }
  }

  // ---------- public ----------
  async function loadInitial() {
    const s = rpt();
    if (s.cat === 'overview') s.key = 'overview';
    await refreshSession();
    await load();
  }

  return { render, load: loadInitial, fmtMoney, fmtDate, fmtDateTime, refreshSession };
})();

window.ReportsModule = ReportsModule;
