// ============================================
// PRICING PAGE - SELF EXECUTING MODULE
// ============================================

(async function initPricingPage() {
    console.log("Pricing page initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    await loadPricing();
})();

// ============================================
// 🔥 ADDED: dynamic pricing settings -- this report used to read
// retail_regular_percent / wholesale_regular_percent straight off each
// product row. Those per-product columns are gone (Retail Regular is now
// an exponential cost-based curve, Wholesale Regular a flat global rate,
// both configured once in Admin > Pricing Settings), so this page has to
// load the same company_settings values and compute the same way the
// Retail/Wholesale POS screens do, or it would show stale/zero prices for
// every product added or edited after the cutover.
// ============================================
// Reads EVERY batch row, 1000 at a time. The old code asked for the batches of all products
// with .in('product_id', [every product id]) -- with ~850 products that web address is too
// long, the request failed, the error was ignored, and every product showed 0 stock.
async function fetchAllBatchRows(columns, newestFirst) {
    const rows = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
        let q = supabaseClient.from('batches').select(columns);
        if (newestFirst) q = q.order('created_at', { ascending: false });
        const { data, error } = await q.order('id', { ascending: true }).range(from, from + PAGE - 1);
        if (error) return { data: null, error };
        rows.push(...(data || []));
        if (!data || data.length < PAGE) break;
    }
    return { data: rows, error: null };
}

async function loadPricingSettings() {
    const fallback = {
        retail_regular_markup_max_percent: 60,
        retail_regular_markup_min_percent: 30,
        wholesale_regular_markup_percent: 10,
        markup_cost_min: 1,
        markup_cost_max: 600
    };
    try {
        const { data, error } = await supabaseClient
            .from('company_settings')
            .select(`retail_regular_markup_max_percent, retail_regular_markup_min_percent,
                wholesale_regular_markup_percent, markup_cost_min, markup_cost_max`)
            .eq('id', 1)
            .maybeSingle();
        if (error || !data) return fallback;
        return {
            retail_regular_markup_max_percent: data.retail_regular_markup_max_percent ?? fallback.retail_regular_markup_max_percent,
            retail_regular_markup_min_percent: data.retail_regular_markup_min_percent ?? fallback.retail_regular_markup_min_percent,
            wholesale_regular_markup_percent: data.wholesale_regular_markup_percent ?? fallback.wholesale_regular_markup_percent,
            markup_cost_min: data.markup_cost_min ?? fallback.markup_cost_min,
            markup_cost_max: data.markup_cost_max ?? fallback.markup_cost_max
        };
    } catch (e) {
        console.warn('Could not load pricing settings, using defaults:', e);
        return fallback;
    }
}

// Same geometric/exponential decay used by Retail POS -- constant
// multiplicative step per unit of cost between maxPct (at costMin) and
// minPct (at costMax), clamped flat outside that range.
function computeExponentialMarkupPercent(cost, maxPct, minPct, costMin, costMax) {
    if (!(costMax > costMin) || maxPct <= 0 || minPct <= 0) return maxPct;
    const clampedCost = Math.min(Math.max(cost, costMin), costMax);
    const t = (clampedCost - costMin) / (costMax - costMin);
    return maxPct * Math.pow(minPct / maxPct, t);
}

// ADDED: "clean" prices for REGULAR retail. The pack price (cost per pack plus
// the markup) is rounded to a tidy figure, with a finer step for cheaper packs
// so a small price never collapses to 0:
//   under K10  -> nearest K0.50 (never below K0.50)
//   K10-K50    -> nearest K1
//   K50-K100   -> nearest K5
//   K100-K1000 -> nearest K10
//   K1000+     -> nearest K50
// Safety: the rounded price is never allowed below cost + 25%; if rounding
// down would do that it rounds UP instead. To change the steps, edit the
// table below (same table is used in Retail POS, Quick Sale, CRM quick sale
// and the Pricing page).
var REGULAR_PRICE_STEPS = [
    { below: 10, step: 0.5 },
    { below: 50, step: 1 },
    { below: 100, step: 5 },
    { below: 1000, step: 10 },
    { below: Infinity, step: 50 }
];
var REGULAR_MIN_MARGIN = 0.25;
function roundRegularPackPrice(price, costPerPack) {
    price = Number(price) || 0;
    if (!(price > 0)) return price;
    const tier = REGULAR_PRICE_STEPS.find(t => price < t.below);
    const step = tier.step;
    let rounded = Math.round(price / step) * step;
    const floor = (Number(costPerPack) || 0) * (1 + REGULAR_MIN_MARGIN);
    if (rounded < floor) rounded = Math.ceil(price / step) * step;
    if (rounded < step) rounded = step;
    return Math.round(rounded * 100) / 100;
}

