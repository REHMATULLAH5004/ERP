// ============================================
// CATEGORY PAGE - SELF EXECUTING MODULE
// ============================================

(async function initCategoryPage() {
    console.log("Category page initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    await loadCategories();

    // 🔥 Wire up the Print Stock Take Sheet button now that it's a real
    // element in this page's HTML, rather than injecting a floating one.
    const stockTakeBtn = document.getElementById('printStockTakeSheetBtn');
    if (stockTakeBtn) {
        stockTakeBtn.addEventListener('click', printStockTakeSheet);
    }

    document.getElementById('closeSubCategoryBtn').addEventListener('click', () => {
        document.getElementById('subCategoryContainer').style.display = 'none';
    });

    document.getElementById('closeProductListBtn').addEventListener('click', () => {
        document.getElementById('productListModal').style.display = 'none';
    });

    // ============================================
    // CLICK DELEGATION: Handle Clicks on the Table
    // ============================================
    document.getElementById('categoryTable').addEventListener('click', async function(e) {
        const target = e.target.closest('a, button, i');
        
        // 1. If clicked on an Edit Category button
        const editBtn = target?.closest('.edit-category');
        if (editBtn) {
            e.preventDefault();
            e.stopPropagation();
            
            const id = editBtn.dataset.id;
            const currentName = editBtn.dataset.name;
            const currentLocation = editBtn.dataset.location || '';

            console.log("Edit button clicked for:", currentName);
            openCategoryEditModal(id, currentName, currentLocation);
            return;
        }

        // 2. If clicked on a Delete Category button
        const deleteBtn = target?.closest('.delete-category');
        if (deleteBtn) {
            e.preventDefault();
            e.stopPropagation();
            
            const id = deleteBtn.dataset.id;
            if (confirm("Are you sure you want to delete this Category? All linked Sub-Categories will also be deleted.")) {
                await deleteCategory(id);
            }
            return;
        }

        // 3. If clicked on a Sub-Category Edit button
        const editSubBtn = target?.closest('.edit-subcategory');
        if (editSubBtn) {
            e.preventDefault();
            e.stopPropagation();
            
            const id = editSubBtn.dataset.id;
            const currentName = editSubBtn.dataset.name;
            const newName = prompt("Edit Sub-Category Name:", currentName);
            if (newName && newName.trim() !== currentName) {
                await updateSubCategory(id, newName.trim());
            }
            return;
        }

        // 4. If clicked on a Sub-Category Delete button
        const deleteSubBtn = target?.closest('.delete-subcategory');
        if (deleteSubBtn) {
            e.preventDefault();
            e.stopPropagation();
            
            const id = deleteSubBtn.dataset.id;
            if (confirm("Are you sure you want to delete this Sub-Category?")) {
                await deleteSubCategory(id);
            }
            return;
        }

        // 5. If clicked on a Category Row (Load Sub-Categories)
        const row = e.target.closest('tr');
        if (row && row.dataset.categoryId) {
            const categoryId = row.dataset.categoryId;
            const categoryName = row.dataset.categoryName;
            loadSubCategories(categoryId, categoryName);
        }
    });
})();

// ============================================
// STOCK TAKE SHEET (PRINTABLE) -- Category+Location ->
// Sub-Category+Location -> Item+Qty, with a blank column for writing
// the physical count during an actual stock take.
// ============================================

async function printStockTakeSheet() {
    const btn = document.getElementById('printStockTakeSheetBtn');
    const originalHtml = btn ? btn.innerHTML : null;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Preparing...';
    }

    try {
        const [{ data: categories, error: catErr }, { data: subCats, error: subErr }, { data: products, error: prodErr }] = await Promise.all([
            supabaseClient.from('categories').select('id, name, location').order('name'),
            supabaseClient.from('sub_categories').select('id, name, location, category_id').order('name'),
            supabaseClient.from('products').select('id, product_name, category_id, sub_category_id').order('product_name')
        ]);

        if (catErr) throw catErr;
        if (subErr) throw subErr;
        if (prodErr) throw prodErr;

        const productIds = (products || []).map(p => p.id);
        let qtyMap = {};
        if (productIds.length > 0) {
            const { data: batches, error: batchErr } = await supabaseClient
                .from('batches')
                .select('product_id, total_qty')
                .in('product_id', productIds);
            if (batchErr) throw batchErr;
            (batches || []).forEach(b => {
                qtyMap[b.product_id] = (qtyMap[b.product_id] || 0) + (b.total_qty || 0);
            });
        }

        // Build the hierarchy: category -> its sub-categories -> its
        // products. Products with no sub_category_id (but a category_id)
        // are grouped under an "Uncategorized" bucket within that
        // category, so nothing silently disappears from the sheet.
        const subsByCategory = {};
        (subCats || []).forEach(s => {
            if (!subsByCategory[s.category_id]) subsByCategory[s.category_id] = [];
            subsByCategory[s.category_id].push(s);
        });

        const productsBySub = {};
        const productsByCategoryUncategorized = {};
        (products || []).forEach(p => {
            if (p.sub_category_id) {
                if (!productsBySub[p.sub_category_id]) productsBySub[p.sub_category_id] = [];
                productsBySub[p.sub_category_id].push(p);
            } else if (p.category_id) {
                if (!productsByCategoryUncategorized[p.category_id]) productsByCategoryUncategorized[p.category_id] = [];
                productsByCategoryUncategorized[p.category_id].push(p);
            }
        });

        let sectionsHtml = '';
        (categories || []).forEach(cat => {
            const subs = subsByCategory[cat.id] || [];
            const uncategorizedProducts = productsByCategoryUncategorized[cat.id] || [];

            if (subs.length === 0 && uncategorizedProducts.length === 0) return; // nothing to count here

            sectionsHtml += `
                <div class="stk-category">
                    <div class="stk-category-header">
                        <span class="stk-category-name">${cat.name}</span>
                        <span class="stk-location">Location: ${cat.location || '-'}</span>
                    </div>
            `;

            subs.forEach(sub => {
                const items = productsBySub[sub.id] || [];
                if (items.length === 0) return;
                sectionsHtml += renderStkSubSection(sub.name, sub.location, items, qtyMap);
            });

            if (uncategorizedProducts.length > 0) {
                sectionsHtml += renderStkSubSection('Uncategorized', '', uncategorizedProducts, qtyMap);
            }

            sectionsHtml += `</div>`;
        });

        if (!sectionsHtml) {
            sectionsHtml = '<p style="text-align:center;color:#94a3b8;padding:40px;">No products found to include on the sheet.</p>';
        }

        const printWindow = window.open('', '_blank', 'width=900,height=700');
        if (!printWindow) {
            showToast('Please allow popups to print', 'error');
            return;
        }

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Stock Take Sheet - ${new Date().toLocaleDateString()}</title>
                <style>
                    body { font-family: Arial, sans-serif; padding: 20px; color: #0f172a; }
                    .stk-header { text-align: center; border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 20px; }
                    .stk-header h1 { margin: 0; font-size: 1.4rem; }
                    .stk-header p { margin: 4px 0 0 0; color: #64748b; font-size: 0.85rem; }
                    .stk-category { margin-bottom: 22px; page-break-inside: avoid; }
                    .stk-category-header { display: flex; justify-content: space-between; align-items: baseline; background: #eff6ff; padding: 8px 12px; border-left: 4px solid #2563eb; margin-bottom: 8px; }
                    .stk-category-name { font-weight: 700; font-size: 1.05rem; }
                    .stk-location { font-size: 0.8rem; color: #475569; }
                    .stk-sub-header { display: flex; justify-content: space-between; align-items: baseline; background: #f8fafc; padding: 5px 12px; margin: 10px 0 4px 12px; border-left: 3px solid #94a3b8; }
                    .stk-sub-name { font-weight: 600; font-size: 0.9rem; }
                    table.stk-table { width: calc(100% - 12px); margin-left: 12px; border-collapse: collapse; margin-bottom: 8px; }
                    table.stk-table th { background: #f1f5f9; text-align: left; padding: 5px 8px; font-size: 0.75rem; border: 1px solid #e2e8f0; }
                    table.stk-table td { padding: 5px 8px; font-size: 0.85rem; border: 1px solid #e2e8f0; }
                    .stk-qty-col { text-align: right; width: 90px; }
                    .stk-count-col { width: 110px; }
                    @media print {
                        body { padding: 10px; }
                        .stk-category { page-break-inside: avoid; }
                    }
                </style>
            </head>
            <body>
                <div class="stk-header">
                    <h1>Stock Take Sheet</h1>
                    <p>Generated ${new Date().toLocaleString()}</p>
                </div>
                ${sectionsHtml}
                <script>
                    window.onload = function() { window.print(); };
                <\/script>
            </body>
            </html>
        `);
        printWindow.document.close();

    } catch (error) {
        console.error('Error generating stock take sheet:', error);
        showToast('Error generating stock take sheet: ' + error.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
        }
    }
}

function renderStkSubSection(subName, subLocation, items, qtyMap) {
    let html = `
        <div class="stk-sub-header">
            <span class="stk-sub-name">${subName}</span>
            <span class="stk-location">Location: ${subLocation || '-'}</span>
        </div>
        <table class="stk-table">
            <thead>
                <tr>
                    <th>Item</th>
                    <th class="stk-qty-col">System Qty</th>
                    <th class="stk-count-col">Physical Count</th>
                </tr>
            </thead>
            <tbody>
    `;
    items.forEach(p => {
        html += `
            <tr>
                <td>${p.product_name}</td>
                <td class="stk-qty-col">${qtyMap[p.id] || 0}</td>
                <td class="stk-count-col">&nbsp;</td>
            </tr>
        `;
    });
    html += `</tbody></table>`;
    return html;
}

// ============================================
// OPEN CATEGORY EDIT MODAL
// ============================================
function openCategoryEditModal(id, currentName, currentLocation) {
    const existing = document.querySelector('#quickAddOverlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'quickAddOverlay';
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.5); display: flex; justify-content: center;
        align-items: center; z-index: 2000;
    `;
    
    overlay.innerHTML = `
        <div style="background: white; padding: 25px; border-radius: 10px; width: 400px; position: relative;">
            <h3>Edit Category</h3>
            <div style="margin: 15px 0;">
                <label style="display: block; font-weight: 500; color: #475569; margin-bottom: 5px;">Category Name</label>
                <input type="text" id="quickAddInput" value="${currentName}" readonly style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px; background: #f1f5f9; color: #64748b;">
            </div>
            <div style="margin: 15px 0;">
                <label style="display: block; font-weight: 500; color: #475569; margin-bottom: 5px;">Location</label>
                <input type="text" id="quickAddLocation" placeholder="e.g. Shelf A-1" value="${currentLocation}" style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px;">
            </div>
            <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 15px;">
                <button onclick="closeQuickAdd()" style="padding: 8px 20px; border: 1px solid #e2e8f0; background: white; border-radius: 6px; cursor: pointer;">Cancel</button>
                <button onclick="saveCategoryEdit('${id}')" style="padding: 8px 20px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer;">Save</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
}

// ============================================
// SAVE CATEGORY EDIT
// ============================================
async function saveCategoryEdit(id) {
    const nameInput = document.getElementById('quickAddInput');
    const locationInput = document.getElementById('quickAddLocation');
    
    const name = nameInput.value.trim();
    const location = locationInput.value.trim();

    if (!name) return showToast("Category name is required.", "error");

    try {
        const { error } = await supabaseClient
            .from('categories')
            .update({ 
                name: name, 
                location: location || null 
            })
            .eq('id', id);

        if (error) throw error;

        closeQuickAdd();
        showToast('Category updated successfully!', 'success');
        await loadCategories();
    } catch (error) {
        showToast('Error updating category: ' + error.message, 'error');
    }
}

// ============================================
// LOAD CATEGORIES
// ============================================
async function loadCategories() {
    const tbody = document.getElementById('categoryTableBody');
    // 🔥 FIX: if this page's DOM is already gone by the time we get
    // here (e.g. the user hadn't navigated away yet when this function
    // started, but did before it finished), there's nothing to render
    // into -- bail out quietly instead of crashing later.
    if (!tbody) return;

    try {
        const { data: categories, error } = await supabaseClient
            .from('categories')
            .select(`
                id,
                name,
                location,
                products:products ( count )
            `)
            .order('name', { ascending: true });

        if (error) throw error;

        // 🔥 FIX: re-check after the await -- the Supabase query is a
        // real network round trip, and the user may have navigated away
        // from this page entirely while it was in flight. If the
        // element is gone now, this response is stale; just drop it.
        const tbodyNow = document.getElementById('categoryTableBody');
        if (!tbodyNow) return;

        if (categories.length === 0) {
            tbodyNow.innerHTML = `<tr><td colspan="3" style="text-align: center; padding: 30px; color: #94a3b8;">No categories found. Add one via the Product Master.</td></tr>`;
            return;
        }

        renderCategories(categories);

    } catch (error) {
        console.error("Error loading categories:", error);
        const tbodyErr = document.getElementById('categoryTableBody');
        if (tbodyErr) {
            tbodyErr.innerHTML = `<tr><td colspan="3" style="text-align: center; padding: 30px; color: #dc2626;">Error: ${error.message}</td></tr>`;
        }
    }
}

// ============================================
// RENDER CATEGORIES
// ============================================
function renderCategories(categories) {
    const tbody = document.getElementById('categoryTableBody');
    // 🔥 FIX: same stale-navigation guard -- this function gets called
    // right after the await in loadCategories() above, so it needs the
    // same protection.
    if (!tbody) return;
    
    tbody.innerHTML = categories.map(cat => `
        <tr data-category-id="${cat.id}" data-category-name="${cat.name}" style="cursor: pointer; transition: 0.2s;" onmouseover="this.style.background='#f1f5f9'" onmouseout="this.style.background=''">
            <td style="padding-left: 20px; font-weight: 500;">
                <i class="fa-solid fa-folder-open" style="color: #3b82f6; margin-right: 10px;"></i>
                ${cat.name}
            </td>
            <td>${cat.location || '-'}</td>
            <td style="text-align: right; padding-right: 20px; font-weight: bold;">
                ${cat.products[0]?.count || 0}
                
                <span style="margin-left: 15px; font-weight: normal;">
                    <a href="#" class="edit-category" data-id="${cat.id}" data-name="${cat.name}" data-location="${cat.location || ''}" style="color: #3b82f6; margin-right: 8px;">
                        <i class="fa-regular fa-pen-to-square"></i>
                    </a>
                    <a href="#" class="delete-category" data-id="${cat.id}" style="color: #ef4444;">
                        <i class="fa-regular fa-trash-can"></i>
                    </a>
                </span>
            </td>
        </tr>
    `).join('');
}

// ============================================
// LOAD SUB-CATEGORIES
// ============================================
async function loadSubCategories(categoryId, categoryName) {
    const subContainer = document.getElementById('subCategoryContainer');
    const subTbody = document.getElementById('subCategoryTableBody');
    const title = document.getElementById('selectedCategoryTitle');
    // 🔥 FIX: same stale-navigation guard as loadCategories() above.
    if (!subContainer || !subTbody || !title) return;

    subContainer.style.display = 'block';
    title.textContent = `${categoryName} - Sub-Categories`;
    subTbody.innerHTML = `<tr><td colspan="3" style="text-align: center; padding: 30px; color: #94a3b8;"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</td></tr>`;

    try {
        const { data: subCats, error } = await supabaseClient
            .from('sub_categories')
            .select(`
                id,
                name,
                location,
                products:products ( count )
            `)
            .eq('category_id', categoryId)
            .order('name', { ascending: true });

        if (error) throw error;

        // 🔥 FIX: re-check after the await -- may have navigated away
        // while this query was in flight.
        const subTbodyNow = document.getElementById('subCategoryTableBody');
        if (!subTbodyNow) return;

        if (subCats.length === 0) {
            subTbodyNow.innerHTML = `<tr><td colspan="3" style="text-align: center; padding: 30px; color: #94a3b8;">No sub-categories found for this category.</td></tr>`;
            return;
        }

        renderSubCategories(subCats);

    } catch (error) {
        console.error("Error loading sub-categories:", error);
        const subTbodyErr = document.getElementById('subCategoryTableBody');
        if (subTbodyErr) {
            subTbodyErr.innerHTML = `<tr><td colspan="3" style="text-align: center; padding: 30px; color: #dc2626;">Error: ${error.message}</td></tr>`;
        }
    }
}

// ============================================
// RENDER SUB-CATEGORIES
// ============================================
function renderSubCategories(subCats) {
    const subTbody = document.getElementById('subCategoryTableBody');
    // 🔥 FIX: same stale-navigation guard.
    if (!subTbody) return;
    
    subTbody.innerHTML = subCats.map(sub => `
        <tr>
            <td style="padding-left: 20px;">${sub.name}</td>
            <td>${sub.location || '-'}</td>
            <td style="text-align: right; padding-right: 20px;">
                <a href="#" style="color: #2563eb; font-weight: 500; text-decoration: none;" onclick="loadProductsBySubCategory('${sub.id}', '${sub.name}')">
                    ${sub.products[0]?.count || 0} Products
                </a>
                <span style="margin-left: 15px; font-weight: normal;">
                    <a href="#" class="edit-subcategory" data-id="${sub.id}" data-name="${sub.name}" style="color: #3b82f6; margin-right: 8px;">
                        <i class="fa-regular fa-pen-to-square"></i>
                    </a>
                    <a href="#" class="delete-subcategory" data-id="${sub.id}" style="color: #ef4444;">
                        <i class="fa-regular fa-trash-can"></i>
                    </a>
                </span>
            </td>
        </tr>
    `).join('');
}

// ============================================
// LOAD PRODUCTS BY SUB-CATEGORY
// ============================================
async function loadProductsBySubCategory(subCategoryId, subCategoryName) {
    const modal = document.getElementById('productListModal');
    const title = document.getElementById('productListTitle');
    const list = document.getElementById('productListContent');
    // 🔥 FIX: same stale-navigation guard as the category functions above.
    if (!modal || !title || !list) return;

    title.textContent = `${subCategoryName} - Products`;
    list.innerHTML = `<li style="padding: 15px; text-align: center; color: #94a3b8;"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</li>`;
    modal.style.display = 'flex';

    try {
        const { data: products, error } = await supabaseClient
            .from('products')
            .select('id, product_name')
            .eq('sub_category_id', subCategoryId)
            .order('product_name', { ascending: true });

        if (error) throw error;

        // 🔥 FIX: re-check after the first await.
        let listNow = document.getElementById('productListContent');
        if (!listNow) return;

        if (products.length === 0) {
            listNow.innerHTML = `<li style="padding: 15px; text-align: center; color: #94a3b8;">No products found in this sub-category.</li>`;
            return;
        }

        // 🔥 FIX: this used to show product names only, with no
        // quantity at all -- not useful for stock taking. Now sums
        // batches.total_qty per product to show real current stock.
        const productIds = products.map(p => p.id);
        const { data: batches } = await supabaseClient
            .from('batches')
            .select('product_id, total_qty')
            .in('product_id', productIds);

        // 🔥 FIX: re-check after the second await too.
        listNow = document.getElementById('productListContent');
        if (!listNow) return;

        const qtyMap = {};
        (batches || []).forEach(b => {
            qtyMap[b.product_id] = (qtyMap[b.product_id] || 0) + (b.total_qty || 0);
        });

        listNow.innerHTML = products.map(p => `
            <li style="padding: 12px 15px; border-bottom: 1px solid #f1f5f9; display: flex; align-items: center; justify-content: space-between; gap: 10px;">
                <span><i class="fa-solid fa-cube" style="color: #3b82f6; margin-right: 8px;"></i>${p.product_name}</span>
                <span style="font-weight: 600; color: ${(qtyMap[p.id] || 0) === 0 ? '#dc2626' : '#15803d'};">${qtyMap[p.id] || 0} units</span>
            </li>
        `).join('');

    } catch (error) {
        console.error("Error loading products:", error);
        list.innerHTML = `<li style="padding: 15px; text-align: center; color: #dc2626;">Error: ${error.message}</li>`;
    }
}

// ============================================
// UPDATE & DELETE FUNCTIONS
// ============================================
async function updateSubCategory(id, newName) {
    try {
        const { error } = await supabaseClient
            .from('sub_categories')
            .update({ name: newName })
            .eq('id', id);
        if (error) throw error;
        showToast('Sub-Category updated successfully!', 'success');
        const activeRow = document.querySelector('#categoryTableBody tr[data-category-id]');
        if (activeRow) {
            const categoryId = activeRow.dataset.categoryId;
            const categoryName = activeRow.dataset.categoryName;
            loadSubCategories(categoryId, categoryName);
        }
    } catch (error) {
        showToast('Error updating sub-category: ' + error.message, 'error');
    }
}

async function deleteSubCategory(id) {
    try {
        const { error } = await supabaseClient
            .from('sub_categories')
            .delete()
            .eq('id', id);
        if (error) throw error;
        showToast('Sub-Category deleted successfully!', 'success');
        const activeRow = document.querySelector('#categoryTableBody tr[data-category-id]');
        if (activeRow) {
            const categoryId = activeRow.dataset.categoryId;
            const categoryName = activeRow.dataset.categoryName;
            loadSubCategories(categoryId, categoryName);
        }
    } catch (error) {
        showToast('Error deleting sub-category: ' + error.message, 'error');
    }
}

async function deleteCategory(id) {
    try {
        const { error } = await supabaseClient
            .from('categories')
            .delete()
            .eq('id', id);
        if (error) throw error;
        showToast('Category deleted successfully!', 'success');
        document.getElementById('subCategoryContainer').style.display = 'none';
        await loadCategories();
    } catch (error) {
        showToast('Error deleting category: ' + error.message, 'error');
    }
}

// ============================================
// CLOSE QUICK ADD MODAL
// ============================================
function closeQuickAdd() {
    const overlay = document.querySelector('#quickAddOverlay');
    if (overlay) overlay.remove();
}

// ============================================
// TOAST NOTIFICATION SYSTEM (FIXED FOR RELOAD)
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

// Add CSS for animations (Safe from redeclaration)
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