import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
const browser=await chromium.launch();
for(const width of [1280,375]) {
 const page=await browser.newPage({viewport:{width,height:812}});
 for(const state of ['ready','unconfigured','error','loading','request']) {
  await page.goto(`http://127.0.0.1:3998?state=${state}`);
  assert.equal(await page.locator('#apTitle').innerText(),'Auto Delegate');
  if(state==='ready') {
   assert.equal(await page.locator('.ap-ranked li').count(),3);
   assert.equal(await page.locator('.v').first().isVisible(),false);
   await page.locator('summary').focus(); await page.keyboard.press('Enter');
   assert.equal(await page.locator('.v').first().innerText(),'50.0');
   assert.ok((await page.locator('.v').allTextContents()).includes('—'));
  }
  const measure=await page.evaluate(()=>({width:innerWidth,page:document.documentElement.scrollWidth,body:document.getElementById('apBody').clientWidth,scroll:document.getElementById('apBody').scrollWidth}));
  assert.equal(measure.page,width); assert.ok(measure.scroll<=measure.body);
  if(['unconfigured','error','request'].includes(state)) {
   const button=page.locator('.ap-action'); await button.scrollIntoViewIfNeeded();
   const box=await button.boundingBox();assert.ok(box.height>=44&&box.x>=0&&box.x+box.width<=width);
   await button.click();assert.equal(await page.evaluate(()=>window.action),state==='request'?'retry':'connections');
  }
  console.log(JSON.stringify({state,...measure}));
 }
 await page.close();
}
await browser.close();
