// ============================================
// STOCK MANAGEMENT - WITH ACCOUNTING INTEGRATION
// ============================================

// Only declare accountCache if it doesn't already exist
if (typeof accountCache === 'undefined') {
    var accountCache = {};
}

(async function initStockPage() {
    console.log("Stock page initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // ============================================
    // ACCOUNT CACHE - Load from Chart of Accounts
    // ============================================
    async function loadAccountCodes() {
        try {
            // 🔥 ADDED: 'Inventory Adjustment Gain' -- see fix note in
            // ensureAccountsExist() for why increases need a separate
            // Income-type account instead of crediting the Expense-type
            // 'Inventory Adjustments' account.
            const { data: accounts, error } = await supabaseClient
                .from('chart_of_accounts')
                .select('code, name')
                .in('name', ['Inventory', 'Inventory Adjustments', 'Inventory Adjustment Gain', 'Opening Balance Equity']);

            if (error) throw error;

            // Clear existing cache
            for (var key in accountCache) {
                delete accountCache[key];
            }

            accounts.forEach(acc => {
                const key = acc.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
                accountCache[key] = acc.code;
            });

            if (!accountCache.inventory) {
                console.warn("⚠️ 'Inventory' account not found. Falling back to 1400.");
                accountCache.inventory = '1400';
            }
            if (!accountCache.inventory_adjustments) {
                console.warn("⚠️ 'Inventory Adjustments' account not found. Falling back to 5100.");
                accountCache.inventory_adjustments = '5100';
            }
            if (!accountCache.inventory_adjustment_gain) {
                console.warn("⚠️ 'Inventory Adjustment Gain' account not found. Falling back to 4900.");
                accountCache.inventory_adjustment_gain = '4900';
            }
            if (!accountCache.opening_balance_equity) {
                console.warn("⚠️ 'Opening Balance Equity' account not found. Falling back to 3000.");
                accountCache.opening_balance_equity = '3000';
            }

            console.log('✅ Account codes loaded:', accountCache);
            return accountCache;

        } catch (error) {
            console.error('❌ Error loading account codes:', error);
            accountCache.inventory = '1400';
            accountCache.inventory_adjustments = '5100';
            accountCache.inventory_adjustment_gain = '4900';
            accountCache.opening_balance_equity = '3000';
            return accountCache;
        }
    }

    // Load accounts first
    await loadAccountCodes();

    await loadStockTakes();

    // ============================================
    // NEW STOCK TAKE MODAL
    // ============================================
    const takeModal = document.getElementById('stockTakeModal');
    const openBtn = document.getElementById('newStockTakeBtn');
    const closeBtn = document.getElementById('closeStockTakeBtn');
    const cancelBtn = document.getElementById('cancelStockTakeBtn');

    const openTakeModal = () => {
        if (takeModal) takeModal.style.display = 'flex';
        const container = document.getElementById('productsContainer');
        if (container) container.innerHTML = '';
        addProductToTake();
    };

    window.closeTakeModal = () => {
        if (takeModal) takeModal.style.display = 'none';
        const form = document.getElementById('stockTakeForm');
        if (form) form.reset();
        const container = document.getElementById('productsContainer');
        if (container) container.innerHTML = '';
    };

    if (openBtn) {
        openBtn.addEventListener('click', openTakeModal);
    }
    if (closeBtn) {
        closeBtn.addEventListener('click', window.closeTakeModal);
    }
    if (cancelBtn) {
        cancelBtn.addEventListener('click', window.closeTakeModal);
    }
    if (takeModal) {
        takeModal.addEventListener('click', (e) => {
            if (e.target === takeModal) window.closeTakeModal();
        });
    }

    const addProductBtn = document.getElementById('addProductToTake');
    if (addProductBtn) {
        addProductBtn.addEventListener('click', addProductToTake);
    }

    const stockForm = document.getElementById('stockTakeForm');
    if (stockForm) {
        stockForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            await submitStockTake();
        });
    }

    // ============================================
    // STOCK TAKE DETAILS MODAL
    // ============================================
    const detailsModal = document.getElementById('stockTakeDetailsModal');
    const closeDetailsBtn = document.getElementById('closeDetailsBtn');

    if (closeDetailsBtn) {
        closeDetailsBtn.addEventListener('click', () => {
            if (detailsModal) detailsModal.style.display = 'none';
        });
    }
    if (detailsModal) {
        detailsModal.addEventListener('click', (e) => {
            if (e.target === detailsModal) detailsModal.style.display = 'none';
        });
    }

    // ============================================
    // CSV UPLOAD MODAL
    // ============================================
    const csvModal = document.getElementById('csvUploadModal');
    const uploadBtn = document.getElementById('uploadCsvBtn');
    const closeCsvBtn = document.getElementById('closeCsvBtn');
    const cancelCsvBtn = document.getElementById('cancelCsvBtn');
    const processCsvBtn = document.getElementById('processCsvBtn');

    if (uploadBtn) {
        uploadBtn.addEventListener('click', () => {
            if (csvModal) csvModal.style.display = 'flex';
        });
    }

    if (closeCsvBtn) {
        closeCsvBtn.addEventListener('click', () => {
            if (csvModal) csvModal.style.display = 'none';
            const fileInput = document.getElementById('csvFileInput');
            if (fileInput) fileInput.value = '';
        });
    }
    if (cancelCsvBtn) {
        cancelCsvBtn.addEventListener('click', () => {
            if (csvModal) csvModal.style.display = 'none';
            const fileInput = document.getElementById('csvFileInput');
            if (fileInput) fileInput.value = '';
        });
    }
    if (csvModal) {
        csvModal.addEventListener('click', (e) => {
            if (e.target === csvModal) {
                csvModal.style.display = 'none';
                const fileInput = document.getElementById('csvFileInput');
                if (fileInput) fileInput.value = '';
            }
        });
    }

    if (processCsvBtn) {
        processCsvBtn.addEventListener('click', async () => {
            await processCsvUpload();
        });
    }
})();

