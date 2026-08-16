// ============================================
// BRAND PAGE - SELF EXECUTING MODULE
// ============================================

(async function initBrandPage() {
    console.log("Brand page initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // 1. Load the brand table with analytics
    await loadBrands();

    // 2. Close Product List Modal
    document.getElementById('closeProductListBtn').addEventListener('click', () => {
        document.getElementById('productListModal').style.display = 'none';
    });

    // 3. Close modal on background click
    document.getElementById('productListModal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            document.getElementById('productListModal').style.display = 'none';
        }
    });
})();

// ============================================
// LOAD BRANDS (With Analytics - Updated for Simplified Table)
// ============================================
async function loadBrands() {
    const tbody = document.getElementById('brandTableBody');

    try {
        // 1. Fetch all brands
        const { data: brands, error: brandError } = await supabaseClient
            .from('brands')
            .select('id, name')
            .order('name', { ascending: true });

        if (brandError) throw brandError;

        if (brands.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 30px; color: #94a3b8;">No brands found. Add one via the Product Master.</td></tr>`;
            return;
        }

        // 2. Fetch all products (map brands to products, and get conversion_rate)
        const { data: products, error: prodError } = await supabaseClient
            .from('products')
            .select(`
                id, 
                product_name, 
                brand_id, 
                supplier_id, 
                conversion_rate,
                suppliers ( name )
            `);

        if (prodError) throw prodError;

        // 3. Fetch all batches (UPDATED: Using total_qty and cost_price only)
        const { data: batches, error: batchError } = await supabaseClient
            .from('batches')
            .select('product_id, total_qty, cost_price');

        if (batchError) throw batchError;

        // 4. Build the analytics map
        const brandMap = {};
        brands.forEach(b => {
            brandMap[b.id] = {
                name: b.name,
                suppliers: new Set(),
                productCount: 0,
                totalCost: 0,
                productsList: []
            };
        });

        // 5. Process products and map them to brands
        products.forEach(p => {
            if (p.brand_id && brandMap[p.brand_id]) {
                // Add supplier to the brand's supplier list
                if (p.suppliers?.name) {
                    brandMap[p.brand_id].suppliers.add(p.suppliers.name);
                }
                // Increment product count
                brandMap[p.brand_id].productCount++;
                // Store product info for the modal
                brandMap[p.brand_id].productsList.push({
                    id: p.id,
                    name: p.product_name,
                    conversion_rate: p.conversion_rate || 1,
                    quantities: []
                });
            }
        });

        // 6. Process batches to calculate costs and populate modal quantities
        batches.forEach(b => {
            const prod = products.find(p => p.id === b.product_id);
            if (prod && prod.brand_id && brandMap[prod.brand_id]) {
                const brand = brandMap[prod.brand_id];
                const conversionRate = prod.conversion_rate || 1;
                
                // Calculate total quantity in Primary Units
                // Note: total_qty is already calculated in the batches table, so we just use it
                const totalQty = b.total_qty || 0;
                
                // Add to total cost using the simplified cost_price
                brand.totalCost += (b.cost_price || 0) * totalQty;
                
                // Add quantity to the product's list for the modal
                const prodInList = brand.productsList.find(p => p.id === b.product_id);
                if (prodInList) {
                    prodInList.quantities.push({
                        qty: totalQty,
                        cost: b.cost_price || 0,
                        batch: b.batch_number || 'N/A',
                        expiry: b.expiry_date || 'N/A'
                    });
                }
            }
        });

        // 7. Render the table
        renderBrands(brandMap);

    } catch (error) {
        console.error("Error loading brands:", error);
        tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 30px; color: #dc2626;">Error: ${error.message}</td></tr>`;
    }
}

