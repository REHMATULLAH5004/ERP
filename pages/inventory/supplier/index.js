// ============================================
// SUPPLIER PAGE - SELF EXECUTING MODULE
// ============================================

(async function initSupplierPage() {
    console.log("Supplier page initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    await loadSuppliers();

    // Modal Logic
    const modal = document.getElementById('supplierModal');
    const addBtn = document.getElementById('addSupplierBtn');
    const closeBtn = document.getElementById('closeSupplierModalBtn');
    const cancelBtn = document.getElementById('cancelSupplierBtn');
    const modalTitle = document.getElementById('supplierModalTitle');
    const submitBtn = document.getElementById('saveSupplierBtn');
    const hiddenId = document.getElementById('editSupplierId');

    const openModal = (title, btnText) => {
        modal.style.display = 'flex';
        modalTitle.textContent = title;
        submitBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> ${btnText}`;
    };

    const closeModal = () => {
        modal.style.display = 'none';
        document.getElementById('supplierForm').reset();
        hiddenId.value = '';
        document.getElementById('openingBalanceUsd').value = '0';
        document.getElementById('openingBalanceZmw').value = '0';
    };

    addBtn.addEventListener('click', () => {
        openModal('Add New Supplier', 'Save Supplier');
        document.getElementById('openingBalanceUsd').value = '0';
        document.getElementById('openingBalanceZmw').value = '0';
    });

    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    // 🔥 ADDED: Supplier Stock Detail modal close handlers.
    const stockModal = document.getElementById('supplierStockModal');
    const closeStockBtn = document.getElementById('closeSupplierStockBtn');
    if (closeStockBtn) {
        closeStockBtn.addEventListener('click', () => {
            stockModal.style.display = 'none';
        });
    }
    if (stockModal) {
        stockModal.addEventListener('click', (e) => {
            if (e.target === stockModal) stockModal.style.display = 'none';
        });
    }

    // ============================================
    // EDIT SUPPLIER LOGIC
    // ============================================
    window.editSupplier = async function(supplierId) {
        try {
            const { data: supplier, error } = await supabaseClient
                .from('suppliers')
                .select('*')
                .eq('id', supplierId)
                .single();

            if (error) throw error;

            openModal('Edit Supplier', 'Update Supplier');
            hiddenId.value = supplier.id;
            document.getElementById('supplierName').value = supplier.name;
            document.getElementById('contactPerson').value = supplier.contact_person || '';
            document.getElementById('supplierPhone').value = supplier.phone || '';
            document.getElementById('supplierEmail').value = supplier.email || '';
            document.getElementById('openingBalanceUsd').value = supplier.opening_balance_usd || 0;
            document.getElementById('openingBalanceZmw').value = supplier.opening_balance_zmw || 0;

        } catch (error) {
            showToast('Error loading supplier data: ' + error.message, 'error');
        }
    };

    // ============================================
    // 🔥 ADDED: SUPPLIER STOCK DETAIL (click Total Stock Amount)
    // ============================================
    window.openSupplierStockDetail = async function(supplierId, supplierName) {
        const stockModal = document.getElementById('supplierStockModal');
        const title = document.getElementById('supplierStockTitle');
        const content = document.getElementById('supplierStockContent');

        if (!stockModal || !title || !content) return;

        title.textContent = `${supplierName} - Stock on Hand`;
        content.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:30px;color:#94a3b8;"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</td></tr>`;
        stockModal.style.display = 'flex';

        try {
            const { data: products, error: prodError } = await supabaseClient
                .from('products')
                .select('id, product_name, conversion_rate')
                .eq('supplier_id', supplierId)
                .order('product_name', { ascending: true });

            if (prodError) throw prodError;

            if (!products || products.length === 0) {
                content.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:30px;color:#94a3b8;">No products linked to this supplier.</td></tr>`;
                return;
            }

            const productIds = products.map(p => p.id);
            const { data: batches, error: batchError } = await supabaseClient
                .from('batches')
                .select('product_id, total_qty, cost_price')
                .in('product_id', productIds);

            if (batchError) throw batchError;

            const qtyMap = {};
            const valueMap = {};
            (batches || []).forEach(b => {
                qtyMap[b.product_id] = (qtyMap[b.product_id] || 0) + (b.total_qty || 0);
                valueMap[b.product_id] = (valueMap[b.product_id] || 0) + ((b.total_qty || 0) * (b.cost_price || 0));
            });

            let grandTotal = 0;
            const rows = products.map(p => {
                const qty = qtyMap[p.id] || 0;
                const value = valueMap[p.id] || 0;
                grandTotal += value;
                return `
                    <tr>
                        <td style="padding-left: 20px;">${p.product_name}</td>
                        <td style="text-align: right; font-weight: ${qty === 0 ? 'normal' : '600'}; color: ${qty === 0 ? '#dc2626' : '#0f172a'};">${qty}</td>
                        <td style="text-align: right; padding-right: 20px; font-weight: 600;">K${formatNumber(value)}</td>
                    </tr>
                `;
            }).join('');

            content.innerHTML = rows + `
                <tr style="border-top: 2px solid #0f172a; background: #f8fafc;">
                    <td style="padding-left: 20px; font-weight: 700;" colspan="2">Total Stock Value</td>
                    <td style="text-align: right; padding-right: 20px; font-weight: 700; color: #2563eb;">K${formatNumber(grandTotal)}</td>
                </tr>
            `;

        } catch (error) {
            console.error('Error loading supplier stock detail:', error);
            content.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:30px;color:#dc2626;">Error: ${error.message}</td></tr>`;
        }
    };

    // Submit Form
    document.getElementById('supplierForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;

        const isEditing = hiddenId.value !== '';
        const formData = {
            name: document.getElementById('supplierName').value.trim(),
            contact_person: document.getElementById('contactPerson').value.trim() || null,
            phone: document.getElementById('supplierPhone').value.trim() || null,
            email: document.getElementById('supplierEmail').value.trim() || null,
            opening_balance_usd: parseFloat(document.getElementById('openingBalanceUsd').value) || 0,
            opening_balance_zmw: parseFloat(document.getElementById('openingBalanceZmw').value) || 0,
        };

        try {
            if (isEditing) {
                const { error } = await supabaseClient
                    .from('suppliers')
                    .update(formData)
                    .eq('id', hiddenId.value);

                if (error) throw error;
                showToast('Supplier updated successfully!', 'success');
            } else {
                const { error } = await supabaseClient
                    .from('suppliers')
                    .insert([formData]);

                if (error) throw error;
                showToast('Supplier added successfully!', 'success');
            }

            submitBtn.innerHTML = `<i class="fa-solid fa-check"></i> Saved!`;
            setTimeout(() => {
                submitBtn.disabled = false;
                submitBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Supplier`;
                closeModal();
                loadSuppliers();
            }, 1500);

        } catch (error) {
            console.error("Error saving supplier:", error);
            showToast('Error saving supplier: ' + error.message, 'error');
            submitBtn.disabled = false;
            submitBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Supplier`;
        }
    });
})();

// ============================================
// LOAD SUPPLIERS (With Total Stock)
// ============================================
async function loadSuppliers() {
    const tbody = document.getElementById('supplierTableBody');

    try {
        // 1. Fetch all suppliers
        const { data: suppliers, error: supError } = await supabaseClient
            .from('suppliers')
            .select('*')
            .order('name', { ascending: true });

        if (supError) throw supError;

        if (suppliers.length === 0) {
            // 🔥 FIX: colspan updated (8 -> 6) to match the removed
            // Opening Balance columns.
            tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 30px; color: #94a3b8;">No suppliers found. Click "Add Supplier" to get started!</td></tr>`;
            return;
        }

        // 2. Fetch all products linked to suppliers
        const supplierIds = suppliers.map(s => s.id);
        const { data: products, error: prodError } = await supabaseClient
            .from('products')
            .select('id, supplier_id, conversion_rate')
            .in('supplier_id', supplierIds);

        if (prodError) throw prodError;

        // 3. Fetch all batches
        const productIds = products.map(p => p.id);
        const { data: batches, error: batchError } = await supabaseClient
            .from('batches')
            .select('product_id, cost_price, total_qty')
            .in('product_id', productIds);

        if (batchError) throw batchError;

        // 4. Build the Supplier Analytics Map
        const supplierMap = {};
        suppliers.forEach(s => {
            supplierMap[s.id] = {
                ...s,
                totalStockValue: 0
            };
        });

        // 5. Calculate total stock value for each supplier
        batches.forEach(b => {
            const supplierId = products.find(p => p.id === b.product_id)?.supplier_id;
            if (supplierId && supplierMap[supplierId]) {
                const totalQty = b.total_qty || 0;
                const value = (b.cost_price || 0) * totalQty;
                supplierMap[supplierId].totalStockValue += value;
            }
        });

        // 6. Render the table
        renderSuppliers(Object.values(supplierMap));

    } catch (error) {
        console.error("Error loading suppliers:", error);
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 30px; color: #dc2626;">Error: ${error.message}</td></tr>`;
    }
}

// ============================================
// RENDER SUPPLIERS
// ============================================
// 🔥 FIX: Opening Balance (USD/ZMW) columns removed from the table --
// they're a static snapshot taken once at supplier creation, get paid
// down over time via the Payment module, and eventually hit zero. Showing
// them as list columns implied a "current" balance they don't represent.
// The underlying fields are kept in the Add/Edit modal (still needed by
// Purchase/Payment for initial payable setup), just not displayed here.
function renderSuppliers(suppliers) {
    const tbody = document.getElementById('supplierTableBody');
    
    tbody.innerHTML = suppliers.map(s => `
        <tr>
            <td style="padding-left: 20px; font-weight: 500;">${s.name}</td>
            <td>${s.contact_person || '-'}</td>
            <td>${s.phone || '-'}</td>
            <td>${s.email || '-'}</td>
            <td style="text-align: right; font-weight: bold; color: #2563eb; cursor: pointer; text-decoration: underline;" onclick="openSupplierStockDetail('${s.id}', '${(s.name || '').replace(/'/g, "\\'")}')" title="Click to view items and stock">
                K${formatNumber(s.totalStockValue)}
            </td>
            <td style="padding-right: 20px; text-align: right;">
                <button onclick="editSupplier('${s.id}')" style="background: none; border: none; color: #3b82f6; cursor: pointer;">
                    <i class="fa-regular fa-pen-to-square"></i>
                </button>
            </td>
        </tr>
    `).join('');
}

// ============================================
// UTILITY FUNCTIONS
// ============================================
function formatNumber(num) {
    return (num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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