// ============================================
// ENSURE ACCOUNTS EXIST (Uses global accountCache)
// ============================================
async function ensureAccountsExist() {
    // Use existing accountCache
    let inventoryAccount = accountCache.inventory || '1400';
    let adjustmentAccount = accountCache.inventory_adjustments || '5100';
    // 🔥 FIX: stock INCREASES were crediting the same Expense-type
    // 'Inventory Adjustments' account used for decreases -- a credit to
    // an Expense account is a negative expense (contra-expense), which
    // is legal double-entry but most financial-statement generators only
    // expect Expense accounts to accumulate debits. That's exactly why
    // decreases (debit to Expense) flowed correctly into the Income
    // Statement/Balance Sheet while increases (credit to Expense) didn't
    // -- the credit balance wasn't being folded into Net Income properly,
    // throwing the Balance Sheet out by that amount. Increases now credit
    // a dedicated Income-type account instead, which is the normal
    // (credit) direction for that account type and flows into Net Income
    // the way any standard report expects.
    let gainAccount = accountCache.inventory_adjustment_gain || '4900';
    let equityAccount = accountCache.opening_balance_equity || '3000';

    // Check and create Inventory account
    const { count: invCount } = await supabaseClient
        .from('chart_of_accounts')
        .select('*', { count: 'exact', head: true })
        .eq('code', inventoryAccount);
    
    if (invCount === 0) {
        console.log(`⚠️ Account ${inventoryAccount} not found. Creating it...`);
        await supabaseClient.from('chart_of_accounts').insert([{ 
            code: inventoryAccount, 
            name: 'Inventory', 
            type: 'Asset', 
            normal_balance: 'Debit' 
        }]);
    }

    // Check and create Inventory Adjustments account (for DECREASES / losses)
    const { count: adjCount } = await supabaseClient
        .from('chart_of_accounts')
        .select('*', { count: 'exact', head: true })
        .eq('code', adjustmentAccount);
    
    if (adjCount === 0) {
        console.log(`⚠️ Account ${adjustmentAccount} not found. Creating it...`);
        await supabaseClient.from('chart_of_accounts').insert([{ 
            code: adjustmentAccount, 
            name: 'Inventory Adjustments', 
            type: 'Expense', 
            normal_balance: 'Debit' 
        }]);
    }

    // Check and create Inventory Adjustment Gain account (for INCREASES / gains)
    const { count: gainCount } = await supabaseClient
        .from('chart_of_accounts')
        .select('*', { count: 'exact', head: true })
        .eq('code', gainAccount);

    if (gainCount === 0) {
        console.log(`⚠️ Account ${gainAccount} not found. Creating it...`);
        await supabaseClient.from('chart_of_accounts').insert([{
            code: gainAccount,
            name: 'Inventory Adjustment Gain',
            type: 'Income',
            normal_balance: 'Credit'
        }]);
    }

    // Check and create Opening Balance Equity account
    const { count: eqCount } = await supabaseClient
        .from('chart_of_accounts')
        .select('*', { count: 'exact', head: true })
        .eq('code', equityAccount);
    
    if (eqCount === 0) {
        console.log(`⚠️ Account ${equityAccount} not found. Creating it...`);
        await supabaseClient.from('chart_of_accounts').insert([{ 
            code: equityAccount, 
            name: 'Opening Balance Equity', 
            type: 'Equity', 
            normal_balance: 'Credit' 
        }]);
    }

    // Reload account cache after creating new accounts
    await reloadAccountCache();

    return { inventoryAccount, adjustmentAccount, gainAccount };
}

