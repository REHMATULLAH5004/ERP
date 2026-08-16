// ============================================
// STOCK MOVEMENT MODULE - UPDATED
// ============================================

(async function initStockMovement() {
    console.log("📦 Stock Movement module initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // ============================================
    // GLOBAL STATE
    // ============================================
    const state = {
        products: [],
        batches: [],
        sales: [],
        donations: [],
        writeoffs: [],
        writeoffItems: [],
        purchaseOrders: [],
        poItems: [],
        grnLines: [],           // ← ADDED: GRN lines for purchase data
        stockCountBatches: [],  // 🔥 ADDED: Stock Take variance data
        categories: [],         // 🔥 ADDED: for resolving real category names
        currentStockDetail: null,
        currentProductId: null,
        sortField: 'product_name',
        sortDirection: 'asc'
    };

    // ============================================
    // LOAD DATA
    // ============================================

    async function loadProducts() {
        try {
            const { data, error } = await supabaseClient
                .from('products')
                .select('*')
                .order('product_name', { ascending: true });

            if (error) throw error;
            state.products = data || [];

            // 🔥 FIX: products.category doesn't exist as a plain text
            // column -- category is stored as category_id, a foreign key
            // to the categories table. Every reference to p.category
            // elsewhere in this file was reading undefined and silently
            // falling back to 'Uncategorized' for every single product,
            // regardless of its real category. Resolve the real name
            // once here so every downstream usage of p.category works
            // without needing to change anything else.
            await loadCategories();
            const categoryMap = {};
            state.categories.forEach(c => { categoryMap[c.id] = c.name; });
            state.products.forEach(p => {
                p.category = categoryMap[p.category_id] || 'Uncategorized';
            });

            console.log(`✅ Loaded ${state.products.length} products`);
            return state.products;
        } catch (error) {
            console.error('Error loading products:', error);
            state.products = [];
            return [];
        }
    }

    async function loadCategories() {
        try {
            const { data, error } = await supabaseClient
                .from('categories')
                .select('id, name');
            if (error) {
                console.warn('Error loading categories:', error);
                state.categories = [];
                return [];
            }
            state.categories = data || [];
            return state.categories;
        } catch (error) {
            console.error('Error loading categories:', error);
            state.categories = [];
            return [];
        }
    }

    async function loadBatches() {
        try {
            const { data, error } = await supabaseClient
                .from('batches')
                .select('*')
                .order('created_at', { ascending: true });

            if (error) throw error;
            state.batches = data || [];
            console.log(`✅ Loaded ${state.batches.length} batches`);
            return state.batches;
        } catch (error) {
            console.error('Error loading batches:', error);
            state.batches = [];
            return [];
        }
    }

    // ============================================
    // LOAD GRN LINES - For Purchase Data
    // ============================================
    async function loadGRNLines() {
        try {
            // 🔥 FIX: this query had goods_receipt_notes embedded INSIDE
            // itself (a malformed self-nested join) plus an entirely
            // unused purchase_orders join -- nothing in this file reads
            // po_number or status. That malformed join made the query
            // fail every time, and since the error was only console.warn'd
            // (never surfaced to the UI), state.grnLines silently stayed
            // empty forever, regardless of how many real purchases
            // existed -- exactly why Purchases always showed 0 while
            // Current Stock (read directly from batches.total_qty) was
            // still correct. Simplified to the one thing this file
            // actually needs from the join: the GRN number for display.
            const { data, error } = await supabaseClient
                .from('goods_receipt_lines')
                .select(`
                    *,
                    goods_receipt_notes (
                        grn_number
                    )
                `)
                .order('created_at', { ascending: true });

            if (error) {
                console.warn('Error loading GRN lines:', error);
                state.grnLines = [];
                return [];
            }
            state.grnLines = data || [];
            console.log(`✅ Loaded ${state.grnLines.length} GRN lines`);
            return state.grnLines;
        } catch (error) {
            console.error('Error loading GRN lines:', error);
            state.grnLines = [];
            return [];
        }
    }

    // ============================================
    // 🔥 ADDED: LOAD STOCK TAKE VARIANCE DATA
    // ============================================
    // The Stock Take module writes actual counts here (stock_counts +
    // stock_count_batches, with system_qty/physical_qty/variance per
    // batch). This page never queried either table, so any product that
    // had a stock take done on it would never satisfy
    // Opening + Movement = Closing -- the variance was real and already
    // baked into batches.total_qty (Current Stock), but invisible as a
    // line item here.
    async function loadStockCountBatches() {
        try {
            const { data, error } = await supabaseClient
                .from('stock_count_batches')
                .select('*, stock_counts(date)');

            if (error) {
                console.warn('Error loading stock count batches:', error);
                state.stockCountBatches = [];
                return [];
            }
            // Sort client-side by the joined stock_counts.date, since
            // stock_count_batches itself may not have its own created_at.
            state.stockCountBatches = (data || []).sort((a, b) =>
                new Date(a.stock_counts?.date || 0) - new Date(b.stock_counts?.date || 0)
            );
            console.log(`✅ Loaded ${state.stockCountBatches.length} stock take variance records`);
            return state.stockCountBatches;
        } catch (error) {
            console.error('Error loading stock count batches:', error);
            state.stockCountBatches = [];
            return [];
        }
    }

    async function loadSales() {
        try {
            // 🔥 FIX: was filtering by status = 'COMPLETED', but status
            // tracks payment/claim settlement, not whether the sale
            // actually happened -- an NHIMA sale sitting in "Pending"
            // status while its claim settles was being silently excluded
            // from stock movement entirely, even though the goods were
            // already dispensed and batches.total_qty already reduced.
            // is_quotation is the correct signal: false/null means a real
            // completed sale, true means a draft quote with no stock
            // impact. Using .neq(...,true) rather than .eq(...,false)
            // since some sale paths never set this column explicitly
            // (defaults to NULL), and .eq('is_quotation', false) would
            // incorrectly exclude those NULL rows too.
            // 🔥 FIX: Donations and Write-offs are BOTH stored as rows in
            // this same sales table -- Donations via client_type =
            // 'DONATION' (the actual sale record), Write-offs via
            // client_type = 'WRITEOFF' (an audit-trail row writeoff.js
            // creates for reporting). Without excluding these, every
            // donation and write-off was being counted correctly once in
            // its own dedicated column AND a second time here, inflating
            // Sales and double-subtracting from Current Stock.
            const { data, error } = await supabaseClient
                .from('sales')
                .select('*')
                .neq('is_quotation', true)
                .neq('client_type', 'DONATION')
                .neq('client_type', 'WRITEOFF')
                .order('created_at', { ascending: true });

            if (error) {
                console.warn('Error loading sales:', error);
                state.sales = [];
                return [];
            }
            state.sales = data || [];
            console.log(`✅ Loaded ${state.sales.length} sales`);
            return state.sales;
        } catch (error) {
            console.error('Error loading sales:', error);
            state.sales = [];
            return [];
        }
    }

    async function loadDonations() {
        try {
            // Same fix as loadSales() -- see notes there.
            const { data, error } = await supabaseClient
                .from('sales')
                .select('*')
                .eq('client_type', 'DONATION')
                .neq('is_quotation', true)
                .order('created_at', { ascending: true });

            if (error) {
                console.warn('Error loading donations:', error);
                state.donations = [];
                return [];
            }
            state.donations = data || [];
            console.log(`✅ Loaded ${state.donations.length} donations`);
            return state.donations;
        } catch (error) {
            console.error('Error loading donations:', error);
            state.donations = [];
            return [];
        }
    }

    async function loadWriteoffs() {
        try {
            const { data, error } = await supabaseClient
                .from('write_offs')
                .select('*')
                .order('created_at', { ascending: true });

            if (error) {
                console.warn('Error loading write-offs:', error);
                state.writeoffs = [];
                state.writeoffItems = [];
                return [];
            }
            state.writeoffs = data || [];
            
            if (state.writeoffs.length > 0) {
                const woIds = state.writeoffs.map(wo => wo.id);
                const { data: woItems, error: woItemError } = await supabaseClient
                    .from('write_off_items')
                    .select('*')
                    .in('write_off_id', woIds);

                if (!woItemError && woItems) {
                    state.writeoffItems = woItems;
                } else {
                    state.writeoffItems = [];
                }
            } else {
                state.writeoffItems = [];
            }
            
            console.log(`✅ Loaded ${state.writeoffs.length} write-offs`);
            return state.writeoffs;
        } catch (error) {
            console.error('Error loading write-offs:', error);
            state.writeoffs = [];
            state.writeoffItems = [];
            return [];
        }
    }

    // ============================================
    // CALCULATE STOCK MOVEMENT
    // ============================================

    // ============================================
    // 🔥 pack-size multiplier for sale/donation items
    // ============================================
    // Per the actual business rule: if the sale's client_sub_type is
    // 'NHIMA', item.qty already represents individual units (no
    // multiplication needed). For every other sub-type (REGULAR, ONLINE,
    // STAFF, DONATION, wholesale's REGULAR/INTERNAL, etc.), item.qty
    // represents PACKS and must be multiplied by pack size to get actual
    // units. Checked at the sale level (client_sub_type), not inferred
    // from the pack_size display string.
    function getSaleQtyMultiplier(sale, item) {
        if (sale.client_sub_type === 'NHIMA') return 1;
        const parsed = parseInt(item.pack_size);
        return isNaN(parsed) || parsed <= 0 ? 1 : parsed;
    }

    function calculateStockMovement() {
        return state.products.map(product => {
            // Get batches for this product
            const productBatches = state.batches.filter(b => b.product_id === product.id);
            
            // ---- OPENING STOCK ----
            // Method 1: If batches have opening_qty column, use it
            // Method 2: First batch's total_qty is considered opening stock
            // Method 3: Sum of all batches that were created as opening (is_opening = true)
            let openingStock = 0;
            
            // Check if any batch has opening_qty set
            const hasOpeningQty = productBatches.some(b => (b.opening_qty || 0) > 0);
            
            if (hasOpeningQty) {
                // Use opening_qty from batches
                openingStock = productBatches.reduce((sum, b) => sum + (b.opening_qty || 0), 0);
            } else if (productBatches.length > 0) {
                // Fallback: First batch's total_qty is opening stock
                // Sort by created_at to get the earliest batch
                const sortedBatches = [...productBatches].sort((a, b) => 
                    new Date(a.created_at) - new Date(b.created_at)
                );
                // The first batch's total quantity is the opening stock
                openingStock = sortedBatches[0]?.total_qty || 0;
            }

            // ---- PURCHASES (Stock In) ----
            // Get purchase quantity from GRN lines
            let totalPurchased = 0;
            
            // Method 1: If batches have purchased_qty column
            const hasPurchasedQty = productBatches.some(b => (b.purchased_qty || 0) > 0);
            
            if (hasPurchasedQty) {
                totalPurchased = productBatches.reduce((sum, b) => sum + (b.purchased_qty || 0), 0);
            } else {
                // 🔥 FIX: gl.received_quantity is the number of PACKS
                // received (matches how Purchase's GRN posting stores it
                // -- see updateInventory(), which does exactly this same
                // received_quantity * pack_size to get the actual unit
                // count added to batches.total_qty). Every other column
                // here (Opening, Current, Sold, Donated, etc.) is in
                // units/each, so this needs the same multiplication or
                // Purchases would be reported in a completely different
                // unit than everything around it.
                const productGRNLines = state.grnLines.filter(gl => gl.product_id === product.id);
                totalPurchased = productGRNLines.reduce((sum, gl) => sum + ((gl.received_quantity || 0) * (gl.pack_size || 1)), 0);
            }

            // ---- CURRENT STOCK ----
            let currentStock = productBatches.reduce((sum, b) => sum + (b.total_qty || 0), 0);

            // ---- SALES ----
            // 🔥 FIX: is_quotation filtering now handled in loadSales();
            // this is the unit-multiplier fix. Per the actual business
            // rule (checked via sale.client_sub_type, not inferred from
            // pack_size formatting): NHIMA sales record qty as actual
            // units already; every other sub-type records qty as packs.
            let totalSold = 0;
            state.sales.forEach(sale => {
                const items = sale.items || [];
                items.forEach(item => {
                    if (item.product_id === product.id) {
                        totalSold += (item.qty || 0) * getSaleQtyMultiplier(sale, item);
                    }
                });
            });

            // ---- DONATIONS ----
            // Donations share the same sales table/rule (client_sub_type
            // is always 'DONATION', never 'NHIMA', so this always
            // multiplies -- correct, since donations are recorded in
            // packs like every other non-NHIMA sale).
            let totalDonated = 0;
            state.donations.forEach(donation => {
                const items = donation.items || [];
                items.forEach(item => {
                    if (item.product_id === product.id) {
                        totalDonated += (item.qty || 0) * getSaleQtyMultiplier(donation, item);
                    }
                });
            });

            // ---- WRITE-OFFS ----
            let totalWrittenOff = 0;
            if (state.writeoffItems) {
                state.writeoffItems.forEach(woItem => {
                    if (woItem.product_id === product.id) {
                        totalWrittenOff += woItem.qty_written_off || 0;
                    }
                });
            }

            // ---- EXPIRED ----
            let totalExpired = 0;
            productBatches.forEach(batch => {
                if (batch.expiry_date) {
                    const expiryDate = new Date(batch.expiry_date);
                    const today = new Date();
                    if (expiryDate < today && batch.total_qty > 0) {
                        totalExpired += batch.total_qty;
                    }
                }
            });

            // ---- STOCK TAKE VARIANCE ----
            // 🔥 ADDED: net variance from all stock takes done on this
            // product (sum of stock_count_batches.variance, positive =
            // more found than expected, negative = shrinkage). This was
            // completely missing before -- batches.total_qty (Current
            // Stock) already reflects it since Stock Take updates batches
            // directly, but it never showed up as a line item, so
            // Opening + Movement never actually equaled Closing for any
            // product that had a stock take done on it.
            const productStockCounts = state.stockCountBatches.filter(sc => sc.product_id === product.id);
            const totalStockTakeVariance = productStockCounts.reduce((sum, sc) => sum + (sc.variance || 0), 0);

            // ---- CALCULATE TOTALS ----
            const totalStockOut = totalSold + totalDonated + totalWrittenOff + totalExpired;
            const totalStockIn = totalPurchased;

            // 🔥 ADDED: the actual "Opening + Movement = Closing" check --
            // now that Stock Take Variance is included, this should hold
            // for every product. If it doesn't, something else is moving
            // stock without going through any of the tracked channels.
            const expectedClosing = openingStock + totalStockIn - totalStockOut + totalStockTakeVariance;
            const isReconciled = Math.abs(expectedClosing - currentStock) < 0.01;

            return {
                ...product,
                openingStock,
                totalPurchased,
                totalSold,
                totalDonated,
                totalWrittenOff,
                totalExpired,
                totalStockTakeVariance,
                totalStockIn,
                totalStockOut,
                currentStock,
                expectedClosing,
                isReconciled,
                batches: productBatches
            };
        });
    }

    // ============================================
    // RENDER FUNCTIONS
    // ============================================

    function renderStockList(data = null) {
        const stockData = data || calculateStockMovement();
        const tbody = document.getElementById('stockTableBody');
        const countSpan = document.getElementById('stockListCount');
        const countMain = document.getElementById('stockCount');

        if (!tbody) return;

        // Filter by search
        const searchTerm = document.getElementById('searchStock')?.value?.toLowerCase() || '';
        const categoryFilter = document.getElementById('stockCategoryFilter')?.value || 'all';

        let filtered = stockData;

        if (searchTerm) {
            filtered = filtered.filter(p => 
                p.product_name.toLowerCase().includes(searchTerm) ||
                (p.category && p.category.toLowerCase().includes(searchTerm))
            );
        }

        if (categoryFilter !== 'all') {
            filtered = filtered.filter(p => p.category === categoryFilter);
        }

        // Update category filter options
        const categories = [...new Set(stockData.map(p => p.category).filter(Boolean))];
        const catFilter = document.getElementById('stockCategoryFilter');
        if (catFilter) {
            const currentValue = catFilter.value;
            catFilter.innerHTML = '<option value="all">All Categories</option>';
            categories.forEach(cat => {
                catFilter.innerHTML += `<option value="${cat}">${cat}</option>`;
            });
            catFilter.value = currentValue;
        }

        // Sort
        filtered.sort((a, b) => {
            let aVal = a[state.sortField] || '';
            let bVal = b[state.sortField] || '';
            
            if (typeof aVal === 'string') {
                aVal = aVal.toLowerCase();
                bVal = bVal.toLowerCase();
            }
            
            if (aVal < bVal) return state.sortDirection === 'asc' ? -1 : 1;
            if (aVal > bVal) return state.sortDirection === 'asc' ? 1 : -1;
            return 0;
        });

        if (filtered.length === 0) {
            tbody.innerHTML = `<tr><td colspan="12" style="text-align: center; padding: 40px; color: #94a3b8;">
                <i class="fa-regular fa-circle-check" style="font-size: 2rem; display: block; margin-bottom: 10px;"></i>
                ${stockData.length === 0 ? 'No products found' : 'No products match the filters.'}
            </td></tr>`;
            if (countSpan) countSpan.textContent = '0 products';
            if (countMain) countMain.textContent = '0 products';
            updateStats([]);
            return;
        }

        tbody.innerHTML = filtered.map(p => `
            <tr>
                <td style="padding-left: 20px;">
                    <span class="product-name-link" onclick="openStockDetail('${p.id}')">${p.product_name}</span>
                </td>
                <td style="text-align: center;">
                    <span class="category-badge">${p.category || 'Uncategorized'}</span>
                </td>
                <td style="text-align: right;">
                    <span class="clickable-qty" onclick="openStockMovementDetail('${p.id}', 'opening')" title="Click to view details">
                        ${formatNumber(p.openingStock)}
                    </span>
                </td>
                <td style="text-align: right;">
                    <span class="clickable-qty positive" onclick="openStockMovementDetail('${p.id}', 'in')" title="Click to view purchase details">
                        ${formatNumber(p.totalPurchased)}
                    </span>
                </td>
                <td style="text-align: right;">
                    <span class="clickable-qty negative" onclick="openStockMovementDetail('${p.id}', 'out')" title="Click to view sale details">
                        ${formatNumber(p.totalSold)}
                    </span>
                </td>
                <td style="text-align: right;">
                    <span class="clickable-qty" style="color: #8b5cf6;" onclick="openStockMovementDetail('${p.id}', 'donation')" title="Click to view donation details">
                        ${formatNumber(p.totalDonated)}
                    </span>
                </td>
                <td style="text-align: right;">
                    <span class="clickable-qty" style="color: #ef4444;" onclick="openStockMovementDetail('${p.id}', 'writeoff')" title="Click to view write-off details">
                        ${formatNumber(p.totalWrittenOff)}
                    </span>
                </td>
                <td style="text-align: right;">
                    <span class="clickable-qty" style="color: #f59e0b;" onclick="openStockMovementDetail('${p.id}', 'expired')" title="Click to view expired details">
                        ${formatNumber(p.totalExpired)}
                    </span>
                </td>
                <td style="text-align: right;">
                    <span class="clickable-qty" style="color: ${p.totalStockTakeVariance > 0 ? '#059669' : p.totalStockTakeVariance < 0 ? '#dc2626' : '#94a3b8'};" onclick="openStockMovementDetail('${p.id}', 'stocktake')" title="Click to view stock take variance details">
                        ${p.totalStockTakeVariance > 0 ? '+' : ''}${formatNumber(p.totalStockTakeVariance)}
                    </span>
                </td>
                <td style="text-align: right;">
                    <span class="clickable-qty ${p.currentStock > 0 ? 'positive' : p.currentStock < 0 ? 'negative' : 'zero'}" onclick="openStockDetail('${p.id}')" title="Click to view details" style="font-weight: bold; font-size: 1.1rem;">
                        ${formatNumber(p.currentStock)}
                    </span>
                </td>
                <td style="text-align: center;" title="${p.isReconciled ? 'Opening + Movement = Closing ✓' : `Expected ${formatNumber(p.expectedClosing)} but Current Stock shows ${formatNumber(p.currentStock)} -- something is moving this product's stock outside the tracked channels`}">
                    ${p.isReconciled
                        ? '<i class="fa-solid fa-circle-check" style="color: #059669;"></i>'
                        : '<i class="fa-solid fa-triangle-exclamation" style="color: #dc2626;"></i>'}
                </td>
                <td style="padding-right: 20px; text-align: center;">
                    <button class="btn btn-sm btn-primary" onclick="openStockDetail('${p.id}')" title="View Details">
                        <i class="fa-solid fa-eye"></i>
                    </button>
                </td>
            </tr>
        `).join('');

        if (countSpan) countSpan.textContent = `${filtered.length} products`;
        if (countMain) countMain.textContent = `${filtered.length} products`;
        updateStats(filtered);
    }

    function updateStats(filteredData) {
        const totalProducts = filteredData.length;
        const totalStockIn = filteredData.reduce((sum, p) => sum + p.totalStockIn, 0);
        const totalStockOut = filteredData.reduce((sum, p) => sum + p.totalStockOut, 0);
        const totalCurrent = filteredData.reduce((sum, p) => sum + p.currentStock, 0);

        document.getElementById('totalProducts').textContent = totalProducts;
        document.getElementById('totalStockIn').textContent = formatNumber(totalStockIn);
        document.getElementById('totalStockOut').textContent = formatNumber(totalStockOut);
        document.getElementById('currentStock').textContent = formatNumber(totalCurrent);
    }

    // ============================================
    // SORT FUNCTION
    // ============================================

    function sortStockBy(field) {
        if (state.sortField === field) {
            state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            state.sortField = field;
            state.sortDirection = 'asc';
        }
        renderStockList();
    }

    // ============================================
    // STOCK DETAIL MODAL
    // ============================================

    async function openStockDetail(productId) {
        try {
            const product = state.products.find(p => p.id === productId);
            if (!product) {
                showToast('Product not found', 'error');
                return;
            }

            const stockData = calculateStockMovement().find(p => p.id === productId);
            if (!stockData) {
                showToast('Stock data not found', 'error');
                return;
            }

            state.currentStockDetail = stockData;
            state.currentProductId = productId;

            renderStockDetail(stockData);
            document.getElementById('stockDetailModal').classList.add('show');
        } catch (error) {
            console.error('Error opening stock detail:', error);
            showToast('Error loading stock details: ' + error.message, 'error');
        }
    }

    function renderStockDetail(data) {
        const content = document.getElementById('stockDetailContent');

        let html = `
            <div style="margin-bottom: 20px;">
                <h3 style="margin: 0; color: #0f172a;">${data.product_name}</h3>
                <p style="color: #64748b; margin: 5px 0 0 0;">
                    Category: ${data.category || 'Uncategorized'} | 
                    Product ID: ${data.id.substring(0, 8)}
                </p>
            </div>

            <div class="stock-summary-grid">
                <div class="stock-summary-box">
                    <h6>📥 Stock In</h6>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                        <div>
                            <div style="font-size: 0.7rem; color: #64748b;">Opening Stock</div>
                            <div style="font-weight: 600;">${formatNumber(data.openingStock)}</div>
                        </div>
                        <div>
                            <div style="font-size: 0.7rem; color: #64748b;">Purchases (GRN)</div>
                            <div style="font-weight: 600; color: #059669;">+${formatNumber(data.totalPurchased)}</div>
                        </div>
                    </div>
                    <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid #e2e8f0;">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span style="font-weight: 600;">Total Stock In</span>
                            <span class="total in">${formatNumber(data.totalStockIn)}</span>
                        </div>
                    </div>
                </div>

                <div class="stock-summary-box">
                    <h6>📤 Stock Out</h6>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                        <div>
                            <div style="font-size: 0.7rem; color: #64748b;">Sales</div>
                            <div style="font-weight: 600; color: #dc2626;">-${formatNumber(data.totalSold)}</div>
                        </div>
                        <div>
                            <div style="font-size: 0.7rem; color: #64748b;">Donations</div>
                            <div style="font-weight: 600; color: #8b5cf6;">-${formatNumber(data.totalDonated)}</div>
                        </div>
                        <div>
                            <div style="font-size: 0.7rem; color: #64748b;">Write-Offs</div>
                            <div style="font-weight: 600; color: #ef4444;">-${formatNumber(data.totalWrittenOff)}</div>
                        </div>
                        <div>
                            <div style="font-size: 0.7rem; color: #64748b;">Expired</div>
                            <div style="font-weight: 600; color: #f59e0b;">-${formatNumber(data.totalExpired)}</div>
                        </div>
                    </div>
                    <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid #e2e8f0;">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span style="font-weight: 600;">Total Stock Out</span>
                            <span class="total out">${formatNumber(data.totalStockOut)}</span>
                        </div>
                    </div>
                </div>
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 20px;">
                <div class="stock-summary-box" style="background: #ecfdf5; border-color: #10b981;">
                    <h6 style="color: #059669;">📊 Current Stock</h6>
                    <div style="font-size: 2rem; font-weight: 700; color: #059669; text-align: center; padding: 10px;">
                        ${formatNumber(data.currentStock)}
                    </div>
                </div>
                <div class="stock-summary-box" style="background: ${data.currentStock <= 10 ? '#fef2f2' : '#f0fdf4'}; border-color: ${data.currentStock <= 10 ? '#ef4444' : '#22c55e'};">
                    <h6 style="color: ${data.currentStock <= 10 ? '#dc2626' : '#059669'};">⚠️ Stock Alert</h6>
                    <div style="font-size: 1rem; text-align: center; padding: 10px; color: #64748b;">
                        ${data.currentStock <= 10 ? 
                            `<span style="color: #dc2626; font-weight: 700;">⚠️ Low Stock! Only ${formatNumber(data.currentStock)} units remaining</span>` : 
                            `<span style="color: #059669;">✅ Stock level is adequate (${formatNumber(data.currentStock)} units)</span>`
                        }
                    </div>
                </div>
            </div>
        `;

        // Batches section
        if (data.batches && data.batches.length > 0) {
            html += `
                <div style="margin-top: 20px;">
                    <h5 style="margin: 0 0 10px 0; color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px;">
                        📦 Batches (${data.batches.length})
                    </h5>
                    <div class="table-responsive">
                        <table class="detail-table">
                            <thead>
                                <tr>
                                    <th>Batch Number</th>
                                    <th>Opening Stock</th>
                                    <th>Purchases (GRN)</th>
                                    <th>Current Stock</th>
                                    <th>Expiry Date</th>
                                    <th>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${data.batches.map(batch => {
                                    const isExpired = batch.expiry_date && new Date(batch.expiry_date) < new Date();
                                    const status = isExpired ? 'Expired' : (batch.total_qty > 0 ? 'Active' : 'Depleted');
                                    const statusColor = isExpired ? '#ef4444' : (batch.total_qty > 0 ? '#059669' : '#f59e0b');
                                    
                                    const opening = batch.opening_qty || 0;
                                    const purchased = batch.purchased_qty || 0;
                                    
                                    return `
                                        <tr>
                                            <td><strong>${batch.batch_number}</strong></td>
                                            <td>${formatNumber(opening)}</td>
                                            <td style="color: #059669;">+${formatNumber(purchased)}</td>
                                            <td style="font-weight: 600;">${formatNumber(batch.total_qty || 0)}</td>
                                            <td>${batch.expiry_date ? new Date(batch.expiry_date).toLocaleDateString() : 'N/A'}</td>
                                            <td>
                                                <span style="background: ${statusColor}; color: white; padding: 2px 10px; border-radius: 10px; font-size: 0.7rem;">
                                                    ${status}
                                                </span>
                                            </td>
                                        </tr>
                                    `;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;
        }

        content.innerHTML = html;
    }

    // ============================================
    // STOCK MOVEMENT DETAIL MODAL (Click on Qty)
    // ============================================

    async function openStockMovementDetail(productId, movementType) {
        try {
            const product = state.products.find(p => p.id === productId);
            if (!product) {
                showToast('Product not found', 'error');
                return;
            }

            const stockData = calculateStockMovement().find(p => p.id === productId);
            if (!stockData) {
                showToast('Stock data not found', 'error');
                return;
            }

            let title = '';
            let items = [];
            let total = 0;
            let isIn = false;

            switch (movementType) {
                case 'opening':
                    title = `Opening Stock - ${product.product_name}`;
                    items = stockData.batches.map(b => ({
                        date: b.created_at ? new Date(b.created_at).toLocaleDateString() : 'N/A',
                        description: `Batch: ${b.batch_number}`,
                        qty: b.opening_qty || 0,
                        type: 'opening',
                        batch: b
                    }));
                    total = stockData.openingStock;
                    isIn = true;
                    break;

                case 'in':
                    title = `Stock In (Purchases from GRN) - ${product.product_name}`;
                    // Get GRN lines for this product
                    const productGRNLines = state.grnLines.filter(gl => gl.product_id === productId);
                    
                    // 🔥 FIX: qty is now the actual UNIT total (packs ×
                    // pack size), matching every other movement type in
                    // this modal -- previously this showed the raw pack
                    // count while everything else was in units, and the
                    // correctly-computed unit total sat unused in a field
                    // nobody displayed as the primary number. Pack count
                    // is now shown as supporting detail instead.
                    items = productGRNLines.map(gl => {
                        const packSize = gl.pack_size || 1;
                        const receivedPacks = gl.received_quantity || 0;
                        return {
                            date: gl.created_at ? new Date(gl.created_at).toLocaleDateString() : 'N/A',
                            description: `GRN: ${gl.goods_receipt_notes?.grn_number || 'N/A'} | ${gl.product_name || product.product_name}`,
                            qty: receivedPacks * packSize,
                            type: 'in',
                            reference: gl.goods_receipt_notes?.grn_number || 'N/A',
                            packSize: packSize,
                            receivedPacks: receivedPacks,
                            rate: gl.purchase_rate || 0
                        };
                    });
                    total = stockData.totalPurchased;
                    isIn = true;
                    break;

                case 'out':
                    title = `Stock Out (Sales) - ${product.product_name}`;
                    state.sales.forEach(sale => {
                        const saleItems = sale.items || [];
                        saleItems.forEach(item => {
                            if (item.product_id === productId) {
                                const multiplier = getSaleQtyMultiplier(sale, item);
                                items.push({
                                    date: sale.created_at ? new Date(sale.created_at).toLocaleDateString() : 'N/A',
                                    description: `Sale: ${sale.sale_id} | ${item.product_name}`,
                                    qty: (item.qty || 0) * multiplier,
                                    type: 'out',
                                    reference: sale.sale_id,
                                    customer: sale.customer_data?.full_name || 'N/A',
                                    clientType: sale.client_type || 'RETAIL',
                                    packInfo: multiplier > 1 ? `${item.qty} pack(s) × ${multiplier} units/pack` : null
                                });
                            }
                        });
                    });
                    total = stockData.totalSold;
                    isIn = false;
                    break;

                case 'donation':
                    title = `Stock Out (Donations) - ${product.product_name}`;
                    state.donations.forEach(donation => {
                        const donationItems = donation.items || [];
                        donationItems.forEach(item => {
                            if (item.product_id === productId) {
                                const multiplier = getSaleQtyMultiplier(donation, item);
                                items.push({
                                    date: donation.created_at ? new Date(donation.created_at).toLocaleDateString() : 'N/A',
                                    description: `Donation: ${donation.sale_id} | ${item.product_name}`,
                                    qty: (item.qty || 0) * multiplier,
                                    type: 'out',
                                    reference: donation.sale_id,
                                    donee: donation.customer_data?.full_name || 'N/A',
                                    packInfo: multiplier > 1 ? `${item.qty} pack(s) × ${multiplier} units/pack` : null
                                });
                            }
                        });
                    });
                    total = stockData.totalDonated;
                    isIn = false;
                    break;

                case 'writeoff':
                    title = `Stock Out (Write-Offs) - ${product.product_name}`;
                    if (state.writeoffItems) {
                        state.writeoffItems.forEach(woItem => {
                            if (woItem.product_id === productId) {
                                const wo = state.writeoffs.find(w => w.id === woItem.write_off_id);
                                items.push({
                                    date: wo?.date || wo?.created_at ? new Date(wo.date || wo.created_at).toLocaleDateString() : 'N/A',
                                    description: `Write-Off: ${wo?.reference_number || 'N/A'} | ${woItem.product_name}`,
                                    qty: woItem.qty_written_off || 0,
                                    type: 'out',
                                    reference: wo?.reference_number || 'N/A',
                                    reason: wo?.reason || 'N/A'
                                });
                            }
                        });
                    }
                    total = stockData.totalWrittenOff;
                    isIn = false;
                    break;

                case 'expired':
                    title = `Stock Out (Expired) - ${product.product_name}`;
                    stockData.batches.forEach(batch => {
                        if (batch.expiry_date && new Date(batch.expiry_date) < new Date()) {
                            items.push({
                                date: new Date(batch.expiry_date).toLocaleDateString(),
                                description: `Batch: ${batch.batch_number} - Expired`,
                                qty: batch.total_qty || 0,
                                type: 'out',
                                reference: batch.batch_number,
                                expiryDate: batch.expiry_date
                            });
                        }
                    });
                    total = stockData.totalExpired;
                    isIn = false;
                    break;

                // 🔥 ADDED: Stock Take Variance detail. Unlike the other
                // types, individual entries here can be BOTH positive
                // (found more than expected) and negative (shrinkage)
                // within the same product's history -- so each row keeps
                // its own sign rather than a single shared in/out
                // direction.
                case 'stocktake':
                    title = `Stock Take Variance - ${product.product_name}`;
                    state.stockCountBatches
                        .filter(sc => sc.product_id === productId)
                        .forEach(sc => {
                            items.push({
                                date: sc.stock_counts?.date ? new Date(sc.stock_counts.date).toLocaleDateString() : 'N/A',
                                description: `Batch: ${sc.batch_number || 'N/A'} | System: ${formatNumber(sc.system_qty)} → Physical: ${formatNumber(sc.physical_qty)}`,
                                qty: sc.variance || 0,
                                type: 'variance',
                                reference: sc.batch_number || 'N/A'
                            });
                        });
                    total = stockData.totalStockTakeVariance;
                    isIn = total >= 0;
                    break;

                default:
                    showToast('Invalid movement type', 'error');
                    return;
            }

            // Sort items by date
            items.sort((a, b) => a.date.localeCompare(b.date));

            // Remove zero qty items
            // 🔥 FIX: for every other movement type, qty <= 0 genuinely
            // means "nothing happened" and should be dropped. But for
            // stock take variance, a negative value means real shrinkage
            // -- filtering those out would silently hide exactly the kind
            // of loss this column exists to surface.
            items = movementType === 'stocktake'
                ? items.filter(item => item.qty !== 0)
                : items.filter(item => item.qty > 0);

            if (items.length === 0) {
                showToast('No movement data found for this type', 'info');
                return;
            }

            renderStockMovementDetail(title, items, total, movementType, product);
            document.getElementById('stockMovementDetailModal').classList.add('show');
        } catch (error) {
            console.error('Error opening stock movement detail:', error);
            showToast('Error loading movement details: ' + error.message, 'error');
        }
    }

    function renderStockMovementDetail(title, items, total, type, product) {
        const content = document.getElementById('stockMovementDetailContent');

        const isStocktake = type === 'stocktake';
        const isIn = type === 'in' || type === 'opening' || (isStocktake && total >= 0);
        const totalColor = isIn ? '#059669' : '#dc2626';
        // 🔥 FIX: formatNumber() already includes a native minus sign for
        // negative numbers (it uses toLocaleString, not an abs-based
        // formatter) -- for stocktake, prepending our own '-' on top of
        // that would show "--5" for a shrinkage of 5. Only add an
        // explicit '+' for positive stocktake totals; everything else
        // keeps the existing prefix logic since those quantities are
        // always stored as positive magnitudes.
        const totalPrefix = isStocktake ? (total >= 0 ? '+' : '') : (isIn ? '+' : '-');

        let html = `
            <div style="margin-bottom: 20px;">
                <h3 style="margin: 0; color: #0f172a;">${title}</h3>
                <p style="color: #64748b; margin: 5px 0 0 0;">
                    Product: ${product.product_name} | 
                    Category: ${product.category || 'Uncategorized'}
                </p>
            </div>

            <div style="background: #f8fafc; padding: 15px 20px; border-radius: 6px; margin-bottom: 20px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-weight: 600; font-size: 1.1rem;">${isStocktake ? 'Net Stock Take Variance' : (isIn ? 'Total Stock In' : 'Total Stock Out')}</span>
                    <span style="font-size: 1.5rem; font-weight: 700; color: ${totalColor};">
                        ${totalPrefix}${formatNumber(total)}
                    </span>
                </div>
                <div style="margin-top: 8px; font-size: 0.85rem; color: #64748b;">
                    ${items.length} transaction(s)
                </div>
            </div>

            <div class="table-responsive">
                <table class="detail-table">
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>Date</th>
                            <th>Description</th>
                            <th style="text-align: right;">Qty</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${items.map((item, index) => {
                            const rowPrefix = isStocktake ? (item.qty > 0 ? '+' : '') : (isIn ? '+' : '-');
                            const rowColor = isStocktake ? (item.qty > 0 ? '#059669' : '#dc2626') : (isIn ? '#059669' : '#dc2626');
                            return `
                            <tr>
                                <td>${index + 1}</td>
                                <td>${item.date}</td>
                                <td>
                                    ${item.description}
                                    ${item.customer ? `<br><small style="color: #64748b;">Customer: ${item.customer}</small>` : ''}
                                    ${item.clientType ? `<br><small style="color: #64748b;">Type: ${item.clientType}</small>` : ''}
                                    ${item.donee ? `<br><small style="color: #64748b;">Donee: ${item.donee}</small>` : ''}
                                    ${item.reason ? `<br><small style="color: #64748b;">Reason: ${item.reason}</small>` : ''}
                                    ${item.packInfo ? `<br><small style="color: #64748b;">${item.packInfo}</small>` : ''}
                                    ${item.packSize ? `<br><small style="color: #64748b;">${item.receivedPacks} pack(s) × ${item.packSize} units/pack | Rate: ${formatNumber(item.rate)}</small>` : ''}
                                </td>
                                <td style="text-align: right; font-weight: 600; color: ${rowColor};">
                                    ${rowPrefix}${formatNumber(item.qty)}
                                </td>
                            </tr>
                        `; }).join('')}
                    </tbody>
                    <tfoot style="background: #f8fafc; font-weight: 700;">
                        <tr>
                            <td colspan="3" style="text-align: right;">${isStocktake ? 'Net Stock Take Variance' : (isIn ? 'Total Stock In' : 'Total Stock Out')}</td>
                            <td style="text-align: right; color: ${totalColor};">
                                ${totalPrefix}${formatNumber(total)}
                            </td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        `;

        content.innerHTML = html;
    }

    // ============================================
    // PRINT STOCK DETAIL
    // ============================================

    function printStockDetail() {
        const data = state.currentStockDetail;
        if (!data) {
            showToast('No data to print', 'error');
            return;
        }

        const printContent = `
            <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 1000px; margin: 0 auto;">
                <div style="text-align: center; border-bottom: 2px solid #333; padding-bottom: 15px; margin-bottom: 20px;">
                    <h2 style="margin: 0; color: #0f172a;">GRIFFINS MEDICALS LIMITED</h2>
                    <p style="margin: 3px 0; color: #475569;">Stock Movement Report</p>
                    <p style="margin: 3px 0; color: #475569; font-size: 0.9rem;">Generated on: ${new Date().toLocaleString()}</p>
                </div>

                <h3 style="color: #0f172a;">${data.product_name}</h3>
                <p style="color: #64748b;">Category: ${data.category || 'Uncategorized'} | Product ID: ${data.id.substring(0, 8)}</p>

                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 20px 0;">
                    <div style="background: #f8fafc; padding: 15px; border-radius: 6px; border: 1px solid #e2e8f0;">
                        <h6 style="margin: 0 0 10px 0; color: #475569;">📥 Stock In</h6>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                            <div><div style="font-size: 0.7rem; color: #64748b;">Opening Stock</div><strong>${formatNumber(data.openingStock)}</strong></div>
                            <div><div style="font-size: 0.7rem; color: #64748b;">Purchases (GRN)</div><strong style="color: #059669;">+${formatNumber(data.totalPurchased)}</strong></div>
                        </div>
                        <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid #e2e8f0;">
                            <div style="display: flex; justify-content: space-between;">
                                <span><strong>Total Stock In</strong></span>
                                <span style="color: #059669; font-weight: 700;">${formatNumber(data.totalStockIn)}</span>
                            </div>
                        </div>
                    </div>

                    <div style="background: #f8fafc; padding: 15px; border-radius: 6px; border: 1px solid #e2e8f0;">
                        <h6 style="margin: 0 0 10px 0; color: #475569;">📤 Stock Out</h6>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 5px;">
                            <div><div style="font-size: 0.7rem; color: #64748b;">Sales</div><strong style="color: #dc2626;">-${formatNumber(data.totalSold)}</strong></div>
                            <div><div style="font-size: 0.7rem; color: #64748b;">Donations</div><strong style="color: #8b5cf6;">-${formatNumber(data.totalDonated)}</strong></div>
                            <div><div style="font-size: 0.7rem; color: #64748b;">Write-Offs</div><strong style="color: #ef4444;">-${formatNumber(data.totalWrittenOff)}</strong></div>
                            <div><div style="font-size: 0.7rem; color: #64748b;">Expired</div><strong style="color: #f59e0b;">-${formatNumber(data.totalExpired)}</strong></div>
                        </div>
                        <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid #e2e8f0;">
                            <div style="display: flex; justify-content: space-between;">
                                <span><strong>Total Stock Out</strong></span>
                                <span style="color: #dc2626; font-weight: 700;">${formatNumber(data.totalStockOut)}</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div style="background: #ecfdf5; padding: 20px; border-radius: 6px; border: 2px solid #10b981; text-align: center; margin: 20px 0;">
                    <h4 style="margin: 0; color: #059669;">📊 Current Stock</h4>
                    <div style="font-size: 2rem; font-weight: 700; color: #059669;">${formatNumber(data.currentStock)}</div>
                </div>

                ${data.batches && data.batches.length > 0 ? `
                    <div style="margin-top: 20px;">
                        <h5 style="margin: 0 0 10px 0; color: #0f172a;">📦 Batches</h5>
                        <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
                            <thead>
                                <tr style="background: #f1f5f9;">
                                    <th style="padding: 8px; text-align: left; border: 1px solid #e2e8f0;">Batch Number</th>
                                    <th style="padding: 8px; text-align: right; border: 1px solid #e2e8f0;">Opening Stock</th>
                                    <th style="padding: 8px; text-align: right; border: 1px solid #e2e8f0;">Purchases (GRN)</th>
                                    <th style="padding: 8px; text-align: right; border: 1px solid #e2e8f0;">Current Stock</th>
                                    <th style="padding: 8px; text-align: center; border: 1px solid #e2e8f0;">Expiry Date</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${data.batches.map(batch => `
                                    <tr>
                                        <td style="padding: 8px; border: 1px solid #e2e8f0;"><strong>${batch.batch_number}</strong></td>
                                        <td style="padding: 8px; text-align: right; border: 1px solid #e2e8f0;">${formatNumber(batch.opening_qty || 0)}</td>
                                        <td style="padding: 8px; text-align: right; border: 1px solid #e2e8f0; color: #059669;">+${formatNumber(batch.purchased_qty || 0)}</td>
                                        <td style="padding: 8px; text-align: right; border: 1px solid #e2e8f0; font-weight: 600;">${formatNumber(batch.total_qty || 0)}</td>
                                        <td style="padding: 8px; text-align: center; border: 1px solid #e2e8f0;">${batch.expiry_date ? new Date(batch.expiry_date).toLocaleDateString() : 'N/A'}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                ` : ''}

                <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0; color: #64748b; font-size: 0.9rem;">
                    <p>This is a computer-generated stock movement report.</p>
                    <p><strong>Note:</strong> Opening Stock is from initial batch creation. Purchases are from GRN (Goods Receipt Notes).</p>
                </div>
            </div>
        `;

        const printWindow = window.open('', '_blank', 'width=800,height=600');
        if (!printWindow) {
            showToast('Please allow popups to print', 'error');
            return;
        }

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Stock Movement - ${data.product_name}</title>
                <style>
                    body { font-family: Arial, sans-serif; padding: 20px; }
                    @media print {
                        body { margin: 0; padding: 10px; }
                        .no-print { display: none; }
                    }
                </style>
            </head>
            <body>
                ${printContent}
                <script>
                    window.onload = function() {
                        window.print();
                    };
                <\/script>
            </body>
            </html>
        `);
        printWindow.document.close();
        setTimeout(() => {
            printWindow.focus();
        }, 500);
    }

    // ============================================
    // REFRESH
    // ============================================

    async function refreshStockMovement() {
        await loadProducts();
        await loadBatches();
        await loadGRNLines();        // ← ADDED: Load GRN lines for purchase data
        await loadSales();
        await loadDonations();
        await loadWriteoffs();
        await loadStockCountBatches();  // 🔥 ADDED: Load stock take variance data
        const stockData = calculateStockMovement();
        renderStockList(stockData);
        showToast('Stock data refreshed successfully', 'success');
    }

    // ============================================
    // UTILITY FUNCTIONS
    // ============================================

    function formatNumber(num) {
        return (num || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }

    function closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.remove('show');
    }

    function showToast(message, type = 'success') {
        const existing = document.querySelector('#customToast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'customToast';
        const bgColor = type === 'success' ? '#059669' : type === 'error' ? '#dc2626' : '#2563eb';
        toast.style.cssText = `
            position: fixed; top: 20px; right: 20px; 
            padding: 16px 24px; border-radius: 8px; 
            color: white; font-weight: 500; z-index: 9999;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            animation: slideIn 0.3s ease;
            background: ${bgColor};
            max-width: 400px;
        `;
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ============================================
    // EVENT LISTENERS
    // ============================================

    function setupEventListeners() {
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal.show').forEach(modal => {
                    modal.classList.remove('show');
                });
            }
        });

        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.classList.remove('show');
                }
            });
        });

        const searchInput = document.getElementById('searchStock');
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                const stockData = calculateStockMovement();
                renderStockList(stockData);
            });
        }

        const categoryFilter = document.getElementById('stockCategoryFilter');
        if (categoryFilter) {
            categoryFilter.addEventListener('change', () => {
                const stockData = calculateStockMovement();
                renderStockList(stockData);
            });
        }
    }

    // ============================================
    // TOAST CSS
    // ============================================
    if (!document.getElementById('customToastStyles')) {
        const style = document.createElement('style');
        style.id = 'customToastStyles';
        style.textContent = `
            @keyframes slideIn {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            @keyframes slideOut {
                from { transform: translateX(0); opacity: 1; }
                to { transform: translateX(100%); opacity: 0; }
            }
        `;
        document.head.appendChild(style);
    }

    // ============================================
    // EXPOSE TO GLOBAL SCOPE
    // ============================================
    window.openStockDetail = openStockDetail;
    window.openStockMovementDetail = openStockMovementDetail;
    window.printStockDetail = printStockDetail;
    window.closeModal = closeModal;
    window.refreshStockMovement = refreshStockMovement;
    window.showToast = showToast;
    window.sortStockBy = sortStockBy;

    // ============================================
    // INITIALIZE
    // ============================================
    await loadProducts();
    await loadBatches();
    await loadGRNLines();        // ← ADDED: Load GRN lines for purchase data
    await loadSales();
    await loadDonations();
    await loadWriteoffs();
    await loadStockCountBatches();  // 🔥 ADDED: Load stock take variance data

    const stockData = calculateStockMovement();
    renderStockList(stockData);
    setupEventListeners();

    console.log("✅ Stock Movement module initialized successfully!");
    console.log(`📦 ${stockData.length} products with stock data`);
    console.log(`📥 ${state.grnLines.length} GRN lines loaded for purchase data`);
    console.log(`📊 ${state.stockCountBatches.length} stock take variance records loaded`);
})();