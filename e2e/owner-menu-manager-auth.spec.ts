import{execFileSync}from'node:child_process';
import{expect,test,type Page}from'@playwright/test';
const password='zaytun-local-2026';
const psql=(sql:string)=>execFileSync('psql',['postgresql://postgres:postgres@127.0.0.1:54322/postgres','-v','ON_ERROR_STOP=1','-Atc',sql],{encoding:'utf8'}).trim();
async function signIn(page:Page,email:string){await page.getByLabel('Telefon yoki email').fill(email);await page.getByLabel('Parol').fill(password);const submit=page.getByRole('button',{name:'Kirish'});await expect(submit).toBeEnabled({timeout:15000});await submit.click()}
const onePixelPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');

test('OWNER navigation reaches Menu boshqaruvi on desktop and mobile, while other roles never see it',async({browser})=>{
  test.setTimeout(60000);
  const anonymousContext=await browser.newContext();const anonymous=await anonymousContext.newPage();await anonymous.goto('/');await expect(anonymous.getByRole('link',{name:'Menu boshqaruvi'})).toHaveCount(0);await anonymousContext.close();

  const restaurantContext=await browser.newContext();const restaurant=await restaurantContext.newPage();await restaurant.goto('/restaurant');await signIn(restaurant,'restaurant@zaytun.local');await expect(restaurant.getByRole('button',{name:'Chiqish'})).toBeVisible();await expect(restaurant.getByRole('link',{name:'Menu boshqaruvi'})).toHaveCount(0);await restaurantContext.close();

  const dispatcherContext=await browser.newContext();const dispatcher=await dispatcherContext.newPage();await dispatcher.goto('/restaurant');await signIn(dispatcher,'dispatcher@zaytun.local');await expect(dispatcher.getByRole('button',{name:'Chiqish'})).toBeVisible();await expect(dispatcher.getByRole('link',{name:'Menu boshqaruvi'})).toHaveCount(0);await dispatcherContext.close();

  const driverContext=await browser.newContext();const driver=await driverContext.newPage();await driver.goto('/driver');await signIn(driver,'driver@zaytun.local');await expect(driver.getByRole('button',{name:'Chiqish'})).toBeVisible();await expect(driver.getByRole('link',{name:'Menu boshqaruvi'})).toHaveCount(0);await driverContext.close();

  const desktopContext=await browser.newContext({viewport:{width:1280,height:800}});const desktop=await desktopContext.newPage();await desktop.goto('/restaurant');await signIn(desktop,'owner@zaytun.local');const desktopNav=desktop.getByTestId('operational-navigation');const desktopOwnerLink=desktopNav.getByRole('link',{name:'Menu boshqaruvi'});await expect(desktopOwnerLink).toBeVisible();expect(await desktop.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await desktopOwnerLink.click();await expect(desktop).toHaveURL(/\/owner\/menu$/);await expect(desktopOwnerLink).toHaveClass(/active/);await expect(desktop.getByRole('link',{name:'Restoran'})).toBeVisible();await desktopContext.close();

  const mobileContext=await browser.newContext({viewport:{width:390,height:844}});const mobile=await mobileContext.newPage();await mobile.goto('/restaurant');await signIn(mobile,'owner@zaytun.local');const mobileNav=mobile.getByTestId('operational-navigation');await expect(mobileNav.getByRole('link')).toHaveCount(4);const mobileOwnerLink=mobileNav.getByRole('link',{name:'Menu boshqaruvi'});await expect(mobileOwnerLink).toBeVisible();expect(await mobile.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);const box=await mobileNav.boundingBox();expect(box).not.toBeNull();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(390);expect(box!.y+box!.height).toBeLessThanOrEqual(844);await mobileOwnerLink.click();await expect(mobile).toHaveURL(/\/owner\/menu$/);await expect(mobileOwnerLink).toHaveClass(/active/);await mobileContext.close();
});

test('OWNER manages menu quickly on mobile while non-owner staff is denied',async({browser})=>{
  const deniedContext=await browser.newContext();const denied=await deniedContext.newPage();
  await denied.goto('/owner/menu');await signIn(denied,'restaurant@zaytun.local');
  await expect(denied.getByRole('heading',{name:'Ruxsat yo‘q'})).toBeVisible();await deniedContext.close();

  const context=await browser.newContext({viewport:{width:390,height:844}});const page=await context.newPage();
  await page.goto('/owner/menu');await signIn(page,'owner@zaytun.local');
  await expect(page.getByTestId('owner-menu-manager')).toBeVisible();
  await expect(page.getByRole('heading',{name:'Menu boshqaruvi'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);

  await page.getByLabel('Mahsulot qidirish').fill('Жиз (филе)');
  const jiz=page.getByTestId('owner-product-nacional-zhiz-file');await expect(jiz).toBeVisible();
  await jiz.getByRole('button',{name:'Narx'}).click();await jiz.getByLabel('Жиз (филе) yangi narxi').fill('275000');await jiz.getByRole('button',{name:'Saqlash'}).click();
  await expect(page.getByRole('status')).toContainText('Narx yangilandi');
  expect(psql("select price from menu_items where id='nacional-zhiz-file'" )).toBe('275000');

  await page.getByLabel('Mahsulot qidirish').fill('');await page.getByLabel('Kategoriya').selectOption('napitki');await expect(page.locator('.owner-product-card')).toHaveCount(19);
  await page.getByLabel('Kategoriya').selectOption('all');await page.getByLabel('Holati').selectOption('unavailable');
  await expect(page.locator('.owner-product-card')).toHaveCount(0);

  await page.getByRole('button',{name:/Yangi taom/}).click();
  const form=page.getByTestId('owner-product-form');await form.getByLabel('Nomi *').fill('E2E Owner taom');await form.getByLabel('Kategoriya *').selectOption('mains');await form.getByLabel('Narxi *').fill('33000');await form.getByLabel('Sotuvda').uncheck();await form.locator('input[type=file]').setInputFiles({name:'new-product.png',mimeType:'image/png',buffer:onePixelPng});await form.getByRole('button',{name:'Saqlash'}).click();
  await expect(page.getByRole('status')).toContainText('Yangi mahsulot qo‘shildi');
  expect(psql("select count(*) from menu_items where name='E2E Owner taom' and available=false and packaging_required=true and packaging_unit_price=3000 and packaging_capacity=1 and image like '%/storage/v1/object/public/menu-images/%'")).toBe('1');

  await context.close();
  psql("update menu_items set price=260000 where id='nacional-zhiz-file'; delete from menu_audit_log where product_id in(select id from menu_items where name='E2E Owner taom') or product_id='nacional-zhiz-file'; delete from menu_items where name='E2E Owner taom';");
});

test('OWNER securely uploads, previews and replaces menu images without corrupting failed saves',async({browser})=>{
  test.setTimeout(60000);
  const original=psql("select image from menu_items where id='nacional-zhiz-file'");
  const originalDescription=psql("select description from menu_items where id='nacional-zhiz-file'");
  const context=await browser.newContext({viewport:{width:390,height:844}});const page=await context.newPage();
  await page.goto('/owner/menu');await signIn(page,'owner@zaytun.local');
  await page.getByLabel('Mahsulot qidirish').fill('Жиз (филе)');const card=page.getByTestId('owner-product-nacional-zhiz-file');await card.getByRole('button',{name:'Tahrirlash'}).click();
  const form=page.getByTestId('owner-product-form');const picker=form.locator('input[type=file]');
  await picker.setInputFiles({name:'jiz.png',mimeType:'image/png',buffer:onePixelPng});
  await expect(form.locator('.owner-image-field>.product-image-element')).toBeVisible();await expect(form).toContainText('jiz.png');
  await form.getByRole('button',{name:'Tanlovni bekor qilish'}).click();await expect(form).not.toContainText('jiz.png');
  await picker.setInputFiles({name:'jiz.webp',mimeType:'image/webp',buffer:onePixelPng});await form.getByRole('button',{name:'Saqlash'}).click();
  await expect(page.getByRole('status')).toContainText('Mahsulot yangilandi');
  const uploaded=psql("select image from menu_items where id='nacional-zhiz-file'");expect(uploaded).toMatch(/^http:\/\/127\.0\.0\.1:54321\/storage\/v1\/object\/public\/menu-images\/10000000-0000-0000-0000-000000000005\/[0-9a-f-]+\.webp$/);
  expect(psql("select count(*) from menu_audit_log where product_id='nacional-zhiz-file' and before_state->>'image'<>after_state->>'image'" )).not.toBe('0');

  await page.goto('/menu/nacional-zhiz-file');await expect(page.locator(`img[src="${uploaded}"]`)).toBeVisible();
  await page.goto('/owner/menu');await page.getByLabel('Mahsulot qidirish').fill('Жиз (филе)');await page.getByTestId('owner-product-nacional-zhiz-file').getByRole('button',{name:'Tahrirlash'}).click();const preserveForm=page.getByTestId('owner-product-form');await preserveForm.getByLabel('Tavsifi').fill('E2E preserved image');await preserveForm.getByRole('button',{name:'Saqlash'}).click();await expect(page.getByRole('status')).toContainText('Mahsulot yangilandi');expect(psql("select image from menu_items where id='nacional-zhiz-file'")).toBe(uploaded);

  await page.getByLabel('Mahsulot qidirish').fill('Жиз (филе)');await page.getByTestId('owner-product-nacional-zhiz-file').getByRole('button',{name:'Tahrirlash'}).click();const failedForm=page.getByTestId('owner-product-form');await failedForm.getByLabel('Tavsifi').fill('Must survive upload failure');await failedForm.locator('input[type=file]').setInputFiles({name:'retry.jpg',mimeType:'image/jpeg',buffer:onePixelPng});await page.route('**/storage/v1/object/menu-images/**',route=>route.fulfill({status:503,body:'temporary failure'}));await failedForm.getByRole('button',{name:'Saqlash'}).click();await expect(failedForm.getByRole('alert')).toBeVisible();await expect(failedForm.getByLabel('Tavsifi')).toHaveValue('Must survive upload failure');expect(psql("select description from menu_items where id='nacional-zhiz-file'")).toBe('E2E preserved image');

  await context.close();
  psql(`update menu_items set image='${original.replaceAll("'","''")}',description='${originalDescription.replaceAll("'","''")}'; delete from menu_audit_log where product_id='nacional-zhiz-file';`);
});
