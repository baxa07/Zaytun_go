import {expect,test} from '@playwright/test'

test.describe('continuous customer menu',()=>{
  test.use({viewport:{width:390,height:844}})

  test('renders every category in one document and synchronizes the sticky rail',async({page})=>{
    await page.goto('/menu')
    const menu=page.getByTestId('continuous-menu')
    await expect(menu.getByRole('heading',{name:'Gril',exact:true})).toBeVisible()
    await expect(menu.getByRole('heading',{name:'Issiq taomlar',exact:true})).toBeAttached()
    await expect(menu.getByRole('heading',{name:'Ichimliklar',exact:true})).toBeAttached()
    await page.getByTestId('menu-category-rail').getByRole('button',{name:'Ichimliklar'}).click()
    await expect(page.getByTestId('menu-section-drinks')).toBeInViewport()
    await expect(page.getByTestId('menu-category-rail').getByRole('button',{name:'Ichimliklar'})).toHaveClass(/active/)
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
  })

  test('simple product plus uses the existing cart while modifier products retain selection',async({page})=>{
    await page.goto('/menu')
    await page.getByRole('button',{name:'Mol go‘shtli kabob savatga qo‘shish'}).click()
    await expect(page.getByTestId('cart-pill')).toContainText('1')
    await expect(page.getByRole('link',{name:'Zaytun tovuq grili tanlash'})).toHaveAttribute('href','/menu/chicken')
  })
})

for(const viewport of [{width:320,height:700},{width:360,height:800},{width:430,height:900},{width:1280,height:800}]){
  test(`continuous menu grid is stable at ${viewport.width}px`,async({page})=>{
    await page.setViewportSize(viewport)
    await page.goto('/menu')
    const columns=await page.getByTestId('menu-section-grill').locator('.menu-grid').evaluate(element=>getComputedStyle(element).gridTemplateColumns.split(' ').length)
    expect(columns).toBe(viewport.width<=760?2:3)
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
  })
}
