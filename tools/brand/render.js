const { chromium } = require('/opt/node-tools/node_modules/playwright');
const fs = require('fs'), path = require('path');
(async () => {
  const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const p = await b.newPage({ deviceScaleFactor: 1 });
  for (const j of jobs) {
    const svg = fs.readFileSync(j.svg, 'utf8');
    const url = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
    await p.setViewportSize({ width: j.w, height: j.h });
    await p.setContent(`<body style="margin:0;background:${j.bg||'transparent'}">
      <img src="${url}" style="display:block;width:${j.w}px;height:${j.h}px">`);
    await p.waitForTimeout(120);
    await p.screenshot({ path: j.out, omitBackground: !j.bg });
    console.log('->', j.out);
  }
  await b.close();
})();