// ============================================
// RELOAD ACCOUNT CACHE
// ============================================
async function reloadAccountCache() {
    try {
        const { data: accounts, error } = await supabaseClient
            .from('chart_of_accounts')
            .select('code, name')
            .in('name', ['Inventory', 'Inventory Adjustments', 'Inventory Adjustment Gain', 'Opening Balance Equity']);

        if (error) throw error;

        // Clear existing cache
        for (var key in accountCache) {
            delete accountCache[key];
        }

        accounts.forEach(acc => {
            const key = acc.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
            accountCache[key] = acc.code;
        });

        console.log('✅ Account cache reloaded:', accountCache);
    } catch (error) {
        console.error('Error reloading account cache:', error);
    }
}

// ============================================
// ADD PRODUCT TO THE STOCK TAKE
// ============================================
async function addProductToTake() {
    const container = document.getElementById('productsContainer');
    if (!container) return;

    const productIndex = container.children.length;

    const block = document.createElement('div');
    block.className = 'product-take-block';
    block.style.cssText = `
        border: 1px solid #e2e8f0; 
        border-radius: 8px; 
        padding: 15px; 
        margin-bottom: 15px; 
        background: #f8fafc;
    `;
    
    block.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <h4 style="margin: 0; color: #0f172a;">Product #${productIndex + 1}</h4>
            ${productIndex > 0 ? `<button type="button" class="remove-product-block" style="background: none; border: none; color: #ef4444; cursor: pointer;"><i class="fa-regular fa-trash-can"></i></button>` : ''}
        </div>
        <div style="margin-bottom: 10px;">
            <label style="display: block; font-weight: 500; color: #475569; margin-bottom: 5px;">Select Product *</label>
            <select class="take-product" required style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px; background: white;">
                <option value="">Select Product</option>
            </select>
        </div>
        <div id="batchRows-${productIndex}" class="batch-rows-container">
            <p style="color: #94a3b8; text-align: center; padding: 10px;">Select a product to load batches</p>
        </div>
    `;
    container.appendChild(block);

    const select = block.querySelector('.take-product');
    await loadProductDropdown(select);

    const removeBtn = block.querySelector('.remove-product-block');
    if (removeBtn) {
        removeBtn.addEventListener('click', () => {
            block.remove();
        });
    }

    select.addEventListener('change', async (e) => {
        const productId = e.target.value;
        const batchContainer = block.querySelector('.batch-rows-container');
        if (productId) {
            await loadBatchRows(productId, batchContainer);
        } else {
            batchContainer.innerHTML = `<p style="color: #94a3b8; text-align: center; padding: 10px;">Select a product to load batches</p>`;
        }
    });
}

// ============================================
// LOAD PRODUCT DROPDOWN
// ============================================
async function loadProductDropdown(select) {
    if (!select) return;

    select.innerHTML = `<option value="">Select Product</option>`;

    try {
        const { data: products, error } = await supabaseClient
            .from('products')
            .select('id, product_name, sku')
            .order('product_name', { ascending: true });

        if (error) throw error;

        products.forEach(p => {
            select.innerHTML += `<option value="${p.id}">${p.product_name} (${p.sku || 'N/A'})</option>`;
        });

    } catch (error) {
        console.error("Error loading products:", error);
    }
}

// ============================================
// LOAD BATCH ROWS
// ============================================
async function loadBatchRows(productId, container) {
    if (!container) return;

    container.innerHTML = '<p style="color: #94a3b8; text-align: center;">Loading batches...</p>';

    try {
        const { data: batches, error } = await supabaseClient
            .from('batches')
            .select(`
                id, 
                batch_number, 
                expiry_date, 
                total_qty, 
                cost_price
            `)
            .eq('product_id', productId);

        if (error) throw error;

        const activeBatches = batches.filter(b => 
            (b.total_qty || 0) > 0
        );

        if (activeBatches.length === 0) {
            container.innerHTML = '<p style="color: #94a3b8; text-align: center;">No active batches found for this product.</p>';
            return;
        }

        container.innerHTML = '';
        activeBatches.forEach(b => {
            addBatchRow(container, b.id, b.batch_number, b.expiry_date, b.total_qty, b.cost_price);
        });

    } catch (error) {
        console.error("Error loading batches:", error);
        container.innerHTML = `<p style="color: #dc2626; text-align: center;">Error: ${error.message}</p>`;
    }
}

// ============================================
// ADD BATCH ROW
// ============================================
function addBatchRow(container, batchId, batchNumber, expiryDate, systemTotal, costPrice) {
    if (!container) return;

    const row = document.createElement('div');
    row.className = 'batch-count-row';
    row.style.cssText = `
        display: grid; 
        grid-template-columns: 1.5fr 1fr 1fr 1fr; 
        gap: 10px; 
        margin-bottom: 10px; 
        align-items: center; 
        padding: 10px;
        background: white;
        border-radius: 6px;
        border: 1px solid #e2e8f0;
    `;
    
    row.innerHTML = `
        <input type="hidden" class="batch-id" value="${batchId}">
        <input type="hidden" class="cost-price" value="${costPrice || 0}">
        <div>
            <label style="font-size: 0.75rem; color: #475569; font-weight: 600;">Batch #</label>
            <input type="text" class="batch-number" value="${batchNumber}" readonly style="width: 100%; padding: 8px; border: 1px solid #e2e8f0; border-radius: 4px; background: #f1f5f9; color: #64748b;">
        </div>
        <div>
            <label style="font-size: 0.75rem; color: #475569; font-weight: 600;">Expiry</label>
            <input type="text" class="batch-expiry" value="${expiryDate ? new Date(expiryDate).toLocaleDateString() : 'N/A'}" readonly style="width: 100%; padding: 8px; border: 1px solid #e2e8f0; border-radius: 4px; background: #f1f5f9; color: #64748b;">
        </div>
        <div>
            <label style="font-size: 0.75rem; color: #475569; font-weight: 600;">System Total</label>
            <input type="number" class="sys-total" value="${systemTotal}" readonly style="width: 100%; padding: 8px; border: 1px solid #e2e8f0; border-radius: 4px; background: #f1f5f9; color: #64748b;">
        </div>
        <div>
            <label style="font-size: 0.75rem; color: #475569; font-weight: 600;">Counted Total *</label>
            <input type="number" class="count-total" value="${systemTotal}" required min="0" style="width: 100%; padding: 8px; border: 1px solid #e2e8f0; border-radius: 4px; background: white;">
        </div>
    `;
    container.appendChild(row);
}

// ============================================
// SUBMIT STOCK TAKE (WITH ACCOUNTING)
// ============================================
async function submitStockTake() {
    const submitBtn = document.getElementById('saveStockTakeBtn');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    }

    const productBlocks = document.querySelectorAll('.product-take-block');
    if (productBlocks.length === 0) {
        alert("Please add at least one product.");
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Stock Take`;
        }
        return;
    }

    const allCounts = [];
    let totalQtyVariance = 0;
    let totalAmountVariance = 0;
    let adjustmentEntries = [];

    for (let block of productBlocks) {
        const productSelect = block.querySelector('.take-product');
        const productId = productSelect?.value;
        if (!productId) continue;

        const batchRows = block.querySelectorAll('.batch-count-row');
        batchRows.forEach(row => {
            const batchId = row.querySelector('.batch-id')?.value;
            const batchNumber = row.querySelector('.batch-number')?.value;
            const costPrice = parseFloat(row.querySelector('.cost-price')?.value) || 0;
            const sysTotal = parseInt(row.querySelector('.sys-total')?.value) || 0;
            const countTotal = parseInt(row.querySelector('.count-total')?.value) || 0;

            const variance = countTotal - sysTotal;
            const amountVariance = variance * costPrice;

            totalQtyVariance += variance;
            totalAmountVariance += amountVariance;

            if (variance !== 0) {
                adjustmentEntries.push({
                    productId,
                    batchId,
                    batchNumber,
                    costPrice,
                    variance,
                    amountVariance
                });
            }

            allCounts.push({
                productId,
                batchId: batchId || null,
                batchNumber,
                costPrice,
                sysTotal,
                countTotal,
                variance
            });
        });
    }

    if (allCounts.length === 0) {
        alert("No batches found to count.");
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Stock Take`;
        }
        return;
    }

    try {
        // Ensure accounts exist
        await ensureAccountsExist();

        // Step 1: Create Stock Take record
        const { data: takeRecord, error: takeError } = await supabaseClient
            .from('stock_counts')
            .insert([{
                date: new Date().toISOString().split('T')[0],
                total_qty_variance: totalQtyVariance,
                total_amount_variance: totalAmountVariance
            }])
            .select();

        if (takeError) throw takeError;

        const takeId = takeRecord[0].id;

        // Step 2: Save batch counts
        const batchCounts = allCounts.map(c => ({
            stock_count_id: takeId,
            product_id: c.productId,
            batch_id: c.batchId || null,
            batch_number: c.batchNumber,
            system_qty: c.sysTotal,
            physical_qty: c.countTotal,
            variance: c.variance
        }));

        const { error: batchError } = await supabaseClient
            .from('stock_count_batches')
            .insert(batchCounts);

        if (batchError) throw batchError;

        // Step 3: Update batch quantities
        for (let c of allCounts) {
            if (c.batchId) {
                const { error: updateError } = await supabaseClient
                    .from('batches')
                    .update({ total_qty: c.countTotal })
                    .eq('id', c.batchId);
                if (updateError) throw updateError;
            } else {
                const { error: insertError } = await supabaseClient
                    .from('batches')
                    .insert([{
                        product_id: c.productId,
                        batch_number: c.batchNumber,
                        expiry_date: new Date().toISOString().split('T')[0],
                        cost_price: c.costPrice,
                        total_qty: c.countTotal
                    }]);
                if (insertError) throw insertError;
            }
        }

        // ==========================================
        // Step 4: CREATE ACCOUNTING ENTRIES
        // ==========================================
        if (totalAmountVariance !== 0) {
            await createAdjustmentJournalEntry(takeId, adjustmentEntries, totalAmountVariance);
        }

        showToast("Stock take saved successfully! Stock levels and accounts updated.", "success");
        window.closeTakeModal();
        await loadStockTakes();

    } catch (error) {
        console.error("Error saving stock take:", error);
        showToast("Error saving stock take: " + error.message, "error");
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Stock Take`;
        }
    }
}

