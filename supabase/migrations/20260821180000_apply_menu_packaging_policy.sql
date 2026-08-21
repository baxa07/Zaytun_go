-- Apply the approved takeaway packaging policy to future orders.
-- Existing order_items already contain immutable packaging snapshots and are
-- deliberately not updated here.

-- Default every current menu item to one 3,000 UZS box per ordered portion.
update public.menu_items
set packaging_required = true,
    packaging_unit_price = 3000,
    packaging_capacity = 1;

-- Non-alcoholic drinks and the legacy local/demo drinks category need no box.
update public.menu_items
set packaging_required = false,
    packaging_unit_price = 0,
    packaging_capacity = null
where category_id in ('napitki', 'drinks');

-- The alcohol category contains both beverages and food snacks. Start with
-- beverages unboxed, then restore the known food rows by stable product id.
update public.menu_items
set packaging_required = false,
    packaging_unit_price = 0,
    packaging_capacity = null
where category_id = 'alkohol';

update public.menu_items
set packaging_required = true,
    packaging_unit_price = 3000,
    packaging_capacity = 1
where id in (
  'alkohol-pivnaya-assorti',
  'alkohol-syrnye-palochki',
  'alkohol-kurt',
  'alkohol-kostichki',
  'alkohol-chipsy',
  'alkohol-grenki'
);

-- Regular somsa remains unboxed.
update public.menu_items
set packaging_required = false,
    packaging_unit_price = 0,
    packaging_capacity = null
where id in (
  'nacional-somsa-obychnyy-i-ostryy',
  'nacional-somsa-baranina'
);

-- Olot somsa is the explicit somsa exception: one box per 15 pieces.
update public.menu_items
set packaging_required = true,
    packaging_unit_price = 3000,
    packaging_capacity = 15
where id = 'nacional-olot-somsa';
