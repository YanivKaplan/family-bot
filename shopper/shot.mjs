// Screenshot of the shopper's browser: node shopper/shot.mjs /tmp/page.png
import { writeFileSync } from 'node:fs';
import { Browser } from './cdp.mjs';

const browser = await Browser.connect(Number(process.env.CDP_PORT ?? 9222));
const { data } = await browser.send('Page.captureScreenshot');
writeFileSync(process.argv[2] ?? 'page.png', Buffer.from(data, 'base64'));
browser.close();
