// AI tool registry and executor.
// Every tool the model can call is declared here with an OpenAI function
// spec, a minimum POS role, and a server-side handler. The model can only
// pick from this list - it can never construct SQL or reach the database
// directly. The executor validates the user, the role, and the arguments
// before any business logic runs.
const sales = require('./tools/sales');
const products = require('./tools/products');
const inventory = require('./tools/inventory');
const customers = require('./tools/customers');
const purchases = require('./tools/purchases');
const expenses = require('./tools/expenses');
const reports = require('./tools/reports');
const { requirePermission, truncateResult, AiPermissionError } = require('./security');
const { PERIODS } = require('./context');

const PERIOD_PROP = {
  type: 'string',
  enum: PERIODS,
  description: 'Named period. today/yesterday/this_week/last_week/this_month/last_month/last_7_days/last_30_days'
};
const DATE_PROPS = {
  from: { type: 'string', description: 'Start date YYYY-MM-DD' },
  to: { type: 'string', description: 'End date YYYY-MM-DD' }
};
const LIMIT_PROP = { type: 'integer', description: 'Max rows to return (1-25)' };
const QUERY_PROP = { type: 'string', description: 'Name or code to search for' };

function obj(properties, required) {
  return { type: 'object', properties, ...(required && required.length ? { required } : {}) };
}

