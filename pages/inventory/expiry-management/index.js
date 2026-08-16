// ============================================
// EXPIRY MANAGEMENT - WITH ACCOUNTING INTEGRATION
// ============================================

// Only declare accountCache if it doesn't already exist
if (typeof accountCache === 'undefined') {
    var accountCache = {};
}

(async function initExpiryPage() {
    console.log("Expiry page initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // ============================================
    // ACCOUNT CACHE - Load from Chart of Accounts
    // ============================================
    async function loadAccountCodes() {
        try {
            const { data: accounts, error } = await supabaseClient
                .from('chart_of_accounts')
                .select('code, name')
                .in('name', ['Inventory', 'Inventory Write-Offs', 'Opening Balance Equity']);

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
            if (!accountCache.inventory_write_offs) {
                console.warn("⚠️ 'Inventory Write-Off' account not found. Falling back to 6002.");
                accountCache.inventory_write_offs = '6002';
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
            accountCache.inventory_write_offs = '6002';
            accountCache.opening_balance_equity = '3000';
            return accountCache;
        }
    }

    // Load accounts first
    await loadAccountCodes();

    await loadExpiryData();

    // ============================================
    // BULK WRITE-OFF MODAL
    // ============================================
    const bulkModal = document.getElementById('bulkWriteOffModal');
    const bulkBtn = document.getElementById('bulkWriteOffBtn');
    const closeBulkBtn = document.getElementById('closeBulkModalBtn');
    const cancelBulkBtn = document.getElementById('cancelBulkBtn');

    if (bulkBtn) {
        bulkBtn.addEventListener('click', () => {
            if (bulkModal) bulkModal.style.display = 'flex';
            loadBulkWriteOffList();
        });
    }

    if (closeBulkBtn) {
        closeBulkBtn.addEventListener('click', () => {
            if (bulkModal) bulkModal.style.display = 'none';
        });
    }
    if (cancelBulkBtn) {
        cancelBulkBtn.addEventListener('click', () => {
            if (bulkModal) bulkModal.style.display = 'none';
        });
    }
    if (bulkModal) {
        bulkModal.addEventListener('click', (e) => {
            if (e.target === bulkModal) {
                bulkModal.style.display = 'none';
            }
        });
    }

    const confirmBtn = document.getElementById('confirmBulkWriteOffBtn');
    if (confirmBtn) {
        confirmBtn.addEventListener('click', async () => {
            await submitBulkWriteOff();
        });
    }

    // ============================================
    // WRITE-OFF HISTORY MODAL
    // ============================================
    const historyModal = document.getElementById('historyModal');
    const viewBtn = document.getElementById('viewHistoryBtn');
    const closeHistoryBtn = document.getElementById('closeHistoryBtn');

    if (viewBtn) {
        viewBtn.addEventListener('click', () => {
            if (historyModal) historyModal.style.display = 'flex';
            loadWriteOffHistory();
        });
    }

    if (closeHistoryBtn) {
        closeHistoryBtn.addEventListener('click', () => {
            if (historyModal) historyModal.style.display = 'none';
        });
    }
    if (historyModal) {
        historyModal.addEventListener('click', (e) => {
            if (e.target === historyModal) historyModal.style.display = 'none';
        });
    }

    // ============================================
    // WRITE-OFF DETAIL MODAL
    // ============================================
    const detailModal = document.getElementById('writeOffDetailModal');
    const closeDetailBtn = document.getElementById('closeDetailBtn');

    if (closeDetailBtn) {
        closeDetailBtn.addEventListener('click', () => {
            if (detailModal) detailModal.style.display = 'none';
        });
    }
    if (detailModal) {
        detailModal.addEventListener('click', (e) => {
            if (e.target === detailModal) detailModal.style.display = 'none';
        });
    }
})();

// ============================================
// ENSURE ACCOUNTS EXIST
// ============================================
async function ensureAccountsExist() {
    let inventoryAccount = accountCache.inventory || '1400';
    let writeOffAccount = accountCache.inventory_write_offs || '6002';
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

    // Check and create Inventory Write-Off account (Expense)
    const { count: woCount } = await supabaseClient
        .from('chart_of_accounts')
        .select('*', { count: 'exact', head: true })
        .eq('code', writeOffAccount);
    
    if (woCount === 0) {
        console.log(`⚠️ Account ${writeOffAccount} not found. Creating it...`);
        await supabaseClient.from('chart_of_accounts').insert([{ 
            code: writeOffAccount, 
            name: 'Inventory Write-Offs', 
            type: 'Expense', 
            normal_balance: 'Debit' 
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

    return { inventoryAccount, writeOffAccount };
}

// ============================================
// RELOAD ACCOUNT CACHE
// ============================================
async function reloadAccountCache() {
    try {
        const { data: accounts, error } = await supabaseClient
            .from('chart_of_accounts')
            .select('code, name')
            .in('name', ['Inventory', 'Inventory Write-Offs', 'Opening Balance Equity']);

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
// LOAD EXPIRY DATA (Only show batches with total_qty > 0)
// ============================================
async function loadExpiryData() {
    const tbody = document.getElementById('expiryTableBody');
    if (!tbody) return;

    try {
        const { data: batches, error } = await supabaseClient
            .from('batches')
            .select(`
                id,
                batch_number,
                expiry_date,
                total_qty,
                cost_price,
                products:product_id ( product_name, sku )
            `)
            .gt('total_qty', 0)
            .order('expiry_date', { ascending: true });

        if (error) throw error;

        if (!batches || batches.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 30px; color: #94a3b8;">No active batches found.</td></tr>`;
            return;
        }

        renderExpiryTable(batches);

    } catch (error) {
        console.error("Error loading expiry data:", error);
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 30px; color: #dc2626;">Error: ${error.message}</td></tr>`;
    }
}

// ============================================
// RENDER EXPIRY TABLE
// ============================================
function renderExpiryTable(batches) {
    const tbody = document.getElementById('expiryTableBody');
    if (!tbody) return;

    const today = new Date();
    
    tbody.innerHTML = batches.map(b => {
        const expiry = new Date(b.expiry_date);
        const daysUntilExpiry = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
        const totalCost = (b.total_qty || 0) * (b.cost_price || 0);
        
        let rowClass = '';
        let expiryClass = '';
        let statusLabel = '';

        if (daysUntilExpiry < 0) {
            rowClass = 'style="background: #fef2f2;"';
            expiryClass = 'style="color: #dc2626; font-weight: bold;"';
            statusLabel = '<span style="background: #fef2f2; color: #dc2626; padding: 3px 8px; border-radius: 10px; font-size: 0.75rem;">Expired</span>';
        } else if (daysUntilExpiry <= 30) {
            rowClass = 'style="background: #fffbeb;"';
            expiryClass = 'style="color: #d97706; font-weight: bold;"';
            statusLabel = '<span style="background: #fef3c7; color: #b45309; padding: 3px 8px; border-radius: 10px; font-size: 0.75rem;">Expiring Soon</span>';
        } else {
            expiryClass = 'style="color: #15803d;"';
            statusLabel = '<span style="background: #dcfce7; color: #15803d; padding: 3px 8px; border-radius: 10px; font-size: 0.75rem;">Safe</span>';
        }

        return `
            <tr ${rowClass}>
                <td style="padding-left: 20px; font-weight: 500;">${b.products?.product_name || 'Unknown'}</td>
                <td style="font-family: monospace; font-size: 0.85rem;">${b.products?.sku || 'N/A'}</td>
                <td style="font-family: monospace;">${b.batch_number}</td>
                <td ${expiryClass}>${new Date(b.expiry_date).toLocaleDateString()}</td>
                <td ${expiryClass}>${daysUntilExpiry} Days</td>
                <td style="padding-right: 20px; text-align: right;">
                    ${statusLabel}
                    ${daysUntilExpiry <= 30 ? ` <button onclick="quickWriteOff('${b.id}')" style="background: #dc2626; color: white; border: none; padding: 2px 10px; border-radius: 4px; cursor: pointer; font-size: 0.75rem;">Write Off</button>` : ''}
                </td>
            </tr>
        `;
    }).join('');
}

// ============================================
// QUICK WRITE-OFF (Single Batch)
// ============================================
window.quickWriteOff = async function(batchId) {
    if (!confirm('Are you sure you want to write off this batch? This action cannot be undone.')) {
        return;
    }

    try {
        const { data: batch, error } = await supabaseClient
            .from('batches')
            .select(`
                id,
                batch_number,
                expiry_date,
                total_qty,
                cost_price,
                product_id,
                products:product_id ( product_name )
            `)
            .eq('id', batchId)
            .single();

        if (error) throw error;

        const totalCost = (batch.total_qty || 0) * (batch.cost_price || 0);

        // Ensure accounts exist
        await ensureAccountsExist();

        // Create Write-Off record
        // 🔥 FIX: last-4-digits-of-Date.now() cycles every 10 seconds, so
        // two write-offs within the same window collide -- same weak
        // scheme already fixed in the original write-off module, but
        // reintroduced independently here. Matches that fix (timestamp +
        // random) and adds duplicate-key retry.
        let refNumber = `WO-${new Date().toISOString().split('T')[0]}-${Date.now().toString().slice(-6)}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
        let writeOff, woError;
        ({ data: writeOff, error: woError } = await supabaseClient
            .from('write_offs')
            .insert([{
                reference_number: refNumber,
                date: new Date().toISOString().split('T')[0],
                total_qty_written_off: batch.total_qty || 0,
                total_cost_written_off: totalCost
            }])
            .select());

        if (woError) {
            if (woError.code === '23505' || woError.message?.includes('duplicate key')) {
                refNumber = `WO-${new Date().toISOString().split('T')[0]}-${Date.now().toString().slice(-6)}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
                ({ data: writeOff, error: woError } = await supabaseClient
                    .from('write_offs')
                    .insert([{
                        reference_number: refNumber,
                        date: new Date().toISOString().split('T')[0],
                        total_qty_written_off: batch.total_qty || 0,
                        total_cost_written_off: totalCost
                    }])
                    .select());
            }
            if (woError) throw woError;
        }

        const writeOffId = writeOff[0].id;

        // Add write-off item
        const { error: itemError } = await supabaseClient
            .from('write_off_items')
            .insert([{
                write_off_id: writeOffId,
                batch_id: batch.id,
                product_id: batch.product_id,
                product_name: batch.products?.product_name || 'Unknown',
                batch_number: batch.batch_number,
                qty_written_off: batch.total_qty || 0,
                cost_per_unit: batch.cost_price || 0,
                total_cost: totalCost
            }]);

        if (itemError) throw itemError;

        // Update batch total_qty to 0
        const { error: updateError } = await supabaseClient
            .from('batches')
            .update({ total_qty: 0 })
            .eq('id', batchId);

        if (updateError) throw updateError;

        // ==========================================
        // CREATE ACCOUNTING ENTRY FOR WRITE-OFF
        // ==========================================
        await createWriteOffJournalEntry(writeOffId, batch, totalCost);

        alert(`Batch ${batch.batch_number} written off successfully!`);
        await loadExpiryData();

    } catch (error) {
        console.error("Error processing write-off:", error);
        alert("Error processing write-off: " + error.message);
    }
};

// ============================================
// LOAD BULK WRITE-OFF LIST
// ============================================
async function loadBulkWriteOffList() {
    const container = document.getElementById('bulkWriteOffList');
    if (!container) return;

    container.innerHTML = '<p style="text-align: center; color: #94a3b8; padding: 20px;">Loading...</p>';

    try {
        const today = new Date();
        const thirtyDaysFromNow = new Date();
        thirtyDaysFromNow.setDate(today.getDate() + 30);

        const { data: batches, error } = await supabaseClient
            .from('batches')
            .select(`
                id,
                batch_number,
                expiry_date,
                total_qty,
                cost_price,
                products:product_id ( product_name, sku )
            `)
            .gt('total_qty', 0)
            .lte('expiry_date', thirtyDaysFromNow.toISOString().split('T')[0])
            .order('expiry_date', { ascending: true });

        if (error) throw error;

        if (!batches || batches.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: #94a3b8; padding: 20px;">No batches expiring soon.</p>';
            return;
        }

        let html = `
            <div style="margin-bottom: 15px; padding: 10px; background: #fef3c7; border-radius: 6px; border-left: 4px solid #f59e0b;">
                <p style="margin: 0; color: #92400e; font-size: 0.9rem;">
                    <i class="fa-solid fa-triangle-exclamation"></i> 
                    Selected batches will be written off and removed from inventory. 
                    A journal entry will be created (Dr Inventory Write-Off, Cr Inventory).
                </p>
            </div>
            <table class="table-minimal">
                <thead>
                    <tr>
                        <th style="width: 30px;"><input type="checkbox" id="selectAllBulk"></th>
                        <th>Product</th>
                        <th>SKU</th>
                        <th>Batch</th>
                        <th>Expiry</th>
                        <th style="text-align: right;">Qty</th>
                        <th style="text-align: right;">Cost/Unit</th>
                        <th style="text-align: right;">Total Cost</th>
                    </tr>
                </thead>
                <tbody>`;

        batches.forEach(b => {
            const totalCost = (b.total_qty || 0) * (b.cost_price || 0);
            html += `
                <tr class="bulk-item" data-id="${b.id}" data-qty="${b.total_qty || 0}" data-cost="${totalCost}" data-product="${b.products?.product_name || 'Unknown'}" data-batch="${b.batch_number}">
                    <td><input type="checkbox" class="bulk-checkbox" data-id="${b.id}"></td>
                    <td>${b.products?.product_name || 'Unknown'}</td>
                    <td style="font-family: monospace; font-size: 0.8rem;">${b.products?.sku || 'N/A'}</td>
                    <td style="font-family: monospace;">${b.batch_number}</td>
                    <td>${new Date(b.expiry_date).toLocaleDateString()}</td>
                    <td style="text-align: right;">${b.total_qty || 0}</td>
                    <td style="text-align: right;">K${(b.cost_price || 0).toFixed(2)}</td>
                    <td style="text-align: right;">K${totalCost.toFixed(2)}</td>
                </tr>
            `;
        });

        html += `</tbody></table>
            <div style="margin-top: 15px; padding: 15px; background: #f8fafc; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
                <div>
                    <strong>Total Selected:</strong> 
                    <span id="bulkTotalQty">0</span> units
                </div>
                <div>
                    <strong>Total Cost:</strong> 
                    <span id="bulkTotalCost" style="color: #dc2626; font-weight: bold;">0.00</span>
                </div>
            </div>
        `;
        container.innerHTML = html;

        const selectAll = document.getElementById('selectAllBulk');
        if (selectAll) {
            selectAll.addEventListener('change', (e) => {
                document.querySelectorAll('.bulk-checkbox').forEach(cb => {
                    cb.checked = e.target.checked;
                });
                updateBulkTotals();
            });
        }

        document.querySelectorAll('.bulk-checkbox').forEach(cb => {
            cb.addEventListener('change', updateBulkTotals);
        });

        updateBulkTotals();

    } catch (error) {
        console.error("Error loading bulk write-off list:", error);
        container.innerHTML = `<p style="text-align: center; color: #dc2626; padding: 20px;">Error: ${error.message}</p>`;
    }
}

// ============================================
// UPDATE BULK TOTALS
// ============================================
function updateBulkTotals() {
    let totalQty = 0;
    let totalCost = 0;

    document.querySelectorAll('.bulk-checkbox:checked').forEach(cb => {
        const row = cb.closest('.bulk-item');
        const qty = parseInt(row.dataset.qty) || 0;
        const cost = parseFloat(row.dataset.cost) || 0;
        totalQty += qty;
        totalCost += cost;
    });

    const qtyEl = document.getElementById('bulkTotalQty');
    const costEl = document.getElementById('bulkTotalCost');
    if (qtyEl) qtyEl.textContent = totalQty;
    if (costEl) costEl.textContent = totalCost.toFixed(2);
}

// ============================================
// SUBMIT BULK WRITE-OFF (WITH ACCOUNTING)
// ============================================
async function submitBulkWriteOff() {
    const btn = document.getElementById('confirmBulkWriteOffBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Processing...`;
    }

    const selectedCheckboxes = document.querySelectorAll('.bulk-checkbox:checked');
    if (selectedCheckboxes.length === 0) {
        alert('Please select at least one batch to write off.');
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<i class="fa-solid fa-trash-can"></i> Confirm Write-Off`;
        }
        return;
    }

    const selectedRows = Array.from(selectedCheckboxes).map(cb => cb.closest('.bulk-item'));
    const items = selectedRows.map(row => ({
        id: row.dataset.id,
        qty: parseInt(row.dataset.qty) || 0,
        cost: parseFloat(row.dataset.cost) || 0,
        product: row.dataset.product || 'Unknown',
        batch: row.dataset.batch || 'N/A'
    }));

    const totalQty = items.reduce((sum, i) => sum + i.qty, 0);
    const totalCost = items.reduce((sum, i) => sum + i.cost, 0);

    if (!confirm(`This will write off ${totalQty} units worth K${totalCost.toFixed(2)}. Continue?`)) {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<i class="fa-solid fa-trash-can"></i> Confirm Write-Off`;
        }
        return;
    }

    try {
        // Ensure accounts exist
        await ensureAccountsExist();

        // 🔥 FIX: same weak reference-number entropy fix as the single
        // write-off path above.
        let refNumber = `WO-${new Date().toISOString().split('T')[0]}-${Date.now().toString().slice(-6)}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
        let writeOff, woError;
        ({ data: writeOff, error: woError } = await supabaseClient
            .from('write_offs')
            .insert([{
                reference_number: refNumber,
                date: new Date().toISOString().split('T')[0],
                total_qty_written_off: totalQty,
                total_cost_written_off: totalCost
            }])
            .select());

        if (woError) {
            if (woError.code === '23505' || woError.message?.includes('duplicate key')) {
                refNumber = `WO-${new Date().toISOString().split('T')[0]}-${Date.now().toString().slice(-6)}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
                ({ data: writeOff, error: woError } = await supabaseClient
                    .from('write_offs')
                    .insert([{
                        reference_number: refNumber,
                        date: new Date().toISOString().split('T')[0],
                        total_qty_written_off: totalQty,
                        total_cost_written_off: totalCost
                    }])
                    .select());
            }
            if (woError) throw woError;
        }

        const writeOffId = writeOff[0].id;

        let batchDetails = [];

        for (let row of selectedRows) {
            const batchId = row.dataset.id;
            const qty = parseInt(row.dataset.qty) || 0;
            const totalCostItem = parseFloat(row.dataset.cost) || 0;
            const costPerUnit = qty > 0 ? totalCostItem / qty : 0;

            const { data: batchInfo } = await supabaseClient
                .from('batches')
                .select(`
                    product_id,
                    batch_number,
                    products:product_id ( product_name )
                `)
                .eq('id', batchId)
                .single();

            const productName = batchInfo?.products?.product_name || row.dataset.product || 'Unknown';

            const { error: itemError } = await supabaseClient
                .from('write_off_items')
                .insert([{
                    write_off_id: writeOffId,
                    batch_id: batchId,
                    product_id: batchInfo?.product_id,
                    product_name: productName,
                    batch_number: batchInfo?.batch_number || row.dataset.batch || 'N/A',
                    qty_written_off: qty,
                    cost_per_unit: costPerUnit,
                    total_cost: totalCostItem
                }]);

            if (itemError) throw itemError;

            // Store batch details for accounting entry
            batchDetails.push({
                batchId: batchId,
                productName: productName,
                batchNumber: batchInfo?.batch_number || row.dataset.batch || 'N/A',
                qty: qty,
                costPerUnit: costPerUnit,
                totalCost: totalCostItem
            });

            // Update batch total_qty to 0
            const { error: updateError } = await supabaseClient
                .from('batches')
                .update({ total_qty: 0 })
                .eq('id', batchId);

            if (updateError) throw updateError;
        }

        // ==========================================
        // CREATE ACCOUNTING ENTRY FOR BULK WRITE-OFF
        // ==========================================
        await createBulkWriteOffJournalEntry(writeOffId, batchDetails, totalCost);

        alert(`Write-Off ${refNumber} completed successfully!`);
        
        const closeBtn = document.getElementById('closeBulkModalBtn');
        if (closeBtn) closeBtn.click();
        
        await loadExpiryData();

    } catch (error) {
        console.error("Error processing bulk write-off:", error);
        alert("Error processing write-off: " + error.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<i class="fa-solid fa-trash-can"></i> Confirm Write-Off`;
        }
    }
}

// ============================================
// CREATE WRITE-OFF JOURNAL ENTRY (Single)
// ============================================
async function createWriteOffJournalEntry(writeOffId, batch, totalCost) {
    try {
        const inventoryAccount = accountCache.inventory || '1400';
        const writeOffAccount = accountCache.inventory_write_offs || '6002';

        const description = `Write-off of expired stock: ${batch.products?.product_name || 'Unknown'} (${batch.batch_number})`;

        // Create Journal Entry
        const journal = {
            entry_date: new Date().toISOString().split('T')[0],
            reference: `WO-${writeOffId.slice(0, 8).toUpperCase()}`,
            description: description,
            journal_number: `WO-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
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
        // Dr Inventory Write-Off (Expense) - Debit
        // Cr Inventory (Asset) - Credit
        const lines = [
            {
                journal_entry_id: journalId,
                account_code: writeOffAccount,
                description: `Write-off of expired stock: ${batch.products?.product_name || 'Unknown'}`,
                debit: Math.abs(totalCost),
                credit: 0
            },
            {
                journal_entry_id: journalId,
                account_code: inventoryAccount,
                description: `Write-off of expired stock: ${batch.products?.product_name || 'Unknown'}`,
                debit: 0,
                credit: Math.abs(totalCost)
            }
        ];

        const { error: lineError } = await supabaseClient
            .from('journal_lines')
            .insert(lines);

        if (lineError) throw lineError;

        console.log(`✅ Write-off journal entry created: K${totalCost.toFixed(2)}`);
        console.log(`   Write-Off Account (Dr): ${writeOffAccount}`);
        console.log(`   Inventory Account (Cr): ${inventoryAccount}`);

        return journalId;

    } catch (error) {
        console.error('Error creating write-off journal entry:', error);
        throw error;
    }
}

// ============================================
// CREATE BULK WRITE-OFF JOURNAL ENTRY
// ============================================
async function createBulkWriteOffJournalEntry(writeOffId, batchDetails, totalCost) {
    try {
        const inventoryAccount = accountCache.inventory || '1400';
        const writeOffAccount = accountCache.inventory_write_offs || '6002';

        // Build description with all products
        const productNames = batchDetails.map(b => b.productName).join(', ');
        const description = `Bulk write-off of expired stock: ${productNames} (${batchDetails.length} batches)`;

        // Create Journal Entry
        const journal = {
            entry_date: new Date().toISOString().split('T')[0],
            reference: `WO-${writeOffId.slice(0, 8).toUpperCase()}`,
            description: description,
            journal_number: `WO-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
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
        const lines = [
            {
                journal_entry_id: journalId,
                account_code: writeOffAccount,
                description: `Bulk write-off of ${batchDetails.length} expired batches`,
                debit: Math.abs(totalCost),
                credit: 0
            },
            {
                journal_entry_id: journalId,
                account_code: inventoryAccount,
                description: `Bulk write-off of ${batchDetails.length} expired batches`,
                debit: 0,
                credit: Math.abs(totalCost)
            }
        ];

        const { error: lineError } = await supabaseClient
            .from('journal_lines')
            .insert(lines);

        if (lineError) throw lineError;

        console.log(`✅ Bulk write-off journal entry created: K${totalCost.toFixed(2)}`);
        console.log(`   Write-Off Account (Dr): ${writeOffAccount}`);
        console.log(`   Inventory Account (Cr): ${inventoryAccount}`);
        console.log(`   ${batchDetails.length} batches written off`);

        return journalId;

    } catch (error) {
        console.error('Error creating bulk write-off journal entry:', error);
        throw error;
    }
}

// ============================================
// LOAD WRITE-OFF HISTORY
// ============================================
async function loadWriteOffHistory() {
    const container = document.getElementById('historyContent');
    if (!container) return;

    container.innerHTML = '<p style="text-align: center; color: #94a3b8; padding: 30px;">Loading...</p>';

    try {
        const { data: history, error } = await supabaseClient
            .from('write_offs')
            .select(`
                id,
                reference_number,
                date,
                total_qty_written_off,
                total_cost_written_off,
                write_off_items (
                    product_name,
                    batch_number,
                    qty_written_off,
                    total_cost
                )
            `)
            .order('date', { ascending: false });

        if (error) throw error;

        if (!history || history.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: #94a3b8; padding: 30px;">No write-off history found.</p>';
            return;
        }

        let html = `
            <div style="margin-bottom: 15px; padding: 10px; background: #f0fdf4; border-radius: 6px; border-left: 4px solid #22c55e;">
                <p style="margin: 0; color: #15803d; font-size: 0.9rem;">
                    <i class="fa-solid fa-circle-info"></i> 
                    Each write-off creates a journal entry: Dr Inventory Write-Off (6002), Cr Inventory (1400)
                </p>
            </div>
            <table class="table-minimal">
                <thead>
                    <tr>
                        <th style="padding-left: 20px;">Reference</th>
                        <th>Date</th>
                        <th>Items</th>
                        <th style="text-align: right;">Total Qty</th>
                        <th style="text-align: right;">Total Cost</th>
                        <th style="text-align: center;">Journal Entry</th>
                    </tr>
                </thead>
                <tbody>
        `;

        history.forEach(h => {
            html += `
                <tr style="cursor: pointer;" onclick="openWriteOffDetail('${h.id}')">
                    <td style="padding-left: 20px; font-weight: 500; color: #2563eb;">
                        <i class="fa-solid fa-receipt"></i> ${h.reference_number}
                    </td>
                    <td>${new Date(h.date).toLocaleDateString()}</td>
                    <td>${h.write_off_items?.length || 0} items</td>
                    <td style="text-align: right;">${h.total_qty_written_off}</td>
                    <td style="text-align: right; font-weight: bold; color: #dc2626;">K${h.total_cost_written_off.toFixed(2)}</td>
                    <td style="text-align: center;">
                        <span style="background: #dbeafe; color: #2563eb; padding: 2px 10px; border-radius: 10px; font-size: 0.75rem;">
                            <i class="fa-solid fa-book"></i> Posted
                        </span>
                    </td>
                </tr>
            `;
        });

        html += `</tbody></table>`;
        container.innerHTML = html;

    } catch (error) {
        console.error("Error loading write-off history:", error);
        container.innerHTML = `<p style="text-align: center; color: #dc2626; padding: 30px;">Error: ${error.message}</p>`;
    }
}

// ============================================
// OPEN WRITE-OFF DETAIL
// ============================================
window.openWriteOffDetail = async function(writeOffId) {
    const modal = document.getElementById('writeOffDetailModal');
    const title = document.getElementById('detailModalTitle');
    const content = document.getElementById('detailContent');

    if (!modal || !title || !content) return;

    modal.style.display = 'flex';
    title.textContent = `Write-Off Details`;
    content.innerHTML = `<p style="text-align: center; color: #94a3b8; padding: 30px;"><i class="fa-solid fa-spinner fa-spin"></i> Loading details...</p>`;

    try {
        const { data: detail, error } = await supabaseClient
            .from('write_offs')
            .select(`
                reference_number,
                date,
                total_qty_written_off,
                total_cost_written_off,
                write_off_items (
                    product_name,
                    batch_number,
                    qty_written_off,
                    cost_per_unit,
                    total_cost
                )
            `)
            .eq('id', writeOffId)
            .single();

        if (error) throw error;

        let html = `
            <div style="margin-bottom: 20px; display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 15px;">
                <div style="padding: 15px; background: #f8fafc; border-radius: 6px;">
                    <p style="margin: 0; font-size: 0.8rem; color: #64748b;">Reference</p>
                    <p style="margin: 5px 0 0 0; font-weight: 600;">${detail.reference_number}</p>
                </div>
                <div style="padding: 15px; background: #f8fafc; border-radius: 6px;">
                    <p style="margin: 0; font-size: 0.8rem; color: #64748b;">Date</p>
                    <p style="margin: 5px 0 0 0; font-weight: 600;">${new Date(detail.date).toLocaleDateString()}</p>
                </div>
                <div style="padding: 15px; background: #f8fafc; border-radius: 6px;">
                    <p style="margin: 0; font-size: 0.8rem; color: #64748b;">Total Qty Written Off</p>
                    <p style="margin: 5px 0 0 0; font-weight: 600;">${detail.total_qty_written_off}</p>
                </div>
                <div style="padding: 15px; background: #fef2f2; border-radius: 6px; border-left: 4px solid #dc2626;">
                    <p style="margin: 0; font-size: 0.8rem; color: #64748b;">Total Cost</p>
                    <p style="margin: 5px 0 0 0; font-weight: 700; color: #dc2626;">K${detail.total_cost_written_off.toFixed(2)}</p>
                </div>
            </div>
            <div style="margin-bottom: 15px; padding: 10px; background: #dbeafe; border-radius: 6px;">
                <p style="margin: 0; color: #2563eb; font-size: 0.85rem;">
                    <i class="fa-solid fa-book"></i> 
                    <strong>Journal Entry:</strong> Dr Inventory Write-Off (6002) | Cr Inventory (1400)
                </p>
            </div>
            <table class="table-minimal">
                <thead>
                    <tr>
                        <th style="padding-left: 20px;">Product</th>
                        <th>Batch</th>
                        <th style="text-align: right;">Qty</th>
                        <th style="text-align: right;">Cost/Unit</th>
                        <th style="text-align: right;">Total Cost</th>
                    </tr>
                </thead>
                <tbody>
        `;

        detail.write_off_items.forEach(item => {
            html += `
                <tr>
                    <td style="padding-left: 20px;">${item.product_name}</td>
                    <td style="font-family: monospace;">${item.batch_number}</td>
                    <td style="text-align: right;">${item.qty_written_off}</td>
                    <td style="text-align: right;">K${(item.cost_per_unit || 0).toFixed(2)}</td>
                    <td style="text-align: right; font-weight: bold;">K${item.total_cost.toFixed(2)}</td>
                </tr>
            `;
        });

        html += `</tbody></table>`;
        content.innerHTML = html;

    } catch (error) {
        console.error("Error loading write-off details:", error);
        content.innerHTML = `<p style="text-align: center; color: #dc2626; padding: 30px;">Error: ${error.message}</p>`;
    }
};