// ============================================
// CREATE ADJUSTMENT JOURNAL ENTRY
// ============================================
async function createAdjustmentJournalEntry(takeId, adjustmentEntries, totalAmountVariance) {
    try {
        const inventoryAccount = accountCache.inventory || '1400';
        const adjustmentAccount = accountCache.inventory_adjustments || '5100';
        const gainAccount = accountCache.inventory_adjustment_gain || '4900';

        // Get product names for description
        const productIds = adjustmentEntries.map(e => e.productId);
        const { data: products } = await supabaseClient
            .from('products')
            .select('id, product_name')
            .in('id', productIds);

        const productMap = {};
        products?.forEach(p => {
            productMap[p.id] = p.product_name;
        });

        const description = `Stock take adjustment - ${adjustmentEntries.length} products affected`;

        // Create Journal Entry
        const journal = {
            entry_date: new Date().toISOString().split('T')[0],
            reference: `STOCK-${takeId.slice(0, 8).toUpperCase()}`,
            description: description,
            journal_number: `STK-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
            status: 'Posted',
            created_at: new Date().toISOString()
        };

        const { data: journalData, error: jError } = await supabaseClient
            .from('journal_entries')
            .insert([journal])
            .select();

        if (jError) throw jError;

        const journalId = journalData[0].id;

        // Create Journal Lines
        const lines = [];

        if (totalAmountVariance > 0) {
            // If physical count > system count (Inventory increased) --
            // credits the Income-type gain account, not the Expense-type
            // adjustments account. See fix note in ensureAccountsExist().
            lines.push({
                journal_entry_id: journalId,
                account_code: inventoryAccount,
                description: `Inventory increase from stock take`,
                debit: Math.abs(totalAmountVariance),
                credit: 0
            });
            lines.push({
                journal_entry_id: journalId,
                account_code: gainAccount,
                description: `Stock take adjustment gain`,
                debit: 0,
                credit: Math.abs(totalAmountVariance)
            });
        } else {
            // If physical count < system count (Inventory decreased) --
            // unchanged, this side was already correct.
            lines.push({
                journal_entry_id: journalId,
                account_code: inventoryAccount,
                description: `Inventory decrease from stock take`,
                debit: 0,
                credit: Math.abs(totalAmountVariance)
            });
            lines.push({
                journal_entry_id: journalId,
                account_code: adjustmentAccount,
                description: `Stock take adjustment (decrease)`,
                debit: Math.abs(totalAmountVariance),
                credit: 0
            });
        }

        const { error: lineError } = await supabaseClient
            .from('journal_lines')
            .insert(lines);

        if (lineError) throw lineError;

        console.log(`✅ Stock take adjustment journal entry created: ${totalAmountVariance.toFixed(2)}`);
        console.log(`   Inventory Account: ${inventoryAccount}`);
        console.log(`   Adjustment Account: ${adjustmentAccount}`);

        return journalId;

    } catch (error) {
        console.error('Error creating adjustment journal entry:', error);
        throw error;
    }
}

// ============================================
// LOAD STOCK TAKES
// ============================================
async function loadStockTakes() {
    const tbody = document.getElementById('stockTakeTableBody');
    if (!tbody) return;

    try {
        const { data: takes, error } = await supabaseClient
            .from('stock_counts')
            .select(`
                id,
                date,
                total_qty_variance,
                total_amount_variance,
                stock_count_batches (
                    product_id,
                    products:product_id ( product_name ),
                    batch_id,
                    batches:batch_id ( cost_price ),
                    system_qty,
                    physical_qty,
                    variance
                )
            `)
            .order('date', { ascending: false });

        if (error) throw error;

        if (!takes || takes.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 30px; color: #94a3b8;">No stock takes found.</td></tr>`;
            return;
        }

        renderStockTakes(takes);

    } catch (error) {
        console.error("Error loading stock takes:", error);
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 30px; color: #dc2626;">Error: ${error.message}</td></tr>`;
    }
}