// ============================================
// RENDER BRANDS
// ============================================
function renderBrands(brandMap) {
    const tbody = document.getElementById('brandTableBody');
    
    tbody.innerHTML = Object.values(brandMap).map(brand => {
        const supplierList = Array.from(brand.suppliers).join(', ') || '-';

        return `
            <tr>
                <td style="padding-left: 20px; font-weight: 500;">${brand.name}</td>
                <td>${supplierList}</td>
                <td>
                    <a href="#" style="color: #2563eb; font-weight: 500; text-decoration: none;" onclick="openProductList('${brand.name}', '${brand.productsList.map(p => p.id).join(',')}')">
                        ${brand.productCount} Products
                    </a>
                </td>
                <td style="text-align: right; padding-right: 20px; font-weight: bold;">
                    K${brand.totalCost.toFixed(2)}
                </td>
            </tr>
        `;
    }).join('');
}

// ============================================
// OPEN PRODUCT LIST MODAL (Updated for total_qty)
// ============================================
async function openProductList(brandName, productIds) {
    const modal = document.getElementById('productListModal');
    const title = document.getElementById('productListTitle');
    const content = document.getElementById('productListContent');

    title.textContent = `${brandName} - Products`;
    content.innerHTML = `<p style="text-align: center; color: #94a3b8; padding: 30px;"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</p>`;
    modal.style.display = 'flex';

    try {
        const ids = productIds.split(',').filter(id => id);
        
        const { data: products, error } = await supabaseClient
            .from('products')
            .select(`
                id,
                product_name,
                conversion_rate,
                batches (
                    batch_number,
                    expiry_date,
                    cost_price,
                    total_qty
                )
            `)
            .in('id', ids)
            .order('product_name', { ascending: true });

        if (error) throw error;

        if (products.length === 0) {
            content.innerHTML = `<p style="text-align: center; color: #94a3b8; padding: 30px;">No products found for this brand.</p>`;
            return;
        }

        content.innerHTML = products.map(p => {
            let totalQty = 0;
            let totalValue = 0;
            let batchDetails = '';

            p.batches.forEach(b => {
                const qty = b.total_qty || 0;
                totalQty += qty;
                totalValue += (b.cost_price || 0) * qty;
                
                batchDetails += `
                    <div style="font-size: 0.85rem; color: #64748b; margin-left: 20px; padding: 4px 0;">
                        Batch: ${b.batch_number || 'N/A'} | 
                        Expiry: ${b.expiry_date ? new Date(b.expiry_date).toLocaleDateString() : 'N/A'} | 
                        Qty: ${qty} | 
                        Cost/Unit: K${(b.cost_price || 0).toFixed(2)}
                    </div>
                `;
            });

            return `
                <div style="padding: 12px 15px; border-bottom: 1px solid #f1f5f9; background: #f8fafc; margin-bottom: 10px; border-radius: 6px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <strong style="font-size: 1.05rem;">${p.product_name}</strong>
                            <span style="margin-left: 15px; color: #64748b; font-size: 0.9rem;">
                                Total Qty: <strong>${totalQty}</strong> | 
                                Value: <strong style="color: #0f172a;">K${totalValue.toFixed(2)}</strong>
                            </span>
                        </div>
                        <button onclick="document.getElementById('batchDetails-${p.id}').style.display = document.getElementById('batchDetails-${p.id}').style.display === 'none' ? 'block' : 'none'" 
                                style="background: none; border: none; color: #3b82f6; cursor: pointer; font-size: 0.85rem;">
                            <i class="fa-solid fa-chevron-down"></i> Batches
                        </button>
                    </div>
                    <div id="batchDetails-${p.id}" style="display: none; margin-top: 10px; padding-top: 10px; border-top: 1px dashed #e2e8f0;">
                        ${batchDetails || '<div style="color: #94a3b8;">No batches recorded</div>'}
                    </div>
                </div>
            `;
        }).join('');

    } catch (error) {
        console.error("Error loading products:", error);
        content.innerHTML = `<p style="text-align: center; color: #dc2626; padding: 30px;">Error: ${error.message}</p>`;
    }
}