// ============================================
// WRITE-OFF POS LOGIC (WITH ACCOUNTING)
// ============================================

(async function initWriteOff() {
    console.log("Write-Off initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // ============================================
    // DOM REFERENCES
    // ============================================
    const tableBody = document.getElementById('writeOffTableBody');
    const productSelect = document.getElementById('writeOffProductSelect');
    const batchSelect = document.getElementById('writeOffBatchSelect');
    const qtyInput = document.getElementById('writeOffQtyInput');
    const addBatchBtn = document.getElementById('addBatchBtn');
    const reasonSelect = document.getElementById('writeOffReason');
    const reasonOther = document.getElementById('writeOffReasonOther');
    const saveBtn = document.getElementById('saveWriteOffBtn');
    const resetBtn = document.getElementById('resetWriteOffBtn');
    const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
    const batchInfo = document.getElementById('batchInfo');
    const batchInfoText = document.getElementById('batchInfoText');

    // State
    let allProducts = [];
    let selectedProductBatches = [];
    let writeOffItems = [];
    let isLoading = false;

    // ============================================
    // 🔥 CHART OF ACCOUNTS - AUTO CREATE MISSING ACCOUNTS
    // ============================================
    // Ported from retail.js/wholesale.js/donation.js. Previously this file
    // hardcoded account codes ('6002', '1400') directly into journal_lines
    // inserts with no guarantee those rows existed in chart_of_accounts.
    const REQUIRED_ACCOUNTS = [
        { code: '1400', name: 'Inventory', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        { code: '6002', name: 'Inventory Write-Offs', type: 'Expense', category: 'Operating Expense', normal_balance: 'Debit' }
    ];

    // 🔥 PERF FIX: this used to run on every single save -- and twice per
    // save at that, since the accounting-entries function called it
    // directly AND getAccountCodesFromChartOfAccounts() called it again
    // right afterwards. Each run checked every required account ONE AT A
    // TIME (a separate SELECT, and INSERT if missing, per account) -- up
    // to REQUIRED_ACCOUNTS.length * 2 sequential round-trips just for this
    // housekeeping step. REQUIRED_ACCOUNTS is a fixed list baked into this
    // file and never changes while the page is open, so it only needs
    // checking once per page load. Now: checked in a single query, any
    // missing ones created in a single batch insert, and skipped entirely
    // after the first successful run.
    let chartOfAccountsSynced = false;

    async function ensureChartOfAccounts() {
        if (chartOfAccountsSynced) {
            return { created: 0, existing: REQUIRED_ACCOUNTS.length, cached: true };
        }

        try {
            const codes = REQUIRED_ACCOUNTS.map(a => a.code);
            const { data: existingAccounts, error: findError } = await supabaseClient
                .from('chart_of_accounts')
                .select('code')
                .in('code', codes);

            if (findError) throw findError;

            const existingCodes = new Set((existingAccounts || []).map(a => a.code));
            const missing = REQUIRED_ACCOUNTS.filter(a => !existingCodes.has(a.code));

            let created = 0;
            if (missing.length > 0) {
                const { error: insertError } = await supabaseClient
                    .from('chart_of_accounts')
                    .insert(missing.map(account => ({
                        code: account.code,
                        name: account.name,
                        type: account.type,
                        category: account.category,
                        normal_balance: account.normal_balance,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    })));

                if (insertError) {
                    console.error('Error creating missing accounts:', insertError);
                } else {
                    created = missing.length;
                    missing.forEach(a => console.log(`✅ Created account: ${a.code} - ${a.name}`));
                }
            }

            const existing = REQUIRED_ACCOUNTS.length - missing.length;
            console.log(`✅ Chart of Accounts sync complete: ${created} created, ${existing} existing`);
            chartOfAccountsSynced = true;
            return { created, existing };
        } catch (error) {
            console.error('Error ensuring chart of accounts:', error);
            return { created: 0, existing: 0, error };
        }
    }

    async function getAccountCodesFromChartOfAccounts() {
        try {
            await ensureChartOfAccounts();
            const accountNames = REQUIRED_ACCOUNTS.map(a => a.name);
            const { data: accounts, error } = await supabaseClient
                .from('chart_of_accounts')
                .select('code, name')
                .in('name', accountNames);

            if (error) throw error;

            const accountMap = {};
            accounts.forEach(acc => {
                const key = acc.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
                accountMap[key] = acc.code;
            });

            return {
                inventory: accountMap['inventory'] || '1400',
                inventory_write_offs: accountMap['inventory_write_offs'] || '6002'
            };
        } catch (error) {
            console.error('Error fetching account codes:', error);
            return { inventory: '1400', inventory_write_offs: '6002' };
        }
    }

    // ============================================
    // CHECK CONNECTION FIRST
    // ============================================
    async function checkConnection() {
        try {
            const { data, error } = await supabaseClient
                .from('products')
                .select('id')
                .limit(1);
            
            if (error) {
                console.error("Connection check failed:", error);
                return false;
            }
            console.log("✅ Supabase connection successful");
            return true;
        } catch (e) {
            console.error("Connection error:", e);
            return false;
        }
    }

    // ============================================
    // TOGGLE SIDEBAR
    // ============================================
    if (toggleSidebarBtn) {
        // 🔥 FIX: previously looked up a `#appRoot` element that doesn't
        // exist anywhere in the page, so this button silently did
        // nothing. Toggles a class on <body> instead (see style.css),
        // which hides the sidebar and lets the workspace expand.
        toggleSidebarBtn.addEventListener('click', function() {
            document.body.classList.toggle('layout-fullscreen');
        });
    }

    // ============================================
    // GENERATE REFERENCE NUMBER
    // ============================================
    function generateReference() {
        const display = document.getElementById('writeOffIdDisplay');
        const date = new Date();
        const year = date.getFullYear();
        // 🔥 FIX: the old scheme was WO-{year}-{4-digit random} — only
        // 10,000 possible IDs per year with no time component. Matched
        // here to retail/wholesale/donation's timestamp+random scheme.
        const timestamp = date.getTime().toString().slice(-6);
        const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        const ref = `WO-${year}-${timestamp}-${random}`;
        if (display) display.textContent = ref;
        return ref;
    }
    generateReference();

    // ============================================
    // LOAD PRODUCTS WITH RETRY
    // ============================================
    async function loadProducts(retryCount = 0) {
        if (isLoading) return;
        isLoading = true;

        try {
            const isConnected = await checkConnection();
            if (!isConnected) {
                productSelect.innerHTML = '<option value="">⚠️ Connection failed. Please refresh.</option>';
                isLoading = false;
                return;
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);

            const { data: products, error } = await supabaseClient
                .from('products')
                .select('id, product_name')
                .order('product_name');

            clearTimeout(timeoutId);

            if (error) {
                console.error("Error loading products:", error);
                throw error;
            }

            allProducts = products || [];
            
            productSelect.innerHTML = '<option value="">🔍 Search or select product...</option>';
            if (products && products.length > 0) {
                products.forEach(p => {
                    productSelect.innerHTML += `<option value="${p.id}">${p.product_name}</option>`;
                });
            } else {
                productSelect.innerHTML = '<option value="">No products found</option>';
            }

            console.log(`✅ Loaded ${products ? products.length : 0} products`);

        } catch (error) {
            console.error("Error loading products:", error);
            
            if (retryCount < 3) {
                console.log(`Retrying... (${retryCount + 1}/3)`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                await loadProducts(retryCount + 1);
            } else {
                productSelect.innerHTML = `
                    <option value="">❌ Error loading products</option>
                    <option value="RETRY" style="color: #2563eb;">🔄 Click to retry</option>
                `;
                productSelect.addEventListener('change', function() {
                    if (this.value === 'RETRY') {
                        loadProducts();
                    }
                });
            }
        } finally {
            isLoading = false;
        }
    }

    // ============================================
    // LOAD BATCHES FOR SELECTED PRODUCT
    // ============================================
    async function loadBatchesForProduct(productId) {
        if (!productId) {
            batchSelect.innerHTML = '<option value="">Select batch...</option>';
            batchInfo.style.display = 'none';
            return;
        }

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
                .eq('product_id', productId)
                .gt('total_qty', 0)
                .order('expiry_date', { ascending: true });

            if (error) throw error;

            selectedProductBatches = batches || [];
            
            batchSelect.innerHTML = '<option value="">Select batch...</option>';
            
            if (batches.length === 0) {
                batchSelect.innerHTML = '<option value="">No stock available</option>';
                batchInfo.style.display = 'block';
                batchInfoText.textContent = '⚠️ No stock available for this product.';
                batchInfoText.style.color = '#dc2626';
                return;
            }

            const firstBatch = batches[0];
            const expiry = new Date(firstBatch.expiry_date);
            const today = new Date();
            const daysUntilExpiry = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
            
            batchInfo.style.display = 'block';
            batchInfoText.style.color = '#64748b';
            batchInfoText.textContent = `📦 ${batches.length} batch(es) available. FEFO: ${firstBatch.batch_number} (${daysUntilExpiry} days until expiry)`;

            batches.forEach(b => {
                const expiryDate = new Date(b.expiry_date).toLocaleDateString();
                const days = Math.ceil((new Date(b.expiry_date) - today) / (1000 * 60 * 60 * 24));
                let expiryLabel = '';
                if (days < 0) expiryLabel = '🔴 EXPIRED';
                else if (days <= 30) expiryLabel = `🟡 ${days} days`;
                else expiryLabel = `🟢 ${days} days`;
                
                batchSelect.innerHTML += `
                    <option value="${b.id}" data-qty="${b.total_qty}" data-cost="${b.cost_price}" data-expiry="${b.expiry_date}">
                        ${b.batch_number} | Qty: ${b.total_qty} | Exp: ${expiryDate} ${expiryLabel}
                    </option>
                `;
            });

            if (batches.length > 0) {
                batchSelect.value = batches[0].id;
                updateQtyMax();
            }

        } catch (error) {
            console.error("Error loading batches:", error);
            batchSelect.innerHTML = '<option value="">Error loading batches</option>';
            batchInfo.style.display = 'block';
            batchInfoText.textContent = '❌ Error loading batches. Please try again.';
            batchInfoText.style.color = '#dc2626';
        }
    }

    // ============================================
    // UPDATE QTY MAX
    // ============================================
    function updateQtyMax() {
        const selected = batchSelect.options[batchSelect.selectedIndex];
        if (selected && selected.dataset.qty) {
            const maxQty = parseInt(selected.dataset.qty) || 0;
            qtyInput.max = maxQty;
            qtyInput.placeholder = `Max: ${maxQty}`;
            if (parseInt(qtyInput.value) > maxQty) {
                qtyInput.value = maxQty;
            }
        }
    }

    // ============================================
    // ADD BATCH TO WRITE-OFF LIST
    // ============================================
    function addBatchToWriteOff() {
        const productId = productSelect.value;
        const batchId = batchSelect.value;
        const qty = parseInt(qtyInput.value) || 0;

        if (!productId) {
            alert('Please select a product.');
            productSelect.focus();
            return;
        }

        if (!batchId) {
            alert('Please select a batch.');
            batchSelect.focus();
            return;
        }

        if (qty <= 0) {
            alert('Please enter a valid quantity.');
            qtyInput.focus();
            return;
        }

        if (writeOffItems.find(item => item.batch_id === batchId)) {
            alert('This batch is already in the list.');
            return;
        }

        const product = allProducts.find(p => p.id === productId);
        const batch = selectedProductBatches.find(b => b.id === batchId);

        if (!batch) {
            alert('Batch not found.');
            return;
        }

        if (qty > batch.total_qty) {
            alert(`Maximum available quantity is ${batch.total_qty}`);
            return;
        }

        writeOffItems.push({
            batch_id: batch.id,
            batch_number: batch.batch_number,
            product_name: product ? product.product_name : 'Unknown',
            product_id: productId,
            expiry_date: batch.expiry_date,
            available_qty: batch.total_qty,
            qty_to_write: qty,
            cost_per_unit: batch.cost_price || 0,
            total_cost: (batch.cost_price || 0) * qty
        });

        renderWriteOffTable();
        updateTotals();
        resetSelection();
    }

    // ============================================
    // RESET SELECTION
    // ============================================
    function resetSelection() {
        productSelect.value = '';
        batchSelect.innerHTML = '<option value="">Select batch...</option>';
        qtyInput.value = '1';
        batchInfo.style.display = 'none';
        selectedProductBatches = [];
        productSelect.focus();
    }

    // ============================================
    // RENDER WRITE-OFF TABLE
    // ============================================
    function renderWriteOffTable() {
        if (!tableBody) return;
        
        if (writeOffItems.length === 0) {
            tableBody.innerHTML = `
                <tr class="writeoff-placeholder">
                    <td colspan="8" style="text-align: center; padding: 40px; color: #94a3b8;">
                        <i class="fa-solid fa-box-open" style="font-size: 2rem; display: block; margin-bottom: 10px;"></i>
                        <p>No batches added yet.</p>
                        <p style="font-size: 0.85rem;">Search and select a product above to add batches.</p>
                    </td>
                </tr>
            `;
            return;
        }

        let html = '';
        writeOffItems.forEach((item, index) => {
            const expiry = new Date(item.expiry_date);
            const today = new Date();
            const daysUntilExpiry = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
            const isExpired = daysUntilExpiry < 0;

            html += `
                <tr style="${isExpired ? 'background: #fef2f2;' : ''} border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 10px 10px 10px 20px; font-weight: 500;">${item.product_name}</td>
                    <td style="padding: 10px; font-family: monospace;">${item.batch_number}</td>
                    <td style="padding: 10px; ${isExpired ? 'color: #dc2626;' : ''}">${expiry.toLocaleDateString()}</td>
                    <td style="padding: 10px; text-align: center;">${item.available_qty}</td>
                    <td style="padding: 10px; text-align: center;">
                        <input type="number" class="writeoff-qty" data-index="${index}" 
                               min="0" max="${item.available_qty}" value="${item.qty_to_write}" 
                               style="width: 70px; padding: 4px 8px; border: 1px solid #e2e8f0; border-radius: 4px; text-align: center;">
                    </td>
                    <td style="padding: 10px; text-align: right;">K${item.cost_per_unit.toFixed(2)}</td>
                    <td style="padding: 10px; text-align: right; font-weight: 600;" class="writeoff-total-cost" data-index="${index}">
                        K${item.total_cost.toFixed(2)}
                    </td>
                    <td style="padding: 10px 20px 10px 10px; text-align: center;">
                        <button class="remove-writeoff-item" data-index="${index}" style="background: none; border: none; color: #ef4444; cursor: pointer; font-size: 1.1rem;">
                            <i class="fa-regular fa-trash-can"></i>
                        </button>
                    </td>
                </tr>
            `;
        });

        tableBody.innerHTML = html;

        document.querySelectorAll('.writeoff-qty').forEach(input => {
            input.addEventListener('input', function() {
                const index = parseInt(this.dataset.index);
                const qty = parseInt(this.value) || 0;
                const max = parseInt(this.max) || 0;
                
                if (qty > max) {
                    this.value = max;
                    alert(`Maximum available quantity is ${max}`);
                    return;
                }
                
                writeOffItems[index].qty_to_write = qty;
                writeOffItems[index].total_cost = qty * writeOffItems[index].cost_per_unit;
                
                const totalCostEl = document.querySelector(`.writeoff-total-cost[data-index="${index}"]`);
                if (totalCostEl) {
                    totalCostEl.textContent = `K${writeOffItems[index].total_cost.toFixed(2)}`;
                }
                updateTotals();
            });
        });

        document.querySelectorAll('.remove-writeoff-item').forEach(btn => {
            btn.addEventListener('click', function() {
                const index = parseInt(this.dataset.index);
                writeOffItems.splice(index, 1);
                renderWriteOffTable();
                updateTotals();
            });
        });
    }

    // ============================================
    // UPDATE TOTALS
    // ============================================
    function updateTotals() {
        let totalItems = writeOffItems.length;
        let totalQty = 0;
        let totalCost = 0;

        writeOffItems.forEach(item => {
            totalQty += item.qty_to_write || 0;
            totalCost += item.total_cost || 0;
        });

        const itemsEl = document.getElementById('writeOffTotalItems');
        const qtyEl = document.getElementById('writeOffTotalQty');
        const costEl = document.getElementById('writeOffTotalCost');
        
        if (itemsEl) itemsEl.textContent = totalItems;
        if (qtyEl) qtyEl.textContent = totalQty;
        if (costEl) costEl.textContent = `K${totalCost.toFixed(2)}`;
    }

    // ============================================
    // EVENT LISTENERS
    // ============================================
    
    if (productSelect) {
        productSelect.addEventListener('change', function() {
            const productId = this.value;
            loadBatchesForProduct(productId);
        });
    }

    if (batchSelect) {
        batchSelect.addEventListener('change', updateQtyMax);
    }

    if (addBatchBtn) {
        addBatchBtn.addEventListener('click', addBatchToWriteOff);
    }

    if (qtyInput) {
        qtyInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                addBatchToWriteOff();
            }
        });
    }

    // ============================================
    // REASON SELECT LOGIC
    // ============================================
    if (reasonSelect) {
        reasonSelect.addEventListener('change', function() {
            if (this.value === 'Other') {
                if (reasonOther) reasonOther.style.display = 'block';
            } else {
                if (reasonOther) {
                    reasonOther.style.display = 'none';
                    reasonOther.value = '';
                }
            }
        });
    }

    // ============================================
    // LOAD WRITE-OFF FOR EDIT
    // ============================================
    function loadWriteOffForEdit(saleData) {
        try {
            console.log('Loading write-off for edit:', saleData);
            
            // Set reason
            if (saleData.payment && saleData.payment.note) {
                const reason = saleData.payment.note;
                // Check if reason matches any predefined options
                const options = ['Expired', 'Damaged', 'Expired/Expiring', 'Damaged/Expired', 'Stock Adjustment'];
                if (options.includes(reason)) {
                    reasonSelect.value = reason;
                } else {
                    reasonSelect.value = 'Other';
                    reasonOther.style.display = 'block';
                    reasonOther.value = reason;
                }
            }
            
            // Add items to table
            if (saleData.items && saleData.items.length > 0) {
                // Clear existing items
                writeOffItems = [];
                
                // Add each item as a write-off item
                saleData.items.forEach(item => {
                    writeOffItems.push({
                        batch_id: item.batch_id || '',
                        batch_number: item.batch_number || 'N/A',
                        product_name: item.product_name || 'Unknown',
                        product_id: item.product_id || '',
                        expiry_date: item.expiry_date || new Date().toISOString(),
                        available_qty: item.available_qty || item.qty || 0,
                        qty_to_write: item.qty || 0,
                        cost_per_unit: item.cost_per_unit || item.rate || 0,
                        total_cost: item.total || (item.qty * item.rate) || 0
                    });
                });
                
                renderWriteOffTable();
                updateTotals();
            }
            
            // Set reference number
            if (saleData.sale_id) {
                const display = document.getElementById('writeOffIdDisplay');
                if (display) {
                    display.textContent = saleData.sale_id;
                }
            }
            
            alert('✅ Write-Off loaded for editing. Make changes and save.');
            
        } catch (error) {
            console.error('Error loading write-off for edit:', error);
            alert('Error loading write-off: ' + error.message);
        }
    }

    // ============================================
    // WRITE-OFF ACCOUNTING INTEGRATION (NEW)
    // ============================================
    async function createWriteOffAccountingEntries(refNumber, validItems, totalCost) {
        try {
            if (totalCost > 0) {
                await ensureChartOfAccounts();
                const accountCodes = await getAccountCodesFromChartOfAccounts();
                const entryDate = new Date().toISOString().split('T')[0];

                // 1. Create the Journal Entry Header
                const journal = {
                    entry_date: entryDate,
                    reference: refNumber,
                    description: `Inventory Write-off: ${validItems.length} item(s)`,
                    journal_number: `WOF-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                    status: 'Posted',
                    created_at: new Date().toISOString()
                };

                const { data: journalData, error: jError } = await supabaseClient
                    .from('journal_entries')
                    .insert([journal])
                    .select();

                if (jError) throw jError;

                // 2. Create the Journal Lines
                const lines = [
                    {
                        journal_entry_id: journalData[0].id,
                        account_code: accountCodes.inventory_write_offs,
                        description: `Write-off cost`,
                        debit: totalCost,
                        credit: 0
                    },
                    {
                        journal_entry_id: journalData[0].id,
                        account_code: accountCodes.inventory,
                        description: `Inventory reduction from write-off`,
                        debit: 0,
                        credit: totalCost
                    }
                ];

                const { error: lineError } = await supabaseClient
                    .from('journal_lines')
                    .insert(lines);

                if (lineError) throw lineError;

                console.log(`✅ Write-off accounting entries created for ${refNumber} (Cost: K${totalCost.toFixed(2)})`);
            }
        } catch (accError) {
            console.error('Error creating write-off accounting entries:', accError);
            // Don't block the save
        }
    }

    // ============================================
    // SAVE WRITE-OFF (UPDATED WITH ACCOUNTING)
    // ============================================
    async function saveWriteOff() {
        if (!reasonSelect) return;
        
        const reason = reasonSelect.value;
        if (!reason) {
            alert('Please select a reason for write-off.');
            reasonSelect.focus();
            return;
        }

        if (reason === 'Other' && reasonOther && !reasonOther.value.trim()) {
            alert('Please specify the reason.');
            reasonOther.focus();
            return;
        }

        const finalReason = reason === 'Other' ? (reasonOther ? reasonOther.value.trim() : '') : reason;

        const validItems = writeOffItems.filter(item => item.qty_to_write > 0);
        if (validItems.length === 0) {
            alert('Please add at least one item with quantity > 0 to write off.');
            return;
        }

        const totalQty = validItems.reduce((sum, i) => sum + i.qty_to_write, 0);
        const totalCost = validItems.reduce((sum, i) => sum + i.total_cost, 0);

        if (!confirm(`Are you sure you want to write off ${totalQty} items worth K${totalCost.toFixed(2)}? This action cannot be undone.`)) {
            return;
        }

        const btn = document.getElementById('saveWriteOffBtn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
        }

        try {
            let refNumber = document.getElementById('writeOffIdDisplay')?.textContent || generateReference();

            // Create write-off record
            let writeOff;
            {
                const { data, error: woError } = await supabaseClient
                    .from('write_offs')
                    .insert([{
                        reference_number: refNumber,
                        date: new Date().toISOString().split('T')[0],
                        reason: finalReason,
                        total_qty_written_off: totalQty,
                        total_cost_written_off: totalCost
                    }])
                    .select();

                if (woError) {
                    // 🔥 ADDED: same duplicate-reference retry pattern used
                    // in retail.js/wholesale.js/donation.js.
                    if (woError.code === '23505' || woError.message?.includes('duplicate key')) {
                        console.log('⚠️ Duplicate reference, regenerating...');
                        refNumber = generateReference();
                        const { data: retryData, error: retryError } = await supabaseClient
                            .from('write_offs')
                            .insert([{
                                reference_number: refNumber,
                                date: new Date().toISOString().split('T')[0],
                                reason: finalReason,
                                total_qty_written_off: totalQty,
                                total_cost_written_off: totalCost
                            }])
                            .select();
                        if (retryError) throw new Error('Failed to save (Retry): ' + retryError.message);
                        writeOff = retryData;
                    } else {
                        throw woError;
                    }
                } else {
                    writeOff = data;
                }
            }

            const writeOffId = writeOff[0].id;

            // ============================================
            // Add write-off items and update stock
            // ============================================
            // 🔥 FIX: this loop used to `throw` immediately on the first
            // item that failed (either the write_off_items insert or the
            // batches update), which aborted the ENTIRE function via the
            // outer catch block. That meant the sales audit record and the
            // accounting journal entries were skipped completely — even for
            // items earlier in the loop that had ALREADY been successfully
            // deducted from stock. You'd end up with real stock reductions
            // and write_off_items rows in the database, but zero audit
            // trail and zero accounting for any of it. Now each item is
            // processed independently: failures are collected and reported,
            // but successful items still get their sales record and
            // accounting entries posted for the amount actually written off.
            // 🔥 PERF FIX: previously processed one item at a time --
            // insert its write_off_items row, THEN update its batch, THEN
            // move to the next item -- so a write-off with many lines
            // meant waiting on 2 sequential round-trips per line, one
            // after another. Each item here is independent (its own
            // batch, its own pre-fetched available_qty), so all of them
            // now run concurrently via Promise.all(). Per-item success/
            // failure tracking (an item recorded but its stock update
            // failing, etc.) is preserved exactly as before -- each item
            // just reports its own outcome instead of the loop moving on
            // to the next item only after this one fully finishes.
            const itemResults = await Promise.all(validItems.map(async (item) => {
                try {
                    const { error: itemError } = await supabaseClient
                        .from('write_off_items')
                        .insert([{
                            write_off_id: writeOffId,
                            batch_id: item.batch_id,
                            product_id: item.product_id,
                            product_name: item.product_name,
                            batch_number: item.batch_number,
                            qty_written_off: item.qty_to_write,
                            cost_per_unit: item.cost_per_unit,
                            total_cost: item.total_cost
                        }]);

                    if (itemError) {
                        return { item, ok: false, message: `${item.product_name} (${item.batch_number}): ${itemError.message}` };
                    }

                    const newQty = item.available_qty - item.qty_to_write;
                    const { error: updateError } = await supabaseClient
                        .from('batches')
                        .update({ total_qty: newQty })
                        .eq('id', item.batch_id);

                    if (updateError) {
                        // The write_off_items row was inserted but the stock
                        // update failed — flag this clearly rather than
                        // silently treating it as fully successful.
                        return { item, ok: false, message: `${item.product_name} (${item.batch_number}): item recorded but stock update failed - ${updateError.message}` };
                    }

                    console.log(`Batch ${item.batch_number} stock updated: ${item.available_qty} -> ${newQty}`);
                    return { item, ok: true };

                } catch (err) {
                    return { item, ok: false, message: `${item.product_name} (${item.batch_number}): ${err.message}` };
                }
            }));

            const succeededItems = itemResults.filter(r => r.ok).map(r => r.item);
            const itemErrors = itemResults.filter(r => !r.ok).map(r => r.message);

            if (succeededItems.length === 0) {
                alert(`❌ Write-off failed for all items:\n\n${itemErrors.join('\n')}`);
                return;
            }

            // From here on, use only what actually succeeded.
            const succeededQty = succeededItems.reduce((sum, i) => sum + i.qty_to_write, 0);
            const succeededCost = succeededItems.reduce((sum, i) => sum + i.total_cost, 0);

            if (itemErrors.length > 0) {
                alert(`⚠️ Write-off partially completed.\n\n${succeededItems.length} of ${validItems.length} items succeeded (${succeededQty} units, K${succeededCost.toFixed(2)}).\n\nFailed:\n${itemErrors.join('\n')}\n\nPlease review the failed items manually.`);
            }

            // Also create a sales record for the write-off (Audit Trail)
            const salesRecord = {
                sale_id: refNumber,
                type: 'WRITEOFF',
                prefix: 'WO',
                client_type: 'WRITEOFF',
                client_sub_type: 'WRITEOFF',
                customer_data: {
                    full_name: 'Stock Write-Off',
                    reason: finalReason
                },
                items: succeededItems.map(item => ({
                    product_id: item.product_id,
                    product_name: item.product_name,
                    batch_id: item.batch_id,
                    batch_number: item.batch_number,
                    qty: item.qty_to_write,
                    rate: item.cost_per_unit,
                    total: item.total_cost,
                    cost_per_unit: item.cost_per_unit
                })),
                payment: {
                    type: 'Write-Off',
                    note: finalReason
                },
                subtotal: succeededCost,
                tax: 0,
                grand_total: succeededCost,
                status: 'COMPLETED',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };

            let salesInsertResult = await supabaseClient.from('sales').insert([salesRecord]);
            if (salesInsertResult.error) {
                // 🔥 ADDED: same duplicate-key retry pattern.
                if (salesInsertResult.error.code === '23505' || salesInsertResult.error.message?.includes('duplicate key')) {
                    console.log('⚠️ Duplicate sale_id on write-off audit record, regenerating...');
                    salesRecord.sale_id = `${refNumber}-${Math.floor(Math.random() * 10000)}`;
                    salesInsertResult = await supabaseClient.from('sales').insert([salesRecord]);
                }
                if (salesInsertResult.error) {
                    console.error('Error creating sales record for write-off:', salesInsertResult.error);
                    alert(`⚠️ Write-Off ${refNumber} saved but sales record failed. Please check manually.`);
                }
            }

            // ============================================
            // CREATE ACCOUNTING ENTRIES (CALLED HERE)
            // ============================================
            await createWriteOffAccountingEntries(refNumber, succeededItems, succeededCost);

            // Only show the "completed successfully" alert when everything
            // succeeded — the partial-failure alert above already covers
            // the mixed-result case, so showing this too would misleadingly
            // claim full success right after warning about failures.
            if (itemErrors.length === 0) {
                alert(`✅ Write-Off ${refNumber} completed successfully!\nTotal: ${succeededQty} items | K${succeededCost.toFixed(2)}`);
            }

            resetForm();
            generateReference();

        } catch (error) {
            console.error("Error processing write-off:", error);
            alert("❌ Error processing write-off: " + error.message);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-trash-can"></i> Process Write-Off';
            }
        }
    }

    // ============================================
    // RESET FORM
    // ============================================
    function resetForm() {
        writeOffItems = [];
        renderWriteOffTable();
        updateTotals();
        if (reasonSelect) reasonSelect.value = '';
        if (reasonOther) {
            reasonOther.style.display = 'none';
            reasonOther.value = '';
        }
        resetSelection();
    }

    // ============================================
    // KEYBOARD SHORTCUTS
    // ============================================
    document.addEventListener('keydown', function(e) {
        if (e.ctrlKey && e.key === 's') {
            e.preventDefault();
            if (saveBtn) saveBtn.click();
        }
        if (e.ctrlKey && e.key === 'r') {
            e.preventDefault();
            if (resetBtn) resetBtn.click();
        }
    });

    // ============================================
    // BUTTON EVENTS
    // ============================================
    if (saveBtn) saveBtn.addEventListener('click', saveWriteOff);
    
    if (resetBtn) {
        resetBtn.addEventListener('click', function() {
            if (writeOffItems.length > 0) {
                if (!confirm('Are you sure you want to reset all items?')) return;
            }
            resetForm();
        });
    }

    // ============================================
    // EXPOSE GLOBALLY
    // ============================================
    window.loadWriteOffForEdit = loadWriteOffForEdit;

    // ============================================
    // INITIAL SETUP
    // ============================================
    const isConnected = await checkConnection();
    if (isConnected) {
        await loadProducts();
    } else {
        productSelect.innerHTML = `
            <option value="">⚠️ Cannot connect to database</option>
            <option value="RETRY" style="color: #2563eb;">🔄 Click to retry</option>
        `;
        productSelect.addEventListener('change', function() {
            if (this.value === 'RETRY') {
                initWriteOff();
            }
        });
    }
    
    renderWriteOffTable();
    updateTotals();

    console.log("✅ Write-Off initialized successfully!");
})();