const TOOLS = [
  // ---- sales (cashier+: same data the dashboard/invoices screens show) ----
  {
    name: 'get_today_sales',
    description: "Today's sales total, bill count and average bill value",
    minRole: 'cashier',
    parameters: obj({}),
    handler: () => sales.getSalesSummary({ period: 'today' })
  },
  {
    name: 'get_yesterday_sales',
    description: "Yesterday's sales total, bill count and average bill value",
    minRole: 'cashier',
    parameters: obj({}),
    handler: () => sales.getSalesSummary({ period: 'yesterday' })
  },
  {
    name: 'get_sales_by_date',
    description: 'Sales for one specific date',
    minRole: 'cashier',
    parameters: obj({ date: { type: 'string', description: 'Date YYYY-MM-DD' } }, ['date']),
    handler: (a) => sales.getSalesByDate(a)
  },
  {
    name: 'get_sales_between_dates',
    description: 'Sales between two dates (from/to, YYYY-MM-DD)',
    minRole: 'cashier',
    parameters: obj({ ...DATE_PROPS }, ['from', 'to']),
    handler: (a) => sales.getSalesSummary(a)
  },
  {
    name: 'get_sales_by_period',
    description: 'Sales for a named period: this week, last week, this month, last month, last 7 or 30 days',
    minRole: 'cashier',
    parameters: obj({ period: PERIOD_PROP }, ['period']),
    handler: (a) => sales.getSalesSummary(a)
  },
  {
    name: 'get_sales_comparison',
    description: 'Compare sales between two periods, e.g. this week vs last week',
    minRole: 'cashier',
    parameters: obj({ period_a: PERIOD_PROP, period_b: PERIOD_PROP }),
    handler: (a) => sales.getSalesComparison(a)
  },
  {
    name: 'get_daily_sales_breakdown',
    description: 'Day-by-day sales within a period or date range',
    minRole: 'cashier',
    parameters: obj({ period: PERIOD_PROP, ...DATE_PROPS }),
    handler: (a) => sales.getDailySalesBreakdown(a)
  },
  {
    name: 'get_payment_collection',
    description: 'Collections split by payment method (Cash/UPI/Card) plus credit sales for a period',
    minRole: 'cashier',
    parameters: obj({ period: PERIOD_PROP, ...DATE_PROPS }),
    handler: (a) => sales.getPaymentCollection(a)
  },
  {
    name: 'get_top_selling_products',
    description: 'Best-selling products by quantity for a period, e.g. top 10 today',
    minRole: 'cashier',
    parameters: obj({ period: PERIOD_PROP, ...DATE_PROPS, limit: LIMIT_PROP }),
    handler: (a) => sales.getTopSellingProducts(a)
  },
  {
    name: 'get_sales_by_category',
    description: 'Sales, profit and margin grouped by product category for a period',
    minRole: 'cashier',
    parameters: obj({ period: PERIOD_PROP, ...DATE_PROPS }),
    handler: (a) => sales.getSalesByCategory(a)
  },

  // ---- products ----
  {
    name: 'get_product',
    description: 'Details of one product: price, stock, reorder level. Look up by name, code or id.',
    minRole: 'cashier',
    parameters: obj({ item_id: { type: 'integer' }, code: { type: 'string' }, name: { type: 'string' } }),
    handler: (a) => products.getProduct(a)
  },
  {
    name: 'search_products',
    description: 'Search products by name or barcode fragment',
    minRole: 'cashier',
    parameters: obj({ query: QUERY_PROP, category: { type: 'string' } }, ['query']),
    handler: (a) => products.searchProducts(a)
  },
  {
    name: 'get_product_sales',
    description: 'How many units of one product sold in a period and its sales value',
    minRole: 'cashier',
    parameters: obj({ query: QUERY_PROP, item_id: { type: 'integer' }, period: PERIOD_PROP, ...DATE_PROPS }),
    handler: (a) => products.getProductSales(a)
  },
  {
    name: 'get_slow_moving_products',
    description: 'Products that sold the least in a period',
    minRole: 'cashier',
    parameters: obj({ period: PERIOD_PROP, limit: LIMIT_PROP }),
    handler: (a) => products.getSlowMovingProducts(a)
  },
  {
    name: 'get_unsold_products',
    description: 'Products in stock with no sale in the last N days (default 60)',
    minRole: 'cashier',
    parameters: obj({ days: { type: 'integer', description: 'Days without a sale, 7-365' } }),
    handler: (a) => products.getUnsoldProducts(a)
  },

  // ---- inventory ----
  {
    name: 'get_current_stock',
    description: 'Current stock levels; optionally filtered by a name/code search or category',
    minRole: 'cashier',
    parameters: obj({ query: { type: 'string' }, category: { type: 'string' } }),
    handler: (a) => inventory.getCurrentStock(a)
  },
  {
    name: 'get_low_stock_products',
    description: 'Products at or below their reorder level (still in stock)',
    minRole: 'cashier',
    parameters: obj({}),
    handler: () => inventory.getLowStockProducts()
  },
  {
    name: 'get_out_of_stock_products',
    description: 'Products completely out of stock',
    minRole: 'cashier',
    parameters: obj({}),
    handler: () => inventory.getOutOfStockProducts()
  },
  {
    name: 'get_products_running_out',
    description: 'Products about to run out: zero or at/below reorder level, sorted by urgency',
    minRole: 'cashier',
    parameters: obj({}),
    handler: () => products.getProductsRunningOut()
  },
  {
    name: 'get_stock_movement',
    description: 'Stock in/out movement per product for a period (purchases, sales, returns, adjustments)',
    minRole: 'manager',
    parameters: obj({ period: PERIOD_PROP, ...DATE_PROPS }),
    handler: (a) => inventory.getStockMovement(a)
  },
  {
    name: 'get_expiring_products',
    description: 'Products nearing expiry. NOTE: expiry dates are not tracked in MartPOS - this reports that honestly.',
    minRole: 'manager',
    parameters: obj({ days: { type: 'integer' } }),
    handler: () => ({
      supported: false,
      note: 'Expiry dates are not recorded for products in this MartPOS installation, so expiring stock cannot be listed. Track expiry via stock adjustments or ask for the feature.'
    })
  },
  {
    name: 'calculate_reorder_suggestions',
    description: 'Suggested reorder quantities for low/out-of-stock products based on recent average daily sales',
    minRole: 'manager',
    parameters: obj({}),
    handler: (a) => inventory.calculateReorderSuggestions(a)
  },

  // ---- customers & credit ----
  {
    name: 'search_customer',
    description: 'Find customers by name; returns their outstanding balance',
    minRole: 'cashier',
    parameters: obj({ query: QUERY_PROP }, ['query']),
    handler: (a) => customers.searchCustomer(a)
  },
  {
    name: 'get_customer_balance',
    description: 'Outstanding credit balance and credit limit for one customer',
    minRole: 'cashier',
    parameters: obj({ query: QUERY_PROP, customer_id: { type: 'integer' } }),
    handler: (a) => customers.getCustomerBalance(a)
  },
  {
    name: 'get_outstanding_credit',
    description: 'All customers with pending credit/dues and the total outstanding',
    minRole: 'cashier',
    parameters: obj({}),
    handler: () => customers.getOutstandingCredit()
  },
  {
    name: 'get_top_credit_customers',
    description: 'Customers who owe the most, ranked by outstanding balance',
    minRole: 'cashier',
    parameters: obj({ limit: LIMIT_PROP }),
    handler: (a) => customers.getTopCreditCustomers(a)
  },
  {
    name: 'get_customer_purchase_history',
    description: 'Recent bills for one customer in a period',
    minRole: 'cashier',
    parameters: obj({ query: QUERY_PROP, customer_id: { type: 'integer' }, period: PERIOD_PROP }),
    handler: (a) => customers.getCustomerPurchaseHistory(a)
  },
  {
    name: 'get_top_customers',
    description: 'Highest-spending customers in a period',
    minRole: 'cashier',
    parameters: obj({ period: PERIOD_PROP, limit: LIMIT_PROP }),
    handler: (a) => customers.getTopCustomers(a)
  },

  // ---- purchases & suppliers (manager+: mirrors /api/purchases guard) ----
  {
    name: 'get_recent_purchases',
    description: 'Recent purchase invoices in a period, optionally filtered by supplier or purchase number',
    minRole: 'manager',
    parameters: obj({ period: PERIOD_PROP, query: { type: 'string' } }),
    handler: (a) => purchases.getRecentPurchases(a)
  },
  {
    name: 'get_purchase_summary',
    description: 'Purchase totals, payments and supplier outstanding for a period',
    minRole: 'manager',
    parameters: obj({ period: PERIOD_PROP, ...DATE_PROPS }),
    handler: (a) => purchases.getPurchaseSummary(a)
  },
  {
    name: 'get_supplier_information',
    description: 'Purchase totals and amount payable for one supplier, or supplier-wise totals',
    minRole: 'manager',
    parameters: obj({ query: QUERY_PROP, period: PERIOD_PROP }),
    handler: (a) => purchases.getSupplierInformation(a)
  },
  {
    name: 'get_supplier_outstanding',
    description: 'Amount payable to each supplier',
    minRole: 'manager',
    parameters: obj({}),
    handler: () => purchases.getSupplierOutstanding()
  },
  {
    name: 'generate_purchase_suggestion',
    description: 'AI-generated purchase recommendations for low-stock products. Suggestions only - never creates an order.',
    minRole: 'manager',
    parameters: obj({}),
    handler: (a) => purchases.generatePurchaseSuggestion(a)
  },

  // ---- expenses (manager+: mirrors /api/expenses guard) ----
  {
    name: 'get_expenses',
    description: 'Expense entries for a period or date range, optionally filtered by category/note',
    minRole: 'manager',
    parameters: obj({ period: PERIOD_PROP, ...DATE_PROPS, query: { type: 'string' } }),
    handler: (a) => expenses.getExpenses(a)
  },
  {
    name: 'get_expense_summary',
    description: 'Expense totals grouped by category for a period',
    minRole: 'manager',
    parameters: obj({ period: PERIOD_PROP, ...DATE_PROPS }),
    handler: (a) => expenses.getExpenseSummary(a)
  },

  // ---- composite reports ----
  {
    name: 'generate_sales_summary',
    description: 'Compact sales overview for a period: totals, top items and top categories',
    minRole: 'cashier',
    parameters: obj({ period: PERIOD_PROP, ...DATE_PROPS }),
    handler: (a) => reports.generateSalesSummary(a)
  },
  {
    name: 'generate_profit_summary',
    description: 'Profit and loss for a period: net sales, COGS, gross/net profit and margins',
    minRole: 'manager',
    parameters: obj({ period: PERIOD_PROP, ...DATE_PROPS }),
    handler: (a) => reports.generateProfitSummary(a)
  },
  {
    name: 'generate_daily_business_summary',
    description: 'Whole-store summary for a day or period: sales, profit, low stock, outstanding credit',
    minRole: 'cashier',
    parameters: obj({ period: PERIOD_PROP, ...DATE_PROPS }),
    handler: (a) => reports.generateDailyBusinessSummary(a)
  },
  {
    name: 'get_sales_drop_analysis',
    description: 'Factual comparison inputs for "why are sales lower" questions: this week vs last week with category changes',
    minRole: 'manager',
    parameters: obj({}),
    handler: () => reports.getSalesDropAnalysis()
  },
  {
    name: 'generate_inventory_summary',
    description: 'Inventory valuation: product count, units, cost/sale value, low and out-of-stock counts',
    minRole: 'manager',
    parameters: obj({}),
    handler: () => reports.generateInventorySummary()
  }
];

const BY_NAME = {};
for (const t of TOOLS) BY_NAME[t.name] = t;

// OpenAI tool specs for chat.completions tools=[...]
function toolSpecs() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }
  }));
}

function toolNames() {
  return TOOLS.map((t) => t.name);
}

function getTool(name) {
  return BY_NAME[name] || null;
}

// Execute one tool call with validation. Returns a JSON-safe result object;
// throws AiPermissionError for role failures, plain Error for bad args.
async function executeTool(name, args, ctx) {
  const tool = BY_NAME[name];
  if (!tool) {
    return { error: `Unknown tool: ${name}`, code: 'unknown_tool' };
  }
  requirePermission(ctx.user, tool.minRole);

  let parsed = args;
  if (typeof parsed === 'string') {
    try {
      parsed = parsed ? JSON.parse(parsed) : {};
    } catch (_) {
      return { error: 'Invalid tool arguments', code: 'bad_args' };
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    parsed = {};
  }

  const result = await tool.handler(parsed, ctx);
  return truncateResult(result);
}

module.exports = { TOOLS, toolSpecs, toolNames, getTool, executeTool, AiPermissionError };
