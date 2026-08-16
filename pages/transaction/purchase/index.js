// ============================================
// PURCHASE MODULE - MAIN CONTROLLER (UPDATED)
// ============================================

(async function initPurchasePage() {
    console.log("🛒 Purchase module initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // ============================================
    // GLOBAL STATE
    // ============================================
    // 🔥 ADDED: today's shared exchange rate (assets/js/shared-exchange-rate.js),
    // fetched once at init below and reused as the default everywhere this
    // file needs a rate -- instead of a hardcoded 1.00/25.00 that had to be
    // corrected by hand on every new PO / new supplier. Deliberately a
    // plain variable read synchronously by resetPOForm() etc., NOT fetched
    // on-demand at the moment those forms open -- some callers (e.g.
    // addSelectedToPO()) populate form fields immediately after opening
    // the PO modal without awaiting it, and an on-demand fetch there would
    // race with -- and could clobber -- those fields.
    let sharedZmwPerUsd = DEFAULT_EXCHANGE_RATE;

    const state = {
        orders: [],
        suppliers: [],
        poLines: [],
        grnLines: [],
        currentGRNOrderId: null,
        currentGRNOrderData: null,
        currentGRNCurrency: 'USD',
        currentGRNExchangeRate: 1,
        isEditing: false,
        reorderItems: [],
        selectedReorderItems: [],
        pendingCancelIndex: null,
        // 🔥 ADDED (issue #2): existing batches per product, keyed by
        // product_id -- loaded once per GRN so the batch number field can
        // offer them as a dropdown.
        existingBatchesByProduct: {}
    };

    // ============================================
    // 🔥 CHART OF ACCOUNTS - AUTO CREATE MISSING ACCOUNTS
    // ============================================
    // This module had NO accounting/GL integration at all before this --
    // GRNs were posted and payables created, but nothing ever touched
    // journal_entries/journal_lines/chart_of_accounts. Account
    // codes/names here match retail.js/wholesale.js/donation.js/writeoff.js
    // exactly, so this never creates duplicates of shared accounts (Cash,
    // Bank, Inventory, Opening Balance Equity) across the whole system --
    // it just adds the one new account this module needs: Accounts Payable.
    const REQUIRED_ACCOUNTS = [
        { code: '1111', name: 'Cash in Hand (ZMW)', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        { code: '1121', name: 'Bank - ZMW', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        { code: '1400', name: 'Inventory', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        { code: '2001', name: 'Accounts Payable', type: 'Liability', category: 'Current Liability', normal_balance: 'Credit' },
        { code: '3000', name: 'Opening Balance Equity', type: 'Equity', category: 'Equity', normal_balance: 'Credit' }
    ];

    async function ensureChartOfAccounts() {
        try {
            let created = 0, existing = 0;
            for (const account of REQUIRED_ACCOUNTS) {
                const { data: existingAccount, error: findError } = await supabaseClient
                    .from('chart_of_accounts')
                    .select('code, name')
                    .eq('code', account.code)
                    .maybeSingle();

                if (findError && findError.code !== 'PGRST116') {
                    console.error(`Error checking account ${account.code}:`, findError);
                    continue;
                }
                if (existingAccount) { existing++; continue; }

                const { error: insertError } = await supabaseClient
                    .from('chart_of_accounts')
                    .insert([{
                        code: account.code,
                        name: account.name,
                        type: account.type,
                        category: account.category,
                        normal_balance: account.normal_balance,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    }]);

                if (insertError) {
                    console.error(`Error creating account ${account.code}:`, insertError);
                } else {
                    created++;
                    console.log(`✅ Created account: ${account.code} - ${account.name}`);
                }
            }
            console.log(`✅ Chart of Accounts sync complete: ${created} created, ${existing} existing`);
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
                cash_zmw: accountMap['cash_in_hand_zmw'] || '1111',
                bank_zmw: accountMap['bank_zmw'] || '1121',
                inventory: accountMap['inventory'] || '1400',
                accounts_payable: accountMap['accounts_payable'] || '2001',
                opening_balance_equity: accountMap['opening_balance_equity'] || '3000'
            };
        } catch (error) {
            console.error('Error fetching account codes:', error);
            return {
                cash_zmw: '1111',
                bank_zmw: '1121',
                inventory: '1400',
                accounts_payable: '2001',
                opening_balance_equity: '3000'
            };
        }
    }

    async function createGRNAccountingEntries(grnNumber, grnTotal, currency, exchangeRate, paymentType) {
        try {
            await ensureChartOfAccounts();
            const accountCodes = await getAccountCodesFromChartOfAccounts();

            // Ledger is ZMW-based -- convert if the PO/GRN was raised in USD.
            const zmwAmount = currency === 'USD' ? grnTotal * (exchangeRate || 1) : grnTotal;

            const creditAccount = paymentType === 'Credit' ? accountCodes.accounts_payable : accountCodes.cash_zmw;
            const creditDescription = paymentType === 'Credit'
                ? `Credit purchase via ${grnNumber}`
                : `Cash purchase via ${grnNumber}`;

            const journal = {
                entry_date: new Date().toISOString().split('T')[0],
                reference: grnNumber,
                description: `Goods received - ${grnNumber}` + (currency === 'USD' ? ` (USD ${formatNumber(grnTotal)} @ ${exchangeRate})` : ''),
                journal_number: `GRN-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                status: 'Posted',
                created_at: new Date().toISOString()
            };

            const { data: journalData, error: jError } = await supabaseClient
                .from('journal_entries')
                .insert([journal])
                .select();
            if (jError) throw jError;

            await supabaseClient.from('journal_lines').insert([
                { journal_entry_id: journalData[0].id, account_code: accountCodes.inventory, description: `Inventory received - ${grnNumber}`, debit: zmwAmount, credit: 0 },
                { journal_entry_id: journalData[0].id, account_code: creditAccount, description: creditDescription, debit: 0, credit: zmwAmount }
            ]);

            console.log(`✅ GRN accounting entries created for ${grnNumber} (${paymentType}, ZK${zmwAmount.toFixed(2)})`);
        } catch (error) {
            console.error('Error creating GRN accounting entries:', error);
            showToast('GRN posted, but the accounting entry failed -- please check manually.', 'warning');
        }
    }

    async function createOpeningPayableGLEntry(supplierId, supplierName, zmwAmount, note) {
        try {
            const accountCodes = await getAccountCodesFromChartOfAccounts();
            const journal = {
                entry_date: new Date().toISOString().split('T')[0],
                reference: `OPEN-PAYABLE-${String(supplierId).slice(0, 8)}`,
                description: `Opening payable for supplier: ${supplierName} (${note})`,
                journal_number: `OPN-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                status: 'Posted',
                created_at: new Date().toISOString()
            };
            const { data: journalData, error: jError } = await supabaseClient.from('journal_entries').insert([journal]).select();
            if (jError) throw jError;

            await supabaseClient.from('journal_lines').insert([
                { journal_entry_id: journalData[0].id, account_code: accountCodes.opening_balance_equity, description: `Opening equity for payable - ${supplierName}`, debit: zmwAmount, credit: 0 },
                { journal_entry_id: journalData[0].id, account_code: accountCodes.accounts_payable, description: `Opening payable - ${supplierName}`, debit: 0, credit: zmwAmount }
            ]);
            console.log(`✅ Opening payable GL entry created for ${supplierName}: ZK${zmwAmount}`);
        } catch (error) {
            console.error('Error creating opening payable GL entry:', error);
        }
    }

    // ============================================
    // LOAD DATA
    // ============================================
    
    async function loadSuppliers() {
        try {
            const { data, error } = await supabaseClient
                .from('suppliers')
                .select('id, name')
                .order('name', { ascending: true });

            if (error) throw error;
            state.suppliers = data || [];
            console.log(`✅ Loaded ${state.suppliers.length} suppliers`);
            populateSupplierSelects();
        } catch (error) {
            console.error('Error loading suppliers:', error);
            state.suppliers = [];
            populateSupplierSelects();
        }
    }

    async function loadPurchaseOrders() {
        try {
            const { data, error } = await supabaseClient
                .from('purchase_orders')
                .select(`
                    *,
                    suppliers:supplier_id (name)
                `)
                .order('created_at', { ascending: false });

            if (error) throw error;
            state.orders = data || [];
            console.log(`✅ Loaded ${state.orders.length} purchase orders`);
            renderPurchaseOrders();
            updateStats(state.orders);
            checkOverduePOs(state.orders);
        } catch (error) {
            console.error('Error loading purchase orders:', error);
            state.orders = [];
            renderPurchaseOrders();
            updateStats([]);
        }
    }

    // ============================================
    // SEARCH PRODUCTS
    // ============================================

    // 🔥 FIX (issue #1): previously this required typing at least 2
    // characters before showing ANY results at all -- there was no way
    // to just open a dropdown and browse. Now: empty search shows the
    // first 20 products (alphabetical) so it behaves like a normal
    // dropdown you can click straight into; typing still filters as
    // before.
    async function searchProducts() {
        const searchInput = document.getElementById('poProductSearch');
        const searchTerm = searchInput ? searchInput.value.trim() : '';
        const resultsDiv = document.getElementById('poSearchResults');
        
        if (!resultsDiv) return;

        try {
            let query = supabaseClient
                .from('products')
                .select('id, product_name, conversion_rate, generic_name_id')
                .order('product_name', { ascending: true })
                .limit(searchTerm ? 10 : 20);

            if (searchTerm) {
                query = query.ilike('product_name', `%${searchTerm}%`);
            }

            const { data: products, error } = await query;

            if (error) throw error;

            let allProducts = [];
            
            if (products && products.length > 0) {
                const genericIds = products.map(p => p.generic_name_id).filter(id => id);
                let genericMap = {};
                
                if (genericIds.length > 0) {
                    const { data: generics, error: genError } = await supabaseClient
                        .from('generic_names')
                        .select('id, name')
                        .in('id', genericIds);
                        
                    if (!genError && generics) {
                        generics.forEach(g => {
                            genericMap[g.id] = g.name;
                        });
                    }
                }
                
                allProducts = products.map(p => ({
                    id: p.id,
                    product_name: p.product_name,
                    generic_name: genericMap[p.generic_name_id] || '',
                    conversion_rate: p.conversion_rate || 1
                }));
            }

            displaySearchResults(allProducts);
        } catch (error) {
            console.error('Error searching products:', error);
            displaySearchResults([]);
        }
    }

    function displaySearchResults(products) {
        const resultsDiv = document.getElementById('poSearchResults');
        if (!resultsDiv) return;
        
        if (!products || products.length === 0) {
            resultsDiv.innerHTML = `<div class="result-item" style="color: #94a3b8; justify-content: center;">No products found</div>`;
            resultsDiv.style.display = 'block';
            return;
        }

        resultsDiv.innerHTML = products.map(p => `
            <div class="result-item" onclick="addProductToPO('${p.id}')">
                <div>
                    <strong>${p.product_name}</strong>
                    <div style="font-size: 0.75rem; color: #94a3b8;">${p.generic_name || 'No generic'}</div>
                </div>
                <span style="color: #94a3b8; font-size: 0.8rem; background: #f1f5f9; padding: 2px 8px; border-radius: 4px;">Pack: ${p.conversion_rate || 1}</span>
            </div>
        `).join('');
        
        resultsDiv.style.display = 'block';
    }

    // ============================================
    // ADD PRODUCT TO PO
    // ============================================

    async function addProductToPO(productId) {
        try {
            const { data: product, error } = await supabaseClient
                .from('products')
                .select('id, product_name, conversion_rate, generic_name_id')
                .eq('id', productId)
                .single();

            if (error) throw error;

            let genericName = '';
            if (product.generic_name_id) {
                const { data: generic, error: genError } = await supabaseClient
                    .from('generic_names')
                    .select('name')
                    .eq('id', product.generic_name_id)
                    .single();
                    
                if (!genError && generic) {
                    genericName = generic.name;
                }
            }

            const existing = state.poLines.find(l => l.product_id === productId);
            if (existing) {
                existing.order_quantity = (existing.order_quantity || 0) + 1;
                existing.total_amount = (existing.order_quantity || 0) * (existing.purchase_rate || 0);
                renderPOLines();
                updatePOTotal();
                clearSearchResults();
                return;
            }

            state.poLines.push({
                product_id: product.id,
                product_name: product.product_name,
                generic_name: genericName,
                pack_size: product.conversion_rate || 1,
                order_quantity: 1,
                purchase_rate: 0,
                total_amount: 0
            });

            renderPOLines();
            updatePOTotal();
            clearSearchResults();
        } catch (error) {
            console.error('Error adding product:', error);
            showToast('Error adding product: ' + error.message, 'error');
        }
    }

    function clearSearchResults() {
        const results = document.getElementById('poSearchResults');
        const search = document.getElementById('poProductSearch');
        if (results) results.style.display = 'none';
        if (search) search.value = '';
    }

    // ============================================
    // REORDER REPORT
    // ============================================

    async function openReorderReport() {
        console.log('📋 Opening reorder report...');
        const modal = document.getElementById('reorderModal');
        if (modal) modal.classList.add('show');
        
        await populateReorderFilters();
        await generateReorderReport();
    }

    async function populateReorderFilters() {
        const suppliers = state.suppliers || [];
        
        const supplierSelect = document.getElementById('reorderSupplier');
        if (supplierSelect) {
            const currentVal = supplierSelect.value;
            supplierSelect.innerHTML = `<option value="">All Suppliers</option>` + 
                suppliers.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
            if (currentVal) supplierSelect.value = currentVal;
        }

        try {
            const { data: categories, error } = await supabaseClient
                .from('categories')
                .select('id, name')
                .order('name');
                
            if (!error && categories) {
                const catSelect = document.getElementById('reorderCategory');
                if (catSelect) {
                    catSelect.innerHTML = `<option value="">All Categories</option>` + 
                        categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
                }
            }
        } catch (e) {
            console.log('Could not load categories');
        }
    }

    async function generateReorderReport() {
        try {
            const supplierId = document.getElementById('reorderSupplier')?.value || '';
            const categoryId = document.getElementById('reorderCategory')?.value || '';
            
            let query = supabaseClient
                .from('products')
                .select('id, product_name, conversion_rate, min_order_qty, generic_name_id, supplier_id, category_id');

            if (supplierId) {
                query = query.eq('supplier_id', supplierId);
            }
            if (categoryId) {
                query = query.eq('category_id', categoryId);
            }

            const { data: products, error } = await query;
            if (error) throw error;

            const genericMap = await fetchGenericNames(products);
            const supplierMap = await fetchSupplierNames(products);
            const categoryMap = await fetchCategoryNames(products);
            const stockMap = await fetchStockLevels(products);

            const reorderItems = products.filter(p => {
                const stock = stockMap[p.id] || 0;
                const minQty = p.min_order_qty || 1;
                return stock < minQty;
            });

            state.reorderItems = reorderItems.map(p => ({
                ...p,
                generic_name: genericMap[p.generic_name_id] || '',
                supplier_name: supplierMap[p.supplier_id] || '',
                category_name: categoryMap[p.category_id] || '',
                current_stock: stockMap[p.id] || 0,
                min_qty: p.min_order_qty || 1,
                reorder_qty: Math.max(1, (p.min_order_qty || 1) - (stockMap[p.id] || 0))
            }));

            console.log(`✅ Found ${state.reorderItems.length} items below reorder level`);
            renderReorderReport();
        } catch (error) {
            console.error('Error generating reorder report:', error);
            const tbody = document.getElementById('reorderTableBody');
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 40px; color: #dc2626;">
                    Error loading reorder report: ${error.message}
                </td></tr>`;
            }
        }
    }

    async function fetchGenericNames(products) {
        const genericIds = products.map(p => p.generic_name_id).filter(id => id);
        let genericMap = {};
        if (genericIds.length > 0) {
            const { data: generics, error: genError } = await supabaseClient
                .from('generic_names')
                .select('id, name')
                .in('id', genericIds);
                
            if (!genError && generics) {
                generics.forEach(g => {
                    genericMap[g.id] = g.name;
                });
            }
        }
        return genericMap;
    }

    async function fetchSupplierNames(products) {
        const supplierIds = products.map(p => p.supplier_id).filter(id => id);
        let supplierMap = {};
        if (supplierIds.length > 0) {
            const { data: suppliers, error: supError } = await supabaseClient
                .from('suppliers')
                .select('id, name')
                .in('id', supplierIds);
                
            if (!supError && suppliers) {
                suppliers.forEach(s => {
                    supplierMap[s.id] = s.name;
                });
            }
        }
        return supplierMap;
    }

    async function fetchCategoryNames(products) {
        const categoryIds = products.map(p => p.category_id).filter(id => id);
        let categoryMap = {};
        if (categoryIds.length > 0) {
            const { data: categories, error: catError } = await supabaseClient
                .from('categories')
                .select('id, name')
                .in('id', categoryIds);
                
            if (!catError && categories) {
                categories.forEach(c => {
                    categoryMap[c.id] = c.name;
                });
            }
        }
        return categoryMap;
    }

    async function fetchStockLevels(products) {
        const productIds = products.map(p => p.id);
        let stockMap = {};
        
        if (productIds.length > 0) {
            const { data: batches, error: batchError } = await supabaseClient
                .from('batches')
                .select('product_id, total_qty')
                .in('product_id', productIds);

            if (!batchError && batches) {
                batches.forEach(b => {
                    if (!stockMap[b.product_id]) stockMap[b.product_id] = 0;
                    stockMap[b.product_id] += b.total_qty || 0;
                });
            }
        }
        return stockMap;
    }

    function renderReorderReport() {
        const tbody = document.getElementById('reorderTableBody');
        if (!tbody) return;
        
        if (state.reorderItems.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 40px; color: #22c55e;">
                <i class="fa-regular fa-circle-check" style="font-size: 2rem; display: block; margin-bottom: 10px;"></i>
                All products are above reorder level
            </td></tr>`;
            return;
        }

        tbody.innerHTML = state.reorderItems.map((item) => `
            <tr>
                <td><input type="checkbox" class="reorder-checkbox" data-id="${item.id}" onchange="updateReorderSelection()"></td>
                <td><strong>${item.product_name}</strong></td>
                <td>${item.generic_name || '-'}</td>
                <td style="color: #dc2626; font-weight: 600;">${item.current_stock}</td>
                <td>${item.min_qty}</td>
                <td>${item.supplier_name || '-'}</td>
                <td>
                    <input type="number" class="form-control reorder-qty-input" 
                        data-id="${item.id}" value="${item.reorder_qty || 1}" 
                        style="width: 80px; padding: 4px 8px;" min="1"
                        onchange="updateReorderSelection()">
                </td>
            </tr>
        `).join('');

        state.selectedReorderItems = [];
        const selectAll = document.getElementById('selectAllReorder');
        if (selectAll) selectAll.checked = false;
    }

    function toggleAllReorderItems() {
        const checked = document.getElementById('selectAllReorder')?.checked || false;
        document.querySelectorAll('.reorder-checkbox').forEach(cb => cb.checked = checked);
        updateReorderSelection();
    }

    function updateReorderSelection() {
        state.selectedReorderItems = [];
        document.querySelectorAll('.reorder-checkbox:checked').forEach(cb => {
            const id = cb.dataset.id;
            const item = state.reorderItems.find(p => p.id === id);
            if (item) {
                const qtyInput = document.querySelector(`.reorder-qty-input[data-id="${id}"]`);
                const qty = parseInt(qtyInput?.value) || item.reorder_qty || 1;
                state.selectedReorderItems.push({
                    ...item,
                    reorder_qty: qty
                });
            }
        });
    }

    function addSelectedToPO() {
        if (state.selectedReorderItems.length === 0) {
            showToast('Please select at least one item', 'error');
            return;
        }

        closeModal('reorderModal');

        const poModal = document.getElementById('poModal');
        if (!poModal || !poModal.classList.contains('show')) {
            openNewPurchaseOrder();
        }

        const firstItem = state.selectedReorderItems[0];
        if (firstItem && firstItem.supplier_id) {
            const supplierSelect = document.getElementById('poSupplier');
            if (supplierSelect) {
                supplierSelect.value = firstItem.supplier_id;
            }
        }

        const allSameSupplier = state.selectedReorderItems.every(item => 
            item.supplier_id === firstItem?.supplier_id
        );

        if (!allSameSupplier && state.selectedReorderItems.length > 1) {
            showToast('Selected items have different suppliers. Please add them separately.', 'warning');
            return;
        }

        state.selectedReorderItems.forEach(item => {
            const existing = state.poLines.find(l => l.product_id === item.id);
            if (existing) {
                existing.order_quantity += item.reorder_qty || 1;
                existing.total_amount = (existing.order_quantity || 0) * (existing.purchase_rate || 0);
            } else {
                state.poLines.push({
                    product_id: item.id,
                    product_name: item.product_name,
                    generic_name: item.generic_name || '',
                    pack_size: item.conversion_rate || 1,
                    order_quantity: item.reorder_qty || 1,
                    purchase_rate: 0,
                    total_amount: 0
                });
            }
        });

        renderPOLines();
        updatePOTotal();
        showToast(`Added ${state.selectedReorderItems.length} items to purchase order`, 'success');
    }

    // ============================================
    // RENDER FUNCTIONS
    // ============================================

    function renderPurchaseOrders(orders = null) {
        const list = orders || state.orders;
        const tbody = document.getElementById('purchaseTableBody');
        if (!tbody) return;
        
        const filtered = applyFilters(list);
        
        if (filtered.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 40px; color: #94a3b8;">
                <i class="fa-regular fa-file-lines" style="font-size: 2rem; display: block; margin-bottom: 10px;"></i>
                No purchase orders found
            </td></tr>`;
            updateOrderCount(0);
            return;
        }

        tbody.innerHTML = filtered.map(order => renderOrderRow(order)).join('');
        updateOrderCount(filtered.length);
    }

    function applyFilters(list) {
        const overdueFilter = document.getElementById('overdueFilter')?.value || 'all';
        let filtered = list;
        
        // First, exclude all completed/cancelled orders
        const completedStatuses = ['Cancelled', 'Closed', 'Goods Received', 'Received', 'Completed', 'Fully Received'];
        
        if (overdueFilter === 'overdue') {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            filtered = filtered.filter(o => {
                // Exclude completed/cancelled orders
                if (completedStatuses.includes(o.status)) return false;
                if (o.fully_received === true) return false;
                if (!o.expected_delivery_date) return false;
                const expectedDate = new Date(o.expected_delivery_date);
                expectedDate.setHours(0, 0, 0, 0);
                return expectedDate < today;
            });
        } else if (overdueFilter === 'upcoming') {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const future = new Date(today);
            future.setDate(future.getDate() + 7);
            filtered = filtered.filter(o => {
                // Exclude completed/cancelled orders
                if (completedStatuses.includes(o.status)) return false;
                if (o.fully_received === true) return false;
                if (!o.expected_delivery_date) return false;
                const expectedDate = new Date(o.expected_delivery_date);
                expectedDate.setHours(0, 0, 0, 0);
                return expectedDate >= today && expectedDate <= future;
            });
        }
        
        return filtered;
    }

    function renderOrderRow(order) {
        const statusClass = (order.status || 'Draft').toLowerCase().replace(/ /g, '-');
        const supplierName = order.suppliers?.name || 'Unknown';
        const symbol = order.currency === 'ZMW' ? 'ZK' : '$';
        const isOverdue = checkIfOverdue(order);
        
        const totalReceivedQty = order.total_received_quantity || 0;
        const totalCancelledQty = order.total_cancelled_quantity || 0;
        const totalOrderQty = order.total_quantity || 0;
        // Remaining = Ordered - Received - Cancelled (calculated)
        const remainingQty = totalOrderQty - totalReceivedQty - totalCancelledQty;
        
        return `
        <tr style="${isOverdue && !['Cancelled', 'Closed', 'Goods Received'].includes(order.status) ? 'background: #fef2f2;' : ''}">
            <td style="padding-left: 20px; font-weight: 500;">
                ${order.po_number || 'N/A'}
                ${isOverdue && !['Cancelled', 'Closed', 'Goods Received'].includes(order.status) ? 
                    `<span style="font-size: 0.6rem; color: #dc2626; display: block;">⚠️ OVERDUE</span>` : ''}
            </td>
            <td>${supplierName}</td>
            <td>
                ${formatDate(order.expected_delivery_date)}
                ${isOverdue && !['Cancelled', 'Closed', 'Goods Received'].includes(order.status) ? 
                    `<span style="font-size: 0.6rem; color: #dc2626; display: block;">${getDaysOverdue(order)} days overdue</span>` : ''}
            </td>
            <td>
                <span class="status-badge status-${statusClass}">${order.status || 'Draft'}</span>
                ${renderOrderStatusDetails(order, remainingQty, totalReceivedQty, totalCancelledQty)}
            </td>
            <td style="text-align: right; padding-right: 20px;">
                ${symbol} ${formatNumber(order.total_amount || 0)}
                ${renderOrderTotals(order, symbol)}
            </td>
            <td style="text-align: center;">
                <div class="action-buttons">
                    ${renderOrderActions(order)}
                </div>
            </td>
        </tr>
        `;
    }

    function renderOrderStatusDetails(order, remainingQty, totalReceivedQty, totalCancelledQty) {
        let html = '';
        
        if (totalReceivedQty > 0 && totalCancelledQty > 0) {
            html += `<span style="font-size: 0.6rem; color: #f59e0b; display: block;">📦 Received: ${totalReceivedQty} | ❌ Cancelled: ${totalCancelledQty}</span>`;
        } else if (totalReceivedQty > 0 && remainingQty > 0) {
            html += `<span style="font-size: 0.6rem; color: #f59e0b; display: block;">Remaining: ${remainingQty}</span>`;
        } else if (totalCancelledQty > 0 && order.status !== 'Cancelled') {
            html += `<span style="font-size: 0.6rem; color: #dc2626; display: block;">Cancelled: ${totalCancelledQty}</span>`;
        }
        
        if (totalReceivedQty > 0 && order.status !== 'Goods Received') {
            html += `<span style="font-size: 0.6rem; color: #10b981; display: block;">Received: ${totalReceivedQty}</span>`;
        }
        
        return html;
    }

    function renderOrderTotals(order, symbol) {
        let html = '';
        if (order.total_received_amount > 0) {
            html += `<br><span style="font-size: 0.65rem; color: #10b981;">Received: ${symbol} ${formatNumber(order.total_received_amount)}</span>`;
        }
        if (order.total_cancelled_amount > 0) {
            html += `<br><span style="font-size: 0.65rem; color: #dc2626;">Cancelled: ${symbol} ${formatNumber(order.total_cancelled_amount)}</span>`;
        }
        if (order.remaining_amount > 0 && order.status !== 'Draft' && order.status !== 'Cancelled') {
            html += `<br><span style="font-size: 0.65rem; color: #f59e0b;">Remaining: ${symbol} ${formatNumber(order.remaining_amount)}</span>`;
        }
        return html;
    }

    // ============================================
    // RENDER ORDER ACTIONS - UPDATED WITH CANCEL REMAINING
    // ============================================

    function renderOrderActions(order) {
        const remainingQty = (order.total_quantity || 0) - (order.total_received_quantity || 0) - (order.total_cancelled_quantity || 0);
        
        let html = `
            <button class="action-btn" onclick="viewPO('${order.id}')" title="View Details">
                <i class="fa-regular fa-eye"></i>
            </button>
        `;
        
        // GRN button - only for Approved or Partially Received with remaining items
        if ((order.status === 'Approved' || order.status === 'Partially Received') && 
            order.status !== 'Cancelled' && 
            remainingQty > 0) {
            html += `
                <button class="action-btn grn" onclick="openGRN('${order.id}')" title="Receive Goods">
                    <i class="fa-solid fa-boxes"></i>
                </button>
            `;
        }
        
        // Edit/Delete - only for Draft or Pending Approval
        if (order.status === 'Draft' || order.status === 'Pending Approval') {
            html += `
                <button class="action-btn" onclick="editPO('${order.id}')" title="Edit">
                    <i class="fa-regular fa-pen-to-square"></i>
                </button>
                <button class="action-btn" onclick="deletePO('${order.id}')" title="Delete" style="color: #ef4444;">
                    <i class="fa-regular fa-trash-can"></i>
                </button>
            `;
        }
        
        // Cancel Remaining - show when there are remaining items to cancel
        // Only show for Approved or Partially Received with remaining > 0
        if (remainingQty > 0 && 
            (order.status === 'Approved' || order.status === 'Partially Received') &&
            order.status !== 'Cancelled' && 
            order.status !== 'Closed' && 
            order.status !== 'Goods Received') {
            html += `
                <button class="action-btn cancel-remaining" onclick="openCancelRemainingPO('${order.id}')" title="Cancel Remaining Items" style="color: #f59e0b;">
                    <i class="fa-solid fa-ban"></i> Cancel Remaining
                </button>
            `;
        }
        
        // Cancel Full PO - only for Approved with nothing received
        if (order.status === 'Approved' && order.total_received_quantity === 0 && order.total_cancelled_quantity === 0) {
            html += `
                <button class="action-btn" onclick="openCancelPO('${order.id}')" title="Cancel Full PO" style="color: #ef4444;">
                    <i class="fa-solid fa-ban"></i> Cancel PO
                </button>
            `;
        }
        
        // View GRN - for Goods Received or Closed
        if (order.status === 'Goods Received' || order.status === 'Closed') {
            html += `
                <button class="action-btn" onclick="viewGRN('${order.id}')" title="View GRN" style="color: #22c55e;">
                    <i class="fa-regular fa-receipt"></i>
                </button>
            `;
        }
        
        if (order.status === 'Pending Approval') {
            html += `
                <span style="font-size: 0.7rem; color: #f59e0b; padding: 2px 8px; background: #fef3c7; border-radius: 12px;">
                    <i class="fa-regular fa-clock"></i> Awaiting Approval
                </span>
            `;
        }
        
        if (order.status === 'Cancelled') {
            html += `
                <span style="font-size: 0.7rem; color: #64748b; padding: 2px 8px; background: #e2e8f0; border-radius: 12px;">
                    <i class="fa-solid fa-ban"></i> Cancelled
                </span>
            `;
        }
        
        return html;
    }

    function checkIfOverdue(order) {
        if (!order.expected_delivery_date) return false;
        // Overdue is a flag, not a status - exclude completed/cancelled
        if (['Cancelled', 'Closed', 'Goods Received'].includes(order.status)) return false;
        if (order.fully_received === true) return false;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const expectedDate = new Date(order.expected_delivery_date);
        expectedDate.setHours(0, 0, 0, 0);
        // Only overdue if remaining > 0
        const remaining = (order.total_quantity || 0) - (order.total_received_quantity || 0) - (order.total_cancelled_quantity || 0);
        if (remaining <= 0) return false;
        return expectedDate < today;
    }

    function getDaysOverdue(order) {
        if (!order.expected_delivery_date) return 0;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const expectedDate = new Date(order.expected_delivery_date);
        expectedDate.setHours(0, 0, 0, 0);
        return Math.floor((today - expectedDate) / (1000 * 60 * 60 * 24));
    }

    function updateOrderCount(count) {
        const countSpan = document.getElementById('poCount');
        const countDisplay = document.getElementById('poCountDisplay');
        if (countSpan) countSpan.textContent = `${count} orders`;
        if (countDisplay) countDisplay.textContent = `${count} orders`;
    }

    function populateSupplierSelects() {
        const selects = ['poSupplier', 'supplierFilter', 'reorderSupplier'];
        const suppliers = state.suppliers || [];
        
        selects.forEach(id => {
            const select = document.getElementById(id);
            if (!select) return;
            
            const placeholder = id === 'poSupplier' ? 'Select Supplier' : 'All Suppliers';
            const currentVal = select.value;
            
            select.innerHTML = `<option value="">${placeholder}</option>` + 
                suppliers.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
            
            if (currentVal && Array.from(select.options).some(opt => opt.value === currentVal)) {
                select.value = currentVal;
            }
        });
    }

    // ============================================
    // 🔥 ADD SUPPLIER MODAL (Name/TPIN/ZAMRA/Contact/Mobile/Email/Address
    // + Opening Payable in USD/ZMW/both) -- injected once, reusable from
    // any [data-open-add-supplier] trigger on the page via
    // data-target-select pointing at the dropdown to auto-select after save.
    // ============================================
    function ensureAddSupplierModal() {
        if (document.getElementById('purchaseAddSupplierModal')) return;
        const html = `
        <div id="purchaseAddSupplierModal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(15,23,42,0.6);backdrop-filter:blur(4px);z-index:1100;justify-content:center;align-items:center;">
            <div class="modal-content-box" style="background:white;padding:30px;border-radius:12px;width:90%;max-width:520px;max-height:90vh;overflow-y:auto;box-shadow:0 20px 50px rgba(0,0,0,0.5);">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;border-bottom:1px solid #e2e8f0;padding-bottom:15px;">
                    <h3 style="margin:0;"><i class="fa-solid fa-truck-field" style="color:#2563eb;"></i> Add Supplier</h3>
                    <button id="purchaseCloseSupplierModalBtn" type="button" style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:#64748b;">&times;</button>
                </div>
                <form id="purchaseAddSupplierForm">
                    <div style="margin-bottom:12px;"><label style="display:block;font-weight:500;color:#475569;margin-bottom:3px;font-size:0.85rem;">Supplier Name *</label>
                        <input type="text" id="newSupplierName" required style="width:100%;padding:6px 10px;border:1px solid #e2e8f0;border-radius:4px;"></div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
                        <div><label style="display:block;font-weight:500;color:#475569;margin-bottom:3px;font-size:0.85rem;">TPIN Number</label>
                            <input type="text" id="newSupplierTpin" style="width:100%;padding:6px 10px;border:1px solid #e2e8f0;border-radius:4px;"></div>
                        <div><label style="display:block;font-weight:500;color:#475569;margin-bottom:3px;font-size:0.85rem;">ZAMRA Number</label>
                            <input type="text" id="newSupplierZamra" style="width:100%;padding:6px 10px;border:1px solid #e2e8f0;border-radius:4px;"></div>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
                        <div><label style="display:block;font-weight:500;color:#475569;margin-bottom:3px;font-size:0.85rem;">Contact Person</label>
                            <input type="text" id="newSupplierContact" style="width:100%;padding:6px 10px;border:1px solid #e2e8f0;border-radius:4px;"></div>
                        <div><label style="display:block;font-weight:500;color:#475569;margin-bottom:3px;font-size:0.85rem;">Mobile Number *</label>
                            <input type="text" id="newSupplierPhone" required style="width:100%;padding:6px 10px;border:1px solid #e2e8f0;border-radius:4px;"></div>
                    </div>
                    <div style="margin-bottom:12px;"><label style="display:block;font-weight:500;color:#475569;margin-bottom:3px;font-size:0.85rem;">Email Address</label>
                        <input type="email" id="newSupplierEmail" style="width:100%;padding:6px 10px;border:1px solid #e2e8f0;border-radius:4px;"></div>
                    <div style="margin-bottom:12px;"><label style="display:block;font-weight:500;color:#475569;margin-bottom:3px;font-size:0.85rem;">Address</label>
                        <input type="text" id="newSupplierAddress" style="width:100%;padding:6px 10px;border:1px solid #e2e8f0;border-radius:4px;"></div>

                    <div style="background:#fff7ed;border-left:4px solid #f97316;padding:10px 12px;border-radius:6px;margin:16px 0 12px;">
                        <strong style="font-size:0.85rem;color:#9a3412;">Opening Payable (optional -- either or both)</strong>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
                        <div><label style="display:block;font-weight:500;color:#475569;margin-bottom:3px;font-size:0.85rem;">Opening Payable (USD)</label>
                            <input type="number" step="0.01" min="0" id="newSupplierOpeningUsd" value="0" style="width:100%;padding:6px 10px;border:1px solid #e2e8f0;border-radius:4px;"></div>
                        <div><label style="display:block;font-weight:500;color:#475569;margin-bottom:3px;font-size:0.85rem;">Opening Payable (ZMW)</label>
                            <input type="number" step="0.01" min="0" id="newSupplierOpeningZmw" value="0" style="width:100%;padding:6px 10px;border:1px solid #e2e8f0;border-radius:4px;"></div>
                    </div>
                    <div id="newSupplierOpeningRateGroup" style="display:none;margin-bottom:12px;">
                        <label style="display:block;font-weight:500;color:#475569;margin-bottom:3px;font-size:0.85rem;">Exchange Rate (USD → ZMW, for posting the USD opening balance to the ledger)</label>
                        <input type="number" step="0.0001" min="0" id="newSupplierOpeningRate" value="25.00" style="width:100%;padding:6px 10px;border:1px solid #e2e8f0;border-radius:4px;">
                    </div>

                    <div style="margin-top:20px;display:flex;gap:10px;justify-content:flex-end;border-top:1px solid #e2e8f0;padding-top:20px;">
                        <button type="button" id="purchaseCancelSupplierModalBtn" style="background:white;border:1px solid #e2e8f0;padding:10px 25px;border-radius:6px;cursor:pointer;">Cancel</button>
                        <button type="submit" id="purchaseSaveSupplierBtn" style="background:#2563eb;color:white;border:none;padding:10px 25px;border-radius:6px;cursor:pointer;">
                            <i class="fa-solid fa-floppy-disk"></i> Save Supplier
                        </button>
                    </div>
                </form>
            </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', html);

        const modal = document.getElementById('purchaseAddSupplierModal');
        modal.querySelector('.modal-content-box').addEventListener('click', e => e.stopPropagation());
        document.getElementById('purchaseCloseSupplierModalBtn').addEventListener('click', () => modal.style.display = 'none');
        document.getElementById('purchaseCancelSupplierModalBtn').addEventListener('click', () => modal.style.display = 'none');
        modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });

        document.getElementById('newSupplierOpeningUsd').addEventListener('input', function () {
            document.getElementById('newSupplierOpeningRateGroup').style.display = parseFloat(this.value) > 0 ? 'block' : 'none';
        });

        document.getElementById('purchaseAddSupplierForm').addEventListener('submit', handleSaveSupplier);
    }

    document.addEventListener('click', function (e) {
        const trigger = e.target.closest('[data-open-add-supplier]');
        if (!trigger) return;
        e.preventDefault();
        ensureAddSupplierModal();
        const modal = document.getElementById('purchaseAddSupplierModal');
        document.getElementById('purchaseAddSupplierForm').reset();
        document.getElementById('newSupplierOpeningRateGroup').style.display = 'none';
        // 🔥 FIX: form.reset() puts the rate field back to its static HTML
        // default (25.00) -- override with today's shared exchange rate
        // instead, same as resetPOForm().
        const openingRateInput = document.getElementById('newSupplierOpeningRate');
        if (openingRateInput) openingRateInput.value = sharedZmwPerUsd;
        modal.style.display = 'flex';
        modal.dataset.targetSelectId = trigger.dataset.targetSelect || '';
    });

    async function handleSaveSupplier(e) {
        e.preventDefault();
        const name = document.getElementById('newSupplierName').value.trim();
        const phoneVal = document.getElementById('newSupplierPhone').value.trim();
        if (!name) { alert('Supplier Name is required'); return; }
        if (!phoneVal) { alert('Mobile Number is required'); return; }

        const openingUsd = parseFloat(document.getElementById('newSupplierOpeningUsd').value) || 0;
        const openingZmw = parseFloat(document.getElementById('newSupplierOpeningZmw').value) || 0;
        const openingRate = parseFloat(document.getElementById('newSupplierOpeningRate').value) || 25.00;

        const btn = document.getElementById('purchaseSaveSupplierBtn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

        try {
            const record = {
                name,
                tpin_number: document.getElementById('newSupplierTpin').value.trim() || null,
                zamra_number: document.getElementById('newSupplierZamra').value.trim() || null,
                contact_person: document.getElementById('newSupplierContact').value.trim() || null,
                phone: phoneVal,
                email: document.getElementById('newSupplierEmail').value.trim() || null,
                address: document.getElementById('newSupplierAddress').value.trim() || null,
                opening_balance_usd: openingUsd,
                opening_balance_zmw: openingZmw,
                created_at: new Date().toISOString()
            };

            const { data, error } = await supabaseClient.from('suppliers').insert([record]).select();
            if (error) throw error;

            const newSupplier = data[0];

            // Opening payable GL posting -- Debit Opening Balance Equity,
            // Credit Accounts Payable (this is a LIABILITY, the reverse of
            // wholesale.js's opening-receivable pattern). Posted separately
            // per currency since the ledger tracks Accounts Payable in ZMW.
            if (openingUsd > 0) {
                await createOpeningPayableGLEntry(newSupplier.id, name, openingUsd * openingRate, `USD ${formatNumber(openingUsd)} @ ${openingRate}`);
            }
            if (openingZmw > 0) {
                await createOpeningPayableGLEntry(newSupplier.id, name, openingZmw, `ZMW ${formatNumber(openingZmw)}`);
            }

            await loadSuppliers();

            const modal = document.getElementById('purchaseAddSupplierModal');
            const targetSelectId = modal.dataset.targetSelectId;
            if (targetSelectId) {
                const targetSelect = document.getElementById(targetSelectId);
                if (targetSelect) {
                    targetSelect.value = newSupplier.id;
                    targetSelect.dispatchEvent(new Event('change'));
                }
            }
            modal.style.display = 'none';

            showToast(`Supplier "${name}" added` + (openingUsd > 0 || openingZmw > 0 ? ' with opening payable' : ''), 'success');
        } catch (error) {
            console.error('Error saving supplier:', error);
            alert('❌ Error saving supplier: ' + error.message);
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Supplier';
        }
    }

    // ============================================
    // 🔥 LOOKUP TABLE QUICK-ADD (Category, Generic -- Brand and
    // Subcategory are NOT wired up here: nothing in this file's existing
    // code references a brand_id or subcategory_id column on products, so
    // rather than guess at column/table names that might not exist, this
    // only covers the two lookup tables already confirmed in use:
    // categories and generic_names)
    // ============================================
    const LOOKUP_TABLE_CONFIG = {
        categories: { label: 'Category', nameColumn: 'name' },
        generic_names: { label: 'Generic', nameColumn: 'name' }
    };

    document.addEventListener('click', async function (e) {
        const trigger = e.target.closest('[data-quick-add-lookup]');
        if (!trigger) return;
        e.preventDefault();
        const table = trigger.dataset.quickAddLookup;
        const config = LOOKUP_TABLE_CONFIG[table] || { label: table, nameColumn: 'name' };
        const name = prompt(`New ${config.label} name:`);
        if (!name || !name.trim()) return;

        try {
            const { data, error } = await supabaseClient.from(table).insert([{ [config.nameColumn]: name.trim() }]).select();
            if (error) throw error;

            if (table === 'categories') await populateReorderFilters();

            const targetId = trigger.dataset.quickAddTarget;
            if (targetId) {
                const targetSelect = document.getElementById(targetId);
                if (targetSelect && data && data[0]) targetSelect.value = data[0].id;
            }
            showToast(`${config.label} "${name.trim()}" added`, 'success');
        } catch (error) {
            console.error(`Error adding ${table}:`, error);
            alert(`❌ Error adding ${config.label}: ` + error.message);
        }
    });

    // ============================================
    // RENDER PO LINES
    // ============================================

    function renderPOLines() {
        const tbody = document.getElementById('poLinesBody');
        if (!tbody) return;
        
        if (state.poLines.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted" style="padding: 30px;">
                <i class="fa-regular fa-plus" style="display: block; margin-bottom: 8px;"></i>
                Add products using the search above or from Reorder Report
            </td></tr>`;
            updatePOLineCounts();
            return;
        }

        const currency = document.getElementById('poCurrency')?.value || 'USD';
        const symbol = currency === 'ZMW' ? 'ZK' : '$';
        
        tbody.innerHTML = state.poLines.map((line, index) => {
            const totalQty = (line.pack_size || 1) * (line.order_quantity || 0);
            return `
            <tr>
                <td>${index + 1}</td>
                <td>
                    <strong>${line.product_name || 'Unknown'}</strong>
                    <br><span style="font-size: 0.7rem; color: #94a3b8;">${line.generic_name || ''}</span>
                </td>
                <td>${line.pack_size || 1}</td>
                <td>
                    <input type="number" class="form-control" value="${line.order_quantity || 0}" 
                        style="width: 70px; padding: 4px 8px;" 
                        onchange="updatePOLine(${index}, 'order_quantity', this.value)" min="1">
                </td>
                <td><strong>${totalQty}</strong></td>
                <td>
                    <input type="number" class="form-control" value="${line.purchase_rate || 0}" 
                        style="width: 100px; padding: 4px 8px;" 
                        onchange="updatePOLine(${index}, 'purchase_rate', this.value)" step="0.01" min="0">
                    <span style="font-size: 0.65rem; color: #94a3b8;">(per pack)</span>
                </td>
                <td style="text-align: right;">${symbol} ${formatNumber(line.total_amount || 0)}</td>
                <td style="text-align: center;">
                    <button class="action-btn" onclick="removePOLine(${index})" style="color: #ef4444;">
                        <i class="fa-regular fa-trash-can"></i>
                    </button>
                </td>
            </tr>
            `;
        }).join('');
        
        updatePOLineCounts();
    }

    function updatePOLineCounts() {
        const totalItems = state.poLines.reduce((sum, l) => sum + (l.order_quantity || 0), 0);
        document.getElementById('poLineCount').textContent = `${state.poLines.length} items`;
        document.getElementById('poTotalItems').textContent = totalItems;
    }

    // ============================================
    // RENDER GRN LINES - NO CANCELLATION COLUMN
    // ============================================

    function renderGRNLines(readonly = false) {
        const tbody = document.getElementById('grnLinesBody');
        if (!tbody) return;
        
        if (state.grnLines.length === 0) {
            tbody.innerHTML = `<tr><td colspan="10" class="text-center text-muted" style="padding: 30px;">
                <i class="fa-regular fa-box" style="display: block; margin-bottom: 8px;"></i>
                No items to receive
            </td></tr>`;
            document.getElementById('grnLineCount').textContent = '0 items';
            return;
        }

        const currency = state.currentGRNCurrency || 'USD';
        const symbol = currency === 'ZMW' ? 'ZK' : '$';

        tbody.innerHTML = state.grnLines.map((line, index) => {
            const totalOrderedQty = (line.pack_size || 1) * (line.order_quantity || 0);
            const remainingQty = (line.order_quantity || 0) - (line.received_quantity || 0) - (line.cancelled_quantity || 0);
            const isFullyReceived = remainingQty <= 0 && (line.received_quantity || 0) > 0;
            const isFullyCancelled = remainingQty <= 0 && (line.received_quantity || 0) === 0 && (line.cancelled_quantity || 0) > 0;
            const isPartiallyProcessed = (line.received_quantity || 0) > 0 && (line.cancelled_quantity || 0) > 0;
            const isCancelled = line.cancel_remaining || false;
            
            const isReceiving = (line.received_quantity || 0) > 0;
            const isDisabled = readonly || isCancelled;
            const expiryStyle = getExpiryUrgencyStyle(line.expiry_date);
            
            let rowClass = '';
            if (isFullyReceived) rowClass = 'grn-row-received';
            else if (isFullyCancelled) rowClass = 'grn-row-cancelled';
            else if (isPartiallyProcessed) rowClass = 'grn-row-partial';
            else if (isCancelled) rowClass = 'grn-row-cancelled';
            
            return `
            <tr class="${rowClass}">
                <td>${index + 1}</td>
                <td>
                    <strong>${line.product_name || 'Unknown'}</strong>
                    <br><span style="font-size: 0.7rem; color: #94a3b8;">${line.generic_name || ''}</span>
                    ${renderGRNStatusBadges(line, isCancelled, isFullyReceived, isFullyCancelled, isPartiallyProcessed)}
                </td>
                <td>${line.pack_size || 1}</td>
                <td><strong>${totalOrderedQty}</strong></td>
                <td>
                    <input type="number" class="form-control" value="${line.received_quantity || 0}" 
                        style="width: 70px; padding: 4px 8px; ${isCancelled ? 'background: #fef2f2;' : ''}" 
                        onchange="updateGRNLine(${index}, 'received_quantity', this.value)"
                        ${readonly || isCancelled ? 'disabled' : ''}
                        min="0" max="${line.order_quantity - line.cancelled_quantity || 0}">
                    ${line.received_quantity > 0 ? `<span style="font-size: 0.6rem; color: #059669;">${line.received_quantity} received</span>` : ''}
                </td>
                <td>
                    <span style="font-weight: 600; color: ${remainingQty > 0 ? '#f59e0b' : '#059669'};">
                        ${remainingQty > 0 ? remainingQty : '✅'}
                    </span>
                    ${line.cancelled_quantity > 0 ? `<span style="font-size: 0.6rem; color: #dc2626; display: block;">${line.cancelled_quantity} cancelled</span>` : ''}
                </td>
                <td>
                    <input type="number" class="form-control" value="${line.purchase_rate || 0}" 
                        style="width: 100px; padding: 4px 8px;" 
                        onchange="updateGRNLine(${index}, 'purchase_rate', this.value)"
                        ${readonly ? 'disabled' : ''}
                        step="0.01" min="0">
                </td>
                <td>
                    <input type="text" class="form-control" list="batchList-${index}" value="${line.batch_number || ''}" 
                        style="width: 130px; padding: 4px 8px; ${isCancelled ? 'background: #fef2f2;' : ''}" 
                        onchange="updateGRNLine(${index}, 'batch_number', this.value)"
                        ${readonly || isCancelled ? 'disabled' : ''}
                        placeholder="${isReceiving ? 'Batch # *' : 'Batch #'}" 
                        ${isReceiving && !isCancelled ? 'required' : ''}>
                    <datalist id="batchList-${index}">
                        ${(state.existingBatchesByProduct[line.product_id] || []).map(b => `<option value="${b.batch_number}">`).join('')}
                    </datalist>
                </td>
                <td>
                    <input type="text" class="form-control" inputmode="numeric" value="${line.expiry_date || ''}" 
                        style="width: 130px; padding: 4px 8px; border-color: ${expiryStyle.border}; background: ${isCancelled ? '#fef2f2' : expiryStyle.background};" 
                        oninput="formatExpiryInput(this)"
                        onchange="updateGRNLine(${index}, 'expiry_date', this.value)"
                        ${readonly || isCancelled ? 'disabled' : ''}
                        placeholder="YYYY-MM-DD"
                        maxlength="10"
                        ${isReceiving && !isCancelled ? 'required' : ''}>
                </td>
                <td style="text-align: center;">
                    <input type="checkbox" ${(line.received_quantity || 0) > 0 ? 'checked' : ''} 
                        onchange="toggleGRNLineReceive(${index}, this.checked)"
                        ${readonly || isCancelled ? 'disabled' : ''}
                        ${(line.cancelled_quantity || 0) > 0 ? 'disabled' : ''}
                        title="Receive items">
                </td>
            </tr>
            `;
        }).join('');
        
        document.getElementById('grnLineCount').textContent = `${state.grnLines.length} items`;
    }

    function renderGRNStatusBadges(line, isCancelled, isFullyReceived, isFullyCancelled, isPartiallyProcessed) {
        let html = '';
        if (isCancelled) {
            html += `<br><span style="font-size: 0.6rem; color: #dc2626;">⚠️ Cancelling: ${line.cancel_reason || 'No reason provided'}</span>`;
        }
        if (isFullyReceived && !isCancelled) {
            html += `<br><span style="font-size: 0.6rem; color: #059669;">✅ Fully Received</span>`;
        }
        if (isFullyCancelled) {
            html += `<br><span style="font-size: 0.6rem; color: #dc2626;">❌ Fully Cancelled</span>`;
        }
        if (isPartiallyProcessed) {
            html += `<br><span style="font-size: 0.6rem; color: #f59e0b;">⚠️ Partially Received & Cancelled</span>`;
        }
        return html;
    }

    // ============================================
    // MODAL FUNCTIONS
    // ============================================

    function openNewPurchaseOrder() {
        state.poLines = [];
        state.isEditing = false;
        resetPOForm();
        renderPOLines();
        updatePOTotal();
        enablePOFields(true);
        showModal('poModal');
    }

    async function editPO(orderId) {
        try {
            const { data: order, error } = await supabaseClient
                .from('purchase_orders')
                .select(`
                    *,
                    purchase_order_lines (*)
                `)
                .eq('id', orderId)
                .single();

            if (error) throw error;

            if (order.status === 'Cancelled' || order.status === 'Closed' || order.status === 'Goods Received') {
                showToast('Completed orders cannot be edited', 'error');
                return;
            }

            state.isEditing = true;
            state.poLines = order.purchase_order_lines || [];
            
            populatePOForm(order);
            renderPOLines();
            updatePOTotal();
            enablePOFields(true);
            showModal('poModal');
        } catch (error) {
            console.error('Error loading PO for edit:', error);
            showToast('Error loading PO: ' + error.message, 'error');
        }
    }

    function resetPOForm() {
        const editId = document.getElementById('editPOId');
        const title = document.getElementById('poModalTitle');
        const supplier = document.getElementById('poSupplier');
        const currency = document.getElementById('poCurrency');
        const rate = document.getElementById('poExchangeRate');
        const delivery = document.getElementById('poDeliveryDate');
        const notes = document.getElementById('poNotes');
        const search = document.getElementById('poProductSearch');
        const results = document.getElementById('poSearchResults');
        
        if (editId) editId.value = '';
        if (title) title.innerHTML = '<i class="fa-solid fa-file-invoice"></i> New Purchase Order';
        if (supplier) supplier.value = '';
        if (currency) currency.value = 'USD';
        // 🔥 FIX: defaults to today's shared exchange rate instead of a
        // hardcoded 1.00, which never made sense next to a USD default
        // currency -- still editable per PO if a specific deal needs a
        // different rate.
        if (rate) rate.value = sharedZmwPerUsd;
        if (delivery) delivery.value = getFutureDate(14);
        if (notes) notes.value = '';
        if (search) search.value = '';
        if (results) results.style.display = 'none';
        
        document.getElementById('cancelPOBtn').style.display = 'none';
    }

    function populatePOForm(order) {
        const editId = document.getElementById('editPOId');
        const title = document.getElementById('poModalTitle');
        const supplier = document.getElementById('poSupplier');
        const currency = document.getElementById('poCurrency');
        const rate = document.getElementById('poExchangeRate');
        const delivery = document.getElementById('poDeliveryDate');
        const notes = document.getElementById('poNotes');
        const cancelBtn = document.getElementById('cancelPOBtn');
        
        if (editId) editId.value = order.id;
        if (title) title.innerHTML = `<i class="fa-solid fa-pen-to-square"></i> Edit PO: ${order.po_number}`;
        if (supplier) supplier.value = order.supplier_id || '';
        if (currency) currency.value = order.currency || 'USD';
        if (rate) rate.value = order.exchange_rate || 1;
        if (delivery) delivery.value = order.expected_delivery_date || '';
        if (notes) notes.value = order.notes || '';
        
        // Only show cancel button if no items received and not cancelled
        if (order.total_received_quantity === 0 && order.total_cancelled_quantity === 0 && 
            order.status !== 'Cancelled' && order.status !== 'Closed' && order.status !== 'Goods Received') {
            cancelBtn.style.display = 'inline-flex';
        } else {
            cancelBtn.style.display = 'none';
        }
    }

    function showModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.add('show');
    }

    function closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.remove('show');
    }

    function enablePOFields(enabled) {
        const fields = ['poSupplier', 'poCurrency', 'poExchangeRate', 'poDeliveryDate', 'poProductSearch', 'poNotes'];
        fields.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.disabled = !enabled;
        });
        const searchBtn = document.querySelector('.search-input-group .btn');
        if (searchBtn) searchBtn.disabled = !enabled;
    }

    // ============================================
    // UPDATE PO LINE
    // ============================================

    function updatePOLine(index, field, value) {
        const line = state.poLines[index];
        if (!line) return;
        
        if (field === 'order_quantity') {
            line.order_quantity = parseInt(value) || 0;
        } else if (field === 'purchase_rate') {
            line.purchase_rate = parseFloat(value) || 0;
        }
        line.total_amount = (line.order_quantity || 0) * (line.purchase_rate || 0);
        renderPOLines();
        updatePOTotal();
    }

    function removePOLine(index) {
        state.poLines.splice(index, 1);
        renderPOLines();
        updatePOTotal();
    }

    function updatePOTotal() {
        const total = state.poLines.reduce((sum, line) => sum + (line.total_amount || 0), 0);
        const currency = document.getElementById('poCurrency')?.value || 'USD';
        const rate = parseFloat(document.getElementById('poExchangeRate')?.value) || 1;
        const symbol = currency === 'ZMW' ? 'ZK' : '$';
        
        const grandTotal = document.getElementById('poGrandTotal');
        if (grandTotal) grandTotal.textContent = `${symbol} ${formatNumber(total)}`;
        
        const zmwDisplay = document.getElementById('poZMWDisplay');
        const zmwTotal = document.getElementById('poZMWTotal');
        if (currency === 'USD' && rate > 0 && zmwDisplay && zmwTotal) {
            zmwDisplay.style.display = 'flex';
            zmwTotal.textContent = `ZK ${formatNumber(total * rate)}`;
        } else if (zmwDisplay) {
            zmwDisplay.style.display = 'none';
        }
    }

    // ============================================
    // PO ACTIONS
    // ============================================

    async function savePODraft() {
        await savePO('Draft');
    }

    async function submitPOForApproval() {
        await savePO('Pending Approval');
    }

    async function approvePO() {
        await savePO('Approved');
    }

    async function savePO(status) {
        if (!validatePO()) return;
        
        const poData = getPOData();
        if (!poData) return;
        
        poData.status = status;
        
        try {
            const isEditing = document.getElementById('editPOId')?.value !== '';
            const poId = isEditing ? document.getElementById('editPOId').value : null;
            
            const totalQty = poData.lines.reduce((sum, l) => sum + (l.order_quantity || 0), 0);
            
            if (isEditing && poId) {
                await updateExistingPO(poId, poData, totalQty);
                showToast('Purchase order updated successfully!', 'success');
            } else {
                await createNewPO(poData, totalQty);
                showToast(`Purchase order ${poData.po_number} created successfully!`, 'success');
            }

            closeModal('poModal');
            await loadPurchaseOrders();
        } catch (error) {
            console.error('Error saving PO:', error);
            showToast('Error saving PO: ' + error.message, 'error');
        }
    }

    async function updateExistingPO(poId, poData, totalQty) {
        // Calculate remaining = total - received - cancelled
        const { data: existingLines } = await supabaseClient
            .from('purchase_order_lines')
            .select('received_quantity, cancelled_quantity')
            .eq('purchase_order_id', poId);
        
        let totalReceived = 0;
        let totalCancelled = 0;
        if (existingLines) {
            totalReceived = existingLines.reduce((sum, l) => sum + (l.received_quantity || 0), 0);
            totalCancelled = existingLines.reduce((sum, l) => sum + (l.cancelled_quantity || 0), 0);
        }
        
        const remainingQty = totalQty - totalReceived - totalCancelled;

        const { error } = await supabaseClient
            .from('purchase_orders')
            .update({
                supplier_id: poData.supplier_id,
                currency: poData.currency,
                exchange_rate: poData.exchange_rate,
                expected_delivery_date: poData.expected_delivery_date,
                status: poData.status,
                notes: poData.notes,
                total_amount: poData.total_amount,
                total_quantity: totalQty,
                remaining_quantity: Math.max(0, remainingQty),
                updated_at: new Date().toISOString()
            })
            .eq('id', poId);

        if (error) throw error;

        await supabaseClient
            .from('purchase_order_lines')
            .delete()
            .eq('purchase_order_id', poId);

        if (poData.lines.length > 0) {
            await insertPOLines(poId, poData.lines, poData.currency);
        }
    }

    async function createNewPO(poData, totalQty) {
        const { data, error } = await supabaseClient
            .from('purchase_orders')
            .insert([{
                po_number: poData.po_number,
                supplier_id: poData.supplier_id,
                currency: poData.currency,
                exchange_rate: poData.exchange_rate,
                expected_delivery_date: poData.expected_delivery_date,
                status: poData.status,
                notes: poData.notes,
                total_amount: poData.total_amount,
                total_quantity: totalQty,
                remaining_quantity: totalQty,
                total_received_quantity: 0,
                total_received_amount: 0,
                total_cancelled_quantity: 0,
                total_cancelled_amount: 0,
                remaining_amount: poData.total_amount,
                fully_received: false
            }])
            .select();

        if (error) throw error;

        if (data && data.length > 0 && poData.lines.length > 0) {
            await insertPOLines(data[0].id, poData.lines, poData.currency);
        }
    }

    async function insertPOLines(poId, lines, currency) {
        const linesToInsert = lines.map(line => ({
            purchase_order_id: poId,
            product_id: line.product_id,
            product_name: line.product_name,
            generic_name: line.generic_name || '',
            pack_size: line.pack_size || 1,
            order_quantity: line.order_quantity,
            purchase_rate: line.purchase_rate,
            total_amount: line.total_amount,
            currency: currency,
            received_quantity: 0,
            remaining_quantity: line.order_quantity,
            fully_received: false,
            cancelled_quantity: 0
        }));

        const { error: lineError } = await supabaseClient
            .from('purchase_order_lines')
            .insert(linesToInsert);

        if (lineError) throw lineError;
    }

    function getPOData() {
        const supplierId = document.getElementById('poSupplier')?.value;
        if (!supplierId) {
            showToast('Please select a supplier', 'error');
            return null;
        }

        const currency = document.getElementById('poCurrency')?.value || 'USD';
        const exchangeRate = parseFloat(document.getElementById('poExchangeRate')?.value) || 1;
        const total = state.poLines.reduce((sum, line) => sum + (line.total_amount || 0), 0);
        
        const isEditing = document.getElementById('editPOId')?.value !== '';
        const poNumber = isEditing ? 
            (state.orders.find(o => o.id === document.getElementById('editPOId').value)?.po_number || generatePONumber()) :
            generatePONumber();

        return {
            po_number: poNumber,
            supplier_id: supplierId,
            currency: currency,
            exchange_rate: exchangeRate,
            expected_delivery_date: document.getElementById('poDeliveryDate')?.value || null,
            notes: document.getElementById('poNotes')?.value || '',
            total_amount: total,
            lines: state.poLines.map(l => ({
                product_id: l.product_id,
                product_name: l.product_name,
                generic_name: l.generic_name || '',
                pack_size: l.pack_size || 1,
                order_quantity: l.order_quantity || 0,
                purchase_rate: l.purchase_rate || 0,
                total_amount: l.total_amount || 0
            }))
        };
    }

    function generatePONumber() {
        return `PO-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
    }

    function validatePO() {
        if (!document.getElementById('poSupplier')?.value) {
            showToast('Please select a supplier', 'error');
            return false;
        }
        if (state.poLines.length === 0) {
            showToast('Please add at least one product', 'error');
            return false;
        }
        const invalidLines = state.poLines.filter(l => (l.order_quantity || 0) <= 0 || (l.purchase_rate || 0) <= 0);
        if (invalidLines.length > 0) {
            showToast('Please ensure all line items have valid quantity and rate', 'error');
            return false;
        }
        return true;
    }

    // ============================================
    // CANCEL FULL PO FUNCTIONS
    // ============================================

    function openCancelPOFromModal() {
        const poId = document.getElementById('editPOId').value;
        if (!poId) {
            showToast('No PO selected to cancel', 'error');
            return;
        }
        closeModal('poModal');
        setTimeout(() => {
            openCancelPO(poId);
        }, 300);
    }

    function openCancelPO(orderId) {
        const order = state.orders.find(o => o.id === orderId);
        if (!order) {
            showToast('Order not found', 'error');
            return;
        }

        if (order.status === 'Cancelled') {
            showToast('PO is already cancelled', 'warning');
            return;
        }

        if (order.status === 'Closed' || order.status === 'Goods Received') {
            showToast('PO is already completed', 'warning');
            return;
        }

        // Check if any items were received
        const hasReceived = (order.total_received_quantity || 0) > 0;

        let cancelReceivedEl = document.getElementById('cancelAlreadyReceived');
        if (!cancelReceivedEl) {
            const cancelPONumber = document.getElementById('cancelPONumber');
            if (cancelPONumber) {
                const parentDiv = cancelPONumber.closest('.modal-body');
                if (parentDiv) {
                    const infoDiv = parentDiv.querySelector('div[style*="background: #f8fafc"]');
                    if (infoDiv) {
                        const receivedP = document.createElement('p');
                        receivedP.style.cssText = 'margin: 5px 0 0 0; font-size: 0.9rem;';
                        receivedP.innerHTML = '<strong>Already Received:</strong> <span id="cancelAlreadyReceived">0</span>';
                        infoDiv.appendChild(receivedP);
                    }
                }
            }
        }

        document.getElementById('cancelPONumber').textContent = order.po_number || 'N/A';
        document.getElementById('cancelPOSupplier').textContent = order.suppliers?.name || 'Unknown';
        const receivedEl = document.getElementById('cancelAlreadyReceived');
        if (receivedEl) receivedEl.textContent = order.total_received_quantity || 0;
        
        // Update cancel message based on scenario
        const cancelMessage = document.getElementById('cancelPOModal').querySelector('p');
        if (cancelMessage) {
            if (hasReceived) {
                cancelMessage.textContent = 'This will cancel the remaining quantity only. Received items will be kept and a payable will be created.';
                cancelMessage.style.color = '#dc2626';
            } else {
                cancelMessage.textContent = 'This action cannot be undone. All items will be marked as cancelled.';
                cancelMessage.style.color = '#64748b';
            }
        }
        
        document.getElementById('cancelPOModal').classList.add('show');
        document.getElementById('cancelPOModal').dataset.orderId = orderId;
    }

    async function confirmCancelPO() {
        const poId = document.getElementById('cancelPOModal').dataset.orderId;
        let reason = document.getElementById('cancelReason').value;
        const reasonOther = document.getElementById('cancelReasonOther').value.trim();

        if (reason === 'Other' && !reasonOther) {
            showToast('Please specify the cancellation reason', 'error');
            return;
        }

        if (reason === 'Other') {
            reason = reasonOther;
        }

        try {
            const { data: order, error: orderError } = await supabaseClient
                .from('purchase_orders')
                .select('*')
                .eq('id', poId)
                .single();

            if (orderError) throw orderError;

            const hasReceived = (order.total_received_quantity || 0) > 0;

            // Determine new status per workflow
            let newStatus;
            if (hasReceived) {
                // Scenario 2: Partial receipt - mark as Closed
                newStatus = 'Closed';
            } else {
                // Scenario 1: Nothing received - mark as Cancelled
                newStatus = 'Cancelled';
            }

            // Update PO header
            const { error: updateError } = await supabaseClient
                .from('purchase_orders')
                .update({
                    status: newStatus,
                    cancelled_at: new Date().toISOString(),
                    cancellation_reason: reason,
                    updated_at: new Date().toISOString(),
                    fully_received: hasReceived ? true : false
                })
                .eq('id', poId);

            if (updateError) throw updateError;

            // Update PO lines - cancel remaining quantities only
            const { data: lines, error: linesError } = await supabaseClient
                .from('purchase_order_lines')
                .select('id, order_quantity, received_quantity, cancelled_quantity')
                .eq('purchase_order_id', poId);

            if (linesError) throw linesError;

            for (const line of lines) {
                const currentReceived = line.received_quantity || 0;
                const currentOrdered = line.order_quantity || 0;
                const currentCancelled = line.cancelled_quantity || 0;
                // Only cancel the remaining quantity
                const remainingToCancel = Math.max(0, currentOrdered - currentReceived - currentCancelled);
                
                let newCancelled = currentCancelled + remainingToCancel;
                let newRemaining = currentOrdered - currentReceived - newCancelled;

                await supabaseClient
                    .from('purchase_order_lines')
                    .update({
                        cancelled_quantity: newCancelled,
                        remaining_quantity: Math.max(0, newRemaining),
                        fully_received: newRemaining <= 0 && currentReceived > 0,
                        cancellation_reason: reason,
                        cancelled_at: new Date().toISOString()
                    })
                    .eq('id', line.id);
            }

            // If there were received items, create supplier payable
            if (hasReceived && order.total_received_amount > 0) {
                const { data: existingPayable } = await supabaseClient
                    .from('supplier_payables')
                    .select('id')
                    .eq('po_id', poId)
                    .maybeSingle();

                if (!existingPayable) {
                    const payableData = {
                        supplier_id: order.supplier_id,
                        po_id: poId,
                        invoice_number: `CLOSED-${order.po_number}`,
                        invoice_date: new Date().toISOString().split('T')[0],
                        due_date: new Date(new Date().setDate(new Date().getDate() + 30)).toISOString().split('T')[0],
                        total_amount: order.total_received_amount || 0,
                        amount_paid: 0,
                        amount_remaining: order.total_received_amount || 0,
                        currency: order.currency || 'USD',
                        exchange_rate: order.exchange_rate || 1,
                        status: 'Pending',
                        payment_terms: 'Net 30',
                        notes: `PO cancelled. Received amount: ${order.total_received_amount}`
                    };

                    const { error: payableError } = await supabaseClient
                        .from('supplier_payables')
                        .insert([payableData]);

                    if (payableError) {
                        console.error('Error creating payable for received items:', payableError);
                    } else {
                        showToast(`✅ Payable created for received amount: ${order.currency} ${formatNumber(order.total_received_amount)}`, 'success');
                    }
                }
            }

            const statusMessage = hasReceived 
                ? `PO closed with ${order.total_received_quantity} items received. Payable created for received amount.`
                : 'PO cancelled successfully. No items received.';

            showToast(statusMessage, 'success');
            closeModal('cancelPOModal');
            await loadPurchaseOrders();

        } catch (error) {
            console.error('Error cancelling PO:', error);
            showToast('Error cancelling PO: ' + error.message, 'error');
        }
    }

    // ============================================
    // CANCEL REMAINING PO FUNCTIONS - NEW
    // ============================================

    function openCancelRemainingPO(orderId) {
        const order = state.orders.find(o => o.id === orderId);
        if (!order) {
            showToast('Order not found', 'error');
            return;
        }

        // Calculate remaining quantities
        const remainingQty = (order.total_quantity || 0) - (order.total_received_quantity || 0) - (order.total_cancelled_quantity || 0);
        
        if (remainingQty <= 0) {
            showToast('No remaining items to cancel', 'warning');
            return;
        }

        // Close any open modals first
        closeModal('poModal');
        closeModal('grnModal');
        
        // Populate the cancel remaining modal
        document.getElementById('cancelRemainingPONumber').textContent = order.po_number || 'N/A';
        document.getElementById('cancelRemainingPOSupplier').textContent = order.suppliers?.name || 'Unknown';
        document.getElementById('cancelRemainingTotalQty').textContent = order.total_quantity || 0;
        document.getElementById('cancelRemainingReceivedQty').textContent = order.total_received_quantity || 0;
        document.getElementById('cancelRemainingCancelledQty').textContent = order.total_cancelled_quantity || 0;
        document.getElementById('cancelRemainingQty').textContent = remainingQty;
        
        // Reset reason fields
        document.getElementById('cancelRemainingReason').value = '';
        document.getElementById('cancelRemainingReasonOther').style.display = 'none';
        document.getElementById('cancelRemainingReasonOther').value = '';
        
        // Store the order ID for confirmation
        document.getElementById('cancelRemainingModal').dataset.orderId = orderId;
        
        // Show the modal
        document.getElementById('cancelRemainingModal').classList.add('show');
    }

    async function confirmCancelRemainingPO() {
        const poId = document.getElementById('cancelRemainingModal').dataset.orderId;
        let reason = document.getElementById('cancelRemainingReason').value;
        const reasonOther = document.getElementById('cancelRemainingReasonOther').value.trim();

        if (!reason) {
            showToast('Please select a cancellation reason', 'error');
            return;
        }

        if (reason === 'Other' && !reasonOther) {
            showToast('Please specify the cancellation reason', 'error');
            return;
        }

        if (reason === 'Other') {
            reason = reasonOther;
        }

        try {
            // Get current order data
            const { data: order, error: orderError } = await supabaseClient
                .from('purchase_orders')
                .select('*')
                .eq('id', poId)
                .single();

            if (orderError) throw orderError;

            const hasReceived = (order.total_received_quantity || 0) > 0;

            // Determine new status
            let newStatus;
            if (hasReceived) {
                // If some items were received, mark as Closed (completed)
                newStatus = 'Closed';
            } else {
                // If nothing received, mark as Cancelled
                newStatus = 'Cancelled';
            }

            // Update PO header
            const { error: updateError } = await supabaseClient
                .from('purchase_orders')
                .update({
                    status: newStatus,
                    cancelled_at: new Date().toISOString(),
                    cancellation_reason: reason,
                    updated_at: new Date().toISOString(),
                    fully_received: hasReceived ? true : false
                })
                .eq('id', poId);

            if (updateError) throw updateError;

            // Update PO lines - cancel remaining quantities only
            const { data: lines, error: linesError } = await supabaseClient
                .from('purchase_order_lines')
                .select('id, order_quantity, received_quantity, cancelled_quantity')
                .eq('purchase_order_id', poId);

            if (linesError) throw linesError;

            for (const line of lines) {
                const currentReceived = line.received_quantity || 0;
                const currentOrdered = line.order_quantity || 0;
                const currentCancelled = line.cancelled_quantity || 0;
                
                // Only cancel the remaining quantity
                const remainingToCancel = Math.max(0, currentOrdered - currentReceived - currentCancelled);
                
                let newCancelled = currentCancelled + remainingToCancel;
                let newRemaining = currentOrdered - currentReceived - newCancelled;

                await supabaseClient
                    .from('purchase_order_lines')
                    .update({
                        cancelled_quantity: newCancelled,
                        remaining_quantity: Math.max(0, newRemaining),
                        fully_received: newRemaining <= 0 && currentReceived > 0,
                        cancellation_reason: reason,
                        cancelled_at: new Date().toISOString()
                    })
                    .eq('id', line.id);
            }

            // If there were received items, create supplier payable for received amount
            if (hasReceived && order.total_received_amount > 0) {
                // Check if payable already exists
                const { data: existingPayable } = await supabaseClient
                    .from('supplier_payables')
                    .select('id')
                    .eq('po_id', poId)
                    .maybeSingle();

                if (!existingPayable) {
                    // Create payable for received amount
                    const payableData = {
                        supplier_id: order.supplier_id,
                        po_id: poId,
                        invoice_number: `CLOSED-${order.po_number}`,
                        invoice_date: new Date().toISOString().split('T')[0],
                        due_date: new Date(new Date().setDate(new Date().getDate() + 30)).toISOString().split('T')[0],
                        total_amount: order.total_received_amount || 0,
                        amount_paid: 0,
                        amount_remaining: order.total_received_amount || 0,
                        currency: order.currency || 'USD',
                        exchange_rate: order.exchange_rate || 1,
                        status: 'Pending',
                        payment_terms: 'Net 30',
                        notes: `PO cancelled. Received amount: ${order.total_received_amount}`
                    };

                    const { error: payableError } = await supabaseClient
                        .from('supplier_payables')
                        .insert([payableData]);

                    if (payableError) {
                        console.error('Error creating payable for received items:', payableError);
                    } else {
                        showToast(`✅ Payable created for received amount: ${order.currency} ${formatNumber(order.total_received_amount)}`, 'success');
                    }
                }
            }

            // Update PO totals
            await updatePOHeader(poId);

            const statusMessage = hasReceived 
                ? `PO closed with ${order.total_received_quantity} items received. Payable created for received amount.`
                : 'PO cancelled successfully. No items received.';

            showToast(statusMessage, 'success');
            closeModal('cancelRemainingModal');
            await loadPurchaseOrders();

        } catch (error) {
            console.error('Error cancelling remaining PO:', error);
            showToast('Error cancelling remaining PO: ' + error.message, 'error');
        }
    }

    // ============================================
    // GRN FUNCTIONS - REMOVED CANCELLATION
    // ============================================

    async function openGRN(orderId) {
        try {
            const orderCheck = await getOrderStatus(orderId);
            
            if (!['Approved', 'Partially Received'].includes(orderCheck.status)) {
                showToast(`Cannot receive goods. Current status: ${orderCheck.status}`, 'error');
                return;
            }

            const fullCheck = await getOrderReceiptStatus(orderId);
            
            if (fullCheck.fully_received) {
                showToast('This PO is already fully received.', 'warning');
                return;
            }

            const order = await getOrderWithLines(orderId);
            
            if (!hasRemainingItems(order)) {
                const hasCancelled = order.purchase_order_lines.some(line => (line.cancelled_quantity || 0) > 0);
                showToast(hasCancelled ? 'All remaining items have been cancelled. No items to receive.' : 'No items remaining to receive.', 'warning');
                return;
            }

            await initializeGRN(order);
            showModal('grnModal');
        } catch (error) {
            console.error('Error opening GRN:', error);
            showToast('Error opening GRN: ' + error.message, 'error');
        }
    }

    async function getOrderStatus(orderId) {
        const { data, error } = await supabaseClient
            .from('purchase_orders')
            .select('status')
            .eq('id', orderId)
            .single();

        if (error) throw error;
        return data;
    }

    async function getOrderReceiptStatus(orderId) {
        const { data, error } = await supabaseClient
            .from('purchase_orders')
            .select('fully_received, remaining_quantity')
            .eq('id', orderId)
            .single();

        if (error) throw error;
        return data;
    }

    async function getOrderWithLines(orderId) {
        const { data, error } = await supabaseClient
            .from('purchase_orders')
            .select(`
                *,
                suppliers:supplier_id (name),
                purchase_order_lines (*)
            `)
            .eq('id', orderId)
            .single();

        if (error) throw error;
        return data;
    }

    function hasRemainingItems(order) {
        return order.purchase_order_lines.some(line => 
            (line.order_quantity || 0) > ((line.received_quantity || 0) + (line.cancelled_quantity || 0))
        );
    }

    async function initializeGRN(order) {
        state.currentGRNOrderId = order.id;
        state.currentGRNOrderData = order;
        state.currentGRNCurrency = order.currency || 'USD';
        state.currentGRNExchangeRate = order.exchange_rate || 1;
        
        state.grnLines = (order.purchase_order_lines || [])
            .filter(line => (line.order_quantity || 0) > ((line.received_quantity || 0) + (line.cancelled_quantity || 0)))
            .map(line => ({
                ...line,
                received_quantity: 0,
                batch_number: '',
                expiry_date: '',
                total_amount: 0,
                max_receivable: (line.order_quantity || 0) - (line.received_quantity || 0) - (line.cancelled_quantity || 0),
                cancel_remaining: false,
                cancel_reason: '',
                cancelled_quantity: line.cancelled_quantity || 0
            }));

        // 🔥 FIX (issue #2): load existing batches for every product on
        // this GRN, so the batch number field can offer them as a
        // dropdown -- pick one to reuse its expiry, or type a new batch
        // number that doesn't exist yet.
        await loadExistingBatchesForGRN();
        populateGRNModal(order);
        renderGRNLines();
        updateGRNTotal();
    }

    async function loadExistingBatchesForGRN() {
        state.existingBatchesByProduct = {};
        const productIds = [...new Set(state.grnLines.map(l => l.product_id).filter(Boolean))];
        if (productIds.length === 0) return;

        try {
            const { data: batches, error } = await supabaseClient
                .from('batches')
                .select('product_id, batch_number, expiry_date')
                .in('product_id', productIds)
                .order('expiry_date', { ascending: true });

            if (error) throw error;

            (batches || []).forEach(b => {
                if (!state.existingBatchesByProduct[b.product_id]) {
                    state.existingBatchesByProduct[b.product_id] = [];
                }
                // Avoid duplicate batch numbers for the same product in the list.
                if (!state.existingBatchesByProduct[b.product_id].some(x => x.batch_number === b.batch_number)) {
                    state.existingBatchesByProduct[b.product_id].push(b);
                }
            });
        } catch (error) {
            console.error('Error loading existing batches for GRN:', error);
        }
    }

    // 🔥 ADDED (issue #4): red if expiry is under 3 months away, yellow
    // if under 6 months, otherwise normal. Returns style strings for the
    // expiry input's border/background.
    function getExpiryUrgencyStyle(dateStr) {
        if (!dateStr) return { border: '#e2e8f0', background: 'white' };
        const expiry = new Date(dateStr);
        if (isNaN(expiry.getTime())) return { border: '#e2e8f0', background: 'white' };

        const today = new Date();
        const threeMonths = new Date(today);
        threeMonths.setMonth(threeMonths.getMonth() + 3);
        const sixMonths = new Date(today);
        sixMonths.setMonth(sixMonths.getMonth() + 6);

        if (expiry <= threeMonths) return { border: '#dc2626', background: '#fef2f2' };
        if (expiry <= sixMonths) return { border: '#f59e0b', background: '#fffbeb' };
        return { border: '#e2e8f0', background: 'white' };
    }

    function populateGRNModal(order) {
        const poRef = document.getElementById('grnPOReference');
        const supplier = document.getElementById('grnSupplier');
        const entryDate = document.getElementById('grnEntryDate');
        const invoiceNumber = document.getElementById('grnInvoiceNumber');
        const invoiceDate = document.getElementById('grnInvoiceDate');
        const freight = document.getElementById('grnFreight');
        const insurance = document.getElementById('grnInsurance');
        const notes = document.getElementById('grnNotes');
        const invoiceTotal = document.getElementById('grnInvoiceTotal');
        const currencyDisplay = document.getElementById('grnCurrencyDisplay');
        const exchangeRateDisplay = document.getElementById('grnExchangeRateDisplay');
        const remainingInfo = document.getElementById('grnRemainingInfo');
        
        if (poRef) poRef.textContent = order.po_number || 'N/A';
        if (supplier) supplier.textContent = order.suppliers?.name || 'Unknown';
        if (entryDate) entryDate.value = new Date().toISOString().split('T')[0];
        if (invoiceNumber) invoiceNumber.value = '';
        if (invoiceDate) invoiceDate.value = new Date().toISOString().split('T')[0];
        if (freight) freight.value = 0;
        if (insurance) insurance.value = 0;
        if (notes) notes.value = '';
        if (invoiceTotal) invoiceTotal.value = '';
        
        if (currencyDisplay) {
            currencyDisplay.textContent = state.currentGRNCurrency;
        }
        if (exchangeRateDisplay) {
            exchangeRateDisplay.textContent = state.currentGRNExchangeRate;
        }
        
        if (remainingInfo) {
            const totalRemaining = order.purchase_order_lines.reduce((sum, l) => 
                sum + ((l.order_quantity || 0) - (l.received_quantity || 0) - (l.cancelled_quantity || 0)), 0);
            const totalCancelled = order.purchase_order_lines.reduce((sum, l) => 
                sum + (l.cancelled_quantity || 0), 0);
            remainingInfo.textContent = `Remaining to receive: ${totalRemaining} packs | Already cancelled: ${totalCancelled} packs`;
        }
    }

    // ============================================
    // VIEW FUNCTIONS
    // ============================================

    async function viewPO(orderId) {
        try {
            const { data: order, error } = await supabaseClient
                .from('purchase_orders')
                .select(`
                    *,
                    suppliers:supplier_id (name),
                    purchase_order_lines (*)
                `)
                .eq('id', orderId)
                .single();

            if (error) throw error;

            const content = document.getElementById('viewPOContent');
            if (!content) return;
            
            const supplierName = order.suppliers?.name || 'Unknown';
            const symbol = order.currency === 'ZMW' ? 'ZK' : '$';
            const lines = order.purchase_order_lines || [];
            
            const totalOrderQty = lines.reduce((sum, l) => sum + (l.order_quantity || 0), 0);
            const totalReceivedQty = lines.reduce((sum, l) => sum + (l.received_quantity || 0), 0);
            const totalCancelledQty = lines.reduce((sum, l) => sum + (l.cancelled_quantity || 0), 0);
            const remainingQty = totalOrderQty - totalReceivedQty - totalCancelledQty;
            
            const isOverdue = checkIfOverdue(order);
            
            content.innerHTML = `
                <div class="view-po-details">
                    <div class="detail-row">
                        <span class="label">PO Number</span>
                        <span class="value"><strong>${order.po_number}</strong></span>
                    </div>
                    <div class="detail-row">
                        <span class="label">Supplier</span>
                        <span class="value">${supplierName}</span>
                    </div>
                    <div class="detail-row">
                        <span class="label">Currency</span>
                        <span class="value">${order.currency || 'USD'}</span>
                    </div>
                    <div class="detail-row">
                        <span class="label">Exchange Rate</span>
                        <span class="value">${order.exchange_rate || 1}</span>
                    </div>
                    <div class="detail-row">
                        <span class="label">Expected Delivery</span>
                        <span class="value">
                            ${formatDate(order.expected_delivery_date)}
                            ${isOverdue ? `<span style="color: #dc2626; margin-left: 8px;">⚠️ ${getDaysOverdue(order)} days overdue</span>` : ''}
                        </span>
                    </div>
                    <div class="detail-row">
                        <span class="label">Status</span>
                        <span class="value">
                            <span class="status-badge status-${(order.status || 'Draft').toLowerCase().replace(/ /g, '-')}">${order.status}</span>
                            ${order.status === 'Partially Received' ? 
                                `<span style="font-size: 0.75rem; color: #f59e0b; margin-left: 8px;">
                                    (${totalReceivedQty}/${totalOrderQty} items received)
                                </span>` : ''}
                            ${totalCancelledQty > 0 ? 
                                `<span style="font-size: 0.75rem; color: #dc2626; margin-left: 8px;">
                                    (${totalCancelledQty} items cancelled)
                                </span>` : ''}
                            ${order.fully_received && order.status !== 'Cancelled' ? 
                                `<span style="font-size: 0.75rem; color: #10b981; margin-left: 8px;">✅ Fully Received</span>` : ''}
                            ${order.status === 'Cancelled' && order.cancellation_reason ?
                                `<span style="font-size: 0.75rem; color: #64748b; margin-left: 8px;">Reason: ${order.cancellation_reason}</span>` : ''}
                        </span>
                    </div>
                    <div class="detail-row">
                        <span class="label">Total Amount</span>
                        <span class="value" style="font-weight: bold; font-size: 1.1rem; color: #2563eb;">
                            ${symbol} ${formatNumber(order.total_amount)}
                            ${order.total_received_amount > 0 ? 
                                `<br><span style="font-size: 0.85rem; color: #10b981;">Received: ${symbol} ${formatNumber(order.total_received_amount)}</span>` : ''}
                            ${order.total_cancelled_amount > 0 ? 
                                `<br><span style="font-size: 0.85rem; color: #dc2626;">Cancelled: ${symbol} ${formatNumber(order.total_cancelled_amount)}</span>` : ''}
                            ${order.remaining_amount > 0 && order.status !== 'Draft' && order.status !== 'Cancelled' ? 
                                `<br><span style="font-size: 0.85rem; color: #f59e0b;">Remaining: ${symbol} ${formatNumber(order.remaining_amount)}</span>` : ''}
                        </span>
                    </div>
                    ${order.notes ? `
                    <div class="detail-row">
                        <span class="label">Notes</span>
                        <span class="value">${order.notes}</span>
                    </div>
                    ` : ''}
                    <div style="margin-top: 20px;">
                        <h5>Order Lines</h5>
                        <div class="table-responsive">
                            <table class="table-minimal">
                                <thead>
                                    <tr>
                                        <th>#</th>
                                        <th>Product</th>
                                        <th>Pack Size</th>
                                        <th>Ordered</th>
                                        <th>Received</th>
                                        <th>Cancelled</th>
                                        <th>Remaining</th>
                                        <th style="text-align: right;">Rate</th>
                                        <th style="text-align: right;">Total</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${lines.length === 0 ? `
                                        <tr><td colspan="9" style="text-align: center; padding: 20px; color: #94a3b8;">No items in this order</td></tr>
                                    ` : lines.map((line, idx) => {
                                        const remaining = (line.order_quantity || 0) - (line.received_quantity || 0) - (line.cancelled_quantity || 0);
                                        const isFullyReceived = remaining <= 0 && (line.received_quantity || 0) > 0;
                                        const isFullyCancelled = remaining <= 0 && (line.received_quantity || 0) === 0 && (line.cancelled_quantity || 0) > 0;
                                        return `
                                        <tr>
                                            <td>${idx + 1}</td>
                                            <td>${line.product_name}</td>
                                            <td>${line.pack_size || 1}</td>
                                            <td>${line.order_quantity}</td>
                                            <td style="color: #10b981;">${line.received_quantity || 0}</td>
                                            <td style="color: #dc2626;">${line.cancelled_quantity || 0}</td>
                                            <td style="color: ${isFullyReceived ? '#10b981' : isFullyCancelled ? '#dc2626' : '#f59e0b'};">${isFullyReceived ? '✅' : isFullyCancelled ? '❌' : remaining}</td>
                                            <td style="text-align: right;">${symbol} ${formatNumber(line.purchase_rate)}</td>
                                            <td style="text-align: right;">${symbol} ${formatNumber(line.total_amount)}</td>
                                        </tr>
                                    `}).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            `;
            
            showModal('viewPOModal');
        } catch (error) {
            console.error('Error viewing PO:', error);
            showToast('Error loading PO details: ' + error.message, 'error');
        }
    }

    async function deletePO(orderId) {
        if (!confirm('Are you sure you want to delete this purchase order?')) return;
        
        try {
            const { error } = await supabaseClient
                .from('purchase_orders')
                .delete()
                .eq('id', orderId);

            if (error) throw error;
            
            showToast('Purchase order deleted successfully', 'success');
            await loadPurchaseOrders();
        } catch (error) {
            console.error('Error deleting PO:', error);
            showToast('Error deleting PO: ' + error.message, 'error');
        }
    }

    async function viewGRN(orderId) {
        try {
            const { data: grns, error } = await supabaseClient
                .from('goods_receipt_notes')
                .select(`
                    *,
                    goods_receipt_lines (*),
                    purchase_orders:purchase_order_id (
                        po_number,
                        suppliers:supplier_id (name),
                        currency,
                        exchange_rate
                    )
                `)
                .eq('purchase_order_id', orderId)
                .order('created_at', { ascending: true });

            if (error) {
                console.error('GRN query error:', error);
                showToast('Error loading GRN: ' + error.message, 'error');
                return;
            }

            if (!grns || grns.length === 0) {
                showToast('No GRN found for this order', 'error');
                return;
            }

            if (grns.length === 1) {
                viewSingleGRN(grns[0]);
            } else {
                showGRNList(grns);
            }
        } catch (error) {
            console.error('Error viewing GRN:', error);
            showToast('Error loading GRN: ' + error.message, 'error');
        }
    }

    function viewSingleGRN(grn) {
        const content = document.getElementById('viewPOContent');
        if (!content) return;

        const symbol = grn.currency === 'ZMW' ? 'ZK' : '$';
        const lines = grn.goods_receipt_lines || [];
        const supplierName = grn.purchase_orders?.suppliers?.name || 'Unknown';

        content.innerHTML = `
            <div class="view-po-details">
                ${renderGRNInfo(grn, supplierName, symbol)}
                ${renderGRNTable(lines, symbol, grn)}
            </div>
        `;

        showModal('viewPOModal');
    }

    function renderGRNInfo(grn, supplierName, symbol) {
        return `
            <div class="detail-row">
                <span class="label">GRN Number</span>
                <span class="value"><strong>${grn.grn_number}</strong></span>
            </div>
            <div class="detail-row">
                <span class="label">PO Reference</span>
                <span class="value">${grn.purchase_orders?.po_number || 'N/A'}</span>
            </div>
            <div class="detail-row">
                <span class="label">Supplier</span>
                <span class="value">${supplierName}</span>
            </div>
            <div class="detail-row">
                <span class="label">Entry Date</span>
                <span class="value">${formatDate(grn.entry_date)}</span>
            </div>
            <div class="detail-row">
                <span class="label">Invoice Number</span>
                <span class="value">${grn.invoice_number || 'N/A'}</span>
            </div>
            <div class="detail-row">
                <span class="label">Invoice Date</span>
                <span class="value">${formatDate(grn.invoice_date)}</span>
            </div>
            <div class="detail-row">
                <span class="label">Currency</span>
                <span class="value">${grn.currency || 'USD'}</span>
            </div>
            <div class="detail-row">
                <span class="label">Total Amount</span>
                <span class="value" style="font-weight: bold; font-size: 1.1rem; color: #2563eb;">
                    ${symbol} ${formatNumber(grn.total_amount || 0)}
                </span>
            </div>
            ${grn.notes ? `
            <div class="detail-row">
                <span class="label">Notes</span>
                <span class="value">${grn.notes}</span>
            </div>
            ` : ''}
        `;
    }

    function renderGRNTable(lines, symbol, grn) {
        return `
            <div style="margin-top: 20px;">
                <h5>Received Items</h5>
                <div class="table-responsive">
                    <table class="table-minimal">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>Product</th>
                                <th>Pack Size</th>
                                <th>Ordered</th>
                                <th>Received</th>
                                <th>Batch</th>
                                <th>Expiry</th>
                                <th style="text-align: right;">Rate</th>
                                <th style="text-align: right;">Total</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${lines.length === 0 ? `
                                <tr><td colspan="9" style="text-align: center; padding: 20px; color: #94a3b8;">No items received</td></tr>
                            ` : lines.map((line, idx) => `
                                <tr>
                                    <td>${idx + 1}</td>
                                    <td>${line.product_name}</td>
                                    <td>${line.pack_size || 1}</td>
                                    <td>${line.ordered_quantity || 0}</td>
                                    <td style="color: #10b981;">${line.received_quantity || 0}</td>
                                    <td>${line.batch_number || 'N/A'}</td>
                                    <td>${formatDate(line.expiry_date)}</td>
                                    <td style="text-align: right;">${symbol} ${formatNumber(line.purchase_rate)}</td>
                                    <td style="text-align: right;">${symbol} ${formatNumber(line.total_amount)}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                        <tfoot>
                            ${renderGRNFooters(grn, symbol)}
                        </tfoot>
                    </table>
                </div>
            </div>
        `;
    }

    function renderGRNFooters(grn, symbol) {
        let html = '';
        if (grn.freight) {
            html += `
                <tr>
                    <td colspan="8" style="text-align: right;">Freight:</td>
                    <td style="text-align: right;">${symbol} ${formatNumber(grn.freight)}</td>
                </tr>
            `;
        }
        if (grn.insurance) {
            html += `
                <tr>
                    <td colspan="8" style="text-align: right;">Insurance:</td>
                    <td style="text-align: right;">${symbol} ${formatNumber(grn.insurance)}</td>
                </tr>
            `;
        }
        html += `
            <tr class="total-row">
                <td colspan="8" style="text-align: right;">Grand Total:</td>
                <td style="text-align: right;">${symbol} ${formatNumber(grn.total_amount || 0)}</td>
            </tr>
        `;
        return html;
    }

    function showGRNList(grns) {
        const content = document.getElementById('viewPOContent');
        if (!content) return;

        const symbol = grns[0]?.currency === 'ZMW' ? 'ZK' : '$';
        const supplierName = grns[0]?.purchase_orders?.suppliers?.name || 'Unknown';

        content.innerHTML = `
            <div class="view-po-details">
                <div class="detail-row">
                    <span class="label">PO Reference</span>
                    <span class="value"><strong>${grns[0]?.purchase_orders?.po_number || 'N/A'}</strong></span>
                </div>
                <div class="detail-row">
                    <span class="label">Supplier</span>
                    <span class="value">${supplierName}</span>
                </div>
                <div style="margin-top: 20px;">
                    <h5>GRN History (${grns.length} receipts)</h5>
                    <div class="table-responsive">
                        <table class="table-minimal">
                            <thead>
                                <tr>
                                    <th>GRN #</th>
                                    <th>Date</th>
                                    <th>Invoice #</th>
                                    <th style="text-align: right;">Amount</th>
                                    <th>Status</th>
                                    <th style="text-align: center;">Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${grns.map(grn => `
                                    <tr>
                                        <td><strong>${grn.grn_number}</strong></td>
                                        <td>${formatDate(grn.entry_date)}</td>
                                        <td>${grn.invoice_number || 'N/A'}</td>
                                        <td style="text-align: right;">${symbol} ${formatNumber(grn.total_amount || 0)}</td>
                                        <td><span class="status-badge status-goods-received">Posted</span></td>
                                        <td style="text-align: center;">
                                            <button class="btn btn-sm btn-outline" onclick="viewSingleGRNById('${grn.id}')">
                                                <i class="fa-regular fa-eye"></i> View
                                            </button>
                                        </td>
                                    </tr>
                                `).join('')}
                            </tbody>
                            <tfoot>
                                <tr class="total-row">
                                    <td colspan="3" style="text-align: right;">Total Received:</td>
                                    <td style="text-align: right;">${symbol} ${formatNumber(grns.reduce((sum, g) => sum + (g.total_amount || 0), 0))}</td>
                                    <td colspan="2"></td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </div>
            </div>
        `;

        showModal('viewPOModal');
    }

    async function viewSingleGRNById(grnId) {
        try {
            const { data: grn, error } = await supabaseClient
                .from('goods_receipt_notes')
                .select(`
                    *,
                    goods_receipt_lines (*),
                    purchase_orders:purchase_order_id (
                        po_number,
                        suppliers:supplier_id (name),
                        currency,
                        exchange_rate
                    )
                `)
                .eq('id', grnId)
                .single();

            if (error) throw error;
            viewSingleGRN(grn);
        } catch (error) {
            console.error('Error loading GRN:', error);
            showToast('Error loading GRN: ' + error.message, 'error');
        }
    }

    // ============================================
    // GRN HELPER FUNCTIONS
    // ============================================

    function receiveAllItems() {
        let receivedCount = 0;
        state.grnLines.forEach((line) => {
            const maxQty = line.max_receivable || line.order_quantity || 0;
            if (maxQty > 0 && !line.cancel_remaining) {
                line.received_quantity = maxQty;
                line.total_amount = (line.received_quantity || 0) * (line.purchase_rate || 0);
                receivedCount++;
            }
        });
        renderGRNLines();
        updateGRNTotal();
        showToast(`${receivedCount} items marked for receiving. Please enter batch and expiry for each item.`, 'success');
    }

    function clearReceivedItems() {
        let clearedCount = 0;
        state.grnLines.forEach(line => {
            if (line.received_quantity > 0 && !line.cancel_remaining) {
                line.received_quantity = 0;
                line.total_amount = 0;
                line.batch_number = '';
                line.expiry_date = '';
                clearedCount++;
            }
        });
        renderGRNLines();
        updateGRNTotal();
        showToast(`${clearedCount} items cleared`, 'info');
    }

    // ============================================
    // UPDATE GRN LINE
    // ============================================

    function updateGRNLine(index, field, value) {
        const line = state.grnLines[index];
        if (!line) return;
        
        if (field === 'received_quantity') {
            const maxQty = line.max_receivable || line.order_quantity || 0;
            let qty = parseInt(value) || 0;
            if (qty > maxQty) {
                qty = maxQty;
                showToast(`Maximum receivable is ${maxQty}`, 'warning');
            }
            line.received_quantity = qty;
            line.total_amount = (line.received_quantity || 0) * (line.purchase_rate || 0);
        } else if (field === 'purchase_rate') {
            line.purchase_rate = parseFloat(value) || 0;
            line.total_amount = (line.received_quantity || 0) * line.purchase_rate;
        } else if (field === 'batch_number') {
            line.batch_number = value;
            // 🔥 FIX (issue #2): if this batch number matches an existing
            // batch for this product, reuse its expiry automatically --
            // it's physically the same batch, so the expiry must match.
            // If it doesn't match anything existing, nothing happens here
            // and the typed value is simply treated as a new batch.
            const existingMatch = (state.existingBatchesByProduct[line.product_id] || [])
                .find(b => b.batch_number === value);
            if (existingMatch && existingMatch.expiry_date) {
                line.expiry_date = existingMatch.expiry_date;
            }
        } else if (field === 'expiry_date') {
            line.expiry_date = value;
        }
        
        renderGRNLines();
        updateGRNTotal();
    }

    // 🔥 ADDED (issue #3): formats digits into YYYY-MM-DD as the user
    // types, so entering a date is a plain, predictable typing experience
    // instead of fighting a native date input's segment-jumping behavior
    // (the most common cause of "can't type the year properly").
    window.formatExpiryInput = function(el) {
        const cursorWasAtEnd = el.selectionStart === el.value.length;
        let digits = el.value.replace(/\D/g, '').slice(0, 8);
        let formatted = digits;
        if (digits.length > 4) formatted = digits.slice(0, 4) + '-' + digits.slice(4);
        if (digits.length > 6) formatted = digits.slice(0, 4) + '-' + digits.slice(4, 6) + '-' + digits.slice(6);
        el.value = formatted;
        if (cursorWasAtEnd) {
            el.setSelectionRange(formatted.length, formatted.length);
        }
    };

    function toggleGRNLineReceive(index, checked) {
        const line = state.grnLines[index];
        if (!line) return;
        
        const maxQty = line.max_receivable || line.order_quantity || 0;
        
        if (checked && !line.cancel_remaining) {
            line.received_quantity = maxQty;
            line.total_amount = (line.received_quantity || 0) * (line.purchase_rate || 0);
        } else {
            line.received_quantity = 0;
            line.total_amount = 0;
            line.batch_number = '';
            line.expiry_date = '';
        }
        
        renderGRNLines();
        updateGRNTotal();
    }

    function updateGRNTotal() {
        const subtotal = state.grnLines.reduce((sum, line) => sum + (line.total_amount || 0), 0);
        const freight = parseFloat(document.getElementById('grnFreight')?.value) || 0;
        const insurance = parseFloat(document.getElementById('grnInsurance')?.value) || 0;
        const total = subtotal + freight + insurance;
        
        const currency = state.currentGRNCurrency || 'USD';
        const symbol = currency === 'ZMW' ? 'ZK' : '$';
        
        const subtotalEl = document.getElementById('grnSubtotal');
        const freightEl = document.getElementById('grnFreightDisplay');
        const insuranceEl = document.getElementById('grnInsuranceDisplay');
        const grandTotalEl = document.getElementById('grnGrandTotal');
        
        if (subtotalEl) subtotalEl.textContent = `${symbol} ${formatNumber(subtotal)}`;
        if (freightEl) freightEl.textContent = `${symbol} ${formatNumber(freight)}`;
        if (insuranceEl) insuranceEl.textContent = `${symbol} ${formatNumber(insurance)}`;
        if (grandTotalEl) grandTotalEl.textContent = `${symbol} ${formatNumber(total)}`;
        
        validateInvoice();
    }

    function validateInvoice() {
        const invoiceTotal = parseFloat(document.getElementById('grnInvoiceTotal')?.value) || 0;
        const grnTotal = parseFloat(document.getElementById('grnGrandTotal')?.textContent?.replace(/[^0-9.]/g, '')) || 0;
        const variance = invoiceTotal - grnTotal;
        const varianceDisplay = document.getElementById('grnVariance');
        const displayDiv = document.getElementById('grnVarianceDisplay');
        const symbol = state.currentGRNCurrency === 'ZMW' ? 'ZK' : '$';
        
        if (invoiceTotal > 0 && varianceDisplay && displayDiv) {
            displayDiv.style.display = 'flex';
            varianceDisplay.textContent = `${symbol} ${formatNumber(variance)}`;
            if (Math.abs(variance) < 0.01) {
                varianceDisplay.style.color = '#22c55e';
                varianceDisplay.textContent = `✓ ${symbol} ${formatNumber(variance)}`;
            } else {
                varianceDisplay.style.color = '#ef4444';
                varianceDisplay.textContent = `⚠ ${symbol} ${formatNumber(variance)}`;
            }
        } else if (displayDiv) {
            displayDiv.style.display = 'none';
        }
    }

        // ============================================
    // 🔥 FIX: the five functions below (getSupplierId, createGRN,
    // createGRNLines, updateInventory, updatePOLinesFromGRN) were being
    // CALLED by postGRN() further down but were never DEFINED anywhere in
    // this file. Posting any GRN would throw "ReferenceError: createGRN is
    // not defined" and crash immediately -- a complete showstopper for the
    // entire receiving workflow. Implemented here to match the exact
    // schema already established elsewhere in this file (purchase_order_lines
    // from insertPOLines, goods_receipt_notes/goods_receipt_lines from the
    // existing view/render functions).
    // ============================================

    async function getSupplierId(orderId) {
        const { data, error } = await supabaseClient
            .from('purchase_orders')
            .select('supplier_id')
            .eq('id', orderId)
            .single();
        if (error) throw error;
        return data.supplier_id;
    }

    async function generateGRNNumber() {
        try {
            const { count, error } = await supabaseClient
                .from('goods_receipt_notes')
                .select('id', { count: 'exact', head: true });
            if (error) throw error;
            const next = (count || 0) + 1;
            return `GRN-${new Date().getFullYear()}-${String(next).padStart(5, '0')}`;
        } catch (e) {
            console.warn('Could not compute sequential GRN number, falling back to timestamp-based:', e);
            return `GRN-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
        }
    }

    async function createGRN(orderId, supplierId, currency, exchangeRate, grnTotal, invoiceTotal, invoiceNumber) {
        const freight = parseFloat(document.getElementById('grnFreight')?.value) || 0;
        const insurance = parseFloat(document.getElementById('grnInsurance')?.value) || 0;
        const entryDate = document.getElementById('grnEntryDate')?.value || new Date().toISOString().split('T')[0];
        const invoiceDate = document.getElementById('grnInvoiceDate')?.value || new Date().toISOString().split('T')[0];
        const notes = document.getElementById('grnNotes')?.value || '';
        const grnNumber = await generateGRNNumber();

        const record = {
            grn_number: grnNumber,
            purchase_order_id: orderId,
            supplier_id: supplierId,
            entry_date: entryDate,
            invoice_number: invoiceNumber,
            invoice_date: invoiceDate,
            currency: currency,
            exchange_rate: exchangeRate,
            total_amount: grnTotal,
            invoice_total: invoiceTotal,
            freight: freight,
            insurance: insurance,
            notes: notes,
            created_at: new Date().toISOString()
        };

        const { data, error } = await supabaseClient
            .from('goods_receipt_notes')
            .insert([record])
            .select();
        if (error) throw error;
        return { id: data[0].id, grn_number: grnNumber };
    }

    async function createGRNLines(grnId) {
        // goods_receipt_lines columns confirmed from renderGRNTable() above:
        // product_name, pack_size, ordered_quantity, received_quantity,
        // batch_number, expiry_date, purchase_rate, total_amount.
        const linesToInsert = state.grnLines
            .filter(line => (line.received_quantity || 0) > 0)
            .map(line => ({
                grn_id: grnId,
                purchase_order_line_id: line.id,
                product_id: line.product_id,
                product_name: line.product_name,
                pack_size: line.pack_size || 1,
                ordered_quantity: line.order_quantity || 0,
                received_quantity: line.received_quantity || 0,
                batch_number: line.batch_number,
                expiry_date: line.expiry_date,
                purchase_rate: line.purchase_rate || 0,
                total_amount: line.total_amount || 0
            }));

        if (linesToInsert.length === 0) return;

        const { error } = await supabaseClient
            .from('goods_receipt_lines')
            .insert(linesToInsert);
        if (error) throw error;
    }

    async function updateInventory(grnId, currency, exchangeRate) {
        // Inventory/COGS elsewhere in this system (retail.js, wholesale.js,
        // donation.js) is ZMW-based -- batches.cost_price needs to be
        // stored in ZMW, converting from USD at the PO's exchange rate.
        // purchase_rate here is PER PACK (see the "(per pack)" label next
        // to the rate input in the PO line UI); batches.cost_price
        // elsewhere in the system is PER UNIT, so divide by pack size.
        const receivedLines = state.grnLines.filter(line => (line.received_quantity || 0) > 0);

        for (const line of receivedLines) {
            const packSize = line.pack_size || 1;
            const qtyToAdd = (line.received_quantity || 0) * packSize;
            const ratePerPack = line.purchase_rate || 0;
            const ratePerUnit = ratePerPack / packSize;
            const costPriceZmw = currency === 'USD' ? ratePerUnit * (exchangeRate || 1) : ratePerUnit;

            const { error } = await supabaseClient
                .from('batches')
                .insert([{
                    product_id: line.product_id,
                    batch_number: line.batch_number,
                    expiry_date: line.expiry_date,
                    total_qty: qtyToAdd,
                    cost_price: costPriceZmw
                }]);

            if (error) {
                console.error(`Error creating batch for ${line.product_name}:`, error);
                throw error;
            }
        }
    }

    async function updatePOLinesFromGRN(orderId) {
        // Re-query the persisted received_quantity for each line right
        // before updating, rather than trusting local state -- the local
        // state.grnLines objects reset received_quantity to 0 for this GRN
        // SESSION only (see initializeGRN), so the persisted prior total
        // isn't reliably available locally.
        const receivedLines = state.grnLines.filter(line => (line.received_quantity || 0) > 0);

        for (const line of receivedLines) {
            const { data: currentLine, error: fetchError } = await supabaseClient
                .from('purchase_order_lines')
                .select('received_quantity')
                .eq('id', line.id)
                .single();

            if (fetchError) {
                console.error(`Error fetching current line for ${line.product_name}:`, fetchError);
                continue;
            }

            const newReceivedQty = (currentLine.received_quantity || 0) + (line.received_quantity || 0);
            const remainingQty = Math.max(0, (line.order_quantity || 0) - newReceivedQty - (line.cancelled_quantity || 0));

            const { error: updateError } = await supabaseClient
                .from('purchase_order_lines')
                .update({
                    received_quantity: newReceivedQty,
                    remaining_quantity: remainingQty,
                    fully_received: remainingQty <= 0
                })
                .eq('id', line.id);

            if (updateError) {
                console.error(`Error updating line for ${line.product_name}:`, updateError);
                throw updateError;
            }
        }
    }

    // ============================================
    // POST GRN
    // ============================================

    async function postGRN() {
        const orderId = state.currentGRNOrderId;
        if (!orderId) {
            showToast('No order selected', 'error');
            return;
        }

        const hasReceived = state.grnLines.some(line => (line.received_quantity || 0) > 0);
        
        if (!hasReceived) {
            showToast('Please receive at least one item', 'error');
            return;
        }

        // Validate received items have batch and expiry
        const invalidBatch = state.grnLines.filter(line => 
            (line.received_quantity || 0) > 0 && (!line.batch_number || line.batch_number.trim() === '')
        );
        if (invalidBatch.length > 0) {
            showToast(`Please enter batch number for: ${invalidBatch.map(l => l.product_name).join(', ')}`, 'error');
            return;
        }

        const invalidExpiry = state.grnLines.filter(line => 
            (line.received_quantity || 0) > 0 && (!line.expiry_date || line.expiry_date === '')
        );
        if (invalidExpiry.length > 0) {
            showToast(`Please enter expiry date for: ${invalidExpiry.map(l => l.product_name).join(', ')}`, 'error');
            return;
        }

        // Validate received quantity doesn't exceed remaining
        const overReceived = state.grnLines.filter(line => {
            const maxQty = (line.order_quantity || 0) - (line.cancelled_quantity || 0);
            return (line.received_quantity || 0) > maxQty;
        });
        if (overReceived.length > 0) {
            showToast(`Received quantity exceeds available quantity for: ${overReceived.map(l => l.product_name).join(', ')}`, 'error');
            return;
        }

        const totalReceived = state.grnLines.reduce((sum, l) => sum + (l.received_quantity || 0), 0);
        const grnTotal = parseFloat(document.getElementById('grnGrandTotal')?.textContent?.replace(/[^0-9.]/g, '')) || 0;
        const invoiceNumber = document.getElementById('grnInvoiceNumber')?.value || null;

        if (!invoiceNumber && totalReceived > 0) {
            showToast('Please enter invoice number', 'error');
            return;
        }

        // 🔥 FIX (issue #5): Invoice Total is the actual amount on the
        // supplier's invoice -- it's what should be owed/booked, not GRN
        // Total (which is just what our own line items compute to, and
        // can legitimately differ from the invoice due to rounding,
        // freight/insurance the supplier billed differently, etc.).
        // Previously the field was editable but not actually required,
        // and the payable/accounting entries used grnTotal instead of it.
        const invoiceTotal = parseFloat(document.getElementById('grnInvoiceTotal')?.value) || 0;
        if (totalReceived > 0 && invoiceTotal <= 0) {
            showToast("Please enter the Invoice Total (the actual amount on the supplier's invoice) before posting.", 'error');
            return;
        }

        let confirmMessage = `Confirm receiving ${totalReceived} items with invoice ${invoiceNumber || 'N/A'}?`;

        if (!confirm(confirmMessage)) {
            return;
        }

        // 🔥 FIX: Cash vs Credit now actually matters. Previously a payable
        // was created for EVERY GRN unconditionally (see the old comment
        // "ALWAYS CREATE PAYABLE"), even for cash purchases where the
        // supplier was already paid in full -- that would have shown a
        // false debt for every cash purchase ever made.
        const paymentType = document.getElementById('grnPaymentType')?.value || 'Cash';

        try {
            const currency = state.currentGRNCurrency || 'USD';
            const exchangeRate = state.currentGRNExchangeRate || 1;
            const supplierId = await getSupplierId(orderId);

            let grnId = null;

            if (totalReceived > 0) {
                const grn = await createGRN(orderId, supplierId, currency, exchangeRate, grnTotal, invoiceTotal, invoiceNumber);
                grnId = grn.id;
                await createGRNLines(grnId);
                await updateInventory(grnId, currency, exchangeRate);

                // Only Credit purchases create a payable -- Cash purchases
                // were already paid, so there's nothing owed to record.
                // Uses invoiceTotal, not grnTotal -- see fix note above.
                if (paymentType === 'Credit') {
                    await createSupplierPayable(supplierId, grnId, orderId, currency, exchangeRate, invoiceTotal, invoiceNumber);
                }

                // Post the accounting entry either way: Debit Inventory,
                // Credit Cash (Cash purchase) or Credit Accounts Payable
                // (Credit purchase) -- also uses invoiceTotal, since that's
                // the actual amount owed/paid, not our own computed total.
                await createGRNAccountingEntries(grn.grn_number, invoiceTotal, currency, exchangeRate, paymentType);
            }

            // Update PO lines
            await updatePOLinesFromGRN(orderId);
            
            // Update PO header
            await updatePOHeader(orderId);

            // Show summary
            showPostGRNSummary(totalReceived, invoiceNumber, currency, invoiceTotal);

            closeModal('grnModal');
            await loadPurchaseOrders();

        } catch (error) {
            console.error('Error posting GRN:', error);
            showToast('Error posting GRN: ' + error.message, 'error');
        }
    }

    // ============================================
    // CREATE SUPPLIER PAYABLE - ALWAYS CALLED
    // ============================================

    async function createSupplierPayable(supplierId, grnId, orderId, currency, exchangeRate, grnTotal, invoiceNumber) {
        if (!supplierId || grnTotal <= 0) return;

        const payableData = {
            supplier_id: supplierId,
            grn_id: grnId,
            po_id: orderId,
            invoice_number: invoiceNumber,
            invoice_date: document.getElementById('grnInvoiceDate')?.value || new Date().toISOString().split('T')[0],
            due_date: new Date(new Date().setDate(new Date().getDate() + 30)).toISOString().split('T')[0],
            total_amount: grnTotal,
            amount_paid: 0,
            amount_remaining: grnTotal,
            currency: currency,
            exchange_rate: exchangeRate,
            status: 'Pending',
            payment_terms: 'Net 30',
            notes: `GRN: ${grnId}`,
            created_at: new Date().toISOString()
        };

        const { error: payableError } = await supabaseClient
            .from('supplier_payables')
            .insert([payableData]);

        if (payableError) {
            console.error('Error creating supplier payable:', payableError);
            showToast('⚠️ GRN posted but payable creation failed. Please check manually.', 'warning');
        } else {
            showToast(`✅ Supplier payable created for invoice ${invoiceNumber}`, 'success');
        }
    }

    // ============================================
    // UPDATE PO HEADER - FIXED STATUS LOGIC
    // ============================================

    async function updatePOHeader(orderId) {
        const { data: allLines, error: linesError } = await supabaseClient
            .from('purchase_order_lines')
            .select('order_quantity, received_quantity, cancelled_quantity, purchase_rate')
            .eq('purchase_order_id', orderId);

        if (linesError) throw linesError;

        let totalReceivedQty = 0;
        let totalReceivedAmount = 0;
        let totalOrderQty = 0;
        let totalOrderAmount = 0;
        let totalCancelledQty = 0;
        let totalCancelledAmount = 0;

        allLines.forEach(l => {
            const orderQty = l.order_quantity || 0;
            const receivedQty = l.received_quantity || 0;
            const cancelledQty = l.cancelled_quantity || 0;
            const rate = l.purchase_rate || 0;
            
            totalOrderQty += orderQty;
            totalReceivedQty += receivedQty;
            totalCancelledQty += cancelledQty;
            totalOrderAmount += orderQty * rate;
            totalReceivedAmount += receivedQty * rate;
            totalCancelledAmount += cancelledQty * rate;
        });

        const remainingQty = totalOrderQty - totalReceivedQty - totalCancelledQty;
        const remainingAmount = totalOrderAmount - totalReceivedAmount - totalCancelledAmount;
        const isFullyProcessed = remainingQty <= 0;
        
        // Determine status - show "Partially Received" if there are both received AND cancelled items
        let status;
        if (totalReceivedQty > 0 && totalCancelledQty > 0) {
            // Both received and cancelled items exist
            status = 'Partially Received';
        } else if (!isFullyProcessed && totalReceivedQty > 0) {
            status = 'Partially Received';
        } else if (isFullyProcessed && totalReceivedQty > 0 && totalCancelledQty === 0) {
            status = 'Goods Received';
        } else if (isFullyProcessed && totalReceivedQty === 0 && totalCancelledQty > 0) {
            status = 'Cancelled';
        } else if (isFullyProcessed && totalReceivedQty > 0 && totalCancelledQty > 0) {
            status = 'Partially Received';
        } else {
            // Keep existing status
            const { data: existing } = await supabaseClient
                .from('purchase_orders')
                .select('status')
                .eq('id', orderId)
                .single();
            status = existing?.status || 'Approved';
        }

        await supabaseClient
            .from('purchase_orders')
            .update({
                total_received_quantity: totalReceivedQty,
                total_received_amount: totalReceivedAmount,
                total_cancelled_quantity: totalCancelledQty,
                total_cancelled_amount: totalCancelledAmount,
                remaining_quantity: Math.max(0, remainingQty),
                remaining_amount: Math.max(0, remainingAmount),
                fully_received: isFullyProcessed,
                status: status,
                updated_at: new Date().toISOString()
            })
            .eq('id', orderId);
    }

    // ============================================
    // SHOW POST GRN SUMMARY - UPDATED
    // ============================================

    // 🔥 FIX (issue #6): this used to be a plain native alert() -- the
    // unstyled browser-default popup with no CSS at all. Replaced with a
    // proper modal matching the same .modal-content-box convention
    // already used elsewhere in this file (e.g. ensureAddSupplierModal).
    function showPostGRNSummary(totalReceived, invoiceNumber, currency, invoiceTotal) {
        const totalRemaining = state.grnLines.reduce((sum, l) =>
            sum + ((l.order_quantity || 0) - (l.received_quantity || 0) - (l.cancelled_quantity || 0)), 0);
        const totalCancelled = state.grnLines.reduce((sum, l) => sum + (l.cancelled_quantity || 0), 0);

        let statusLine = '';
        if (totalRemaining <= 0 && totalCancelled > 0) {
            statusLine = `<div style="color:#15803d;"><i class="fa-solid fa-circle-check"></i> PO is partially received with some items cancelled.</div>`;
        } else if (totalRemaining <= 0 && totalCancelled === 0) {
            statusLine = `<div style="color:#15803d;"><i class="fa-solid fa-circle-check"></i> PO is fully received.</div>`;
        }
        if (totalRemaining > 0) {
            statusLine += `<div style="color:#b45309;margin-top:6px;"><i class="fa-solid fa-triangle-exclamation"></i> ${totalRemaining} item(s) still pending -- use "Cancel Remaining" or receive more later.</div>`;
        }
        if (totalCancelled > 0) {
            statusLine += `<div style="color:#dc2626;margin-top:6px;"><i class="fa-solid fa-ban"></i> ${totalCancelled} item(s) cancelled from this PO.</div>`;
        }

        const existing = document.getElementById('grnSummaryModal');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'grnSummaryModal';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(15,23,42,0.6);backdrop-filter:blur(4px);z-index:1200;display:flex;justify-content:center;align-items:center;';
        overlay.innerHTML = `
            <div class="modal-content-box" style="background:white;padding:30px;border-radius:12px;width:90%;max-width:440px;box-shadow:0 20px 50px rgba(0,0,0,0.5);text-align:center;">
                <div style="margin-bottom:14px;"><i class="fa-solid fa-circle-check" style="font-size:3rem;color:#22c55e;"></i></div>
                <h3 style="margin:0 0 16px 0;color:#0f172a;">GRN Processed Successfully</h3>
                <div style="background:#f8fafc;border-radius:8px;padding:14px;text-align:left;font-size:0.9rem;color:#334155;margin-bottom:12px;">
                    <div style="display:flex;justify-content:space-between;padding:4px 0;"><span>Received</span><strong>${totalReceived} item(s)</strong></div>
                    <div style="display:flex;justify-content:space-between;padding:4px 0;"><span>Invoice #</span><strong>${invoiceNumber || 'N/A'}</strong></div>
                    <div style="display:flex;justify-content:space-between;padding:4px 0;"><span>Invoice Amount</span><strong>${currency} ${formatNumber(invoiceTotal || 0)}</strong></div>
                    <div style="display:flex;justify-content:space-between;padding:4px 0;"><span>Payable</span><strong>Created for this invoice</strong></div>
                </div>
                <div style="text-align:left;font-size:0.85rem;">${statusLine}</div>
                <button id="grnSummaryCloseBtn" style="margin-top:20px;background:#2563eb;color:white;border:none;padding:10px 28px;border-radius:6px;cursor:pointer;">
                    <i class="fa-solid fa-check"></i> Done
                </button>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector('.modal-content-box').addEventListener('click', e => e.stopPropagation());
        document.getElementById('grnSummaryCloseBtn').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    }

    // ============================================
    // DETERMINE PO STATUS - HELPER (optional)
    // ============================================

    function determinePOStatus(totalReceivedQty, totalCancelledQty, totalOrderQty) {
        const remainingQty = totalOrderQty - totalReceivedQty - totalCancelledQty;
        
        // If both received and cancelled exist -> Partially Received
        if (totalReceivedQty > 0 && totalCancelledQty > 0) {
            return 'Partially Received';
        }
        
        // If fully processed
        if (remainingQty <= 0) {
            if (totalReceivedQty > 0 && totalCancelledQty === 0) {
                return 'Goods Received';
            } else if (totalReceivedQty === 0 && totalCancelledQty > 0) {
                return 'Cancelled';
            } else if (totalReceivedQty > 0 && totalCancelledQty > 0) {
                return 'Partially Received';
            }
        }
        
        // Partially received
        if (totalReceivedQty > 0 && remainingQty > 0) {
            return 'Partially Received';
        }
        
        return 'Approved';
    }

    // ============================================
    // STATS AND OVERDUE FUNCTIONS
    // ============================================

    function updateStats(orders) {
        const total = orders.length;
        const pending = orders.filter(o => o.status === 'Pending Approval').length;
        const received = orders.filter(o => o.status === 'Goods Received' || o.status === 'Closed').length;
        const partial = orders.filter(o => o.status === 'Partially Received').length;
        const cancelled = orders.filter(o => o.status === 'Cancelled').length;

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const overdue = orders.filter(o => {
            // Overdue is a flag - exclude completed/cancelled
            if (['Cancelled', 'Closed', 'Goods Received'].includes(o.status)) return false;
            if (o.fully_received === true) return false;
            if (!o.expected_delivery_date) return false;
            const expectedDate = new Date(o.expected_delivery_date);
            expectedDate.setHours(0, 0, 0, 0);
            // Only overdue if remaining > 0
            const remaining = (o.total_quantity || 0) - (o.total_received_quantity || 0) - (o.total_cancelled_quantity || 0);
            if (remaining <= 0) return false;
            return expectedDate < today;
        });

        document.getElementById('totalOrders').textContent = total;
        document.getElementById('pendingOrders').textContent = pending;
        document.getElementById('receivedOrders').textContent = received;
        document.getElementById('partialOrders').textContent = partial;
        document.getElementById('cancelledOrders').textContent = cancelled;
        document.getElementById('overdueOrders').textContent = overdue.length;

        const overdueEl = document.getElementById('overdueOrders');
        if (overdue.length > 0) {
            overdueEl.style.color = '#dc2626';
        } else {
            overdueEl.style.color = '#0f172a';
        }
    }

    function checkOverduePOs(orders) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const overdueList = [];
        const overdueAlert = document.getElementById('overdueAlert');
        const overdueListEl = document.getElementById('overdueList');

        orders.forEach(order => {
            // EXCLUDE ALL COMPLETED/CANCELLED STATUSES
            const completedStatuses = ['Cancelled', 'Closed', 'Goods Received', 'Received', 'Completed', 'Fully Received'];
            if (completedStatuses.includes(order.status)) {
                return;
            }

            if (order.fully_received === true) {
                return;
            }

            // Check remaining quantity
            const remaining = (order.total_quantity || 0) - (order.total_received_quantity || 0) - (order.total_cancelled_quantity || 0);
            if (remaining <= 0) {
                return;
            }

            if (order.expected_delivery_date) {
                const expectedDate = new Date(order.expected_delivery_date);
                expectedDate.setHours(0, 0, 0, 0);

                if (expectedDate < today) {
                    const daysOverdue = Math.floor((today - expectedDate) / (1000 * 60 * 60 * 24));
                    overdueList.push({
                        po_number: order.po_number,
                        supplier: order.suppliers?.name || 'Unknown',
                        days: daysOverdue,
                        status: order.status,
                        received: order.total_received_quantity || 0,
                        total: order.total_quantity || 0,
                        remaining: remaining
                    });
                }
            }
        });

        if (overdueList.length > 0) {
            overdueAlert.style.display = 'block';
            overdueListEl.innerHTML = overdueList.map(o => 
                `<span style="background: #fee2e2; padding: 2px 10px; border-radius: 12px; margin: 0 4px; display: inline-block;">
                    ${o.po_number} (${o.supplier}) - ${o.days} days overdue | Remaining: ${o.remaining}
                </span>`
            ).join(' ');
        } else {
            overdueAlert.style.display = 'none';
        }

        return overdueList;
    }

       // ============================================
    // PRINT FUNCTIONS
    // ============================================

    function printPO() {
        const orderId = document.getElementById('editPOId')?.value;
        if (!orderId) {
            showToast('Please open a PO to print', 'error');
            return;
        }
        
        const order = state.orders.find(o => o.id === orderId);
        if (!order) {
            showToast('Order not found', 'error');
            return;
        }
        
        generatePOPrint(order);
    }

    function printPOFromView() {
        const content = document.getElementById('viewPOContent');
        if (!content) return;
        
        const poNumberEl = content.querySelector('.detail-row .value strong');
        if (!poNumberEl) {
            showToast('PO not found', 'error');
            return;
        }
        
        const order = state.orders.find(o => o.po_number === poNumberEl.textContent);
        if (!order) {
            showToast('Order not found', 'error');
            return;
        }
        
        generatePOPrint(order);
    }

    function generatePOPrint(order) {
        const printWindow = window.open('', '_blank', 'width=800,height=600');
        if (!printWindow) {
            showToast('Please allow popups to print', 'error');
            return;
        }
        
        const symbol = order.currency === 'ZMW' ? 'ZK' : '$';
        const lines = order.purchase_order_lines || [];

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Purchase Order - ${order.po_number}</title>
                <style>
                    ${getPrintStyles()}
                </style>
            </head>
            <body>
                ${getPrintHeader()}
                <h2 style="text-align: center;">PURCHASE ORDER</h2>
                ${getPOInfoTable(order)}
                ${getPOLinesTable(lines, order, symbol)}
                ${getPrintFooter()}
                ${getPrintButton()}
            </body>
            </html>
        `);
        printWindow.document.close();
        setTimeout(() => printWindow.focus(), 500);
    }

    function getPrintStyles() {
        return `
            body { font-family: Arial, sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; }
            .header { text-align: center; border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 20px; }
            .header h1 { margin: 0; color: #0f172a; font-size: 1.5rem; }
            .header p { margin: 3px 0; color: #475569; font-size: 0.9rem; }
            .info { margin-bottom: 20px; padding: 10px; background: #f8fafc; border-radius: 4px; }
            .info table { width: 100%; }
            .info td { padding: 5px; }
            .info .label { font-weight: 600; width: 120px; }
            table { width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 0.9rem; }
            th { background: #f1f5f9; padding: 10px; text-align: left; border: 1px solid #e2e8f0; }
            td { padding: 10px; border: 1px solid #e2e8f0; }
            .text-right { text-align: right; }
            .total-row { font-weight: bold; background: #f8fafc; }
            .footer { text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0; color: #64748b; font-size: 0.9rem; }
            .status-badge { padding: 2px 10px; border-radius: 12px; font-size: 0.8rem; display: inline-block; }
            .received-status { font-size: 0.8rem; color: #10b981; }
            @media print {
                body { margin: 0; padding: 10px; }
                .no-print { display: none; }
            }
        `;
    }

    function getPrintHeader() {
        return `
            <div class="header">
                <h1>GRIFFINS MEDICALS LIMITED</h1>
                <p>Plot 3534, Freedomway, Lusaka | Phone: +260 97 000 0000</p>
                <p>ZAMRA #: ZAMRA-123456</p>
            </div>
        `;
    }

    function getPrintFooter() {
        return `
            <div class="footer">
                <p>This is a computer-generated purchase order.</p>
                <p>Generated on: ${new Date().toLocaleString()}</p>
            </div>
        `;
    }

    function getPrintButton() {
        return `
            <div class="no-print" style="text-align: center; margin-top: 20px;">
                <button onclick="window.print()" style="background: #2563eb; color: white; border: none; padding: 10px 30px; border-radius: 6px; cursor: pointer; font-size: 1rem;">
                    <i class="fa-solid fa-print"></i> Print
                </button>
            </div>
        `;
    }

    function getPOInfoTable(order) {
        const statusBg = order.status === 'Approved' ? '#dcfce7' : order.status === 'Goods Received' ? '#dcfce7' : '#fef3c7';
        const statusColor = order.status === 'Approved' ? '#15803d' : order.status === 'Goods Received' ? '#15803d' : '#b45309';
        
        return `
            <div class="info">
                <table>
                    <tr><td class="label">PO Number:</td><td><strong>${order.po_number}</strong></td></tr>
                    <tr><td class="label">Supplier:</td><td>${order.suppliers?.name || 'Unknown'}</td></tr>
                    <tr><td class="label">Currency:</td><td>${order.currency || 'USD'}</td></tr>
                    <tr><td class="label">Exchange Rate:</td><td>${order.exchange_rate || 1}</td></tr>
                    <tr><td class="label">Expected Delivery:</td><td>${formatDate(order.expected_delivery_date)}</td></tr>
                    <tr><td class="label">Status:</td><td>
                        <span class="status-badge" style="background: ${statusBg}; color: ${statusColor};">${order.status || 'Draft'}</span>
                        ${order.fully_received ? '<span class="received-status">✅ Fully Received</span>' : ''}
                        ${order.status === 'Partially Received' ? `<span class="received-status" style="color: #f59e0b;">⚠️ Partially Received (${order.total_received_quantity || 0}/${order.total_quantity || 0})</span>` : ''}
                        ${order.status === 'Cancelled' ? `<span class="received-status" style="color: #64748b;">❌ Cancelled</span>` : ''}
                        ${order.total_cancelled_quantity > 0 && order.status !== 'Cancelled' ? `<span class="received-status" style="color: #dc2626;">⚠️ ${order.total_cancelled_quantity} items cancelled</span>` : ''}
                        ${order.remaining_quantity > 0 && order.status !== 'Draft' && order.status !== 'Cancelled' ? `<span class="received-status" style="color: #f59e0b;">Remaining: ${order.remaining_quantity}</span>` : ''}
                    </td></tr>
                    ${order.notes ? `<tr><td class="label">Notes:</td><td>${order.notes}</td></tr>` : ''}
                    ${order.cancellation_reason ? `<tr><td class="label">Cancellation Reason:</td><td>${order.cancellation_reason}</td></tr>` : ''}
                </table>
            </div>
        `;
    }

    function getPOLinesTable(lines, order, symbol) {
        if (lines.length === 0) {
            return `
                <h3>Order Lines</h3>
                <table>
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>Product</th>
                            <th>Pack Size</th>
                            <th class="text-right">Qty</th>
                            <th class="text-right">Rate</th>
                            <th class="text-right">Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr><td colspan="6" style="text-align: center; padding: 20px; color: #94a3b8;">No items in this order</td></tr>
                    </tbody>
                </table>
            `;
        }

        return `
            <h3>Order Lines</h3>
            <table>
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Product</th>
                        <th>Pack Size</th>
                        <th class="text-right">Qty</th>
                        <th class="text-right">Received</th>
                        <th class="text-right">Cancelled</th>
                        <th class="text-right">Remaining</th>
                        <th class="text-right">Rate</th>
                        <th class="text-right">Total</th>
                    </tr>
                </thead>
                <tbody>
                    ${lines.map((line, idx) => {
                        const remaining = (line.order_quantity || 0) - (line.received_quantity || 0) - (line.cancelled_quantity || 0);
                        const isFullyReceived = remaining <= 0 && (line.received_quantity || 0) > 0;
                        const isFullyCancelled = remaining <= 0 && (line.received_quantity || 0) === 0 && (line.cancelled_quantity || 0) > 0;
                        return `
                        <tr>
                            <td>${idx + 1}</td>
                            <td>${line.product_name}</td>
                            <td>${line.pack_size || 1}</td>
                            <td class="text-right">${line.order_quantity}</td>
                            <td class="text-right" style="color: #10b981;">${line.received_quantity || 0}</td>
                            <td class="text-right" style="color: #dc2626;">${line.cancelled_quantity || 0}</td>
                            <td class="text-right" style="color: ${isFullyReceived ? '#10b981' : isFullyCancelled ? '#dc2626' : '#f59e0b'};">${isFullyReceived ? '✅' : isFullyCancelled ? '❌' : remaining}</td>
                            <td class="text-right">${symbol} ${formatNumber(line.purchase_rate)}</td>
                            <td class="text-right">${symbol} ${formatNumber(line.total_amount)}</td>
                        </tr>
                    `}).join('')}
                </tbody>
                <tfoot>
                    ${getPOFooterRows(order, symbol)}
                </tfoot>
            </table>
        `;
    }

    function getPOFooterRows(order, symbol) {
        let html = `
            <tr class="total-row">
                <td colspan="8" class="text-right">Grand Total:</td>
                <td class="text-right">${symbol} ${formatNumber(order.total_amount || 0)}</td>
            </tr>
        `;
        if (order.total_received_amount > 0) {
            html += `
                <tr>
                    <td colspan="8" class="text-right">Total Received:</td>
                    <td class="text-right" style="color: #10b981;">${symbol} ${formatNumber(order.total_received_amount)}</td>
                </tr>
            `;
        }
        if (order.total_cancelled_amount > 0) {
            html += `
                <tr>
                    <td colspan="8" class="text-right">Total Cancelled:</td>
                    <td class="text-right" style="color: #dc2626;">${symbol} ${formatNumber(order.total_cancelled_amount)}</td>
                </tr>
            `;
        }
        if (order.remaining_amount > 0 && order.status !== 'Draft' && order.status !== 'Cancelled') {
            html += `
                <tr>
                    <td colspan="8" class="text-right">Remaining:</td>
                    <td class="text-right" style="color: #f59e0b;">${symbol} ${formatNumber(order.remaining_amount)}</td>
                </tr>
            `;
        }
        return html;
    }

    function printGRN() {
        const orderId = state.currentGRNOrderId;
        if (!orderId) {
            showToast('No GRN open to print', 'error');
            return;
        }
        
        supabaseClient
            .from('goods_receipt_notes')
            .select(`
                *,
                goods_receipt_lines (*)
            `)
            .eq('purchase_order_id', orderId)
            .order('created_at', { ascending: false })
            .limit(1)
            .then(({ data, error }) => {
                if (error || !data || data.length === 0) {
                    showToast('GRN data not found', 'error');
                    return;
                }
                generateGRNPrint(data[0]);
            });
    }

    function generateGRNPrint(grn) {
        const printWindow = window.open('', '_blank', 'width=800,height=600');
        if (!printWindow) {
            showToast('Please allow popups to print', 'error');
            return;
        }
        
        const symbol = grn.currency === 'ZMW' ? 'ZK' : '$';
        const lines = grn.goods_receipt_lines || [];

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Goods Receipt Note - ${grn.grn_number}</title>
                <style>
                    ${getPrintStyles()}
                </style>
            </head>
            <body>
                ${getPrintHeader()}
                <h2 style="text-align: center;">GOODS RECEIPT NOTE</h2>
                ${getGRNInfoTable(grn)}
                ${getGRNLinesTable(lines, grn, symbol)}
                ${getPrintFooter()}
                ${getPrintButton()}
            </body>
            </html>
        `);
        printWindow.document.close();
        setTimeout(() => printWindow.focus(), 500);
    }

    function getGRNInfoTable(grn) {
        return `
            <div class="info">
                <table>
                    <tr><td class="label">GRN Number:</td><td><strong>${grn.grn_number}</strong></td></tr>
                    <tr><td class="label">PO Reference:</td><td>${grn.purchase_orders?.po_number || 'N/A'}</td></tr>
                    <tr><td class="label">Supplier:</td><td>${grn.purchase_orders?.suppliers?.name || 'Unknown'}</td></tr>
                    <tr><td class="label">Entry Date:</td><td>${formatDate(grn.entry_date)}</td></tr>
                    <tr><td class="label">Invoice Number:</td><td>${grn.invoice_number || 'N/A'}</td></tr>
                    <tr><td class="label">Invoice Date:</td><td>${formatDate(grn.invoice_date)}</td></tr>
                    <tr><td class="label">Currency:</td><td>${grn.currency || 'USD'}</td></tr>
                    ${grn.notes ? `<tr><td class="label">Notes:</td><td>${grn.notes}</td></tr>` : ''}
                </table>
            </div>
        `;
    }

    function getGRNLinesTable(lines, grn, symbol) {
        return `
            <h3>Received Items</h3>
            <table>
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Product</th>
                        <th>Batch</th>
                        <th>Expiry</th>
                        <th class="text-right">Ordered</th>
                        <th class="text-right">Received</th>
                        <th class="text-right">Rate</th>
                        <th class="text-right">Total</th>
                    </tr>
                </thead>
                <tbody>
                    ${lines.length === 0 ? `
                        <tr><td colspan="8" style="text-align: center; padding: 20px; color: #94a3b8;">No items received</td></tr>
                    ` : lines.map((line, idx) => `
                        <tr>
                            <td>${idx + 1}</td>
                            <td>${line.product_name}</td>
                            <td>${line.batch_number || 'N/A'}</td>
                            <td>${formatDate(line.expiry_date)}</td>
                            <td class="text-right">${line.ordered_quantity || 0}</td>
                            <td class="text-right" style="color: #10b981;">${line.received_quantity || 0}</td>
                            <td class="text-right">${symbol} ${formatNumber(line.purchase_rate)}</td>
                            <td class="text-right">${symbol} ${formatNumber(line.total_amount)}</td>
                        </tr>
                    `).join('')}
                </tbody>
                <tfoot>
                    ${getGRNFooterRows(grn, symbol)}
                </tfoot>
            </table>
        `;
    }

    function getGRNFooterRows(grn, symbol) {
        let html = '';
        if (grn.freight) {
            html += `
                <tr>
                    <td colspan="7" class="text-right">Freight:</td>
                    <td class="text-right">${symbol} ${formatNumber(grn.freight)}</td>
                </tr>
            `;
        }
        if (grn.insurance) {
            html += `
                <tr>
                    <td colspan="7" class="text-right">Insurance:</td>
                    <td class="text-right">${symbol} ${formatNumber(grn.insurance)}</td>
                </tr>
            `;
        }
        html += `
            <tr class="total-row">
                <td colspan="7" class="text-right">Grand Total:</td>
                <td class="text-right">${symbol} ${formatNumber(grn.total_amount || 0)}</td>
            </tr>
        `;
        return html;
    }

    // ============================================
    // UTILITY FUNCTIONS
    // ============================================

    function formatNumber(num) {
        return (num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function formatDate(dateStr) {
        if (!dateStr) return '-';
        try {
            const d = new Date(dateStr);
            return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        } catch {
            return dateStr;
        }
    }

    function getFutureDate(days) {
        const date = new Date();
        date.setDate(date.getDate() + days);
        return date.toISOString().split('T')[0];
    }

    function updateExchangeRate() {
        const currency = document.getElementById('poCurrency')?.value;
        const rateInput = document.getElementById('poExchangeRate');
        
        if (currency === 'ZMW' && rateInput) {
            rateInput.value = 1;
            rateInput.disabled = true;
        } else if (rateInput) {
            rateInput.disabled = false;
            // 🔥 FIX: fell back to a flat 1 (i.e. "no conversion at all")
            // whenever the field was empty -- now falls back to today's
            // shared exchange rate instead, matching resetPOForm().
            rateInput.value = rateInput.value || sharedZmwPerUsd;
        }
        updatePOTotal();
    }

    function refreshPurchaseList() {
        const searchTerm = document.getElementById('searchPurchase')?.value?.toLowerCase() || '';
        const statusFilter = document.getElementById('statusFilter')?.value || '';
        const supplierFilter = document.getElementById('supplierFilter')?.value || '';
        
        let filtered = state.orders || [];
        
        if (searchTerm) {
            filtered = filtered.filter(o => 
                (o.po_number || '').toLowerCase().includes(searchTerm) ||
                (o.suppliers?.name || '').toLowerCase().includes(searchTerm)
            );
        }
        if (statusFilter) {
            filtered = filtered.filter(o => o.status === statusFilter);
        }
        if (supplierFilter) {
            filtered = filtered.filter(o => o.supplier_id === supplierFilter);
        }
        
        renderPurchaseOrders(filtered);
    }

    function showToast(message, type = 'success') {
        const existing = document.querySelector('#customToast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'customToast';
        const bgColor = type === 'success' ? '#059669' : type === 'error' ? '#dc2626' : type === 'warning' ? '#f59e0b' : '#2563eb';
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

        // Cancel PO Reason - Other field
        document.getElementById('cancelReason')?.addEventListener('change', function() {
            const otherField = document.getElementById('cancelReasonOther');
            if (this.value === 'Other') {
                otherField.style.display = 'block';
                otherField.setAttribute('required', '');
            } else {
                otherField.style.display = 'none';
                otherField.removeAttribute('required');
                otherField.value = '';
            }
        });

        // Cancel Remaining Reason - Other field
        document.getElementById('cancelRemainingReason')?.addEventListener('change', function() {
            const otherField = document.getElementById('cancelRemainingReasonOther');
            if (this.value === 'Other') {
                otherField.style.display = 'block';
                otherField.setAttribute('required', '');
            } else {
                otherField.style.display = 'none';
                otherField.removeAttribute('required');
                otherField.value = '';
            }
        });

        // Product search
        const searchInput = document.getElementById('poProductSearch');
        if (searchInput) {
            searchInput.addEventListener('keyup', function(e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                }
                searchProducts();
            });
            // 🔥 FIX (issue #1): opening the dropdown no longer requires
            // typing anything -- clicking/focusing the field now shows
            // the product list immediately, same as a normal dropdown.
            searchInput.addEventListener('focus', function() {
                searchProducts();
            });
            document.addEventListener('click', function(e) {
                const results = document.getElementById('poSearchResults');
                if (results && !searchInput.contains(e.target) && !results.contains(e.target)) {
                    results.style.display = 'none';
                }
            });
        }

        const searchBtn = document.querySelector('.search-input-group .btn');
        if (searchBtn) {
            searchBtn.addEventListener('click', function(e) {
                e.preventDefault();
                searchProducts();
            });
        }

        // Filters
        const searchPurchase = document.getElementById('searchPurchase');
        const statusFilter = document.getElementById('statusFilter');
        const supplierFilter = document.getElementById('supplierFilter');
        const overdueFilter = document.getElementById('overdueFilter');
        
        if (searchPurchase) searchPurchase.addEventListener('input', refreshPurchaseList);
        if (statusFilter) statusFilter.addEventListener('change', refreshPurchaseList);
        if (supplierFilter) supplierFilter.addEventListener('change', refreshPurchaseList);
        if (overdueFilter) overdueFilter.addEventListener('change', refreshPurchaseList);
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
    // IMPORTANT: Functions must be exposed before rendering
    // so inline onclick handlers in HTML can access them
    
    window.openNewPurchaseOrder = openNewPurchaseOrder;
    window.editPO = editPO;
    window.viewPO = viewPO;
    window.deletePO = deletePO;
    window.openGRN = openGRN;
    window.viewGRN = viewGRN;
    window.viewSingleGRNById = viewSingleGRNById;
    window.closeModal = closeModal;
    window.searchProducts = searchProducts;
    window.addProductToPO = addProductToPO;
    window.removePOLine = removePOLine;
    window.updatePOLine = updatePOLine;
    window.updateGRNLine = updateGRNLine;
    window.toggleGRNLineReceive = toggleGRNLineReceive;
    window.savePODraft = savePODraft;
    window.submitPOForApproval = submitPOForApproval;
    window.approvePO = approvePO;
    window.postGRN = postGRN;
    window.updateExchangeRate = updateExchangeRate;
    window.updatePOTotal = updatePOTotal;
    window.updateGRNTotal = updateGRNTotal;
    window.validateInvoice = validateInvoice;
    window.refreshPurchaseList = refreshPurchaseList;
    window.printPO = printPO;
    window.printPOFromView = printPOFromView;
    window.printGRN = printGRN;
    window.showToast = showToast;
    window.openReorderReport = openReorderReport;
    window.generateReorderReport = generateReorderReport;
    window.toggleAllReorderItems = toggleAllReorderItems;
    window.updateReorderSelection = updateReorderSelection;
    window.addSelectedToPO = addSelectedToPO;
    window.openCancelPO = openCancelPO;
    window.openCancelPOFromModal = openCancelPOFromModal;
    window.confirmCancelPO = confirmCancelPO;
    window.openCancelRemainingPO = openCancelRemainingPO;
    window.confirmCancelRemainingPO = confirmCancelRemainingPO;
    window.receiveAllItems = receiveAllItems;
    window.clearReceivedItems = clearReceivedItems;
    window.checkOverduePOs = checkOverduePOs;
    window.updateStats = updateStats;

    // ============================================
    // INITIALIZE
    // ============================================
    // 🔥 ADDED: load today's shared exchange rate FIRST, before anything
    // that might read sharedZmwPerUsd (new-PO/new-supplier forms) could
    // possibly be opened.
    sharedZmwPerUsd = await getSharedExchangeRate();
    ensureAddSupplierModal();
    await ensureChartOfAccounts();
    await loadSuppliers();
    await loadPurchaseOrders();
    setupEventListeners();

    console.log("✅ Purchase module initialized successfully!");
})();