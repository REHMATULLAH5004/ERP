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
// LOAD PRICING DATA
// ============================================
async function loadPricing() {
    const tbody = document.getElementById('pricingTableBody');

    try {
        // 1. Fetch all products
        const { data: products, error: prodError } = await supabaseClient
            .from('products')
            .select(`
                id,
                product_name,
                conversion_rate,
                retail_regular_percent,
                wholesale_regular_percent
            `)
            .order('product_name', { ascending: true });

        if (prodError) throw prodError;

        if (products.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 30px; color: #94a3b8;">No products found. Add a product via Product Master.</td></tr>`;
            return;
        }

        // 2. Fetch the most recent batch for each product
        const productIds = products.map(p => p.id);
        const { data: batches, error: batchError } = await supabaseClient
            .from('batches')
            .select('product_id, cost_price, created_at')
            .in('product_id', productIds)
            .order('created_at', { ascending: false });

        if (batchError) throw batchError;

        // 3. Map the most recent cost_price to each product
        const costMap = {};
        batches.forEach(b => {
            if (!costMap[b.product_id]) {
                costMap[b.product_id] = b.cost_price || 0;
            }
        });

        // 4. Render the table
        renderPricing(products, costMap);

    } catch (error) {
        console.error("Error loading pricing data:", error);
        tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 30px; color: #dc2626;">Error: ${error.message}</td></tr>`;
    }
}

// ============================================
// RENDER PRICING (With Commercial Rounding)
// ============================================
function renderPricing(products, costMap) {
    const tbody = document.getElementById('pricingTableBody');
    
    tbody.innerHTML = products.map(p => {
        const packSize = p.conversion_rate || 1;
        const costPrice = costMap[p.id] || 0;

        // Calculate Retail Price: (Cost × Pack Size) × (1 + Retail Markup%)
        const retailMarkup = p.retail_regular_percent || 0;
        const retailPrice = (costPrice * packSize) * (1 + (retailMarkup / 100));

        // Calculate Wholesale Price: (Cost × Pack Size) × (1 + Wholesale Markup%)
        const wholesaleMarkup = p.wholesale_regular_percent || 0;
        const wholesalePrice = (costPrice * packSize) * (1 + (wholesaleMarkup / 100));

        return `
            <tr>
                <td style="padding-left: 20px; font-weight: 500;">${p.product_name}</td>
                <td>${packSize}</td>
                <td style="text-align: right; font-weight: bold;">
                    ${costPrice > 0 ? `K${Math.round(retailPrice)}` : 'No Cost Set'}
                </td>
                <td style="padding-right: 20px; text-align: right; font-weight: bold;">
                    ${costPrice > 0 ? `K${Math.round(wholesalePrice)}` : 'No Cost Set'}
                </td>
            </tr>
        `;
    }).join('');
}