function renderStockTakes(takes) {
    const tbody = document.getElementById('stockTakeTableBody');
    if (!tbody) return;
    
    tbody.innerHTML = takes.map(t => {
        let uniqueProducts = new Set();
        let totalQtyVariance = 0;
        let totalAmountVariance = 0;

        t.stock_count_batches.forEach(b => {
            if (b.product_id) {
                uniqueProducts.add(b.product_id);
            }

            const costPrice = b.batches?.cost_price || 0;
            const variance = b.variance || 0;

            totalQtyVariance += variance;
            totalAmountVariance += variance * costPrice;
        });

        const varianceColor = totalAmountVariance > 0 ? '#15803d' : totalAmountVariance < 0 ? '#dc2626' : '#64748b';

        return `
            <tr style="cursor: pointer;" onclick="openStockTakeDetails('${t.id}')">
                <td style="padding-left: 20px; font-weight: 500; color: #2563eb;">
                    <i class="fa-solid fa-receipt"></i> STK-${t.id.slice(0, 8).toUpperCase()}
                </td>
                <td>${new Date(t.date).toLocaleDateString()}</td>
                <td>${uniqueProducts.size} items</td>
                <td style="color: ${totalQtyVariance > 0 ? '#15803d' : totalQtyVariance < 0 ? '#dc2626' : '#64748b'};">
                    ${totalQtyVariance > 0 ? '+' : ''}${totalQtyVariance}
                </td>
                <td style="padding-right: 20px; text-align: right; font-weight: bold; color: ${varianceColor};">
                    K${totalAmountVariance.toFixed(2)}
                </td>
                <td style="padding-right: 20px; text-align: center;">
                    <span style="background: ${totalAmountVariance !== 0 ? '#fef3c7' : '#dcfce7'}; 
                                 color: ${totalAmountVariance !== 0 ? '#92400e' : '#15803d'}; 
                                 padding: 2px 10px; border-radius: 10px; font-size: 0.75rem;">
                        ${totalAmountVariance !== 0 ? 'Adjustment Made' : 'No Change'}
                    </span>
                </td>
            </tr>
        `;
    }).join('');
}