// ============================================
// LOAD PRICING DATA
// ============================================
async function loadPricing() {
    const tbody = document.getElementById('pricingTableBody');

    try {
        const pricingSettings = await loadPricingSettings();

        // 🔥 CHANGED: dropped retail_regular_percent / wholesale_regular_percent
        // from the select -- those columns are no longer maintained per-product.
        const { data: products, error: prodError } = await supabaseClient
            .from('products')
            .select(`
                id,
                product_name,
                conversion_rate
            `)
            .order('product_name', { ascending: true });

        if (prodError) throw prodError;

        if (products.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 30px; color: #94a3b8;">No products found. Add a product via Product Master.</td></tr>`;
            return;
        }

        // 2. Fetch the most recent batch for each product
        const productIds = products.map(p => p.id);
        const { data: batches, error: batchError } = await fetchAllBatchRows('product_id, cost_price, created_at', true);

        if (batchError) throw batchError;

        // 3. Map the most recent cost_price to each product
        const costMap = {};
        batches.forEach(b => {
            if (!costMap[b.product_id]) {
                costMap[b.product_id] = b.cost_price || 0;
            }
        });

        // 4. Render the table
        renderPricing(products, costMap, pricingSettings);

    } catch (error) {
        console.error("Error loading pricing data:", error);
        tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 30px; color: #dc2626;">Error: ${error.message}</td></tr>`;
    }
}

// ============================================
// RENDER PRICING (With Commercial Rounding)
// ============================================
function renderPricing(products, costMap, pricingSettings) {
    const tbody = document.getElementById('pricingTableBody');

    tbody.innerHTML = products.map(p => {
        const packSize = p.conversion_rate || 1;
        const costPrice = costMap[p.id] || 0;
        const costPerPack = costPrice * packSize;

        // 🔥 CHANGED: Retail Regular markup is now the exponential curve
        // (same formula/settings as Retail POS), not a stored per-product
        // percent.
        const retailMarkup = computeExponentialMarkupPercent(
            costPerPack,
            pricingSettings.retail_regular_markup_max_percent,
            pricingSettings.retail_regular_markup_min_percent,
            pricingSettings.markup_cost_min,
            pricingSettings.markup_cost_max
        );
        // REGULAR retail pack price, rounded to a clean figure (same rule as Retail POS)
        const retailPrice = roundRegularPackPrice(costPerPack * (1 + (retailMarkup / 100)), costPerPack);

        // 🔥 CHANGED: Wholesale Regular markup is now the flat global rate
        // (same as Wholesale POS), not a stored per-product percent.
        const wholesaleMarkup = pricingSettings.wholesale_regular_markup_percent;
        const wholesalePrice = costPerPack * (1 + (wholesaleMarkup / 100));

        return `
            <tr>
                <td style="padding-left: 20px; font-weight: 500;">${p.product_name}</td>
                <td>${packSize}</td>
                <td style="text-align: right; font-weight: bold;">
                    ${costPrice > 0 ? `K${Number.isInteger(retailPrice) ? retailPrice : retailPrice.toFixed(2)}` : 'No Cost Set'}
                </td>
                <td style="padding-right: 20px; text-align: right; font-weight: bold;">
                    ${costPrice > 0 ? `K${Math.round(wholesalePrice)}` : 'No Cost Set'}
                </td>
            </tr>
        `;
    }).join('');
}