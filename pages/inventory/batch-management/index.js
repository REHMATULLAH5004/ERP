// ============================================
// BATCH MANAGEMENT - SELF EXECUTING MODULE
// ============================================

(async function initBatchPage() {
    console.log("Batch page initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    await loadBatches();

    const searchInput = document.getElementById('searchBatch');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            filterBatches(e.target.value);
        });
        console.log("✅ Search listener attached.");
    } else {
        console.warn("⚠️ Search input (#searchBatch) not found.");
    }

    // ============================================
    // 🔥 ADDED: EDIT BATCH COST PRICE
    // Previously there was NO working way anywhere in the app to correct
    // a batch's cost price once stock existed for it -- Product Master's
    // edit screen hides the batch section entirely when editing (it only
    // shows batch/cost fields for a brand-new product), and this page was
    // read-only. That meant a wrong cost price entered at batch creation
    // could never actually be fixed, even though it looked editable from
    // Product Master. This wires up a small modal, right here where the
    // batch's current cost is already visible, to update batches.cost_price
    // directly. It intentionally only affects the batch's cost going
    // forward (used for future sales and stock valuation) -- it does NOT
    // rewrite cost_per_unit on past invoices, since that's a frozen
    // snapshot of what things actually cost at the time of each sale
    // (changing history there would be incorrect bookkeeping).
    // ============================================
    const editModal = document.getElementById('editBatchCostModal');
    const editIdInput = document.getElementById('editBatchCostId');
    const editCostInput = document.getElementById('editBatchCostInput');
    const editSubtitle = document.getElementById('editBatchCostSubtitle');
    const editCancelBtn = document.getElementById('editBatchCostCancelBtn');
    const editSaveBtn = document.getElementById('editBatchCostSaveBtn');

    window.openEditBatchCostModal = function (batchId, batchNumber, productName, currentCost) {
        if (!editModal) return;
        editIdInput.value = batchId;
        editCostInput.value = currentCost || 0;
        editSubtitle.textContent = `${productName} — Batch ${batchNumber}`;
        editModal.style.display = 'flex';
        setTimeout(() => editCostInput.focus(), 50);
    };

    const closeEditBatchCostModal = () => {
        if (editModal) editModal.style.display = 'none';
    };

    if (editCancelBtn) editCancelBtn.addEventListener('click', closeEditBatchCostModal);
    if (editModal) {
        editModal.addEventListener('click', (e) => {
            if (e.target === editModal) closeEditBatchCostModal();
        });
    }

    if (editSaveBtn) {
        editSaveBtn.addEventListener('click', async () => {
            const batchId = editIdInput.value;
            const newCost = parseFloat(editCostInput.value);

            if (!batchId) return;
            if (isNaN(newCost) || newCost < 0) {
                alert('Please enter a valid cost price (0 or higher).');
                return;
            }

            editSaveBtn.disabled = true;
            editSaveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

            try {
                const { error } = await supabaseClient
                    .from('batches')
                    .update({ cost_price: newCost, updated_at: new Date().toISOString() })
                    .eq('id', batchId);

                if (error) throw error;

                if (typeof showToast === 'function') {
                    showToast('Cost price updated successfully!', 'success');
                }
                closeEditBatchCostModal();
                await loadBatches();
            } catch (error) {
                console.error('Error updating batch cost price:', error);
                alert('❌ Error updating cost price: ' + error.message);
            } finally {
                editSaveBtn.disabled = false;
                editSaveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save';
            }
        });
    }
})();

async function loadBatches() {
    const tbody = document.getElementById('batchTableBody');

    if (!tbody) {
        console.error("❌ batchTableBody element not found in HTML!");
        return;
    }

    try {
        console.log("Fetching batches from Supabase...");
        
        // ✅ SIMPLIFIED: Only fetch the columns that actually exist
        const { data: batches, error } = await supabaseClient
            .from('batches')
            .select(`
                id,
                batch_number,
                expiry_date,
                cost_price,
                total_qty,
                products:product_id ( 
                    product_name
                )
            `)
            .order('expiry_date', { ascending: true });

        if (error) {
            console.error("Supabase Error:", error);
            throw error;
        }

        console.log("Batches fetched:", batches);

        if (batches.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 30px; color: #94a3b8;">No batches found.</td></tr>`;
            return;
        }

        renderBatches(batches);

    } catch (error) {
        console.error("Error loading batches:", error);
        tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 30px; color: #dc2626;">Error: ${error.message || error}</td></tr>`;
    }
}

function renderBatches(batches) {
    const tbody = document.getElementById('batchTableBody');
    const today = new Date();
    
    tbody.innerHTML = batches.map(batch => {
        const expiry = new Date(batch.expiry_date);
        const daysUntilExpiry = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
        
        let rowClass = '';
        let expiryClass = '';
        if (daysUntilExpiry < 0) {
            rowClass = 'style="background: #fef2f2;"';
            expiryClass = 'style="color: #dc2626; font-weight: bold;"';
        } else if (daysUntilExpiry <= 30) {
            rowClass = 'style="background: #fffbeb;"';
            expiryClass = 'style="color: #d97706; font-weight: bold;"';
        } else {
            expiryClass = 'style="color: #15803d;"';
        }

        // ✅ SIMPLIFIED: Directly use total_qty and cost_price
        const totalQty = batch.total_qty || 0;
        const totalAmount = totalQty * parseFloat(batch.cost_price || 0);

        const productNameSafe = (batch.products?.product_name || 'Unknown Product').replace(/'/g, "\\'");
        const batchNumberSafe = (batch.batch_number || '').replace(/'/g, "\\'");

        return `
            <tr ${rowClass} data-batch="${batch.batch_number}">
                <td style="padding-left: 20px; font-family: monospace; font-weight: 500;">${batch.batch_number}</td>
                <td>${batch.products?.product_name || 'Unknown Product'}</td>
                <td ${expiryClass}>${new Date(batch.expiry_date).toLocaleDateString()}</td>
                <td>K${parseFloat(batch.cost_price).toFixed(2)}</td>
                <td style="text-align: right; font-weight: bold;">${totalQty}</td>
                <td style="text-align: right; font-weight: bold;">
                    K${totalAmount.toFixed(2)}
                </td>
                <td style="padding-right: 20px; text-align: right;">
                    <button onclick="openEditBatchCostModal('${batch.id}', '${batchNumberSafe}', '${productNameSafe}', ${parseFloat(batch.cost_price) || 0})" style="background: none; border: none; color: #3b82f6; cursor: pointer;" title="Edit cost price">
                        <i class="fa-regular fa-pen-to-square"></i>
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

function filterBatches(searchTerm) {
    const rows = document.querySelectorAll('#batchTableBody tr');
    const term = searchTerm.toLowerCase();

    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(term) ? '' : 'none';
    });
}