// ============================================
// OPEN STOCK TAKE DETAILS
// ============================================
window.openStockTakeDetails = async function(stockTakeId) {
    const modal = document.getElementById('stockTakeDetailsModal');
    const title = document.getElementById('detailsTitle');
    const content = document.getElementById('detailsContent');

    if (!modal || !title || !content) return;

    title.textContent = `Stock Take Details - STK-${stockTakeId.slice(0, 8).toUpperCase()}`;
    content.innerHTML = `<p style="text-align: center; color: #94a3b8; padding: 30px;"><i class="fa-solid fa-spinner fa-spin"></i> Loading details...</p>`;
    modal.style.display = 'flex';

    try {
        const { data: details, error } = await supabaseClient
            .from('stock_counts')
            .select(`
                id,
                date,
                total_qty_variance,
                total_amount_variance,
                stock_count_batches (
                    id,
                    product_id,
                    products:product_id ( product_name, sku ),
                    batch_id,
                    batches:batch_id ( cost_price ),
                    batch_number,
                    expiry_date,
                    system_qty,
                    physical_qty,
                    variance
                )
            `)
            .eq('id', stockTakeId)
            .single();

        if (error) throw error;

        let totalAmountVariance = 0;
        details.stock_count_batches.forEach(b => {
            const costPrice = b.batches?.cost_price || 0;
            totalAmountVariance += (b.variance || 0) * costPrice;
        });

        let html = `
            <div style="margin-bottom: 20px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px;">
                <div style="padding: 15px; background: #f8fafc; border-radius: 6px;">
                    <p style="margin: 0; font-size: 0.8rem; color: #64748b;">Date</p>
                    <p style="margin: 5px 0 0 0; font-weight: 600;">${new Date(details.date).toLocaleDateString()}</p>
                </div>
                <div style="padding: 15px; background: #f8fafc; border-radius: 6px;">
                    <p style="margin: 0; font-size: 0.8rem; color: #64748b;">Items Counted</p>
                    <p style="margin: 5px 0 0 0; font-weight: 600;">${details.stock_count_batches.length}</p>
                </div>
                <div style="padding: 15px; background: #f8fafc; border-radius: 6px;">
                    <p style="margin: 0; font-size: 0.8rem; color: #64748b;">Total Variance</p>
                    <p style="margin: 5px 0 0 0; font-weight: 600; color: ${totalAmountVariance > 0 ? '#15803d' : totalAmountVariance < 0 ? '#dc2626' : '#64748b'};">
                        K${totalAmountVariance.toFixed(2)}
                    </p>
                </div>
            </div>
            <table class="table-minimal">
                <thead>
                    <tr>
                        <th style="padding-left: 20px;">Product</th>
                        <th>SKU</th>
                        <th>Batch</th>
                        <th style="text-align: right;">System Qty</th>
                        <th style="text-align: right;">Counted Qty</th>
                        <th style="text-align: right;">Variance</th>
                        <th style="padding-right: 20px; text-align: right;">Amount Variance (K)</th>
                    </tr>
                </thead>
                <tbody>
        `;

        details.stock_count_batches.forEach(b => {
            const costPrice = b.batches?.cost_price || 0;
            const variance = b.variance || 0;
            const amountVariance = variance * costPrice;

            html += `
                <tr>
                    <td style="padding-left: 20px;">${b.products?.product_name || 'Unknown'}</td>
                    <td style="font-family: monospace; font-size: 0.8rem;">${b.products?.sku || 'N/A'}</td>
                    <td style="font-family: monospace; font-size: 0.8rem;">${b.batch_number || 'N/A'}</td>
                    <td style="text-align: right;">${b.system_qty}</td>
                    <td style="text-align: right;">${b.physical_qty}</td>
                    <td style="text-align: right; color: ${variance > 0 ? '#15803d' : variance < 0 ? '#dc2626' : '#64748b'};">
                        ${variance > 0 ? '+' : ''}${variance}
                    </td>
                    <td style="padding-right: 20px; text-align: right; font-weight: bold;">
                        K${amountVariance.toFixed(2)}
                    </td>
                </tr>
            `;
        });

        html += `
                </tbody>
            </table>
        `;

        content.innerHTML = html;

    } catch (error) {
        console.error("Error loading stock take details:", error);
        content.innerHTML = `<p style="text-align: center; color: #dc2626; padding: 30px;">Error: ${error.message}</p>`;
    }
};

// ============================================
// PROCESS CSV UPLOAD (WITH ACCOUNTING)
// ============================================
async function processCsvUpload() {
    const fileInput = document.getElementById('csvFileInput');
    const file = fileInput?.files[0];

    if (!file) {
        alert("Please select a CSV file.");
        return;
    }

    const reader = new FileReader();
    reader.onload = async function(e) {
        const text = e.target.result;
        const rows = text.split('\n').filter(row => row.trim() !== '');
        
        // Skip header row
        const dataRows = rows.slice(1);
        let successCount = 0;
        let errorCount = 0;
        let adjustmentEntries = [];

        for (let row of dataRows) {
            const columns = row.split(',');
            // COLUMNS: SKU, Batch Number, Expiry Date, Total Qty, Cost Price
            if (columns.length < 4) {
                errorCount++;
                continue;
            }

            const sku = columns[0].trim();
            const batchNumber = columns[1].trim();
            const expiryDate = columns[2].trim();
            const totalQty = parseInt(columns[3].trim());
            const costPrice = parseFloat(columns[4]?.trim()) || 0;

            try {
                const { data: product } = await supabaseClient
                    .from('products')
                    .select('id, product_name')
                    .eq('sku', sku)
                    .single();

                if (!product) {
                    errorCount++;
                    continue;
                }

                // Check if batch exists
                const { data: existingBatch } = await supabaseClient
                    .from('batches')
                    .select('id, total_qty')
                    .eq('product_id', product.id)
                    .eq('batch_number', batchNumber)
                    .single();

                let variance = 0;
                let oldQty = 0;

                if (existingBatch) {
                    oldQty = existingBatch.total_qty || 0;
                    variance = totalQty - oldQty;

                    await supabaseClient
                        .from('batches')
                        .update({ 
                            total_qty: totalQty,
                            cost_price: costPrice || 0
                        })
                        .eq('id', existingBatch.id);

                    // Track adjustment for accounting
                    if (variance !== 0) {
                        adjustmentEntries.push({
                            productId: product.id,
                            productName: product.product_name,
                            batchId: existingBatch.id,
                            batchNumber: batchNumber,
                            costPrice: costPrice,
                            variance: variance,
                            amountVariance: variance * costPrice
                        });
                    }
                } else {
                    await supabaseClient
                        .from('batches')
                        .insert([{
                            product_id: product.id,
                            batch_number: batchNumber,
                            expiry_date: expiryDate || null,
                            cost_price: costPrice,
                            total_qty: totalQty
                        }]);

                    // New batch - treat as addition
                    if (totalQty > 0 && costPrice > 0) {
                        adjustmentEntries.push({
                            productId: product.id,
                            productName: product.product_name,
                            batchId: null,
                            batchNumber: batchNumber,
                            costPrice: costPrice,
                            variance: totalQty,
                            amountVariance: totalQty * costPrice
                        });
                    }
                }
                successCount++;

            } catch (error) {
                errorCount++;
                console.error("Error processing row:", error);
            }
        }

        // ==========================================
        // CREATE ACCOUNTING ENTRIES FOR CSV UPLOAD
        // ==========================================
        if (adjustmentEntries.length > 0) {
            const totalAdjustment = adjustmentEntries.reduce((sum, e) => sum + e.amountVariance, 0);
            
            if (totalAdjustment !== 0) {
                try {
                    // Ensure accounts exist
                    await ensureAccountsExist();

                    const inventoryAccount = accountCache.inventory || '1400';
                    const adjustmentAccount = accountCache.inventory_adjustments || '5100';
                    const gainAccount = accountCache.inventory_adjustment_gain || '4900';

                    const journal = {
                        entry_date: new Date().toISOString().split('T')[0],
                        reference: `CSV-${new Date().toISOString().split('T')[0]}`,
                        description: `Stock adjustment from CSV upload - ${adjustmentEntries.length} products affected`,
                        journal_number: `CSV-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                        status: 'Posted',
                        created_at: new Date().toISOString()
                    };

                    const { data: journalData, error: jError } = await supabaseClient
                        .from('journal_entries')
                        .insert([journal])
                        .select();

                    if (jError) throw jError;

                    const lines = [];

                    if (totalAdjustment > 0) {
                        // 🔥 FIX: same bug as the stock take path -- credits
                        // the Income-type gain account, not the Expense-type
                        // adjustments account.
                        lines.push({
                            journal_entry_id: journalData[0].id,
                            account_code: inventoryAccount,
                            description: `Inventory increase from CSV upload`,
                            debit: Math.abs(totalAdjustment),
                            credit: 0
                        });
                        lines.push({
                            journal_entry_id: journalData[0].id,
                            account_code: gainAccount,
                            description: `CSV stock adjustment gain`,
                            debit: 0,
                            credit: Math.abs(totalAdjustment)
                        });
                    } else {
                        lines.push({
                            journal_entry_id: journalData[0].id,
                            account_code: inventoryAccount,
                            description: `Inventory decrease from CSV upload`,
                            debit: 0,
                            credit: Math.abs(totalAdjustment)
                        });
                        lines.push({
                            journal_entry_id: journalData[0].id,
                            account_code: adjustmentAccount,
                            description: `CSV stock adjustment (decrease)`,
                            debit: Math.abs(totalAdjustment),
                            credit: 0
                        });
                    }

                    const { error: lineError } = await supabaseClient
                        .from('journal_lines')
                        .insert(lines);

                    if (lineError) throw lineError;

                    console.log(`✅ CSV adjustment journal entry created: ${totalAdjustment.toFixed(2)}`);

                } catch (error) {
                    console.error('Error creating CSV adjustment entry:', error);
                    showToast('Error creating accounting entry for CSV upload: ' + error.message, 'error');
                }
            }
        }

        alert(`CSV processed: ${successCount} rows updated, ${errorCount} errors.\n${adjustmentEntries.length} batches had accounting adjustments.`);
        
        const closeCsvBtn = document.getElementById('closeCsvBtn');
        if (closeCsvBtn) closeCsvBtn.click();
        
        await loadStockTakes();
    };
    reader.readAsText(file);
}

// ============================================
// TOAST NOTIFICATION SYSTEM
// ============================================
function showToast(message, type = 'success') {
    const existing = document.querySelector('#customToast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'customToast';
    toast.style.cssText = `
        position: fixed; top: 20px; right: 20px; 
        padding: 16px 24px; border-radius: 8px; 
        color: white; font-weight: 500; z-index: 9999;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        animation: slideIn 0.3s ease;
        background: ${type === 'success' ? '#059669' : '#dc2626'};
        max-width: 400px;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Add CSS for animations
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